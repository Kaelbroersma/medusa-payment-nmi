import { describe, it, expect } from "vitest"
import { createHmac } from "crypto"
import {
  parseSignatureHeader,
  verifySignature,
  extractSessionId,
  isMedusaSessionId,
  mapNmiEvent,
  classifyAchEvent,
} from "../src/lib/webhook"

const SECRET = "whsec_test_123"
const NONCE = "1700000000"
const BODY = JSON.stringify({ event_type: "transaction.sale.success", event_body: { transaction_id: "99" } })
const SIG = createHmac("sha256", SECRET).update(`${NONCE}.${BODY}`).digest("hex")
const HEADER = `t=${NONCE},s=${SIG}`

describe("NMI webhook signature", () => {
  it("parses t=<nonce>,s=<sig> header", () => {
    expect(parseSignatureHeader(HEADER)).toEqual({ nonce: NONCE, signature: SIG })
  })

  it("keeps a value that itself contains '='", () => {
    expect(parseSignatureHeader("t=abc==,s=def=")).toEqual({ nonce: "abc==", signature: "def=" })
  })

  it("verifies a correct signature over nonce + '.' + body", () => {
    expect(verifySignature(SECRET, BODY, HEADER)).toBe(true)
  })

  it("rejects a tampered body", () => {
    expect(verifySignature(SECRET, BODY + "x", HEADER)).toBe(false)
  })

  it("rejects a wrong secret", () => {
    expect(verifySignature("nope", BODY, HEADER)).toBe(false)
  })

  it("rejects a missing/garbage header", () => {
    expect(verifySignature(SECRET, BODY, undefined)).toBe(false)
    expect(verifySignature(SECRET, BODY, "garbage")).toBe(false)
    expect(verifySignature(SECRET, BODY, ["x"] as any)).toBe(false)
  })

  it("never verifies without a secret, and does not throw", () => {
    // createHmac throws on an undefined key; an unset secret must simply fail.
    expect(verifySignature(undefined, BODY, HEADER)).toBe(false)
    expect(verifySignature("", BODY, HEADER)).toBe(false)
    // Not even a signature computed with an empty key is accepted.
    const emptySig = createHmac("sha256", "").update(`${NONCE}.${BODY}`).digest("hex")
    expect(verifySignature("", BODY, `t=${NONCE},s=${emptySig}`)).toBe(false)
  })
})

describe("session id extraction", () => {
  it("reads order_id first", () => {
    expect(extractSessionId({ order_id: "ps_1" })).toBe("ps_1")
  })
  it("falls back to merchant_defined_field_1 / merchant_defined_fields", () => {
    expect(extractSessionId({ merchant_defined_field_1: "ps_2" })).toBe("ps_2")
    expect(extractSessionId({ merchant_defined_fields: { "1": "ps_3" } })).toBe("ps_3")
  })
  it("falls back past an empty order_id, which NMI sends as \"\"", () => {
    expect(extractSessionId({ order_id: "", merchant_defined_fields: { "1": "ps_4" } })).toBe("ps_4")
  })
  it("returns empty string when absent", () => {
    expect(extractSessionId({})).toBe("")
    expect(extractSessionId({ order_id: "" })).toBe("")
  })
  it("recognises Medusa payment session ids", () => {
    expect(isMedusaSessionId("payses_01JABC")).toBe(true)
    expect(isMedusaSessionId("12345678")).toBe(false)
    expect(isMedusaSessionId("")).toBe(false)
  })
})

describe("nmi event mapping", () => {
  it("ach settlement → captured; ach return and late return → failed", () => {
    expect(mapNmiEvent("transaction.check.status.settle", { check: {} })).toBe("captured")
    expect(mapNmiEvent("transaction.check.status.return", { check: {} })).toBe("failed")
    expect(mapNmiEvent("transaction.check.status.latereturn", { check: {} })).toBe("failed")
  })

  it("ignores every synchronous card event", () => {
    for (const type of [
      "transaction.sale.success",
      "transaction.auth.success",
      "transaction.capture.success",
      "transaction.refund.success",
      "transaction.void.success",
      "transaction.sale.failure",
    ]) {
      expect(mapNmiEvent(type, { card: {} })).toBeNull()
    }
  })

  it("ignores the ACH submission event: the checkout request already has the answer", () => {
    expect(mapNmiEvent("transaction.sale.success", { check: {} })).toBeNull()
  })

  it("never turns a refund or a void into a capture or a cancel", () => {
    expect(mapNmiEvent("transaction.refund.success", {})).toBeNull()
    expect(mapNmiEvent("transaction.refund.success", { check: {} })).toBeNull()
    expect(mapNmiEvent("transaction.void.success", {})).toBeNull()
    expect(mapNmiEvent("transaction.void.success", { check: {} })).toBeNull()
  })

  it("ignores settlement.batch.complete, which carries no order id", () => {
    expect(mapNmiEvent("settlement.batch.complete", { check: {} })).toBeNull()
    expect(mapNmiEvent("settlement.batch.complete", {})).toBeNull()
  })

  it("classifies the ach lifecycle for reconciliation subscribers", () => {
    expect(classifyAchEvent("transaction.check.status.settle")).toBe("settled")
    expect(classifyAchEvent("transaction.check.status.return")).toBe("returned")
    expect(classifyAchEvent("transaction.check.status.latereturn")).toBe("late_returned")
    expect(classifyAchEvent("transaction.sale.success")).toBeNull()
    expect(classifyAchEvent("settlement.batch.complete")).toBeNull()
  })

  it("ach submission rejection (sale.failure) → failed; unknown → null", () => {
    expect(mapNmiEvent("transaction.sale.failure", { check: {} })).toBe("failed")
    expect(mapNmiEvent("transaction.unknown.x", {})).toBeNull()
  })
})
