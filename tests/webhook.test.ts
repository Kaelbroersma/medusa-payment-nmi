import { describe, it, expect } from "vitest"
import { createHmac } from "crypto"
import {
  parseSignatureHeader,
  verifySignature,
  extractSessionId,
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

describe("nmi event mapping", () => {
  it("card sale → captured; ach sale → authorized", () => {
    expect(mapNmiEvent("transaction.sale.success", { card: {} })).toBe("captured")
    expect(mapNmiEvent("transaction.sale.success", { check: {} })).toBe("authorized")
  })
  it("auth → authorized; capture/refund → captured; void → canceled", () => {
    expect(mapNmiEvent("transaction.auth.success", {})).toBe("authorized")
    expect(mapNmiEvent("transaction.capture.success", {})).toBe("captured")
    expect(mapNmiEvent("transaction.refund.success", {})).toBe("captured")
    expect(mapNmiEvent("transaction.void.success", {})).toBe("canceled")
  })
  it("ach settlement → captured; ach return and late return → failed", () => {
    expect(mapNmiEvent("transaction.check.status.settle", { check: {} })).toBe("captured")
    expect(mapNmiEvent("transaction.check.status.return", { check: {} })).toBe("failed")
    expect(mapNmiEvent("transaction.check.status.latereturn", { check: {} })).toBe("failed")
  })
  it("still maps settlement.batch.complete → captured (core drops it if it has no order_id)", () => {
    expect(mapNmiEvent("settlement.batch.complete", { check: {} })).toBe("captured")
  })
  it("classifies the ach lifecycle for reconciliation subscribers", () => {
    expect(classifyAchEvent("transaction.check.status.settle")).toBe("settled")
    expect(classifyAchEvent("transaction.check.status.return")).toBe("returned")
    expect(classifyAchEvent("transaction.check.status.latereturn")).toBe("late_returned")
    expect(classifyAchEvent("transaction.sale.success")).toBeNull()
    expect(classifyAchEvent("settlement.batch.complete")).toBeNull()
  })
  it("ach submission rejection (sale.failure) → failed; card sale.failure → null; unknown → null", () => {
    expect(mapNmiEvent("transaction.sale.failure", { check: {} })).toBe("failed")
    expect(mapNmiEvent("transaction.sale.failure", { card: {} })).toBeNull()
    expect(mapNmiEvent("transaction.unknown.x", {})).toBeNull()
  })
})
