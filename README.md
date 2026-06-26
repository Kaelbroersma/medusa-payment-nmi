# medusa-payment-nmi

A Medusa v2 payment provider for the **NMI Gateway** — card **and** ACH/eCheck, collected
through **NMI Collect.js** hosted fields. The card PAN / bank number is tokenized in the
browser and never touches your server (PCI SAQ-A-EP).

- **Card** authorizes **synchronously**: Collect.js tokenizes → the backend charges the
  token via the Payment API and knows the result immediately. Webhooks are a backstop.
- **ACH** is **asynchronous**: the backend submits the debit (`authorized`); a settlement
  webhook captures it, an ACH return fails it.

## Install

```bash
npm install medusa-payment-nmi
```

## Configure (`medusa-config.ts`)

```ts
module.exports = defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-nmi/providers/nmi-card",
            id: "nmi-card",
            options: {
              securityKey: process.env.NMI_SECURITY_KEY,
              tokenizationKey: process.env.NMI_TOKENIZATION_KEY,
              webhookSecret: process.env.NMI_WEBHOOK_SECRET,
              captureMethod: "auth",            // or "sale"
              sandbox: process.env.NODE_ENV !== "production",
            },
          },
          {
            resolve: "medusa-payment-nmi/providers/nmi-ach",
            id: "nmi-ach",
            options: {
              securityKey: process.env.NMI_SECURITY_KEY,
              tokenizationKey: process.env.NMI_TOKENIZATION_KEY,
              webhookSecret: process.env.NMI_WEBHOOK_SECRET,
              secCode: "WEB",                   // internet-initiated consumer debit
              sandbox: process.env.NODE_ENV !== "production",
            },
          },
        ],
      },
    },
  ],
})
```

| Option | Required | Notes |
|---|---|---|
| `securityKey` | ✅ | Private API key for `transact.php`. |
| `tokenizationKey` | ✅ | Public Collect.js key; sent to the storefront. |
| `webhookSecret` | ✅ | Webhook signing key (HMAC-SHA256). |
| `captureMethod` (card) | — | `auth` (default) or `sale`. |
| `secCode` (ACH) | — | `WEB` (default), `PPD`, `CCD`, `TEL`. |
| `sandbox` | — | Use `sandbox.nmi.com`. |

## Card flow

1. `initiatePayment` returns `{ tokenizationKey, collectScriptUrl, amount }`.
2. The storefront's `NmiHostedFields` loads Collect.js, tokenizes the card → `payment_token`.
3. Your `onToken` writes `{ payment_token }` onto the session and completes the cart.
4. `authorizePayment` charges the token (`auth` or `sale`) and returns the result synchronously.

## ACH flow

1. `NmiAchForm` tokenizes the bank account → `payment_token` (+ account type fields).
2. `authorizePayment` submits a `sale` → **authorized** (not yet settled).
3. The settlement webhook → **captured**; an ACH return → **failed**.

## Webhooks (required for ACH, recommended for card)

Medusa exposes one webhook route per provider:

- `POST https://<your-backend>/hooks/payment/nmi-card`
- `POST https://<your-backend>/hooks/payment/nmi-ach`

In **NMI Merchant Portal → Settings → Webhooks**, add an endpoint for each URL, paste the
signing key (that is your `webhookSecret`), and subscribe to:

| Endpoint | Events |
|---|---|
| `…/nmi-card` | `transaction.sale.success`, `transaction.auth.success`, `transaction.capture.success`, `transaction.refund.success`, `transaction.void.success` |
| `…/nmi-ach` | `transaction.sale.success`, `transaction.sale.failure`, `settlement.batch.complete` (+ ACH return) |

Each handler verifies the `Webhook-Signature` HMAC and **self-filters by rail** (the card
handler ignores ACH events and vice-versa), so over-subscribing is harmless. NMI requires
public HTTPS — for local dev, tunnel (e.g. `cloudflared`, `ngrok`) to your backend.

## Storefront

See [`storefront/README.md`](./storefront/README.md) for the copy-paste Collect.js
components and checkout wiring.

## Not in v1

Saved cards / NMI Customer Vault. The account-holder step is satisfied with a synthetic
holder; no card is stored. (Easy to add later.)

## License

MIT
