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

  it("emits NMI AVS keys when billing is provided", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 25,
      paymentToken: "tok_3",
      sessionId: "ps_3",
      billing: {
        firstName: "Ada",
        lastName: "Lovelace",
        address1: "12 Analytical Way",
        city: "Austin",
        state: "TX",
        zip: "78701",
        country: "us",
      },
    })
    expect(p.get("firstname")).toBe("Ada")
    expect(p.get("lastname")).toBe("Lovelace")
    expect(p.get("address1")).toBe("12 Analytical Way")
    expect(p.get("city")).toBe("Austin")
    expect(p.get("state")).toBe("TX")
    expect(p.get("zip")).toBe("78701")
  })

  it("normalizes country to an upper-case 2-char code", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 25,
      paymentToken: "tok_4",
      billing: {
        firstName: "Ada",
        lastName: "Lovelace",
        address1: "12 Analytical Way",
        city: "Austin",
        state: "TX",
        zip: "78701",
        country: "us",
      },
    })
    expect(p.get("country")).toBe("US")
  })

  it("includes optional billing fields only when present", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 25,
      paymentToken: "tok_5",
      billing: {
        firstName: "Ada",
        lastName: "Lovelace",
        company: "Analytical Engines Ltd",
        address1: "12 Analytical Way",
        address2: "Suite 1",
        city: "Austin",
        state: "TX",
        zip: "78701",
        email: "ada@example.com",
        phone: "+15125550100",
      },
    })
    expect(p.get("company")).toBe("Analytical Engines Ltd")
    expect(p.get("address2")).toBe("Suite 1")
    expect(p.get("email")).toBe("ada@example.com")
    expect(p.get("phone")).toBe("+15125550100")
  })

  it("omits absent optional billing fields and country when not given", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 25,
      paymentToken: "tok_6",
      billing: {
        firstName: "Ada",
        lastName: "Lovelace",
        address1: "12 Analytical Way",
        city: "Austin",
        state: "TX",
        zip: "78701",
      },
    })
    expect(p.has("company")).toBe(false)
    expect(p.has("address2")).toBe(false)
    expect(p.has("email")).toBe(false)
    expect(p.has("phone")).toBe(false)
    expect(p.has("country")).toBe(false)
  })

  it("never emits billing keys when no billing is provided", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 25,
      paymentToken: "tok_7",
    })
    expect(p.has("firstname")).toBe(false)
    expect(p.has("address1")).toBe(false)
    expect(p.has("zip")).toBe(false)
  })
})
