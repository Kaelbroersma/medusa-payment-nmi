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
- [ACH reconciliation](#ach-reconciliation)
- [Captures, refunds, and voids](#captures-refunds-and-voids)
- [Declines and what the buyer sees](#declines-and-what-the-buyer-sees)
- [Lost responses and the Query API](#lost-responses-and-the-query-api)
- [Finding a payment in the NMI portal](#finding-a-payment-in-the-nmi-portal)
- [Testing against the sandbox](#testing-against-the-sandbox)
- [Troubleshooting](#troubleshooting)
- [Not supported yet](#not-supported-yet)
- [Upgrading to 0.5](#upgrading-to-05)
- [Local development](#local-development)
- [Disclaimer](#disclaimer)

## Requirements

- Medusa `>= 2.5` (the package declares `@medusajs/framework` as a peer dependency)
- Node `>= 20`
- An NMI merchant account with two keys from the Merchant Portal: a private security key
  and a public tokenization key
- A third key, the webhook signing key, if you take ACH. Card and wallet payments do not
  need it
- The **Query API** permission on the security key. The plugin works without it, but it
  cannot then recover a charge whose response was lost. See
  [Lost responses and the Query API](#lost-responses-and-the-query-api)

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
              webhookSecret: process.env.NMI_WEBHOOK_SECRET, // ACH only
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

Copy `.env.example` for the variable names. The keys live in the NMI Merchant Portal under
Settings, in Security Keys and Webhooks. When you create the security key, give it the
Query API permission as well as the Payment API one.

### 2. Enable it for a region

Registering a provider does not expose it at checkout. Open the Medusa admin, go to
Settings, then Regions, pick a region, and add the NMI providers you want shoppers to
see. Most stores enable one or two.

### 3. Collect the payment details

Copy the components you need out of [`storefront/`](./storefront) into your Next.js app.
There are two collection styles and they are covered in detail under
[Collecting card and bank details](#collecting-card-and-bank-details).

### 4. Point NMI at your webhook (ACH only)

ACH will sit in `authorized` forever without this. See [Webhooks](#webhooks). A store that
takes only cards and wallets has no webhook to set up and can skip this step.

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
| `webhookSecret` | For ACH | | Webhook signing key, used to verify the HMAC on every inbound event. Without it ACH payments are refused and all webhooks are ignored. |
| `captureMethod` | No | `"auth"` | Card and wallet only. `"auth"` holds the funds, `"sale"` charges immediately. |
| `secCode` | No | `"WEB"` | ACH SEC code. `WEB`, `PPD`, `CCD`, or `TEL`. |
| `sandbox` | No | `false` | Routes both the API calls and the storefront's Collect.js script to `sandbox.nmi.com`. |
| `timeoutMs` | No | `60000` | How long to wait for NMI to answer a Payment API request before treating the response as lost. |

`securityKey` and `tokenizationKey` are validated at boot. A missing one throws a
`MedusaError` with the name of the option, so a bad deploy fails fast instead of failing at
the first checkout.

`webhookSecret` is not validated at boot, on purpose. Resolving the package root registers
all four providers with one block of options, so requiring the signing key there would stop
a card-only store from starting over a key it never uses. It is enforced where it matters
instead:

- With no `webhookSecret`, an ACH authorization is refused before anything is sent to NMI.
  An ACH debit is only finished by its settlement webhook, and a webhook that cannot be
  verified is never acted on, so the payment could never complete.
- With no `webhookSecret`, every inbound webhook is ignored. There is no mode in which an
  unsigned event is accepted.
- The plugin logs one warning at startup so the missing key is visible.

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
const [payError, setPayError] = useState<string | null>(null)

async function handleToken(data: Record<string, unknown>) {
  try {
    await sdk.store.payment.initiatePaymentSession(cart, {
      provider_id: "pp_nmi-card",
      data, // { payment_token, payment_method: "card" }
    })
    const res = await sdk.store.cart.complete(cart.id)
    if (res.type === "order") {
      window.location.href = `/order/confirmed/${res.order.id}`
      return
    }
    // A declined card is not an exception: Medusa answers 200 with the cart and
    // an error whose message is written for the buyer.
    setPayError(res.error?.message ?? "Your payment could not be completed.")
  } catch (e) {
    setPayError("Something went wrong placing your order. Please try again.")
  }
  setSubmitting(false)
}

{selected === "pp_nmi-card" && (
  <NmiCardFields
    ref={fieldsRef}
    session={activeSession}
    onToken={handleToken}
    onError={() => setSubmitting(false)} // tokenization failed or timed out
  />
)}
{payError && <p role="alert">{payError}</p>}

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
no token, if the request gets no answer within 15 seconds, or if Collect.js never loaded,
the components show an error message and call `onError`. Reset your "submitting" state
there. `onToken` does not fire in any of those cases, so a button that is only re-enabled
in `onToken` would stay disabled for good.

After a failed charge, tokenize again before the next attempt. The token is spent as soon
as it has been submitted once, whether or not the charge was approved.

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
| `ip_address` | Storefront, server side | Recommended | The buyer's IP address, sent to NMI as `ipaddress` for its fraud screening. Ignored unless it is a valid IPv4 or IPv6 address. |
| `order_description` | Storefront, server side | Optional | Free text shown against the transaction in the NMI portal, sent as `order_description` (255 characters at most). |

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
them queryable later. On a decline the gateway's response text and code are written to the
Medusa log, next to the payment session id.

The payment module gives the provider no request context either, so the buyer's IP address
has to travel the same way. Read it from the request headers in your server action and put
it on the session as `ip_address`; NMI recommends sending it.

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

**Webhooks are for ACH.** A card or wallet payment is decided inside the request that makes
it, so Medusa already knows the outcome and there is nothing for a webhook to add. An ACH
debit is accepted at checkout and settles, or comes back, days later; the webhook is the
only way Medusa finds out. If you do not take ACH you do not need to create a webhook in the
NMI portal at all, and you can leave `webhookSecret` unset.

Medusa exposes one webhook route per registered provider, at
`/hooks/payment/<identifier>`. Registering the package root creates all four:

| Provider | Route | Configure it in the portal? |
|---|---|---|
| `nmi-ach` | `POST https://<your-backend>/hooks/payment/nmi-ach` | Yes. ACH cannot complete without it. |
| `nmi` | `POST https://<your-backend>/hooks/payment/nmi` | Yes, if you take ACH through the unified provider. |
| `nmi-card` | `POST https://<your-backend>/hooks/payment/nmi-card` | No. Card events are ignored. |
| `nmi-wallet` | `POST https://<your-backend>/hooks/payment/nmi-wallet` | No. Wallet events are ignored. |

Setting an `id` on the provider config appends it to the path, so `id: "primary"` gives
`/hooks/payment/nmi-ach_primary` and so on.

In the NMI Merchant Portal, go to Settings then Webhooks and click Create. Enter your
receiver URL and pick the event types from the list, which is grouped by category — the ACH
events live under Check Status, not under Transactions. The signing key is generated by NMI
and shown on that same Webhooks settings page; copy it into `webhookSecret`. You do not
choose it. Once the URL is saved, delivery starts with no further setup.

Subscribe to:

```
transaction.check.status.settle
transaction.check.status.return
transaction.check.status.latereturn
transaction.sale.failure
```

The three `check.status` events are how an ACH payment finishes. Each carries `order_id`,
`transaction_id`, and the amount at `action.amount`, so they match back to a payment
session. Subscribing to more event types does no harm; the provider ignores them.

### How events are interpreted

| NMI event | Card or wallet | ACH |
|---|---|---|
| `transaction.check.status.settle` | — | captured |
| `transaction.check.status.return` | — | failed |
| `transaction.check.status.latereturn` | — | failed |
| `transaction.sale.failure` | ignored | failed (rejected at submission) |
| `transaction.sale.success`, `transaction.auth.success`, `transaction.capture.success` | ignored | ignored |
| `transaction.refund.success`, `transaction.void.success` | ignored | ignored |
| `settlement.batch.complete` | ignored | ignored |

Before 0.5.0 the transaction events were mapped too. They are ignored now because they could
only do harm:

- `sale.success`, `auth.success` and `capture.success` describe something Medusa was told in
  the response to its own request. The event arrives about five seconds later and can only
  race it. If the payment row is not written yet, Medusa's payment workflow authorizes the
  session a second time. If the cart failed to complete and the charge was voided, it tries
  to complete the cart again against the voided payment.
- `refund.success` was mapped to `captured`. NMI's sample for that event has an empty
  `order_id` and a negative amount, so it either matched nothing or asked Medusa to capture
  a negative amount. It never recorded a refund.
- `void.success` was mapped to `canceled`, which Medusa's webhook subscriber discards.
- `settlement.batch.complete` is a card batch total with no `order_id` at any level.

**A refund or void made in the NMI portal is not reflected in Medusa.** Nothing in this
plugin, and nothing in Medusa's webhook handling, turns a portal refund into a Medusa
refund. Refund and cancel from the Medusa admin, which calls NMI for you, so the two stay
in step.

An event is also ignored when its `order_id` is not a Medusa payment session id (they start
with `payses_`). That keeps transactions made by another system on the same NMI account out
of Medusa's payment workflow.

Every request is verified before any of that happens. NMI signs with a
`Webhook-Signature: t=<nonce>,s=<signature>` header, and the handler recomputes
`HMAC-SHA256(nonce + "." + rawBody)` with your signing key, hex encoded, and compares in
constant time. That is the scheme in NMI's own
[validation sample](https://docs.nmi.com/reference/overview). The event is then read from
the same bytes that were verified. A mismatch returns `not_supported`, which means the event
is ignored, and a warning is logged. If a webhook seems to do nothing at all, check the
signing key first, then check that nothing in front of Medusa is re-encoding the request
body.

NMI requires a public HTTPS endpoint with valid TLS, so for local development tunnel to
your backend with `cloudflared` or `ngrok`.

### Delivery, retries, and why a 200 means less than you think

NMI treats an HTTP 200 as success. Anything else is retried up to 20 times over roughly
three days — a few seconds apart at first, then minutes, then hourly, then twice daily —
after which the event is dropped permanently. NMI cautions that the exact schedule may
change, so do not encode it. Because the same event can arrive more than once, anything you
build on these events should be idempotent.

The catch: Medusa's hook route answers 200 as soon as it hands the event to the event bus,
before any signature check or mapping happens. So an event with a bad signature, or one
this provider does not map, is still a 200 to NMI. **Retries will never fire for a webhook
your backend accepted and then ignored** — if something is silently dropping events, NMI's
delivery log will show success and tell you nothing. Debug from the Medusa side.

That route also delays processing by 5 seconds and retries internally 3 times. Both are
tunable through the payment module's `webhook_delay` and `webhook_retries` options if you
need different behaviour.

> **On asynchronous outcomes.** Medusa's built-in payment webhook subscriber acts on the
> `authorized` and `captured` outcomes. ACH settlement therefore works out of the box.
> Returns are detected and mapped to `failed` by this provider, but a `failed` webhook
> outcome does not transition the payment in current Medusa core. If you need automated
> reconciliation for returns, subscribe to the `payment.webhook_received` event and handle
> it yourself. See [ACH reconciliation](#ach-reconciliation).

## ACH reconciliation

Medusa's payment status is a card state machine. `authorized` means funds are held and
`captured` means the money moved and the matter is closed. Neither is true of a bank debit,
so this provider maps ACH onto the closest available states and you have to supply the rest:

| Reality | What the plugin reports | What it actually means |
|---|---|---|
| Debit submitted | `authorized` | Money requested. Nothing is held and nothing has moved. |
| Settled | `captured` | Money moved, and can still be clawed back for up to 60 days. |
| Returned | `failed` — **dropped by core** | Money came back. Nothing in Medusa changes on its own. |

Two consequences worth designing around.

**Nothing stops you shipping an unsettled order.** Medusa does not gate fulfillment on
payment status — `create-fulfillment` contains no `payment_status` check. An ACH order is
fulfillable the moment it is placed, days before anyone knows whether the money arrives.

**Clicking Capture on an ACH payment lies.** The provider sends nothing, but Medusa still
stamps `captured_at`, so the order reads as paid while the debit is in flight. The provider
cannot refuse the click, because the settlement webhook captures through the same method
and Medusa passes no way to distinguish the callers. Do not press Capture on ACH; let the
webhook do it.

So gate on the ACH lifecycle rather than on payment status. Subscribe to
`payment.webhook_received`, classify with the exported helpers, and record the outcome
somewhere your fulfillment path can read:

```ts
// src/subscribers/ach-reconciliation.ts
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { verifySignature, classifyAchEvent, extractSessionId } from "medusa-payment-nmi"

export default async function achReconciliation({ event, container }: SubscriberArgs<any>) {
  const { payload } = event.data
  const raw = Buffer.isBuffer(payload.rawData)
    ? payload.rawData.toString("utf8")
    : String(payload.rawData)

  // Re-verify: this subscriber sees every webhook, not just ours.
  const header = payload.headers?.["webhook-signature"]
  if (!verifySignature(process.env.NMI_WEBHOOK_SECRET!, raw, header)) return

  const body = JSON.parse(raw)
  const state = classifyAchEvent(body.event_type)
  if (!state) return

  const sessionId = extractSessionId(body.event_body ?? {})
  if (!sessionId) return

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: payments } = await query.graph({
    entity: "payment",
    fields: ["id", "payment_collection_id"],
    filters: { payment_session_id: sessionId },
  })
  if (!payments.length) return

  // Resolve the order from the payment collection, then act on `state`:
  //   settled       -> mark fulfillable
  //   returned      -> cancel if unfulfilled (frees the reservation), else raise a claim
  //   late_returned -> alert only; the order is long closed
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  logger.warn(`NMI ACH ${state} for payment session ${sessionId}`)
}

export const config: SubscriberConfig = { event: "payment.webhook_received" }
```

The order lookup from a payment collection differs across Medusa 2.x minors, so verify that
traversal against your version rather than copying it blind.

On a return, cancelling an unfulfilled order is usually the right move: `cancel-order`
runs `deleteReservationsByLineItemsStep`, which frees the inventory the order was holding.
It also runs `cancelPaymentStep` against uncaptured payments, which would try to void a
debit that has already come back — this provider tolerates that failure for ACH and records
`void_failed` on the payment data rather than blocking the cancellation. If the order was
already fulfilled there is no reservation to release and cancelling is not appropriate;
that case needs a claim and a human.

That tolerance is checked against NMI. When an ACH void fails, the provider asks the Query
API what state the transaction is in. If the debit is still pending settlement or has
settled, the cancellation is refused: letting it through would cancel the order while the
buyer is still charged. If the transaction has failed or is already voided, the cancellation
goes ahead. If the state cannot be read, because the security key has no Query permission,
the cancellation goes ahead as before and an error is logged asking you to confirm the
debit in the portal.

## Captures, refunds, and voids

**Capture** sends an NMI `capture` against the stored `transactionid`, for the amount that
was authorized. Medusa does not pass a capture amount to payment providers, so a capture is
always for the full authorization; a partial capture entered in Medusa still captures the
whole amount at NMI. For ACH capture is a no-op, since settlement is what captures those —
and pressing it anyway records a misleading capture. See
[ACH reconciliation](#ach-reconciliation).

**Refund** of the whole payment, when nothing has been refunded on it before, is sent as a
**void first**. Before the settlement batch runs a void removes the charge altogether. A
refund at that point is accepted by NMI too, but it lets both the sale and a credit settle:
the buyer sees a charge followed by a credit, and you normally pay processing on the sale.
Medusa's admin only offers Refund once a payment is captured, which in `"sale"` mode is
always, so the provider makes the choice for you. If NMI refuses the void, which is what it
does once the transaction has settled, the provider sends an ordinary `refund` for the
amount. A payment reversed by void is marked `voided: true` on `payment.data` so you can
tell the two apart afterwards.

Partial refunds are always sent as a `refund`, because a void is all or nothing. So is any
refund after the first one on a payment.

Two limits. The provider needs to know the original amount to recognise a full refund, and
it records that on the payment from 0.5.0 onward; a payment authorized by an earlier version
is refunded directly, with no void attempt. And if the void's own response is lost, the
provider does not follow it with a refund unless NMI shows the transaction as settled, for
the reason given under [Lost responses](#lost-responses-and-the-query-api).

**Cancel** sends a void, which is the correct pre-settlement reversal. If the void fails
and NMI reports the transaction as already voided, the cancellation succeeds. If NMI reports
it as settled, the error says to refund it instead.

A void or refund of an ACH payment is sent with `payment=check`. NMI assumes a card
transaction otherwise.

When any of these fails, the admin sees NMI's reason in the error rather than a generic
message.

## Declines and what the buyer sees

A declined card is not a crash. The provider throws a `MedusaError` of type
`payment_authorization_error`, which Medusa's cart-completion route returns to the
storefront with HTTP 200:

```json
{ "type": "cart", "cart": { }, "error": { "type": "payment_authorization_error", "message": "Your card was declined for insufficient funds. Please use a different card." } }
```

Show `error.message` to the buyer. It is written for them and it never repeats the
gateway's text, because issuer responses include things like "pick up card" and "stolen
card" that should not be put in front of the person holding the card.

| Situation | What the buyer is told |
|---|---|
| Insufficient funds, over limit | That, plainly. |
| Bad card number, expiry, or CVV | Which of the three to check. |
| Any other issuer decline, including lost, stolen, and fraud responses | "Your card was declined. Please use a different card or contact your bank." |
| Gateway rejection (AVS or CVV rules you set in the portal) | To check the card details and billing address. |
| Gateway or processor error | A generic "could not process", with no suggestion that the card is at fault. |
| Rate limited | To wait a minute. |
| Duplicate transaction rejected by NMI | To contact you before trying again. |
| Outcome unknown | Not to try again, and to contact you. See below. |

The gateway's own response text and code go to the Medusa log with the payment session id.
`buyerMessageFor` and `NmiError` are exported if you want to produce the same messages
elsewhere.

After a decline the token is spent. Tokenize again before the next attempt.

## Lost responses and the Query API

NMI's Payment API has no idempotency key. If a sale is sent and the response never arrives,
because of a timeout, a dropped connection, an HTTP 5xx, or NMI's own "communication error"
codes 420 and 421, the plugin does not know whether the card was charged. Treating that as a
failure is how a buyer gets charged for an order that does not exist.

So a lost response is never treated as a failure, and a sale is never blindly sent again.
The plugin asks NMI what happened, through the Query API, using the `orderid` it sent with
the charge:

| What the lookup shows | Result |
|---|---|
| An approved transaction for that order id and amount | It is used as the result. The order completes normally. |
| A failed or voided transaction | The payment fails, with the decline reason if there is one. |
| No transaction, after three lookups over a few seconds | The payment fails. Nothing was charged, and the buyer can try again. |
| A transaction NMI itself marks `unknown`, or one for a different amount | Outcome unknown. See below. |

**This needs the Query API permission on your security key.** Check it under Settings,
Security Keys in the Merchant Portal. If the lookup is refused, the plugin logs an error
naming the permission and falls back to sending the request again. That is safe for a
charge, because the payment token is single-use and a second submission can never produce a
second charge, but it is less informative: if the re-send is rejected, the most likely
reason is that the first attempt used the token, which means the first attempt went through.
That case is reported as an unknown outcome.

**Outcome unknown** means the plugin could not establish whether money moved. It logs a line
starting `[nmi] OUTCOME UNKNOWN` with the session or transaction id, the buyer is told not
to try again and to contact you, and no order is created. Search the NMI portal for the
session id and void the transaction if it is there.

The same rule covers the other operations:

- **Void and capture** are looked up by transaction id. If the transaction is already in the
  state the call was trying to reach, the call is treated as done; otherwise it is retried,
  up to three attempts in all.
- **Refund** is never retried and never guessed at. A refund creates a new transaction, so a
  second attempt after a lost response could refund twice. The admin sees an "outcome
  unknown" error and should check the portal before refunding again.
- **The void that a full refund tries first** follows the void rule above. If it still cannot
  be resolved, the provider checks the transaction once more: voided means the refund is
  done, settled means the void cannot have applied and a refund is sent, and anything else is
  reported as an unknown outcome with no refund sent. A void that did land followed by a
  refund would return the money twice.
- A request that provably never left the server (DNS failure, connection refused) is simply
  retried, for every operation.

What is not retried: any definitive answer from NMI, including 430 (duplicate at processor),
440 and 441 (format errors), which earlier versions retried to no purpose; and a rate limit,
which NMI reports as `response_code` 301 or HTTP 429 and asks you not to retry immediately.

If your account has duplicate transaction checking switched on in the portal, leave it on.
It is a second line of defence for the one case the plugin cannot close by itself, a buyer
who retries by hand after an unknown outcome.

## Finding a payment in the NMI portal

NMI is sent the Medusa payment session id (`payses_...`) as the order id, and again as
merchant defined field 1. It is not the Medusa order number: the charge happens before the
order exists. To get from a portal transaction to an order, look up the payment whose
`payment_session_id` matches, or search the other way with the `transactionid` stored on
`payment.data`. If you want something readable in the portal, put `order_description` on the
session data, for example the cart's display id or the buyer's email.

## Testing against the sandbox

Set `sandbox: true` and both sides switch hosts together. The backend talks to
`sandbox.nmi.com/api/transact.php`, and because `initiatePayment` puts the flag on the
session, the storefront components load Collect.js from `sandbox.nmi.com` too. Use the keys
from your sandbox account, not your live ones.

NMI keeps the current test card numbers, test routing and account numbers, and the trigger
amounts for forcing declines in its
[developer documentation](https://docs.nmi.com/docs/quick-start-tutorial). Those values
change occasionally, so read them from NMI rather than copying them out of a blog post.

A live account can also be put into Test Mode in the Merchant Portal. That uses your live
keys with `sandbox: false`, so it exercises the real hosts and your real key permissions,
including the Query API one.

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
| Buyer sees "Bank payments are not available right now" | `webhookSecret` is not set, so ACH is refused. | Set the signing key from Settings, Webhooks. |
| Log line `The Query API lookup failed` | The security key has no Query API permission, or the Query API was unreachable. | Enable the Query permission on the key. |
| Log line `[nmi] OUTCOME UNKNOWN` | A response was lost and the transaction could not be confirmed either way. | Search the NMI portal for the id in the log line and void or keep the transaction by hand. |
| Buyer told "do not try again yet" | Same as above. | Same as above; then tell the buyer whether they were charged. |
| Admin Cancel fails with "still live at NMI" | The void was rejected and NMI reports the transaction as pending or settled. | If it has settled, refund it instead. |
| A refund or void made in the NMI portal does not show in Medusa | Card and wallet webhooks are ignored, by design. | Refund or cancel from the Medusa admin. |

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

## Upgrading to 0.5

No configuration change is required. What behaves differently:

- **0.5.1: a full refund is tried as a void first**, then as a refund if NMI refuses the
  void. 0.5.0 and earlier sent the refund first and only fell back to a void if it was
  rejected, but NMI accepts a refund of an unsettled sale, so the void never ran. See
  [Captures, refunds, and voids](#captures-refunds-and-voids).

- **`webhookSecret` is optional.** A card-only store can remove it. Without it ACH is
  refused and webhooks are ignored.
- **Card and wallet webhooks are ignored.** If you pointed NMI at `/hooks/payment/nmi-card`
  or `/hooks/payment/nmi-wallet`, you can delete those webhooks in the portal. The ACH
  check-status mapping is unchanged. `mapNmiEvent` now returns `null` for the transaction
  and settlement-batch events.
- **A failed charge throws a `MedusaError`**, type `payment_authorization_error`, with a
  message for the buyer. The `NmiError` is on its `cause`. Storefronts that showed a generic
  failure should show `error.message` from the cart-completion response.
- **Give the security key the Query API permission.** See
  [Lost responses and the Query API](#lost-responses-and-the-query-api).
- **`isRetryableCode` is deprecated** in favour of `isAmbiguousCode`, and no longer matches
  430, 431, 440 or 441.
- **The storefront components gained an `onError` prop** and a 15 second tokenization
  timeout. They are templates you copied, so copy them again or port the change.
- **`payment.data` now includes `amount` and `session_id`.** Payments authorized before the
  upgrade do not have them; see the note under
  [Captures, refunds, and voids](#captures-refunds-and-voids).

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
NMI's public developer documentation. NMI's documentation gives only the sandbox address of
the Query API; the plugin uses `https://secure.nmi.com/api/query.php` for live accounts,
which answers as a Query API endpoint but is not stated in those pages. Gateway behavior can differ by merchant account,
processor, and portal configuration, and NMI's documentation is the authority on their
side of the integration. Where this README and NMI disagree, believe NMI and your own
sandbox. For support with the gateway itself, contact NMI. For problems with the plugin,
open an issue on this repository.

## License

MIT
