/**
 * NMI transact.php returns a flat set of fields. We classify the outcome:
 *   response: "1" approved | "2" declined | "3" error
 *   response_code: numeric reason (100 = approved; 4xx = gateway/processing).
 * See https://docs.nmi.com/reference/transactions-processing
 */
export interface NmiTransactResult {
  response: string
  responsetext?: string
  response_code?: string
  transactionid?: string
  authcode?: string
  [k: string]: string | undefined
}

export class NmiError extends Error {
  constructor(
    message: string,
    readonly response: string,
    readonly responseCode?: string,
    readonly raw?: NmiTransactResult
  ) {
    super(message)
    this.name = "NmiError"
  }
}

// 4xx response_codes are gateway/communication failures worth retrying.
const RETRYABLE = new Set(["420", "421", "430", "431", "440", "441"])

export function isRetryableCode(code?: string): boolean {
  return code ? RETRYABLE.has(code) : false
}

/** Throw if NMI did not approve (response !== "1"). */
export function assertApproved(r: NmiTransactResult): void {
  if (r.response !== "1") {
    throw new NmiError(
      `NMI transaction ${r.response === "2" ? "declined" : "error"}: ${r.responsetext ?? "unknown"}`,
      r.response,
      r.response_code,
      r
    )
  }
}
