import { describe, it, expect } from "vitest"
import { toNmiBilling } from "./billing"

describe("toNmiBilling", () => {
  it("maps a Medusa billing address (session data shape) to NmiBilling", () => {
    const b = toNmiBilling({
      first_name: "Ada",
      last_name: "Lovelace",
      company: "Analytical Engines Ltd",
      address_1: "12 Analytical Way",
      address_2: "Suite 1",
      city: "Austin",
      province: "TX",
      postal_code: "78701",
      country_code: "us",
      phone: "+15125550100",
      email: "ada@example.com",
    })
    expect(b).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      company: "Analytical Engines Ltd",
      address1: "12 Analytical Way",
      address2: "Suite 1",
      city: "Austin",
      state: "TX",
      zip: "78701",
      country: "us",
      phone: "+15125550100",
      email: "ada@example.com",
    })
  })

  it("omits optional fields that are absent", () => {
    const b = toNmiBilling({
      first_name: "Ada",
      last_name: "Lovelace",
      address_1: "12 Analytical Way",
      city: "Austin",
      province: "TX",
      postal_code: "78701",
    })
    expect(b).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      address1: "12 Analytical Way",
      city: "Austin",
      state: "TX",
      zip: "78701",
    })
  })

  it("returns undefined when the address is missing entirely", () => {
    expect(toNmiBilling(undefined)).toBeUndefined()
    expect(toNmiBilling(null)).toBeUndefined()
  })

  it("returns undefined when required AVS fields are incomplete", () => {
    // No street/zip -> AVS has nothing meaningful to verify; no-op safely.
    expect(
      toNmiBilling({ first_name: "Ada", last_name: "Lovelace", city: "Austin" })
    ).toBeUndefined()
  })
})
