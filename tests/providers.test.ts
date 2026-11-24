import { describe, it, expect, vi } from "vitest"
import { createHmac } from "crypto"
import { MedusaError } from "@medusajs/framework/utils"
import { NmiProviderService } from "../src/providers/nmi"
import { NmiCardProviderService } from "../src/providers/nmi-card"
import { NmiAchProviderService } from "../src/providers/nmi-ach"
import { NmiWalletProviderService } from "../src/providers/nmi-wallet"
import { NmiError } from "../src/lib/errors"

const OPTS = {
  securityKey: "sk",
  tokenizationKey: "tk",
  webhookSecret: "ws",
}

const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })

function makeService<T>(Ctor: new (c: any, o: any) => T, opts: Record<string, unknown> = {}): {
  svc: any
  transact: ReturnType<typeof vi.fn>
  condition: ReturnType<typeof vi.fn>
  log: ReturnType<typeof logger>
} {
  const log = logger()
  const svc = new Ctor({ logger: log }, { ...OPTS, ...opts }) as any
  const transact = vi.fn(async (args: any) => ({
    response: "1",
    transactionid: "tx_1",
    authcode: "auth_1",
    avsresponse: "Y",
    cvvresponse: "M",
    ...args,
  }))
  // null = "the Query API could not tell us", the state of a key without Query permission.
  const condition = vi.fn(async () => null as string | null)
  svc.client = { transact, condition }
  return { svc, transact, condition, log }
}

/** Replace the client with one whose transact() is scripted per call type. */
function failing(svc: any, impl: (args: any) => any, condition: string | null = null) {
  const transact = vi.fn(async (args: any) => impl(args))
  const cond = vi.fn(async () => condition)
  svc.client = { transact, condition: cond }
  return { transact, condition: cond }
}

const AUTH_INPUT = {
  data: { payment_token: "tok_1", session_id: "ps_1", amount: 100 },
  context: {},
}

describe("provider identifiers", () => {
  it("registers distinct identifiers per variant", () => {
    expect((NmiProviderService as any).identifier).toBe("nmi")
    expect((NmiCardProviderService as any).identifier).toBe("nmi-card")
    expect((NmiAchProviderService as any).identifier).toBe("nmi-ach")
    expect((NmiWalletProviderService as any).identifier).toBe("nmi-wallet")
  })
})

describe("nmi-card", () => {
  it("authorizes synchronously with type=auth by default", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    const res = await svc.authorizePayment(AUTH_INPUT)
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ type: "auth" }))
    expect(res.status).toBe("authorized")
    expect(res.data.payment_method).toBe("card")
  })

  it("captures immediately when captureMethod=sale", async () => {
    const { svc, transact } = makeService(NmiCardProviderService, { captureMethod: "sale" })
    const res = await svc.authorizePayment(AUTH_INPUT)
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ type: "sale" }))
    expect(res.status).toBe("captured")
  })

  it("stays pending without a payment token", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    const res = await svc.authorizePayment({ data: { session_id: "ps_1" }, context: {} })
    expect(transact).not.toHaveBeenCalled()
    expect(res.status).toBe("pending")
  })

  it("sends the session id as the order id, preferring the module's idempotency key", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    await svc.authorizePayment({
      data: { payment_token: "tok", session_id: "from_data", amount: 10 },
      context: { idempotency_key: "payses_trusted" },
    })
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "payses_trusted" }))
  })

  it("keeps the amount and session id on the payment data", async () => {
    // The payment module replaces session.data with what authorize returns, so
    // capture and refund can only see what is copied across here.
    const { svc } = makeService(NmiCardProviderService)
    const res = await svc.authorizePayment(AUTH_INPUT)
    expect(res.data.amount).toBe(100)
    expect(res.data.session_id).toBe("ps_1")
    expect(res.data.transactionid).toBe("tx_1")
  })

  it.each([0, -5, "abc", undefined, null, NaN])(
    "refuses to charge an invalid amount (%s) without calling NMI",
    async (amount) => {
      const { svc, transact } = makeService(NmiCardProviderService)
      const err = await svc
        .authorizePayment({ data: { payment_token: "tok", session_id: "ps", amount }, context: {} })
        .catch((e: unknown) => e)
      expect(MedusaError.isMedusaError(err)).toBe(true)
      expect(transact).not.toHaveBeenCalled()
    }
  )

  it("passes a valid buyer IP and order description through, and drops a bogus IP", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    await svc.authorizePayment({
      data: { ...AUTH_INPUT.data, ip_address: "203.0.113.9", order_description: " Order #1001 " },
      context: {},
    })
    expect(transact).toHaveBeenLastCalledWith(
      expect.objectContaining({ ipAddress: "203.0.113.9", orderDescription: "Order #1001" })
    )
    await svc.authorizePayment({
      data: { ...AUTH_INPUT.data, ip_address: "not-an-ip&type=refund" },
      context: {},
    })
    expect(transact.mock.calls[1][0].ipAddress).toBeUndefined()
  })
})

