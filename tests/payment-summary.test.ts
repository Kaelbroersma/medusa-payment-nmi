import { describe, it, expect } from "vitest"
import {
  isNmiPayment,
  summarizeNmiPayment,
  describeAvs,
  describeCvv,
} from "../src/lib/payment-summary"

const CARD = {
  payment_method: "card",
  transactionid: "12846959106",
  authcode: "123456",
  avs_response: "Y",
  cvv_response: "M",
  card_type: "visa",
  card_last4: "1111",
  amount: 486.87,
}
const pay = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  id: "pay_1",
  provider_id: "pp_nmi-card",
  amount: 486.87,
  currency_code: "usd",
  captured_at: "2026-11-24T20:00:00Z",
  refunds: [],
  ...over,
  data: { ...CARD, ...data },
})

describe("isNmiPayment", () => {
  it("matches every variant, including a suffixed provider id", () => {
    for (const id of ["pp_nmi", "pp_nmi-card", "pp_nmi-ach", "pp_nmi-wallet", "pp_nmi-card_primary"]) {
      expect(isNmiPayment({ provider_id: id })).toBe(true)
    }
  })
  it("ignores other providers and missing payments", () => {
    expect(isNmiPayment({ provider_id: "pp_stripe_stripe" })).toBe(false)
    expect(isNmiPayment({ provider_id: "pp_system_default" })).toBe(false)
    expect(isNmiPayment(null)).toBe(false)
    expect(isNmiPayment({})).toBe(false)
  })
})

describe("summarizeNmiPayment", () => {
  it("describes a plain charge", () => {
    const s = summarizeNmiPayment(pay())
    expect(s.state).toBe("charged")
    expect(s.label).toBe("Charged")
    expect(s.card).toBe("Visa ending 1111")
    expect(s.transactionId).toBe("12846959106")
    expect(s.authCode).toBe("123456")
    expect(s.avs?.text).toMatch(/address and ZIP match/i)
    expect(s.cvv?.text).toMatch(/matches/i)
    expect(s.recovered).toBe(false)
  })

  it("says VOID, not refund, when a same-day full refund was reversed by void", () => {
    // What Medusa holds after 0.5.1's void-first refund: a refund row for the full
    // amount, and voided + refundId (the sale's own id) on the payment data.
    const s = summarizeNmiPayment(
      pay({ refunds: [{ amount: 486.87 }] }, { voided: true, refundId: "12846959106" })
    )
    expect(s.state).toBe("voided")
    expect(s.label).toBe("Voided")
    expect(s.detail).toMatch(/voided the charge instead/i)
    expect(s.detail).toMatch(/nothing will settle/i)
    // The sale id must not be presented as a refund transaction.
    expect(s.refundId).toBeUndefined()
  })

  it("describes a cancelled (voided) authorization", () => {
    const s = summarizeNmiPayment(
      pay({ captured_at: null, canceled_at: "2026-11-24T21:00:00Z" }, { canceled: true })
    )
    expect(s.state).toBe("voided")
    expect(s.detail).toMatch(/voided before settlement/i)
  })

  it("flags a cancellation whose void NMI refused", () => {
    const s = summarizeNmiPayment(
      pay({}, { canceled: true, void_failed: true, void_error: "Transaction already returned" })
    )
    expect(s.state).toBe("void_failed")
    expect(s.tone).toBe("red")
    expect(s.detail).toContain("Transaction already returned")
  })

  it("describes a full refund of a settled charge, with the refund id", () => {
    const s = summarizeNmiPayment(
      pay({ refunds: [{ amount: 486.87 }] }, { refundId: "12846925394" })
    )
    expect(s.state).toBe("refunded")
    expect(s.refundId).toBe("12846925394")
    expect(s.detail).toMatch(/separate credit/i)
  })

  it("describes partial refunds and totals them", () => {
    const s = summarizeNmiPayment(
      pay(
        { amount: 248.87, refunds: [{ amount: 48.87 }, { amount: { value: "200", precision: 20 } }] },
        { amount: 248.87, refundId: "999" }
      )
    )
    // 48.87 + 200.00 = 248.87: the two partials add up to the whole.
    expect(s.state).toBe("refunded")
    expect(s.refundedAmount).toBeCloseTo(248.87)

    const partial = summarizeNmiPayment(
      pay({ amount: 248.87, refunds: [{ amount: 48.87 }] }, { amount: 248.87, refundId: "998" })
    )
    expect(partial.state).toBe("partially_refunded")
    expect(partial.label).toBe("Partially refunded")
  })

  it("describes an uncaptured authorization", () => {
    expect(summarizeNmiPayment(pay({ captured_at: null })).state).toBe("authorized")
  })

  it("describes the ACH lifecycle without card fields", () => {
    const ach = { payment_method: "ach", card_type: undefined, card_last4: undefined }
    const pending = summarizeNmiPayment(pay({ provider_id: "pp_nmi-ach", captured_at: null }, ach))
    expect(pending.state).toBe("ach_pending")
    expect(pending.method).toBe("ach")
    expect(pending.card).toBeUndefined()
    expect(pending.cvv).toBeUndefined()
    const settled = summarizeNmiPayment(pay({ provider_id: "pp_nmi-ach" }, ach))
    expect(settled.state).toBe("ach_settled")
    expect(settled.detail).toMatch(/60 days/)
  })

  it("notes a charge that was confirmed through the Query API", () => {
    const s = summarizeNmiPayment(pay({}, { raw: { recovered: "query" } }))
    expect(s.recovered).toBe(true)
  })

  it("copes with a payment that never reached NMI, or has no data", () => {
    expect(summarizeNmiPayment({ provider_id: "pp_nmi-card", data: null }).state).toBe("none")
    expect(summarizeNmiPayment(pay({}, { transactionid: undefined })).state).toBe("none")
  })

  it("omits the card line when the storefront recorded no card details", () => {
    const s = summarizeNmiPayment(pay({}, { card_type: undefined, card_last4: undefined }))
    expect(s.card).toBeUndefined()
  })
})

describe("AVS and CVV in plain words", () => {
  it("groups AVS codes by what matched", () => {
    expect(describeAvs("Y")?.tone).toBe("green")
    expect(describeAvs("x")?.text).toMatch(/address and ZIP match/i)
    expect(describeAvs("A")?.text).toMatch(/ZIP does not/i)
    expect(describeAvs("Z")?.text).toMatch(/street address does not/i)
    expect(describeAvs("N")?.tone).toBe("red")
    expect(describeAvs("U")?.tone).toBe("grey")
  })
  it("still shows an unrecognised code rather than hiding it", () => {
    expect(describeAvs("Q")?.text).toContain("Q")
    expect(describeCvv("Q")?.text).toContain("Q")
  })
  it("returns nothing when there is no code", () => {
    expect(describeAvs("")).toBeUndefined()
    expect(describeAvs(undefined)).toBeUndefined()
    expect(describeCvv(null)).toBeUndefined()
  })
  it("explains CVV results", () => {
    expect(describeCvv("M")?.tone).toBe("green")
    expect(describeCvv("N")?.tone).toBe("red")
    expect(describeCvv("P")?.text).toMatch(/not checked/i)
  })
})
