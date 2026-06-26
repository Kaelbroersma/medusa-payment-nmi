import { describe, it, expect } from "vitest"
import { createHmac } from "crypto"
import {
  parseSignatureHeader,
  verifySignature,
  extractSessionId,
  mapCardEvent,
  mapAchEvent,
} from "./webhook"

const SECRET = "whsec_test_123"
const NONCE = "1700000000"
const BODY = JSON.stringify({ event_type: "transaction.sale.success", event_body: { transaction_id: "99" } })
const SIG = createHmac("sha256", SECRET).update(`${NONCE}.${BODY}`).digest("hex")
const HEADER = `t=${NONCE},s=${SIG}`

describe("NMI webhook signature", () => {
  it("parses t=<nonce>,s=<sig> header", () => {
    expect(parseSignatureHeader(HEADER)).toEqual({ nonce: NONCE, signature: SIG })
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
  it("returns empty string when absent", () => {
    expect(extractSessionId({})).toBe("")
  })
})

describe("card event mapping", () => {
  it("maps auth/sale/capture/refund/void", () => {
    expect(mapCardEvent("transaction.auth.success", {})).toBe("authorized")
    expect(mapCardEvent("transaction.sale.success", {})).toBe("captured")
    expect(mapCardEvent("transaction.capture.success", {})).toBe("captured")
    expect(mapCardEvent("transaction.refund.success", {})).toBe("captured")
    expect(mapCardEvent("transaction.void.success", {})).toBe("canceled")
  })
  it("ignores ACH (check) events and unknown types", () => {
    expect(mapCardEvent("transaction.sale.success", { check: {} })).toBeNull()
    expect(mapCardEvent("transaction.sale.failure", {})).toBeNull()
  })
})

describe("ach event mapping", () => {
  it("maps sale (accepted) → authorized, settlement/refund → captured, failure → failed", () => {
    expect(mapAchEvent("transaction.sale.success", {})).toBe("authorized")
    expect(mapAchEvent("settlement.batch.complete", {})).toBe("captured")
    expect(mapAchEvent("transaction.refund.success", {})).toBe("captured")
    expect(mapAchEvent("transaction.sale.failure", {})).toBe("failed")
    expect(mapAchEvent("transaction.void.success", {})).toBe("canceled")
  })
  it("ignores card events and unknown types", () => {
    expect(mapAchEvent("transaction.sale.success", { card: {} })).toBeNull()
    expect(mapAchEvent("transaction.auth.success", {})).toBeNull()
  })
})