describe("declines reach the buyer", () => {
  const declineWith = (code: string, text: string) => () => {
    throw new NmiError(`NMI transaction declined: ${text}`, "2", code, {
      response: "2",
      responsetext: text,
      response_code: code,
    })
  }

  it("throws a PAYMENT_AUTHORIZATION_ERROR MedusaError, which Medusa passes to the storefront", async () => {
    const { svc, log } = makeService(NmiCardProviderService)
    failing(svc, declineWith("202", "INSUFFICIENT FUNDS"))
    const err = await svc.authorizePayment(AUTH_INPUT).catch((e: unknown) => e)
    expect(MedusaError.isMedusaError(err)).toBe(true)
    expect(err.type).toBe(MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR)
    expect(err.message).toMatch(/insufficient funds/i)
    // The gateway detail goes to the log, with the session it belongs to.
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("INSUFFICIENT FUNDS"))
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("ps_1"))
    expect(err.cause).toBeInstanceOf(NmiError)
  })

  it("does not show the buyer issuer text such as a stolen-card response", async () => {
    const { svc } = makeService(NmiCardProviderService)
    failing(svc, declineWith("252", "STOLEN CARD"))
    const err = await svc.authorizePayment(AUTH_INPUT).catch((e: unknown) => e)
    expect(err.message).not.toMatch(/stolen/i)
    expect(err.message).toMatch(/declined/i)
  })

  it("keeps a gateway error generic", async () => {
    const { svc } = makeService(NmiCardProviderService)
    failing(svc, () => {
      throw new NmiError("NMI transaction error: Invalid merchant configuration", "3", "410")
    })
    const err = await svc.authorizePayment(AUTH_INPUT).catch((e: unknown) => e)
    expect(err.type).toBe(MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR)
    expect(err.message).not.toMatch(/merchant/i)
  })

  it("tells the buyer not to retry when the outcome is unknown", async () => {
    const { svc } = makeService(NmiCardProviderService)
    failing(svc, () => {
      throw new NmiError("NMI sale outcome unknown", "3", undefined, undefined, true)
    })
    const err = await svc.authorizePayment(AUTH_INPUT).catch((e: unknown) => e)
    expect(err.message).toMatch(/do not try again/i)
  })

  it("words an ACH decline for a bank account", async () => {
    const { svc } = makeService(NmiAchProviderService)
    failing(svc, declineWith("200", "DECLINE"))
    const err = await svc.authorizePayment(AUTH_INPUT).catch((e: unknown) => e)
    expect(err.type).toBe(MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR)
    expect(err.message).toMatch(/bank payment/i)
  })
})

