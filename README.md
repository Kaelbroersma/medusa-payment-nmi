# medusa-payment-nmi

[![npm version](https://img.shields.io/npm/v/medusa-payment-nmi.svg)](https://www.npmjs.com/package/medusa-payment-nmi)
[![npm downloads](https://img.shields.io/npm/dt/medusa-payment-nmi.svg)](https://www.npmjs.com/package/medusa-payment-nmi)
[![license](https://img.shields.io/npm/l/medusa-payment-nmi.svg)](./LICENSE)
[![Medusa](https://img.shields.io/badge/Medusa-%E2%89%A5%202.5-7C3AED.svg)](https://docs.medusajs.com/)

A payment provider for Medusa v2 that runs card, ACH/eCheck, Apple Pay, and Google Pay
through an [NMI](https://www.nmi.com/) merchant account.

Card numbers and bank account numbers are tokenized in the shopper's browser by NMI and
never reach your Medusa server. Your backend receives a single-use token and charges it
through NMI's Payment API (`transact.php`). Card and wallet payments resolve while the
shopper waits. ACH does not, so the provider treats it as an asynchronous flow and lets a
settlement webhook finish the job.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Choosing providers](#choosing-providers)
- [Configuration](#configuration)
- [How a payment moves through the system](#how-a-payment-moves-through-the-system)
- [Authorize first or charge once](#authorize-first-or-charge-once)
- [Collecting card and bank details](#collecting-card-and-bank-details)
  - [Two ways to collect](#two-ways-to-collect)
  - [Collect.js inline hosted fields](#collectjs-inline-hosted-fields)
  - [The unified payment element](#the-unified-payment-element)
  - [What the storefront writes onto the session](#what-the-storefront-writes-onto-the-session)
- [Billing address and AVS](#billing-address-and-avs)
- [Showing the card on receipts](#showing-the-card-on-receipts)
- [Webhooks](#webhooks)
- [Captures, refunds, and voids](#captures-refunds-and-voids)
- [Testing against the sandbox](#testing-against-the-sandbox)
- [Troubleshooting](#troubleshooting)
- [Not supported yet](#not-supported-yet)
- [Local development](#local-development)
- [Disclaimer](#disclaimer)

## Requirements

- Medusa `>= 2.5` (the package declares `@medusajs/framework` as a peer dependency)
- Node `>= 20`
- An NMI merchant account with three keys from the Merchant Portal: a private security
  key, a public tokenization key, and a webhook signing key

## Install

```bash
npm install medusa-payment-nmi
```

You can also install straight from GitHub. The `prepare` script runs `medusa plugin:build`,
so `.medusa/server` is built during install:

```bash
npm install github:Kaelbroersma/medusa-payment-nmi
```

This is a standard [Medusa plugin](https://docs.medusajs.com/learn/fundamentals/plugins)
built with `medusa plugin:build`, so it follows the official exports layout.
`medusa-payment-nmi/providers/nmi` resolves a single payment module provider, and the
package root resolves all of them at once.

## Quick start

### 1. Register the provider

In `medusa-config.ts`:

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
              captureMethod: "auth",
              secCode: "WEB",
              sandbox: process.env.NODE_ENV !== "production",
            },
          },
        ],
      },
    },
  ],
})
```

Copy `.env.example` for the variable names. The three keys live in the NMI Merchant
Portal under Settings, in Security Keys and Webhooks.

### 2. Enable it for a region

Registering a provider does not expose it at checkout. Open the Medusa admin, go to
Settings, then Regions, pick a region, and add the NMI providers you want shoppers to
see. Most stores enable one or two.

### 3. Collect the payment details

Copy the components you need out of [`storefront/`](./storefront) into your Next.js app.
There are two collection styles and they are covered in detail under
[Collecting card and bank details](#collecting-card-and-bank-details).

### 4. Point NMI at your webhook

ACH will sit in `authorized` forever without this. See [Webhooks](#webhooks).

## Choosing providers

The package ships four providers that share one NMI account and one block of config.
Resolving `"medusa-payment-nmi"` registers all four, and you decide per region which ones
appear at checkout.

| Identifier | Checkout option | Lifecycle |
|---|---|---|
| `nmi-card` | Credit card | Synchronous. Runs `auth` or `sale` per `captureMethod`. |
| `nmi-ach` | Bank account (ACH/eCheck) | Asynchronous. Submits a sale now, settlement webhook captures. |
| `nmi-wallet` | Apple Pay / Google Pay | Synchronous. Charges exactly like a card token. Needs wallet setup in the NMI portal. |
| `nmi` | One option covering all of the above | Branches on the `payment_method` value the storefront writes onto the session. |

Split providers give each method its own radio button, its own webhook route, and its own
enable/disable switch per region. The unified `nmi` provider gives you one checkout option
and lets NMI's payment element handle the method picker inside it. Pick the split
providers if you want control over the checkout layout, and the unified one if you want
the shortest path to a working payment step.

To register only one variant, resolve its subpath instead of the package root:

```ts
{ resolve: "medusa-payment-nmi/providers/nmi-card", options: { /* ... */ } }
```

### Provider ids

Medusa stores a provider as `pp_<identifier>`, so the four ids are `pp_nmi`, `pp_nmi-card`,
`pp_nmi-ach`, and `pp_nmi-wallet`. If you add an `id` key to the provider config, Medusa
appends it (`{ resolve: "medusa-payment-nmi", id: "primary" }` produces `pp_nmi_primary`
and friends). Confirm what your store actually exposes with `GET /store/payment-providers`
before you hardcode an id in the storefront.

## Configuration

| Option | Required | Default | Notes |
|---|---|---|---|
| `securityKey` | Yes | | Private API key used server side for `transact.php`. Never send it to the browser. |
| `tokenizationKey` | Yes | | Public key. The provider hands it to the storefront through the payment session. |
| `webhookSecret` | Yes | | Webhook signing key, used to verify the HMAC on every inbound event. |
| `captureMethod` | No | `"auth"` | Card and wallet only. `"auth"` holds the funds, `"sale"` charges immediately. |
| `secCode` | No | `"WEB"` | ACH SEC code. `WEB`, `PPD`, `CCD`, or `TEL`. |
| `sandbox` | No | `false` | Routes both the API calls and the storefront's Collect.js script to `sandbox.nmi.com`. |

All three keys are validated at boot. A missing one throws a `MedusaError` with the name
of the option, so a bad deploy fails fast instead of failing at the first checkout.

## How a payment moves through the system

```
initiatePayment          -> session.data { tokenizationKey, sandbox, amount, currency_code }
browser tokenizes        -> single-use token from NMI (24 hour lifetime, one submission)
initiatePaymentSession   -> session.data gains { payment_token, payment_method, billing }
cart.complete            -> authorizePayment charges the token via transact.php
                            card/wallet: authorized or captured, right now
                            ACH:         authorized, settlement pending
webhook                  -> ACH settlement captures, an ACH return fails it
```

`initiatePayment` moves no money. Its only job is to hand the storefront the public
tokenization key and the sandbox flag so the browser can load Collect.js from the matching
gateway host.

The storefront then writes the token back onto the same session with a second
`initiatePaymentSession` call, which merges into `session.data`. When the cart completes,
`authorizePayment` reads that data and charges the token.

One detail worth knowing before you debug anything: Medusa's cart completion calls
`authorizePaymentSessionStep({ id })` with no context, and the payment module forwards only
`{ data: session.data, context: { idempotency_key } }` to the provider. The session data is
the only channel you have. Anything the charge needs, including the billing address, has to
be on that object by the time the cart completes.

## Authorize first or charge once

`captureMethod` decides what happens the moment the token is charged.

**`"auth"` (the default).** The provider sends `type=auth`. NMI places a hold on the card,
Medusa marks the payment `authorized`, and no money moves until something calls capture.
That capture happens when you capture the payment in the admin, or through your own
fulfillment workflow, and it issues an NMI `capture` against the stored `transactionid`.
This is the right default for physical goods, where you should not take the money before
the box ships. Authorizations do expire, on a window set by the card brand and your
processor, so capture within a few days.

**`"sale"`.** The provider sends `type=sale`, one call that authorizes and captures
together. Medusa records the payment as `captured` immediately. Use it for digital goods
or anything that ships instantly. There is nothing left to capture afterwards.

**ACH ignores the setting entirely.** An eCheck debit is always submitted as a sale and is
always asynchronous, because the ACH network settles in batches over the following days.
The provider returns `authorized` to mean "the debit was accepted," and `capturePayment`
is deliberately a no-op for ACH so an admin click cannot double-submit. The settlement
webhook is what moves it to `captured`. If ACH payments never leave `authorized`, your
webhook is not wired up.

Wallet tokens behave exactly like card tokens, so `nmi-wallet` follows `captureMethod`
too.

## Collecting card and bank details

### Two ways to collect

|  | Collect.js inline hosted fields | NMI payment element |
|---|---|---|
| Components | `NmiCardFields`, `NmiAchFields` | `NmiPaymentElement` |
| Backend provider | `nmi-card`, `nmi-ach` | `nmi` |
| Extra npm dependency | None | `@nmipayments/nmi-pay-react` |
| Layout | Yours. You write the labels, the grid, the error text. | NMI's, with an `appearance` prop for styling. |
| Wallets | Not covered by these components | Built in |
| Method picker | You build it | Built in |
| Good for | Checkouts with an existing design system | Getting a working payment step quickly |

Both approaches tokenize inside an iframe served by NMI, so the card number and the bank
account number stay out of your DOM and out of your server logs. Talk to your acquirer
about which PCI DSS self-assessment questionnaire applies to your integration; that answer
depends on your whole checkout, not just this plugin.

### Collect.js inline hosted fields

Collect.js loads from your gateway host with the public tokenization key attached, and
`CollectJS.configure()` tells it which of your empty `div`s to fill. It injects one iframe
per sensitive input. You keep the label, the border, the spacing, and the error message.
NMI keeps the keystrokes.

`use-collect-js.ts` handles the script loading and the configure call. The two field
components are thin wrappers around it.

#### The fields

| Field key | Component | Element id in the shipped component | Holds |
|---|---|---|---|
| `ccnumber` | `NmiCardFields` | `#nmi-ccnumber` | Card number |
| `ccexp` | `NmiCardFields` | `#nmi-ccexp` | Expiry, `MM / YY` |
| `cvv` | `NmiCardFields` | `#nmi-cvv` | Security code |
| `checkname` | `NmiAchFields` | `#nmi-checkname` | Name on the account |
| `checkaba` | `NmiAchFields` | `#nmi-checkaba` | Routing number |
| `checkaccount` | `NmiAchFields` | `#nmi-checkaccount` | Account number |

`NmiAchFields` also renders two ordinary `<select>` elements for account type
(checking or savings) and holder type (personal or business). Those are not sensitive, so
they stay in your page as normal React state and ride along in the token payload.

The hook configures Collect.js with `variant: "inline"`, `styleSniffer: false`, and
`paymentType` set to `"cc"` for cards or `"ck"` for bank accounts. It also pins
`country: "US"` and `currency: "USD"`. If you sell outside the US, change those two lines
in `use-collect-js.ts` when you copy it.

#### Wiring it up

The components expose a ref with `requestToken()` and `isValid`, so your existing Place
Order button drives tokenization instead of a second button appearing inside the form.

```tsx
const fieldsRef = useRef<NmiFieldsHandle>(null)
const [submitting, setSubmitting] = useState(false)

async function handleToken(data: Record<string, unknown>) {
  await sdk.store.payment.initiatePaymentSession(cart, {
    provider_id: "pp_nmi-card",
    data, // { payment_token, payment_method: "card" }
  })
  const res = await sdk.store.cart.complete(cart.id)
  if (res.type === "order") {
    window.location.href = `/order/confirmed/${res.order.id}`
  }
  setSubmitting(false)
}

{selected === "pp_nmi-card" && (
  <NmiCardFields ref={fieldsRef} session={activeSession} onToken={handleToken} />
)}

<button
  disabled={submitting || !fieldsRef.current?.isValid}
  onClick={() => {
    setSubmitting(true)
    fieldsRef.current?.requestToken()
  }}
>
  Place order
</button>
```

`NmiAchFields` works the same way against `pp_nmi-ach`. Its `onToken` payload carries two
extra keys, `account_type` and `account_holder_type`.

The `session` prop is the active payment session. The components read
`session.data.tokenizationKey` and `session.data.sandbox` from it, both of which
`initiatePayment` put there. If the session has no tokenization key yet, the components
render a short "Payment session not ready" message rather than mounting a broken form.

#### Styling the inputs

Your stylesheet stops at the iframe boundary. A rule on `#nmi-ccnumber` styles the box
around the input, not the input itself. To reach inside, pass CSS objects that Collect.js
applies within its own document:

```tsx
<NmiCardFields
  ref={fieldsRef}
  session={activeSession}
  onToken={handleToken}
  googleFont="Inter:400"
  fieldClassName="h-11 rounded-md border border-neutral-700 px-3"
  customCss={{
    base: {
      "font-family": "Inter, sans-serif",
      "font-size": "15px",
      color: "#e5e5e5",
      "background-color": "#171717",
    },
    focus: { color: "#ffffff" },
    invalid: { color: "#dc2626" },
    placeholder: { color: "#737373" },
  }}
/>
```

Two traps here, both of which cost real time to find.

The iframe document has its own white background. On a dark checkout, the text you type
turns light grey on white and looks blank until you set an explicit `background-color` in
`customCss.base`.

Fonts do not cross the frame boundary either. Loading Inter in your app does nothing for
the hosted input. Pass `googleFont="Inter:400"` so Collect.js loads the family inside its
own document, then reference the family name in `customCss.base["font-family"]`.

#### Validation and the token request

Collect.js reports validity per field as the shopper types, and the hook aggregates that
into a single `isValid` boolean. It only turns true once every mounted field has reported
valid and Collect.js has confirmed the iframes are installed, which is why disabling the
submit button on `isValid` is safe from the first render.

Calling `requestToken()` triggers `CollectJS.startPaymentRequest()`. The token comes back
through the callback and lands in your `onToken` handler. If NMI returns a response with
no token, the components surface an error message and the shopper can correct the fields
and try again.

Tokens are single use and NMI expires them 24 hours after creation. In practice this only
matters if you tokenize on one page and complete the cart much later; if the charge fails
with a missing token, tokenize again rather than retrying the old one.

#### Mount one form at a time

Collect.js is a single page-level global and does not survive being configured twice. Call
`configure()` a second time, which is exactly what happens when a shopper toggles from card
to bank, and it rebuilds the iframes but never rewires the validation and token events. The
form looks fine and is completely dead.

`use-collect-js.ts` works around this by tearing the script out of the page on unmount, so
the next mount loads it fresh from browser cache and always gets a working first configure.
For that to hold, render only the selected method's component and let React unmount the
other one. Do not render both and hide one with CSS.

#### The wallet probe console error

On init, Collect.js checks whether the browser supports the Payment Request API and logs a
`console.error` reading "Could not create PaymentRequestAbstraction" when the merchant
account has no wallets provisioned. It is harmless for a card and ACH integration, but the
Next.js dev overlay promotes any `console.error` to a full-screen error, which makes it
look like checkout crashed.

The hook filters that one message, and only in development. In production nothing global is
patched and the gateway script runs exactly as shipped, which is the posture you want for a
script that touches payment data.

### The unified payment element

`NmiPaymentElement` wraps `<NmiPayments>` from NMI's official React package. One component
renders the method picker, the fields, and the pay button, and it covers Apple Pay and
Google Pay alongside card and ACH.

```bash
npm install @nmipayments/nmi-pay-react
```

```tsx
{session.provider_id === "pp_nmi" && (
  <NmiPaymentElement
    session={session}
    onToken={async (data) => {
      await sdk.store.payment.initiatePaymentSession(cart, {
        provider_id: session.provider_id,
        data, // { payment_token, payment_method }
      })
      const res = await sdk.store.cart.complete(cart.id)
      if (res.type === "order") {
        window.location.href = `/order/confirmed/${res.order.id}`
      }
    }}
    onError={(e) => console.error(e)}
  />
)}
```

The wrapper reads the tokenization key off the session, passes the element a
`paymentMethods` list of `["card", "ach", "google-pay", "apple-pay"]`, and derives the
method from the payment event so the backend knows which lifecycle to run. Card, Apple Pay,
and Google Pay all report as `"card"`; a bank payment reports as `"ach"`.

Apple Pay and Google Pay need to be enabled in the NMI Merchant Portal first, and Apple Pay
additionally requires domain registration there. Until that is done the element will show
the wallet buttons only on devices that support them, or not at all.

Field styling comes from the component's own `appearance` prop rather than from Collect.js
CSS objects. See NMI's component documentation for the shape.

### What the storefront writes onto the session

Everything the backend needs at authorize time has to be on `session.data`. Each
`initiatePaymentSession` call merges into it.

| Key | Written by | Required | Notes |
|---|---|---|---|
| `tokenizationKey` | `initiatePayment` | | Public key for the browser. |
| `sandbox` | `initiatePayment` | | Tells the components which gateway host to load Collect.js from. |
| `amount`, `currency_code`, `session_id` | `initiatePayment` | | `session_id` is sent to NMI as both `orderid` and `merchant_defined_field_1` so webhooks can be matched back to the session. |
| `payment_token` | Storefront | Yes | The single-use token. Without it, `authorizePayment` returns `pending` instead of charging. |
| `payment_method` | Storefront | Yes for `pp_nmi` | `"card"` or `"ach"`. The unified provider branches on it and defaults to `"card"`. |
| `account_type` | Storefront | ACH | `"checking"` or `"savings"`. |
| `account_holder_type` | Storefront | ACH | `"personal"` or `"business"`. |
| `billing` | Storefront, server side | Recommended | Cardholder address for AVS. See below. |
| `card_type`, `card_last4`, `card_exp` | Storefront | Optional | Display metadata, passed through to `payment.data`. |

## Billing address and AVS

The provider sends the cardholder billing address on every card and ACH sale or auth, so
NMI's Address Verification Service has something to check. There is no accept or reject
logic in this package. Enforcement belongs in the NMI Merchant Portal, where you can tune
AVS rules without a redeploy, and a hard reject arrives as a normal decline.

Because the payment module gives the provider no customer context at authorize time, the
address has to travel on the session data. Read it from the cart on the server, never from
the browser:

```ts
// storefront: in your submitPayment / placeOrder action
const cart = await retrieveCart()
const a = cart.billing_address

await sdk.store.payment.initiatePaymentSession(cart, {
  provider_id: providerId,
  data: {
    payment_token: token,
    payment_method: method,
    ...(a && {
      billing: {
        first_name: a.first_name,
        last_name: a.last_name,
        company: a.company,
        address_1: a.address_1,
        address_2: a.address_2,
        city: a.city,
        province: a.province,
        postal_code: a.postal_code,
        country_code: a.country_code,
        phone: a.phone,
        email: cart.email,
      },
    }),
  },
})
```

Use Medusa's snake_case address keys; the provider maps them to NMI's field names and
uppercases the country code. If first name, last name, street, city, province, or postal
code is missing, the whole billing block is dropped rather than sent with blanks, and the
charge goes through without AVS for that order.

NMI's answers come back on `payment.data` as `avs_response` and `cvv_response`, which makes
them queryable later. On a decline the full gateway result is attached to the thrown
`NmiError` as `error.raw`, so those two codes are reachable there too.

AVS is a card-side control. The address is sent on ACH as well, which is harmless and helps
fraud scoring.

## Showing the card on receipts

If the storefront puts `card_type`, `card_last4`, and `card_exp` on the session, the
provider copies them onto `payment.data` after authorization so receipts and the admin can
render something like "Visa 1111". None of these keys contain a real card number.

The shipped `NmiCardFields` does not set them. Collect.js returns a `card` object alongside
the token, but what it contains varies by account and integration, so the component keeps
its payload to the two keys the backend actually requires. If you want the display
metadata, widen the payload in your copy of the component:

```tsx
// NmiCardFields.tsx, inside the useCollectJs call
onToken: (response: CollectJsResponse) =>
  onToken({
    payment_token: response.token,
    payment_method: "card",
    card_type: response.card?.type,               // e.g. "visa"
    card_last4: response.card?.number?.slice(-4), // the number arrives masked
  }),
```

Log the `card` object once against your own account before relying on either field.

## Webhooks

Medusa exposes one webhook route per registered provider, at
`/hooks/payment/<identifier>`. Registering the package root creates all four:

| Provider | Route | Configure it in the portal? |
|---|---|---|
| `nmi` | `POST https://<your-backend>/hooks/payment/nmi` | Yes, if you use the unified provider. |
| `nmi-ach` | `POST https://<your-backend>/hooks/payment/nmi-ach` | Yes. ACH cannot complete without it. |
| `nmi-card` | `POST https://<your-backend>/hooks/payment/nmi-card` | Optional. |
| `nmi-wallet` | `POST https://<your-backend>/hooks/payment/nmi-wallet` | Optional. |

Every route exists whether or not you point NMI at it, and every route runs the same
verification and mapping. What differs is whether you need it. ACH is the only
asynchronous provider, so a split setup needs the `nmi-ach` destination or payments sit in
`authorized` forever. Card and wallet payments learn their outcome during the request, so
their routes are useful only if you want a second record of the outcome, or if you reverse
transactions from the NMI portal rather than the Medusa admin and want Medusa to hear about
it.

Setting an `id` on the provider config appends it to the path, so `id: "primary"` gives
`/hooks/payment/nmi-ach_primary` and so on.

In the NMI Merchant Portal, under Settings then Webhooks, add the URL, paste the signing
key you configured as `webhookSecret`, and subscribe to:

```
transaction.sale.success      transaction.sale.failure
transaction.auth.success      transaction.capture.success
transaction.refund.success    transaction.void.success

settlement.batch.complete

transaction.check.status.settle       (ACH only)
transaction.check.status.return       (ACH only)
transaction.check.status.latereturn   (ACH only)
```

The three `check.status` events are the documented way an ACH payment finishes, and they
are the ones to rely on: they carry `order_id` and merchant defined fields, so they always
match back to a payment session. `settlement.batch.complete` is still handled, since some
accounts do receive it with an order id attached even though NMI's published sample omits
one. Subscribing to both is safe — Medusa ignores any event it cannot tie to a session, so
a batch event without an order id simply does nothing.

### How events are interpreted

The same event means different things for a card and for a bank debit, so the handler looks
at `event_body.check` to tell them apart.

| NMI event | Card | ACH |
|---|---|---|
| `transaction.auth.success` | authorized | authorized |
| `transaction.sale.success` | captured | authorized (accepted, not settled) |
| `transaction.capture.success` | captured | captured |
| `transaction.refund.success` | captured | captured |
| `transaction.void.success` | canceled | canceled |
| `transaction.sale.failure` | ignored | failed (rejected at submission) |
| `transaction.check.status.settle` | — | captured |
| `transaction.check.status.return` | — | failed |
| `transaction.check.status.latereturn` | — | failed |
| `settlement.batch.complete` | captured | captured |

Every request is verified before any of that happens. NMI signs with a
`Webhook-Signature: t=<nonce>,s=<signature>` header, and the handler recomputes
`HMAC-SHA256(nonce + "." + rawBody)` with your signing key and compares in constant time. A
mismatch returns `not_supported`, which means the event is ignored silently. If a webhook
seems to do nothing at all, check the signing key first, then check that nothing in front
of Medusa is re-encoding the request body.

NMI requires a public HTTPS endpoint, so for local development tunnel to your backend with
`cloudflared` or `ngrok`.

> **On asynchronous outcomes.** Medusa's built-in payment webhook subscriber acts on the
> `authorized` and `captured` outcomes. ACH settlement therefore works out of the box.
> Returns and voids are detected and mapped correctly by this provider, but `failed` and
> `canceled` webhook outcomes do not auto-transition the payment in current Medusa core.
> If you need automated reconciliation for returns, subscribe to the
> `payment.webhook_received` event and handle it yourself.

## Captures, refunds, and voids

**Capture** sends an NMI `capture` against the stored `transactionid`. For ACH it is a
no-op, since settlement is what captures those.

**Refund** sends an NMI `refund`. NMI can only refund a settled transaction, which means a
same-day reversal has to be a void instead. Rather than making you know that, the provider
retries a failed full-amount refund as a void, so the Refund button in the admin works
before the settlement batch runs. The result is marked with `voided: true` on
`payment.data` so you can tell the two apart afterwards. Partial refunds cannot be voided,
because a void is all or nothing, so those surface the original NMI error.

**Cancel** sends a void, which is the correct pre-settlement reversal.

Network failures and NMI's 4xx gateway response codes are retried up to twice with
exponential backoff. Declines are not retried; they throw an `NmiError` carrying the
response code and the full gateway result.

## Testing against the sandbox

Set `sandbox: true` and both sides switch hosts together. The backend talks to
`sandbox.nmi.com/api/transact.php`, and because `initiatePayment` puts the flag on the
session, the storefront components load Collect.js from `sandbox.nmi.com` too. Use the keys
from your sandbox account, not your live ones.

NMI keeps the current test card numbers, test routing and account numbers, and the trigger
amounts for forcing declines in its
[developer documentation](https://docs.nmi.com/docs/quick-start-tutorial). Those values
change occasionally, so read them from NMI rather than copying them out of a blog post.

For ACH specifically, a sandbox settlement will not arrive on its own schedule the way it
does in production. Test the settlement path by replaying a
`transaction.check.status.settle` event at your webhook endpoint with a valid signature and
the `order_id` set to the payment session id. Replay a `transaction.check.status.return` to
exercise the return path.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Payment Token does not exist` on a bank payment | The token was looked up in the card token space. `transact.php` defaults `payment` to `creditcard`. | Make sure `payment_method` is `"ach"` on the session, and that you are using `pp_nmi-ach` or `pp_nmi`, not `pp_nmi-card`. |
| `Invalid amount` | An amount arrived as something other than a plain number. Medusa's `BigNumber` stringifies to `NaN`. | The provider coerces every shape it knows about. If you write an amount onto the session yourself, write a plain number of dollars. |
| Fields render but the form is dead after switching payment method | Collect.js was configured twice on one page. | Render only the selected method's component so the other unmounts. See [Mount one form at a time](#mount-one-form-at-a-time). |
| Full-screen Next.js error about `PaymentRequestAbstraction` | Collect.js probing for wallet support that the account does not have. | Harmless. `use-collect-js.ts` filters it in development. |
| Typed text invisible inside the fields | The iframe document's own background is white. | Set `background-color` and `color` in `customCss.base`. |
| Your font does not apply to the inputs | Fonts do not cross the iframe boundary. | Pass `googleFont` and reference the family in `customCss.base`. |
| Webhook returns 200 but nothing happens | Signature verification failed, which returns `not_supported`. | Confirm `webhookSecret` matches the portal, and that no proxy is rewriting the raw body. |
| ACH payments stay `authorized` forever | No settlement webhook reaching the route, or the event arriving carries no `order_id` — Medusa ignores any event it cannot tie to a session. | Subscribe to `transaction.check.status.settle` and point it at `/hooks/payment/nmi-ach`. |
| `authorizePayment` returns `pending` | No `payment_token` on the session. | The storefront never wrote the token back, or wrote it to a different provider's session. |

## Not supported yet

Saved cards, meaning NMI's Customer Vault. Medusa's account holder methods are implemented
as no-ops around a synthetic id, so the checkout step that expects them succeeds, but
nothing is stored at NMI and shoppers re-enter their details each time. Adding it is
straightforward and has simply not been needed yet.

Multi-currency stores need a second look. The provider does not send a `currency` field to
`transact.php`, so every charge settles in whatever currency your NMI account is configured
for, regardless of the cart's currency. A cart priced at 40 EUR is submitted as an amount of
40.00 and charged as 40 of the account currency. If you sell in one currency, which is the
common case, this is exactly right and there is nothing to do. If you sell in several, treat
this plugin as single-currency for now and open an issue.

The shipped storefront components hardcode `country: "US"` and `currency: "USD"` in the
Collect.js config. Those two values feed NMI's Apple Pay and Google Pay payment request and
are inert for the card and ACH fields, which pass `paymentType: "cc"` or `"ck"` and never
build a wallet request. Change them when you copy the files if you sell elsewhere or if you
surface wallets through Collect.js.

## Local development

```bash
npm install     # runs medusa plugin:build via prepare
npm run dev     # medusa plugin:develop, watches and publishes to the local registry
npm test        # vitest
npm run typecheck
```

To try local changes inside a real Medusa app, use the
[local plugin workflow](https://docs.medusajs.com/learn/fundamentals/plugins/create#3-publish-plugin-locally-for-development-and-testing):

```bash
# in this repo
npx medusa plugin:publish

# in your Medusa app
npx medusa plugin:add medusa-payment-nmi
```

## Disclaimer

This is an independent plugin. The author is not affiliated with, endorsed by, or
supported by NMI or Network Merchants LLC, and "NMI" is their trademark, used here only to
say what the plugin talks to.

The documentation above was written from two sources: this plugin's own source code and
NMI's public developer documentation. Gateway behavior can differ by merchant account,
processor, and portal configuration, and NMI's documentation is the authority on their
side of the integration. Where this README and NMI disagree, believe NMI and your own
sandbox. For support with the gateway itself, contact NMI. For problems with the plugin,
open an issue on this repository.

## License

MIT
