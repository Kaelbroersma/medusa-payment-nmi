import { createHmac, timingSafeEqual } from "crypto"

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

/** Medusa payment action returned from getWebhookActionAndData. */
export type NmiAction = "authorized" | "captured" | "canceled" | "failed"

/**
 * Map an NMI webhook event to a Medusa action for the unified provider.
 * Card and ACH are disambiguated by `event_body.check` (ACH) vs `event_body.card`.
 * A card `sale.success` is a synchronous capture; an ACH `sale.success` is only
 * an accepted submission (authorized) — settlement arrives later. ACH returns come
 * through as `sale.failure`.
 */
export function mapNmiEvent(
  eventType: string,
  eventBody: Record<string, any>
): NmiAction | null {
  const ach = !!eventBody.check
  switch (eventType) {
    case "transaction.auth.success": return "authorized"
    case "transaction.sale.success": return ach ? "authorized" : "captured"
    case "transaction.capture.success": return "captured"
    case "settlement.batch.complete": return "captured"
    case "transaction.refund.success": return "captured"
    case "transaction.void.success": return "canceled"
    case "transaction.sale.failure": return ach ? "failed" : null
    default: return null
  }
}