describe("nmi-ach", () => {
  it("submits a sale but reports authorized (settlement is async)", async () => {
    const { svc, transact } = makeService(NmiAchProviderService)
    const res = await svc.authorizePayment(AUTH_INPUT)
    expect(transact).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sale",
        ach: expect.objectContaining({ secCode: "WEB" }),
      })
    )
    expect(res.status).toBe("authorized")
    expect(res.data.payment_method).toBe("ach")
    expect(res.data.amount).toBe(100)
  })

  it("treats capture as a no-op for ach payments", async () => {
    const { svc, transact } = makeService(NmiAchProviderService)
    const res = await svc.capturePayment({ data: { payment_method: "ach", transactionid: "tx_1" } })
    expect(transact).not.toHaveBeenCalled()
    expect(res.data.payment_method).toBe("ach")
  })

  it("cancels even when the void fails, since a returned debit cannot be voided", async () => {
    const { svc } = makeService(NmiAchProviderService)
    failing(svc, () => {
      throw new Error("NMI transaction declined: Transaction already returned")
    })
    const res = await svc.cancelPayment({ data: { payment_method: "ach", transactionid: "tx_1" } })
    expect(res.data.canceled).toBe(true)
    expect(res.data.void_failed).toBe(true)
    expect(res.data.void_error).toContain("already returned")
  })

  it("records NMI's condition when a returned debit's void fails", async () => {
    const { svc } = makeService(NmiAchProviderService)
    failing(svc, () => { throw new Error("cannot void") }, "failed")
    const res = await svc.cancelPayment({ data: { payment_method: "ach", transactionid: "tx_1" } })
    expect(res.data.void_failed).toBe(true)
    expect(res.data.nmi_condition).toBe("failed")
  })

  it.each(["pendingsettlement", "complete", "pending"])(
    "refuses to cancel when the void fails and the debit is still live (%s)",
    async (condition) => {
      // Otherwise the order is cancelled while the buyer is still being debited.
      const { svc } = makeService(NmiAchProviderService)
      failing(svc, () => { throw new Error("void rejected") }, condition)
      await expect(
        svc.cancelPayment({ data: { payment_method: "ach", transactionid: "tx_1" } })
      ).rejects.toThrow(/still live/)
    }
  )

  it("still voids normally when the debit has not returned, as a check transaction", async () => {
    const { svc, transact } = makeService(NmiAchProviderService)
    const res = await svc.cancelPayment({ data: { payment_method: "ach", transactionid: "tx_1" } })
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ type: "void", ach: {} }))
    expect(res.data.canceled).toBe(true)
    expect(res.data.void_failed).toBeUndefined()
  })

  it("refunds as a check transaction", async () => {
    const { svc, transact } = makeService(NmiAchProviderService)
    await svc.refundPayment({
      amount: 40,
      data: { payment_method: "ach", transactionid: "tx_1", amount: 100 },
    })
    expect(transact).toHaveBeenCalledWith(
      expect.objectContaining({ type: "refund", amount: 40, ach: {} })
    )
  })
})

describe("webhookSecret is only needed for ACH", () => {
  const NO_SECRET = { webhookSecret: undefined }

  it("does not fail at boot without it", () => {
    expect(() =>
      (NmiCardProviderService as any).validateOptions({ securityKey: "sk", tokenizationKey: "tk" })
    ).not.toThrow()
    expect(() =>
      (NmiAchProviderService as any).validateOptions({ securityKey: "sk", tokenizationKey: "tk" })
    ).not.toThrow()
  })

  it("constructs and charges cards without it", async () => {
    const { svc, transact } = makeService(NmiCardProviderService, NO_SECRET)
    const res = await svc.authorizePayment(AUTH_INPUT)
    expect(transact).toHaveBeenCalled()
    expect(res.status).toBe("authorized")
  })

  it("refuses an ACH authorization without it, before any money is requested", async () => {
    const { svc, transact, log } = makeService(NmiAchProviderService, NO_SECRET)
    const err = await svc.authorizePayment(AUTH_INPUT).catch((e: unknown) => e)
    expect(MedusaError.isMedusaError(err)).toBe(true)
    expect(err.type).toBe(MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR)
    expect(err.message).toMatch(/bank payments are not available/i)
    expect(transact).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("webhookSecret"))
  })

  it("refuses ACH through the unified provider too, but still takes cards", async () => {
    const { svc, transact } = makeService(NmiProviderService, NO_SECRET)
    await expect(
      svc.authorizePayment({ data: { ...AUTH_INPUT.data, payment_method: "ach" }, context: {} })
    ).rejects.toThrow(/bank payments/i)
    expect(transact).not.toHaveBeenCalled()
    const res = await svc.authorizePayment(AUTH_INPUT)
    expect(res.data.payment_method).toBe("card")
  })
})

describe("card cancel stays strict", () => {
  it("propagates a failed void, since the authorization may still be live", async () => {
    const { svc } = makeService(NmiCardProviderService)
    failing(svc, () => {
      throw new Error("NMI transaction error: gateway timeout")
    })
    await expect(
      svc.cancelPayment({ data: { payment_method: "card", transactionid: "tx_1" } })
    ).rejects.toThrow("gateway timeout")
  })

  it("accepts a failed void when NMI confirms the transaction is already voided", async () => {
    const { svc } = makeService(NmiCardProviderService)
    failing(svc, () => { throw new Error("Transaction already voided") }, "canceled")
    const res = await svc.cancelPayment({ data: { payment_method: "card", transactionid: "tx_1" } })
    expect(res.data.canceled).toBe(true)
    expect(res.data.already_voided).toBe(true)
  })

  it("tells the admin to refund when the transaction has settled", async () => {
    const { svc } = makeService(NmiCardProviderService)
    failing(svc, () => { throw new Error("void rejected") }, "complete")
    await expect(
      svc.cancelPayment({ data: { payment_method: "card", transactionid: "tx_1" } })
    ).rejects.toThrow(/refund it instead/)
  })

  it("does not call NMI when the payment never got a transaction", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    const res = await svc.cancelPayment({ data: { session_id: "ps_1" } })
    expect(transact).not.toHaveBeenCalled()
    expect(res.data.canceled).toBe(true)
  })
})

