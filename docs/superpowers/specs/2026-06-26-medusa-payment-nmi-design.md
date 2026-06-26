# medusa-payment-nmi — Design Spec

**Date:** 2026-06-26
**Status:** Approved (design); pending implementation plan
**Author:** Kael Broersma

A Medusa v2 payment provider for the **NMI Gateway**, supporting **card** and **ACH**
payments collected through NMI **Collect.js** hosted fields (PCI SAQ-A-EP — the PAN /
bank number never touches the merchant server). Structured after the existing
`medusa-payment-kadima` provider, but adapted to NMI's native model.

---

## 1. Goals & scope

**In scope (v1):**

- `nmi-card` provider — Collect.js card fields → synchronous server-side auth/sale.
- `nmi-ach` provider — Collect.js ACH fields → async submit + webhook settlement.
- Webhook handling for both rails (HMAC-SHA256 verified).
- Configurable card capture model (`auth` then capture, or `sale`).
- Copy-paste storefront React components for Collect.js (card + ACH).
- Thorough, easy-to-use documentation.

**Out of scope (v1, deferred):**

- NMI **Customer Vault** / saved cards. Account-holder methods are stubbed (mirrors
  Kadima's `enableVault: false` default) so Medusa's account-holder step succeeds
  without a vault. Easy to add later.
- Apple Pay / Google Pay (Collect.js supports them; not wired in v1).
- 3DS / surcharging.

---

## 2. Key model difference vs Kadima (why this is simpler)

| | Kadima Hosted Fields | **NMI Collect.js** |
|---|---|---|
| Browser role | **Performs the charge** | **Only tokenizes** → single-use `payment_token` (24h) |
| Authorization | Async — backend returns `pending`, webhook authorizes | **Synchronous** — backend charges via `transact.php`, knows result immediately |
| Webhook role (card) | **Primary** (drives auth) | **Backstop / reconciliation** |
| Webhook role (ACH) | Primary (settlement) | Primary (settlement / return) |

NMI's Collect.js produces a token with the **public tokenization key** entirely
client-side, so — unlike Kadima — there is **no server token-minting round trip** in
`initiatePayment`.

---

## 3. NMI API facts (verified against docs.nmi.com)

**Collect.js (hosted fields):**
- Script: `https://securepay.nmi.com/collect.js` with attribute
  `data-tokenization-key="<public key>"`.
- `CollectJS.configure({ variant: 'inline', fields: { ccnumber, ccexp, cvv }, callback,
  fieldsAvailableCallback, validationCallback })`.
- `CollectJS.startPaymentRequest()` → `callback(response)` where `response.token` is the
  single-use `payment_token`.
- ACH: same flow with checking-account fields (`checkaccount`, `checkaba`, `checkname`).

**Payment API (Direct Post):**
- Endpoint: `https://secure.nmi.com/api/transact.php` (prod) /
  `https://sandbox.nmi.com/api/transact.php` (sandbox). POST, `application/x-www-form-urlencoded`.
- Auth: `security_key` (private). `type` = `sale` | `auth` | `capture` | `refund` | `void`.
- Charge a Collect.js token with `payment_token=<token>`.
- `amount` is **dollars `x.xx`** (e.g. `49.99`) — Medusa stores prices as-is, so **no
  cents conversion** (`toFixed(2)` only). This satisfies the `data-price-format` rule.
- Follow-ups (`capture`/`refund`/`void`) reference `transactionid`.
- Correlation: send `orderid=<session_id>` **and** `merchant_defined_field_1=<session_id>`.
- **Response is a URL-encoded query string** (not JSON): `response` (`1`=approved,
  `2`=decline, `3`=error), `responsetext`, `transactionid`, `response_code` (`100`=approved),
  `authcode`, `avsresponse`, `cvvresponse`, `type`, `orderid`. Parse with `URLSearchParams`.

**Webhooks:**
- Configured in NMI Merchant Portal → Settings → Webhooks. HTTPS only.
- Header `Webhook-Signature: t=<nonce>,s=<sig>`; verify with
  `HMAC-SHA256(nonce + "." + rawBody, signingKey)` and timing-safe compare.
- Payload: `{ event_id, event_type, event_body: { transaction_id, requested_amount,
  action: { amount, action_type }, merchant_defined_fields, ... , card?|check? } }`.
- Event types used:
  - `transaction.sale.success`, `transaction.auth.success`, `transaction.capture.success`,
    `transaction.refund.success`, `transaction.void.success`, `transaction.sale.failure`.
  - `settlement.batch.complete` (ACH settlement).
- **To verify during implementation:** exact ACH-return event string, and whether
  `event_body` echoes `orderid` directly vs only via `merchant_defined_fields`
  (we set both, read whichever is present).

---

## 4. Repository structure (mirrors Kadima)

```
src/
  index.ts                 ModuleProvider(Modules.PAYMENT, { services: [card, ach] })
  types.ts                 NmiCardOptions, NmiAchOptions, HOSTS, status enums
  providers/
    nmi-card.ts            NmiCardProviderService   (static identifier = "nmi-card")
    nmi-ach.ts             NmiAchProviderService    (static identifier = "nmi-ach")
  lib/
    nmi-client.ts          transact.php client: sale/auth/capture/refund/void (+ ACH)
    webhook.ts             verifySignature() HMAC-SHA256
    webhook.test.ts        signature verify happy/tamper tests
    nmi-client.test.ts     response-string parsing test
    errors.ts              NmiError + response_code classification (retryable vs hard)
storefront/
    NmiHostedFields.tsx    Collect.js inline card fields
    NmiAchForm.tsx         Collect.js inline ACH fields
    README.md
docs/
README.md
package.json               name "medusa-payment-nmi"; subpath exports per provider
tsup.config.ts             build → .medusa/server/src (esm, node20)
tsconfig.json, .env.example, .gitignore, LICENSE
```

Build & packaging mirror Kadima: `tsup` to `.medusa/server`, `prepare` script,
subpath exports `./providers/nmi-card` and `./providers/nmi-ach`, `vitest` tests.

---

## 5. Provider contracts (AbstractPaymentProvider, v2-typed I/O)

### 5.1 Card (`nmi-card`) — synchronous

- **`initiatePayment`** — no network call. Returns
  `data: { tokenizationKey, collectScriptUrl, amount, currency_code, sessionId }`;
  `id = "nmi_" + session_id`.
- **`authorizePayment`** — reads `payment_token` from `input.data` (storefront wrote it
  after Collect.js tokenization). POSTs `transact.php` `type = captureMethod==="sale" ?
  "sale" : "auth"`, with `payment_token`, `amount` (`x.xx`), `orderid`/`merchant_defined_field_1
  = session_id`. Returns `status: "captured" | "authorized"` + `data: { transactionid, … }`.
  Throws `NmiError` on decline/error.
- **`capturePayment`** — `type=capture`, `transactionid`. If already a sale, return as-is.
- **`refundPayment`** — `type=refund`, `transactionid`, `amount`.
- **`cancelPayment`** — `type=void` (pre-settlement). Post-settlement falls back to refund.
- **`getPaymentStatus` / `retrievePayment` / `updatePayment` / `deletePayment`** — mirror
  Kadima (status derived from stored data; update re-stamps amount).
- **`getWebhookActionAndData`** — see §6.
- Account-holder methods (`createAccountHolder` etc.) — **stubbed** (synthetic id, no vault).
- **`static validateOptions`** — require `securityKey`, `tokenizationKey`, `webhookSecret`.

### 5.2 ACH (`nmi-ach`) — asynchronous

- **`initiatePayment`** — returns Collect.js ACH config (tokenizationKey, script URL, amount).
- **`authorizePayment`** — `type=sale` with the ACH `payment_token`. Accepted → return
  **`status: "authorized"`** (NOT captured; funds not settled), store `transactionid`.
- **`capturePayment`** — no-op (settlement is async; real capture is the webhook).
- **`refundPayment` / `cancelPayment`** — void if not yet settled, else refund/credit.
- **`getWebhookActionAndData`** — see §6.
- **`static validateOptions`** — require `securityKey`, `tokenizationKey`, `webhookSecret`.

---

## 6. Webhook handling

Both providers implement `getWebhookActionAndData(payload)`:

1. Verify `Webhook-Signature` header via `HMAC-SHA256(nonce + "." + rawBody, webhookSecret)`,
   timing-safe. On failure → `{ action: "not_supported" }`.
2. **Self-filter by rail:** card handler ignores events whose `event_body` has a `check`
   object; ACH handler ignores events whose `event_body` has a `card` object. This makes
   over-subscription harmless and avoids cross-routing.
3. Recover `session_id` from `event_body.orderid` ?? `event_body.merchant_defined_fields…`.
4. Map event → Medusa action:

| `event_type` | Card action | ACH action |
|---|---|---|
| `transaction.auth.success` | `authorized` | — |
| `transaction.sale.success` | `captured` | `authorized` (accepted) |
| `transaction.capture.success` | `captured` | — |
| `transaction.refund.success` | `captured` | `captured` |
| `transaction.void.success` | `canceled` | `canceled` |
| `transaction.sale.failure` (ACH return) | — | `failed` |
| `settlement.batch.complete` | — | `captured` |
| anything else | `not_supported` | `not_supported` |

Returns `{ action, data: { session_id, amount: new BigNumber(requested_amount) } }`.

### Webhook setup (documented for the merchant)

- URLs: `POST /hooks/payment/nmi-card` and `POST /hooks/payment/nmi-ach`.
- In NMI Merchant Portal → Settings → Webhooks, add an endpoint per URL, paste the
  signing key (→ `webhookSecret`), subscribe to the event groups in §3.
- Card webhook is an optional backstop; ACH webhook is **required**.
- Local dev needs a public HTTPS tunnel.

---

## 7. Configuration

```ts
interface NmiCardOptions {
  securityKey: string        // private API key (transact.php)
  tokenizationKey: string    // public Collect.js key (sent to storefront)
  webhookSecret: string      // webhook signing key
  captureMethod?: "auth" | "sale"   // default "auth"
  sandbox?: boolean          // secure.nmi.com vs sandbox.nmi.com
}

interface NmiAchOptions {
  securityKey: string
  tokenizationKey: string
  webhookSecret: string
  secCode?: "PPD" | "CCD" | "WEB" | "TEL"   // default "WEB"
  sandbox?: boolean
}
```

`medusa-config.ts` registers both under `@medusajs/medusa/payment` via subpath resolves
(`medusa-payment-nmi/providers/nmi-card`, `…/nmi-ach`).

---

## 8. Error handling & testing

- `transact.php` non-`1` responses → `NmiError(message, code, raw)`, classifying retryable
  (gateway/timeout `response_code`s) vs hard declines. Transport retries on 5xx/network
  like the Kadima client.
- **Unit tests (vitest, no live NMI):**
  - `webhook.test.ts` — valid signature passes; tampered body/nonce/sig fails.
  - `nmi-client.test.ts` — URL-encoded response parsing (approved, decline, error).
- Build validation: `npm run build` (tsup) + `npm run typecheck` must pass.

---

## 9. Documentation deliverables

- **`README.md`** — overview, install, config table, env vars, per-rail flow diagrams,
  full webhook setup walkthrough, troubleshooting.
- **`storefront/README.md`** — Collect.js wiring, copy-paste card + ACH components, styles.
- **`.env.example`** — all keys with comments.
- **Inline JSDoc** on every provider method explaining the NMI mapping.

---

## 10. Open items to confirm during implementation

1. Exact ACH-return webhook `event_type` string.
2. Whether `event_body` echoes `orderid` directly (set both `orderid` and
   `merchant_defined_field_1` regardless).
3. Sandbox host confirmation (`sandbox.nmi.com` vs sandbox security_key on `secure.nmi.com`).
