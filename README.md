# medusa-payment-nmi

A Medusa v2 payment provider for the **NMI Gateway** — **card, ACH/eCheck, and Apple/Google
Pay through one provider**, collected with NMI's official **`<NmiPayments>`** component
(`@nmipayments/nmi-pay-react`). The card PAN / bank number is tokenized in the browser and
never touches your server.

You register a single **NMI** payment method; the customer picks card or bank (or a wallet)
inside the payment element, and the provider runs the right lifecycle:

- **Card / Apple Pay / Google Pay** authorize **synchronously** — the backend charges the
  token via the Payment API and knows the result immediately.
- **ACH** is **asynchronous** — the backend submits the debit (`authorized`); a settlement
  webhook captures it, an ACH return fails it.

## Install

```bash
npm install medusa-payment-nmi
```

Or straight from GitHub (the `prepare` script builds `.medusa/server` on install):

```bash
npm install github:Kaelbroersma/medusa-payment-nmi
```

**Requires:** Medusa `>= 2.5`, Node `>= 20`.

This package is a standard [Medusa plugin](https://docs.medusajs.com/learn/fundamentals/plugins)
built with `medusa plugin:build`, so it follows the official exports layout —
`medusa-payment-nmi/providers/nmi` resolves the payment module provider.

## Providers

The package ships four payment providers sharing one NMI account/config. Register
once, then enable the ones you want per region in the Medusa admin
(Settings → Regions):

| Identifier | Checkout option | Lifecycle |
|---|---|---|
| `nmi-card` | Credit card | synchronous `auth`/`sale` per `captureMethod` |
| `nmi-ach` | Bank account (ACH/eCheck) | async: sale now → settlement webhook captures |
| `nmi-wallet` | Apple Pay / Google Pay | synchronous, charges like card; needs portal wallet setup |
| `nmi` | all of the above in one option | branches on the `payment_method` the storefront stamps |

Resolving `"medusa-payment-nmi"` registers all four. To register a single
variant, resolve its subpath, e.g. `"medusa-payment-nmi/providers/nmi-card"`.

## Configure (`medusa-config.ts`)

```ts
module.exports = defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-nmi",
            options: {
              securityKey: process.env.NMI_SECURITY_KEY,
              tokenizationKey: process.env.NMI_TOKENIZATION_KEY,
              webhookSecret: process.env.NMI_WEBHOOK_SECRET,
              captureMethod: "auth",   // card/wallet: "auth" or "sale"
              secCode: "WEB",          // ACH SEC code (internet-initiated consumer debit)
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
| `tokenizationKey` | ✅ | Public key; sent to the storefront `<NmiPayments>` component. |
| `webhookSecret` | ✅ | Webhook signing key (HMAC-SHA256). |
| `captureMethod` | — | Card/wallet: `auth` (default) or `sale`. |
| `secCode` | — | ACH: `WEB` (default), `PPD`, `CCD`, `TEL`. |
| `sandbox` | — | Use `sandbox.nmi.com`. |

## How a payment flows

1. `initiatePayment` returns `{ tokenizationKey }` to the storefront.
2. `<NmiPayments>` tokenizes the chosen method → a single-use token; the storefront writes
   `{ payment_token, payment_method }` onto the payment session and completes the cart.
3. `authorizePayment` charges the token:
   - **card/wallet** → `auth` or `sale` (per `captureMethod`) → `authorized` / `captured`.
   - **ach** → `sale` → `authorized` (not yet settled).
4. For ACH, the settlement webhook → `captured`; an ACH return → `failed`.

## Webhooks

Medusa exposes one webhook route per provider identifier:

- split providers → `POST https://<your-backend>/hooks/payment/nmi-ach`
  (ACH is the only asynchronous provider; card/wallet learn their outcome
  synchronously, so one webhook destination covers the split setup)
- unified provider → `POST https://<your-backend>/hooks/payment/nmi`

In **NMI Merchant Portal → Settings → Webhooks**, add that URL, paste the signing key (your
`webhookSecret`), and subscribe to these events:

| Events |
|---|
| `transaction.sale.success`, `transaction.auth.success`, `transaction.capture.success`, `transaction.refund.success`, `transaction.void.success`, `transaction.sale.failure`, `settlement.batch.complete` |

The handler verifies the `Webhook-Signature` HMAC and maps each event to the right action,
disambiguating card vs ACH by the event body. NMI requires public HTTPS — for local dev,
tunnel (e.g. `cloudflared`, `ngrok`) to your backend.

> **Note on async outcomes:** Medusa's built-in payment-webhook subscriber acts on the
> `authorized` and `captured` outcomes. ACH **settlement** (→ captured) works out of the
> box. ACH **returns** and **voids** are detected and mapped by this provider but, like all
> `failed`/`canceled` webhook outcomes in current Medusa core, do not auto-transition the
> payment — add your own subscriber on the `payment.webhook_received` event if you need
> automated return/void reconciliation.

## Storefront

See [`storefront/README.md`](./storefront/README.md) for the copy-paste components:

- **Split providers** — `NmiCardFields` / `NmiAchFields`: Collect.js inline hosted
  fields (no extra npm dependency; you own the layout and styling, NMI's iframes
  hold the sensitive inputs)
- **Unified provider** — `NmiPaymentElement`: the all-in-one `<NmiPayments>` widget
  (`@nmipayments/nmi-pay-react`)

## Local development

The repo uses the official Medusa plugin toolchain:

```bash
npm install          # also builds .medusa/server via prepare
npm run dev          # medusa plugin:develop — watch + publish to the local registry
npm test             # vitest unit tests
```

To try local changes inside a Medusa app, use the
[local plugin workflow](https://docs.medusajs.com/learn/fundamentals/plugins/create#3-publish-plugin-locally-for-development-and-testing):

```bash
# in this repo
npx medusa plugin:publish

# in your Medusa app
npx medusa plugin:add medusa-payment-nmi
```

## Not in v1

Saved cards / NMI Customer Vault. The account-holder methods are implemented as no-ops
around a synthetic holder; no card is stored. (Easy to add later.)

## License

MIT
