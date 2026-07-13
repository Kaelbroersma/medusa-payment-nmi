import { describe, it, expect, vi } from "vitest"
import { NmiProviderService } from "../src/providers/nmi"
import { NmiCardProviderService } from "../src/providers/nmi-card"
import { NmiAchProviderService } from "../src/providers/nmi-ach"
import { NmiWalletProviderService } from "../src/providers/nmi-wallet"

const OPTS = {
  securityKey: "sk",
  tokenizationKey: "tk",
  webhookSecret: "ws",
}

function makeService<T>(Ctor: new (c: any, o: any) => T, opts: Record<string, unknown> = {}): {
  svc: T
  transact: ReturnType<typeof vi.fn>
} {
  const svc = new Ctor({}, { ...OPTS, ...opts }) as any
  const transact = vi.fn(async (args: any) => ({
    response: "1",
    transactionid: "tx_1",
    authcode: "auth_1",
    avsresponse: "Y",
    cvvresponse: "M",
    ...args,
  }))
  svc.client = { transact }
  return { svc, transact }
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
  })

  it("treats capture as a no-op for ach payments", async () => {
    const { svc, transact } = makeService(NmiAchProviderService)
    const res = await svc.capturePayment({ data: { payment_method: "ach", transactionid: "tx_1" } })
    expect(transact).not.toHaveBeenCalled()
    expect(res.data.payment_method).toBe("ach")
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
  })
})
