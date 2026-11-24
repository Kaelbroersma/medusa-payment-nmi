import { describe, it, expect } from "vitest"
import {
  NmiError,
  isRetryableCode,
  isAmbiguousCode,
  isRateLimitCode,
  assertApproved,
  buyerMessageFor,
} from "../src/lib/errors"

describe("NMI errors", () => {
  it("assertApproved passes when response === '1'", () => {
    expect(() => assertApproved({ response: "1", responsetext: "Approved", response_code: "100" })).not.toThrow()
  })

  it("assertApproved throws NmiError on decline (response '2')", () => {
    try {
      assertApproved({ response: "2", responsetext: "DECLINE", response_code: "200" })
      throw new Error("did not throw")
    } catch (e) {
      expect(e).toBeInstanceOf(NmiError)
      expect((e as NmiError).responseCode).toBe("200")
      expect((e as NmiError).message).toContain("DECLINE")
      expect((e as NmiError).outcomeUnknown).toBe(false)
    }
  })

  it("treats only the communication errors as ambiguous", () => {
    expect(isAmbiguousCode("420")).toBe(true) // communication error
    expect(isAmbiguousCode("421")).toBe(true) // communication error with issuer
    expect(isAmbiguousCode("200")).toBe(false) // hard decline
    expect(isRetryableCode("420")).toBe(true) // deprecated alias
  })

  it("no longer treats definitive processor errors as retryable", () => {
    // 430 duplicate at processor, 440 format error, 441 invalid transaction info:
    // the same request cannot succeed on a second try.
    for (const code of ["430", "431", "440", "441", "300", "301", "400"]) {
      expect(isAmbiguousCode(code)).toBe(false)
    }
  })

  it("recognises the rate limit code", () => {
    expect(isRateLimitCode("301")).toBe(true)
    expect(isRateLimitCode("300")).toBe(false)
  })
})

describe("buyerMessageFor", () => {
  const decline = (code: string, text: string) =>
    new NmiError(`NMI transaction declined: ${text}`, "2", code, {
      response: "2",
      responsetext: text,
      response_code: code,
    })

  it("never repeats the gateway text to the buyer", () => {
    for (const [code, text] of [
      ["250", "PICK UP CARD"],
      ["251", "LOST CARD"],
      ["252", "STOLEN CARD"],
      ["253", "FRAUDULENT CARD"],
      ["200", "DECLINE"],
    ]) {
      const msg = buyerMessageFor(decline(code, text))
      expect(msg).not.toContain(text)
      expect(msg.toLowerCase()).not.toMatch(/stolen|lost|fraud|pick up/)
      expect(msg).toMatch(/declined/i)
    }
  })

  it("gives a useful reason where one is safe to give", () => {
    expect(buyerMessageFor(decline("202", "INSUFFICIENT FUNDS"))).toMatch(/insufficient funds/i)
    expect(buyerMessageFor(decline("223", "EXPIRED CARD"))).toMatch(/expir/i)
    expect(buyerMessageFor(decline("225", "INVALID CVV"))).toMatch(/security code/i)
  })

  it("keeps gateway errors (response '3') generic", () => {
    const err = new NmiError("NMI transaction error: Invalid merchant configuration", "3", "410")
    const msg = buyerMessageFor(err)
    expect(msg).not.toMatch(/merchant|declined/i)
    expect(msg).toMatch(/could not process/i)
  })

  it("tells the buyer not to retry when the outcome is unknown", () => {
    const err = new NmiError("NMI sale outcome unknown", "3", undefined, undefined, true)
    expect(buyerMessageFor(err)).toMatch(/do not try again/i)
  })

  it("asks the buyer to wait on a rate limit", () => {
    const err = new NmiError("NMI transaction error: Rate limit exceeded", "3", "301")
    expect(buyerMessageFor(err)).toMatch(/wait/i)
  })

  it("flags a duplicate rather than inviting another attempt", () => {
    const err = decline("300", "Duplicate transaction REFID:123")
    const msg = buyerMessageFor(err)
    expect(msg).toMatch(/contact us/i)
    // A deliberate second order is legitimate: tell the buyer what will work.
    expect(msg).toMatch(/wait a few minutes and try again/i)
    expect(msg).not.toContain("REFID")
  })

  it("blames the card details for a gateway reject only when it was an AVS or CVV rule", () => {
    const avs = new NmiError("NMI transaction error: AVS REJECTED", "3", "300", {
      response: "3",
      responsetext: "AVS REJECTED",
      response_code: "300",
    })
    expect(buyerMessageFor(avs)).toMatch(/billing address/i)
    // A misconfigured API key also answers 300. That is not the buyer's card.
    const auth = new NmiError("NMI transaction error: Authentication Failed", "3", "300", {
      response: "3",
      responsetext: "Authentication Failed",
      response_code: "300",
    })
    expect(buyerMessageFor(auth)).not.toMatch(/card|address/i)
  })

  it("speaks about the bank account for ACH", () => {
    expect(buyerMessageFor(decline("200", "DECLINE"), "ach")).toMatch(/bank payment/i)
  })

  it("handles a non-NMI error", () => {
    expect(buyerMessageFor(new Error("boom"))).toMatch(/could not process/i)
  })
})
