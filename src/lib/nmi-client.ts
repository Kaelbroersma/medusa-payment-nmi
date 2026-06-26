import { TRANSACT_HOSTS } from "../types"
import { assertApproved, isRetryableCode, NmiError, NmiTransactResult } from "./errors"

export interface ChargeParamsInput {
  securityKey: string
  type: "sale" | "auth" | "capture" | "refund" | "void"
  amount?: number
  paymentToken?: string
  transactionId?: string
  sessionId?: string
  ach?: {
    secCode?: "PPD" | "CCD" | "WEB" | "TEL"
    accountType?: "checking" | "savings"
    accountHolderType?: "personal" | "business"
  }
}

/** Parse NMI's URL-encoded transact.php response into a flat object. */
export function parseTransactResponse(text: string): NmiTransactResult {
  const params = new URLSearchParams(text)
  const out: NmiTransactResult = { response: params.get("response") ?? "3" }
  for (const [k, v] of params.entries()) out[k] = v
  return out
}

/** Build the form body for a transact.php request. Amount is dollars x.xx. */
export function buildChargeParams(input: ChargeParamsInput): URLSearchParams {
  const p = new URLSearchParams()
  p.set("security_key", input.securityKey)
  p.set("type", input.type)
  if (input.amount != null) p.set("amount", input.amount.toFixed(2))
  if (input.paymentToken) p.set("payment_token", input.paymentToken)
  if (input.transactionId) p.set("transactionid", input.transactionId)
  if (input.sessionId) {
    p.set("orderid", input.sessionId)
    p.set("merchant_defined_field_1", input.sessionId)
  }
  if (input.ach) {
    if (input.ach.secCode) p.set("sec_code", input.ach.secCode)
    if (input.ach.accountType) p.set("account_type", input.ach.accountType)
    if (input.ach.accountHolderType) p.set("account_holder_type", input.ach.accountHolderType)
  }
  return p
}

/** Thin client over NMI Direct Post (transact.php). */
export class NmiClient {
  private readonly base: string
  constructor(private readonly securityKey: string, sandbox?: boolean) {
    this.base = (sandbox ? TRANSACT_HOSTS.sandbox : TRANSACT_HOSTS.prod) + "/api/transact.php"
  }

  /** Run a transaction; throws NmiError unless approved. */
  async transact(input: Omit<ChargeParamsInput, "securityKey">): Promise<NmiTransactResult> {
    const params = buildChargeParams({ ...input, securityKey: this.securityKey })
    const result = await this.post(params)
    assertApproved(result)
    return result
  }

  private async post(params: URLSearchParams, attempt = 0): Promise<NmiTransactResult> {
    let resp: Response
    try {
      resp = await fetch(this.base, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      })
    } catch (e) {
      if (attempt < 2) return this.post(params, attempt + 1)
      throw new NmiError(`Network error calling NMI: ${String(e)}`, "3")
    }
    const text = await resp.text()
    if (resp.status >= 500 && attempt < 2) {
      await delay(2 ** attempt * 500)
      return this.post(params, attempt + 1)
    }
    const result = parseTransactResponse(text)
    if (isRetryableCode(result.response_code) && attempt < 2) {
      await delay(2 ** attempt * 500)
      return this.post(params, attempt + 1)
    }
    return result
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
