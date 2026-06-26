/**
 * Per-merchant NMI configuration. NMI uses two distinct keys:
 *  - securityKey:     PRIVATE API key for server-side Payment API (transact.php).
 *  - tokenizationKey: PUBLIC Collect.js key, safe to send to the browser.
 *  - webhookSecret:   the signing key from Merchant Portal > Settings > Webhooks.
 */
export interface NmiCardOptions {
  /** Private API security key (transact.php `security_key`). */
  securityKey: string
  /** Public Collect.js tokenization key (sent to the storefront). */
  tokenizationKey: string
  /** Webhook signing key (HMAC-SHA256). */
  webhookSecret: string
  /** "auth" = authorize then capture later; "sale" = auth + capture together. Default "auth". */
  captureMethod?: "auth" | "sale"
  /** Use the NMI sandbox host. */
  sandbox?: boolean
}

export interface NmiAchOptions {
  /** Private API security key. */
  securityKey: string
  /** Public Collect.js tokenization key. */
  tokenizationKey: string
  /** Webhook signing key (HMAC-SHA256). */
  webhookSecret: string
  /** NMI `sec_code`. Default "WEB" (internet-initiated consumer debit). */
  secCode?: "PPD" | "CCD" | "WEB" | "TEL"
  /** Use the NMI sandbox host. */
  sandbox?: boolean
}

/** Payment API (Direct Post) hosts. */
export const TRANSACT_HOSTS = {
  prod: "https://secure.nmi.com",
  sandbox: "https://sandbox.nmi.com",
} as const

/** Collect.js is always served from securepay.nmi.com; the tokenization key selects the env. */
export const COLLECT_SCRIPT_URL = "https://securepay.nmi.com/collect.js"

/** transact.php `response` field. */
export type NmiResponseCode = "1" | "2" | "3" // 1 approved, 2 declined, 3 error
