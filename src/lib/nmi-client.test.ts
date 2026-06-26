import { describe, it, expect } from "vitest"
import { parseTransactResponse, buildChargeParams } from "./nmi-client"

describe("parseTransactResponse", () => {
  it("parses NMI's URL-encoded response into fields", () => {
    const text =
      "response=1&responsetext=Approved&authcode=123456&transactionid=9999&response_code=100"
    const r = parseTransactResponse(text)
    expect(r.response).toBe("1")
    expect(r.transactionid).toBe("9999")
    expect(r.response_code).toBe("100")
    expect(r.responsetext).toBe("Approved")
  })
})

describe("buildChargeParams", () => {
  it("formats amount as dollars x.xx (no cents conversion) and includes correlation", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 49.9,
      paymentToken: "tok_1",
      sessionId: "ps_1",
    })
    expect(p.get("security_key")).toBe("sk")
    expect(p.get("type")).toBe("sale")
    expect(p.get("amount")).toBe("49.90")
    expect(p.get("payment_token")).toBe("tok_1")
    expect(p.get("orderid")).toBe("ps_1")
    expect(p.get("merchant_defined_field_1")).toBe("ps_1")
  })

  it("includes ACH fields when provided", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 10,
      paymentToken: "tok_ach",
      sessionId: "ps_2",
      ach: { secCode: "WEB", accountType: "checking", accountHolderType: "personal" },
    })
    expect(p.get("sec_code")).toBe("WEB")
    expect(p.get("account_type")).toBe("checking")
    expect(p.get("account_holder_type")).toBe("personal")
  })
})