describe("capture", () => {
  it("captures the authorized amount against the stored transaction", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    const res = await svc.capturePayment({
      data: { payment_method: "card", transactionid: "tx_1", amount: 100 },
    })
    expect(transact).toHaveBeenCalledWith({ type: "capture", transactionId: "tx_1", amount: 100 })
    expect(res.data.captured).toBe(true)
  })

  it("captures without an amount for payments authorized before it was recorded", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    await svc.capturePayment({ data: { payment_method: "card", transactionid: "tx_1" } })
    expect(transact).toHaveBeenCalledWith({ type: "capture", transactionId: "tx_1" })
  })

  it("fails clearly, without calling NMI, when there is no transaction id", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    await expect(svc.capturePayment({ data: {} })).rejects.toThrow(/no NMI transaction id/)
    expect(transact).not.toHaveBeenCalled()
  })

  it("surfaces NMI's reason to the admin as a MedusaError", async () => {
    const { svc } = makeService(NmiCardProviderService)
    failing(svc, () => {
      throw new NmiError("NMI transaction error: Authorization expired", "3", "300")
    })
    const err = await svc
      .capturePayment({ data: { transactionid: "tx_1", amount: 5 } })
      .catch((e: unknown) => e)
    expect(MedusaError.isMedusaError(err)).toBe(true)
    expect(err.message).toContain("Authorization expired")
  })
})

describe("nmi-wallet", () => {
  it("charges like a card", async () => {
    const { svc, transact } = makeService(NmiWalletProviderService)
    const res = await svc.authorizePayment(AUTH_INPUT)
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ type: "auth" }))
    expect(res.status).toBe("authorized")
  })
})

describe("nmi (unified)", () => {
  it("routes to the ach lifecycle when the session says ach", async () => {
    const { svc, transact } = makeService(NmiProviderService)
    const res = await svc.authorizePayment({
      data: { ...AUTH_INPUT.data, payment_method: "ach" },
      context: {},
    })
    expect(transact).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sale", ach: expect.anything() })
    )
    expect(res.data.payment_method).toBe("ach")
  })

  it("defaults to the card lifecycle", async () => {
    const { svc, transact } = makeService(NmiProviderService)
    const res = await svc.authorizePayment(AUTH_INPUT)
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ type: "auth" }))
    expect(res.data.payment_method).toBe("card")
  })
})

