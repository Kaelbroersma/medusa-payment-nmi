import { describe, it, expect } from "vitest"
import { NmiError, isRetryableCode, assertApproved } from "./errors"

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
    }
  })

  it("classifies gateway/timeout codes as retryable", () => {
    expect(isRetryableCode("420")).toBe(true)  // communication error
    expect(isRetryableCode("421")).toBe(true)  // communication error with issuer
    expect(isRetryableCode("200")).toBe(false) // hard decline
  })
})
