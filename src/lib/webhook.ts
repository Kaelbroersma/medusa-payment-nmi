import { createHmac, timingSafeEqual } from "crypto"

/** Medusa payment action strings returned from getWebhookActionAndData. */
export type CardAction = "authorized" | "captured" | "canceled"
export type AchAction = "authorized" | "captured" | "canceled" | "failed"

/** Parse `Webhook-Signature: t=<nonce>,s=<sig>`. */
export function parseSignatureHeader(
  header: string | undefined
): { nonce: string; signature: string } | null {
  if (!header) return null
  let nonce = "", signature = ""
  for (const part of header.split(",")) {
    const [k, v] = part.split("=")
    if (k?.trim() === "t") nonce = v?.trim() ?? ""
    if (k?.trim() === "s") signature = v?.trim() ?? ""
  }
  if (!nonce || !signature) return null
  return { nonce, signature }
}

/** Verify HMAC-SHA256(nonce + "." + rawBody, secret) against the header signature. */
export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | undefined
): boolean {
  const parsed = parseSignatureHeader(header)
  if (!parsed) return false
  const expected = createHmac("sha256", secret)
    .update(`${parsed.nonce}.${rawBody}`)
    .digest("hex")
  if (expected.length !== parsed.signature.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.signature))
}

/**
 * Recover the Medusa payment session id we stamped on the transaction.
 * We send it as both `orderid` and `merchant_defined_field_1`, so read either.
 */
export function extractSessionId(eventBody: Record<string, any>): string {
  return (
    eventBody.order_id ??
    eventBody.order?.order_id ??
    eventBody.merchant_defined_field_1 ??
    eventBody.merchant_defined_fields?.["1"] ??
    ""
  )
}

const isAch = (b: Record<string, any>) => !!b.check
const isCard = (b: Record<string, any>) => !!b.card

/** Card webhook is a reconciliation backstop (card auth is synchronous). */
export function mapCardEvent(
  eventType: string,
  eventBody: Record<string, any>
): CardAction | null {
  if (isAch(eventBody)) return null // not our rail
  switch (eventType) {
    case "transaction.auth.success": return "authorized"
    case "transaction.sale.success":
    case "transaction.capture.success":
    case "transaction.refund.success": return "captured"
    case "transaction.void.success": return "canceled"
    default: return null
  }
}

/** ACH webhook is the PRIMARY capture/fail signal (settlement is async). */
export function mapAchEvent(
  eventType: string,
  eventBody: Record<string, any>
): AchAction | null {
  if (isCard(eventBody)) return null // not our rail
  switch (eventType) {
    case "transaction.sale.success": return "authorized" // accepted, not yet settled
    case "settlement.batch.complete":
    case "transaction.refund.success": return "captured"
    case "transaction.sale.failure": return "failed" // includes ACH returns
    case "transaction.void.success": return "canceled"
    default: return null
  }
}