describe("full refunds try a void first", () => {
  const FULL = { amount: 100, data: { transactionid: "tx_1", amount: 100 } }
  const types = (transact: any) => transact.mock.calls.map((c: any) => c[0].type)

  it("voids an unsettled payment and never sends a refund", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    const res = await svc.refundPayment(FULL)
    expect(types(transact)).toEqual(["void"])
    expect(res.data.voided).toBe(true)
    expect(res.data.refundId).toBe("tx_1")
  })

  it("falls back to a refund when NMI refuses the void (settled transaction)", async () => {
    const { svc } = makeService(NmiCardProviderService)
    const { transact } = failing(svc, (args) => {
      if (args.type === "void") {
        throw new NmiError("NMI transaction error: Only unsettled transactions can be voided", "3", "300")
      }
      return { response: "1", transactionid: "refund_1" }
    })
    const res = await svc.refundPayment(FULL)
    expect(types(transact)).toEqual(["void", "refund"])
    expect(transact.mock.calls[1][0]).toMatchObject({ type: "refund", amount: 100 })
    expect(res.data.refundId).toBe("refund_1")
    expect(res.data.voided).toBeUndefined()
  })

  it("works end to end on the data a real authorization leaves behind", async () => {
    // Regression: authorize used to drop `amount`, so the provider could never
    // recognise a full refund outside of tests.
    const { svc } = makeService(NmiCardProviderService, { captureMethod: "sale" })
    const authorized = await svc.authorizePayment(AUTH_INPUT)
    const { transact } = failing(svc, () => ({ response: "1", transactionid: "void_1" }))
    const res = await svc.refundPayment({
      amount: { value: "100", precision: 20 },
      data: authorized.data,
    })
    expect(types(transact)).toEqual(["void"])
    expect(res.data.voided).toBe(true)
  })

  it("sends a partial refund as a refund only", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    await svc.refundPayment({ amount: 25, data: { transactionid: "tx_1", amount: 100 } })
    expect(types(transact)).toEqual(["refund"])
  })

  it("does NOT void on a partial refund failure", async () => {
    const { svc } = makeService(NmiCardProviderService)
    const { transact } = failing(svc, (args) => {
      if (args.type === "refund") throw new Error("not settled")
      return { response: "1", transactionid: "void_1" }
    })
    await expect(
      svc.refundPayment({ amount: 25, data: { transactionid: "tx_1", amount: 100 } })
    ).rejects.toThrow("not settled")
    expect(types(transact)).toEqual(["refund"])
  })

  it("does not void once something has already been refunded on the payment", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    await svc.refundPayment({
      amount: 100,
      data: { transactionid: "tx_1", amount: 100, refundId: "refund_0" },
    })
    expect(types(transact)).toEqual(["refund"])
  })

  it("refunds directly when the original amount was never recorded (pre-0.5 payments)", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    await svc.refundPayment({ amount: 100, data: { transactionid: "tx_1" } })
    expect(types(transact)).toEqual(["refund"])
  })

  describe("when the void's response is lost", () => {
    const lostVoid = (svc: any, condition: string | null) =>
      failing(
        svc,
        (args) => {
          if (args.type === "void") {
            throw new NmiError("NMI void outcome unknown", "3", undefined, undefined, true)
          }
          return { response: "1", transactionid: "refund_1" }
        },
        condition
      )

    it("does NOT fire a refund blindly: a void that landed plus a refund would pay out twice", async () => {
      for (const condition of [null, "pendingsettlement", "pending", "unknown"]) {
        const { svc } = makeService(NmiCardProviderService)
        const { transact } = lostVoid(svc, condition)
        await expect(svc.refundPayment(FULL)).rejects.toThrow(/outcome unknown/)
        expect(types(transact)).toEqual(["void"])
      }
    })

    it("treats the refund as done when NMI shows the transaction voided", async () => {
      const { svc } = makeService(NmiCardProviderService)
      const { transact } = lostVoid(svc, "canceled")
      const res = await svc.refundPayment(FULL)
      expect(types(transact)).toEqual(["void"])
      expect(res.data.voided).toBe(true)
      expect(res.data.refundId).toBe("tx_1")
    })

    it("refunds when NMI shows the transaction settled, which a void cannot have changed", async () => {
      const { svc } = makeService(NmiCardProviderService)
      const { transact } = lostVoid(svc, "complete")
      const res = await svc.refundPayment(FULL)
      expect(types(transact)).toEqual(["void", "refund"])
      expect(res.data.refundId).toBe("refund_1")
    })
  })

  it("surfaces the refund error when both the void and the refund are refused", async () => {
    const { svc } = makeService(NmiCardProviderService)
    failing(svc, (args) => {
      throw new Error(args.type === "refund" ? "refund refused" : "void refused")
    })
    await expect(svc.refundPayment(FULL)).rejects.toThrow("refund refused")
  })

  it("does not follow an unknown refund outcome with anything else", async () => {
    const { svc } = makeService(NmiCardProviderService)
    const { transact } = failing(svc, (args) => {
      if (args.type === "void") throw new Error("already settled")
      throw new NmiError("NMI refund outcome unknown", "3", undefined, undefined, true)
    })
    await expect(svc.refundPayment(FULL)).rejects.toThrow(/outcome unknown/)
    expect(types(transact)).toEqual(["void", "refund"])
  })

  it("voids and refunds an ACH payment as a check transaction", async () => {
    const { svc } = makeService(NmiAchProviderService)
    const { transact } = failing(svc, (args) => {
      if (args.type === "void") throw new Error("settled")
      return { response: "1", transactionid: "refund_1" }
    })
    await svc.refundPayment({
      amount: 100,
      data: { payment_method: "ach", transactionid: "tx_1", amount: 100 },
    })
    expect(transact.mock.calls[0][0]).toMatchObject({ type: "void", ach: {} })
    expect(transact.mock.calls[1][0]).toMatchObject({ type: "refund", ach: {} })
  })

  it.each([0, -1, "x"])("rejects an invalid refund amount (%s) without calling NMI", async (amount) => {
    const { svc, transact } = makeService(NmiCardProviderService)
    await expect(
      svc.refundPayment({ amount, data: { transactionid: "tx_1", amount: 100 } })
    ).rejects.toThrow(/invalid amount/)
    expect(transact).not.toHaveBeenCalled()
  })
})

