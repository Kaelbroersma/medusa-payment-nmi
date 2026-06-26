# Storefront integration (Medusa v2 / Next.js)

One copy-paste component for your checkout payment step, built on NMI's official
React component — it renders **card, ACH, and Apple/Google Pay** in a single element.

- `NmiPaymentElement.tsx` — wraps `<NmiPayments>` from `@nmipayments/nmi-pay-react`.

The card PAN / bank number is tokenized inside NMI's secure fields and never touches your
storefront or backend. On a completed payment, the component yields a single-use token;
the wrapper derives the method (ACH vs card/wallet) and hands you both so you can write
them onto the Medusa payment session and complete the cart.

## Install

```bash
npm install @nmipayments/nmi-pay-react
```

## Wiring

```tsx
import { sdk } from "@lib/config"
import NmiPaymentElement from "./NmiPaymentElement"

async function setSessionData(cart: any, providerId: string, data: Record<string, unknown>) {
  await sdk.store.payment.initiatePaymentSession(cart, { provider_id: providerId, data })
}

async function completeCart(cartId: string) {
  const res = await sdk.store.cart.complete(cartId)
  if (res.type === "order") window.location.href = `/order/confirmed/${res.order.id}`
}

{session.provider_id === "pp_nmi" && (
  <NmiPaymentElement
    session={session}
    onToken={async (data) => {
      await setSessionData(cart, session.provider_id, data)
      await completeCart(cart.id)
    }}
  />
)}
```

> Provider id follows Medusa's `pp_<provider>` scheme → `pp_nmi`. Confirm yours from
> `GET /store/payment-providers`.

## Card vs ACH

The single `nmi` backend provider runs the right lifecycle from the `payment_method`
the wrapper writes onto the session:

- **card / Apple Pay / Google Pay** → authorized (or captured) synchronously.
- **ACH** → submitted now as *authorized*; the settlement webhook captures it, an ACH
  return fails it.

## Minimal styles

```css
.nmi-pay-error { color:#dc2626; font-size:13px; }
```

The `<NmiPayments>` component ships its own field styling; pass an `appearance` prop to
customize it (see NMI's component docs).
