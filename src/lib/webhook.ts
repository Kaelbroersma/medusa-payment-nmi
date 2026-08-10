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
 * The real ACH lifecycle, which Medusa's card-shaped payment status cannot express.
 * `settled` is not final: an unauthorized return can arrive up to 60 days later, and a
 * late return after that. Medusa records `settled` as `captured` and has no state at all
 * for the returns, so anything that depends on an ACH debit actually sticking has to read
 * this rather than the payment status.
 */
export type AchState = "settled" | "returned" | "late_returned"

/**
 * Classify an NMI event as an ACH lifecycle transition, or null if it is not one.
 * Exported so a `payment.webhook_received` subscriber can react to returns, which
 * Medusa core drops before the payment workflow runs.
 */
export function classifyAchEvent(eventType: string): AchState | null {
  switch (eventType) {
    case "transaction.check.status.settle": return "settled"
    case "transaction.check.status.return": return "returned"
    case "transaction.check.status.latereturn": return "late_returned"
    default: return null
  }
}

/**
 * Map an NMI webhook event to a Medusa action for the unified provider.
 * Card and ACH are disambiguated by `event_body.check` (ACH) vs `event_body.card`.
 * A card `sale.success` is a synchronous capture; an ACH `sale.success` is only
 * an accepted submission (authorized) — the ACH network settles days later and
 * reports the outcome through the `transaction.check.status.*` family.
 *
 * `settlement.batch.complete` stays mapped. NMI's published sample for it shows only
 * batch totals with no `order_id`, but samples are abridged and real payloads have been
 * observed to carry one. Keeping it is free: Medusa's payment webhook subscriber drops
 * any event whose `session_id` is empty before acting on it, so a batch event without an
 * order id is a no-op either way.
 * See https://docs.nmi.com/reference/check-status
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
    // ACH settlement outcomes, days after the debit was accepted.
    case "transaction.check.status.settle": return "captured"
    case "transaction.check.status.return": return "failed"
    case "transaction.check.status.latereturn": return "failed"
    default: return null
  }
}