describe("amount coercion", () => {
  it("refunds with a BigNumber-shaped amount (admin refunds)", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    // Medusa hands refund amounts as BigNumber instances; raw shape is
    // { value, precision } and the class exposes .numeric.
    await svc.refundPayment({
      amount: { numeric: 25.5, value: "25.5" },
      data: { transactionid: "tx_1" },
    })
    expect(transact).toHaveBeenCalledWith(
      expect.objectContaining({ type: "refund", amount: 25.5 })
    )
  })

  it("authorizes with a string amount without NaN", async () => {
    const { svc, transact } = makeService(NmiCardProviderService)
    await svc.authorizePayment({
      data: { payment_token: "tok", session_id: "ps", amount: "99.95" },
      context: {},
    })
    expect(transact).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 99.95 })
    )
  })
})

describe("webhook handling", () => {
  const SESSION = "payses_01TEST"
  const event = (type: string, body: Record<string, unknown>) =>
    JSON.stringify({ event_id: "evt_1", event_type: type, event_body: body })
  const signed = (raw: string, secret = "ws") => ({
    data: JSON.parse(raw),
    rawData: raw,
    headers: {
      "webhook-signature": `t=n1,s=${createHmac("sha256", secret).update(`n1.${raw}`).digest("hex")}`,
    },
  })
  const SETTLE = event("transaction.check.status.settle", {
    transaction_id: "1234560000",
    transaction_type: "ck",
    condition: "complete",
    order_id: SESSION,
    check: { sec_code: "WEB" },
    action: { amount: "54.04", action_type: "settle" },
  })

  it("captures on a verified ACH settlement, with the settled amount", async () => {
    const { svc } = makeService(NmiAchProviderService)
    const res = await svc.getWebhookActionAndData(signed(SETTLE))
    expect(res.action).toBe("captured")
    expect(res.data.session_id).toBe(SESSION)
    expect(Number(res.data.amount.numeric)).toBe(54.04)
  })

  it("accepts the raw body as a Buffer", async () => {
    const { svc } = makeService(NmiAchProviderService)
    const p = signed(SETTLE)
    const res = await svc.getWebhookActionAndData({ ...p, rawData: Buffer.from(SETTLE) })
    expect(res.action).toBe("captured")
  })

  it("leaves the amount out when the event states none, so Medusa captures in full", async () => {
    const { svc } = makeService(NmiAchProviderService)
    const raw = event("transaction.check.status.settle", { order_id: SESSION, check: {} })
    const res = await svc.getWebhookActionAndData(signed(raw))
    expect(res.action).toBe("captured")
    expect(res.data.amount).toBeUndefined()
  })

  it("reports an ACH return as failed", async () => {
    const { svc } = makeService(NmiAchProviderService)
    const raw = event("transaction.check.status.return", {
      order_id: SESSION, check: {}, action: { amount: "54.04" },
    })
    expect((await svc.getWebhookActionAndData(signed(raw))).action).toBe("failed")
  })

  it("ignores everything when no webhookSecret is configured", async () => {
    const { svc } = makeService(NmiAchProviderService, { webhookSecret: undefined })
    // Even a payload "signed" with an empty key must not get through.
    expect((await svc.getWebhookActionAndData(signed(SETTLE, ""))).action).toBe("not_supported")
    expect((await svc.getWebhookActionAndData(signed(SETTLE))).action).toBe("not_supported")
  })

  it("ignores a bad signature, an unsigned request and a tampered body", async () => {
    const { svc } = makeService(NmiAchProviderService)
    const good = signed(SETTLE)
    expect((await svc.getWebhookActionAndData(signed(SETTLE, "wrong"))).action).toBe("not_supported")
    expect(
      (await svc.getWebhookActionAndData({ ...good, headers: {} })).action
    ).toBe("not_supported")
    expect(
      (await svc.getWebhookActionAndData({ ...good, rawData: SETTLE.replace("54.04", "1.00") })).action
    ).toBe("not_supported")
  })

  it("acts on the verified bytes, not on a separately supplied parsed body", async () => {
    const { svc } = makeService(NmiAchProviderService)
    const p = signed(SETTLE)
    const forged = JSON.parse(SETTLE)
    forged.event_body.order_id = "payses_SOMEONE_ELSE"
    const res = await svc.getWebhookActionAndData({ ...p, data: forged })
    expect(res.data.session_id).toBe(SESSION)
  })

  it("ignores a request with no raw body rather than throwing", async () => {
    const { svc } = makeService(NmiAchProviderService)
    const p = signed(SETTLE)
    expect(
      (await svc.getWebhookActionAndData({ ...p, rawData: undefined })).action
    ).toBe("not_supported")
  })

  it("ignores card events even when correctly signed", async () => {
    const { svc } = makeService(NmiCardProviderService)
    for (const type of [
      "transaction.sale.success",
      "transaction.auth.success",
      "transaction.capture.success",
      "transaction.void.success",
    ]) {
      const raw = event(type, { order_id: SESSION, card: {}, action: { amount: "10.00" } })
      expect((await svc.getWebhookActionAndData(signed(raw))).action).toBe("not_supported")
    }
  })

  it("ignores a refund event: it has no order id and a negative amount", async () => {
    const { svc } = makeService(NmiCardProviderService)
    const raw = event("transaction.refund.success", {
      order_id: "", requested_amount: "-1.50", card: {}, action: { amount: "-1.50" },
    })
    expect((await svc.getWebhookActionAndData(signed(raw))).action).toBe("not_supported")
  })

  it("ignores events whose order id is not a Medusa payment session", async () => {
    // e.g. another system sharing the NMI account.
    const { svc } = makeService(NmiAchProviderService)
    const raw = event("transaction.check.status.settle", { order_id: "12345678", check: {} })
    expect((await svc.getWebhookActionAndData(signed(raw))).action).toBe("not_supported")
  })

  it("ignores a signed body that is not JSON", async () => {
    const { svc } = makeService(NmiAchProviderService)
    const p = signed(SETTLE)
    const raw = "not json"
    const sig = createHmac("sha256", "ws").update(`n1.${raw}`).digest("hex")
    expect(
      (await svc.getWebhookActionAndData({
        ...p, rawData: raw, headers: { "webhook-signature": `t=n1,s=${sig}` },
      })).action
    ).toBe("not_supported")
  })
})

