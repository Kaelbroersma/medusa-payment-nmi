# Storefront components

Copy these files into your Medusa v2 storefront. They are written for the Next.js App
Router, though nothing in them is framework specific beyond the `"use client"` directive.
Treat them as templates rather than a published package and edit them freely once they are
in your project.

The concepts behind them, including the session data contract, AVS, and the webhook setup,
live in the [root README](../README.md). This file is the component reference.

| File | Use with | Purpose |
|---|---|---|
| `use-collect-js.ts` | `nmi-card`, `nmi-ach` | Loads Collect.js and configures the inline hosted fields. |
| `NmiCardFields.tsx` | `nmi-card` | Card number, expiry, CVV. |
| `NmiAchFields.tsx` | `nmi-ach` | Name on account, routing, account number, plus account and holder type selects. |
| `NmiPaymentElement.tsx` | `nmi` | Wraps NMI's `<NmiPayments>` element: card, ACH, and wallets in one component. |

Mount exactly one of `NmiCardFields` and `NmiAchFields` at a time. Collect.js is a single
page-level global that cannot be configured twice, so let React unmount one before the
other appears. Hiding a mounted form with CSS will break tokenization.

## NmiCardFields and NmiAchFields

Both components render your labels and layout around empty `div`s that NMI fills with an
iframe per sensitive input. Neither renders a submit button. Tokenization is driven from
your existing Place Order button through the forwarded ref.

```tsx
const fieldsRef = useRef<NmiFieldsHandle>(null)

{selected === "pp_nmi-card" && (
  <NmiCardFields
    ref={fieldsRef}
    session={activeSession}
    onToken={async (data) => {
      await sdk.store.payment.initiatePaymentSession(cart, {
        provider_id: "pp_nmi-card",
        data, // { payment_token, payment_method: "card" }
      })
      await completeCart(cart.id)
    }}
  />
)}

<button
  disabled={!fieldsRef.current?.isValid}
  onClick={() => fieldsRef.current?.requestToken()}
>
  Place order
</button>
```

### Props

| Prop | Type | Notes |
|---|---|---|
| `session` | payment session | Read for `data.tokenizationKey` and `data.sandbox`. Renders a placeholder message until the key is there. |
| `onToken` | `(data) => void` | Fires once tokenization succeeds. Write `data` onto the session, then complete the cart. |
| `customCss` | `{ base?, focus?, invalid?, placeholder? }` | CSS applied inside NMI's iframes. Your own stylesheet cannot reach in. |
| `googleFont` | `string` | Font spec such as `"Inter:400"`, loaded inside the iframes. |
| `className`, `fieldClassName`, `labelClassName` | `string` | Applied to your wrapper, the field boxes, and the labels. |
| `selectClassName` | `string` | `NmiAchFields` only. Applied to the two selects. |

### Ref handle

| Member | Type | Notes |
|---|---|---|
| `requestToken()` | `() => void` | Starts tokenization. The result arrives through `onToken`. |
| `isValid` | `boolean` | True once every field reports valid and the iframes are installed. |

### onToken payload

`NmiCardFields`:

```ts
{ payment_token: string, payment_method: "card" }
```

`NmiAchFields`:

```ts
{
  payment_token: string,
  payment_method: "ach",
  account_type: "checking" | "savings",
  account_holder_type: "personal" | "business",
}
```

### Styling notes

The iframe document defaults to a white background and does not inherit your fonts. On a
dark checkout, set both `color` and `background-color` in `customCss.base` or the typed
text will look invisible. To match your site's typeface, pass `googleFont` and reference
the family in `customCss.base["font-family"]`.

```tsx
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
```

The hook configures Collect.js with `country: "US"` and `currency: "USD"`. Change those two
lines in `use-collect-js.ts` if you sell elsewhere.

## NmiPaymentElement

One element covering card, ACH, Apple Pay, and Google Pay, built on NMI's official React
package. It renders its own method picker and pay button, so there is no ref and no
external submit trigger.

```bash
npm install @nmipayments/nmi-pay-react
```

```tsx
import { sdk } from "@lib/config"
import NmiPaymentElement from "./NmiPaymentElement"

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

| Prop | Type | Notes |
|---|---|---|
| `session` | payment session | Read for `data.tokenizationKey`. |
| `onToken` | `(data) => void \| Promise<void>` | Receives `{ payment_token, payment_method }`. Card and both wallets report as `"card"`. |
| `onError` | `(e: unknown) => void` | Optional. Catches anything thrown inside `onToken`. |

Field styling comes from the `appearance` prop on `<NmiPayments>` rather than from
Collect.js CSS objects. Apple Pay and Google Pay have to be enabled in the NMI Merchant
Portal first, and Apple Pay also needs domain registration there.

## Provider ids

Medusa stores providers as `pp_<identifier>`, giving `pp_nmi`, `pp_nmi-card`,
`pp_nmi-ach`, and `pp_nmi-wallet`. Adding an `id` to the provider config appends it. Check
`GET /store/payment-providers` for what your store actually exposes.

## Minimal error style

The components render errors into `.nmi-pay-error`:

```css
.nmi-pay-error { color: #dc2626; font-size: 13px; }
```