describe("shared lifecycle", () => {
  it("initiatePayment exposes tokenizationKey and sandbox flag", async () => {
    const { svc } = makeService(NmiCardProviderService, { sandbox: true })
    const res = await svc.initiatePayment({
      amount: 100,
      currency_code: "usd",
      data: { session_id: "ps_1" },
    })
    expect(res.data.tokenizationKey).toBe("tk")
    expect(res.data.sandbox).toBe(true)
  })

  it("validateOptions rejects missing keys", () => {
    expect(() =>
      (NmiCardProviderService as any).validateOptions({ securityKey: "sk" })
    ).toThrow(/tokenizationKey/)
    expect(() =>
      (NmiCardProviderService as any).validateOptions({ tokenizationKey: "tk" })
    ).toThrow(/securityKey/)
  })

  it("reports canceled, captured, authorized and pending from the payment data", async () => {
    const { svc } = makeService(NmiCardProviderService)
    const status = async (data: Record<string, unknown>) =>
      (await svc.getPaymentStatus({ data })).status
    expect(await status({ transactionid: "1", canceled: true })).toBe("canceled")
    expect(await status({ transactionid: "1", refundId: "2", voided: true })).toBe("canceled")
    expect(await status({ transactionid: "1", captured: true })).toBe("captured")
    expect(await status({ transactionid: "1" })).toBe("authorized")
    expect(await status({})).toBe("pending")
  })

  it("updatePayment stores a plain number amount", async () => {
    const { svc } = makeService(NmiCardProviderService)
    const res = await svc.updatePayment({
      data: { session_id: "ps_1" },
      amount: { numeric: 42.5, value: "42.5" },
      currency_code: "usd",
    })
    expect(res.data.amount).toBe(42.5)
  })
})
