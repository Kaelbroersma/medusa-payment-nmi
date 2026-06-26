# Storefront integration (Medusa v2 / Next.js)

Two copy-paste components for your checkout payment step:

- `NmiHostedFields.tsx` — card, via NMI Collect.js (PCI SAQ-A-EP; the PAN is tokenized
  client-side and never touches your storefront or backend).
- `NmiAchForm.tsx` — ACH / eCheck bank debit, also via Collect.js.

Both take the active **payment session** and an `onToken` callback. In `onToken`, write
the returned `payment_token` onto the payment session's `data` and then complete the cart.

## Wiring

```tsx
import { sdk } from "@lib/config"

async function setSessionData(cartId: string, providerId: string, data: Record<string, unknown>) {
  await sdk.store.payment.initiatePaymentSession(cart, { provider_id: providerId, data })
}

async function completeCart(cartId: string) {
  const res = await sdk.store.cart.complete(cartId)
  if (res.type === "order") window.location.href = `/order/confirmed/${res.order.id}`
}

{session.provider_id === "pp_nmi-card_nmi-card" && (
  <NmiHostedFields
    session={session}
    onToken={async (payment_token) => {
      await setSessionData(cart.id, session.provider_id, { payment_token })
      await completeCart(cart.id)
    }}
  />
)}

{session.provider_id === "pp_nmi-ach_nmi-ach" && (
  <NmiAchForm
    session={session}
    onToken={async (data) => {
      await setSessionData(cart.id, session.provider_id, data)
      await completeCart(cart.id)
    }}
  />
)}
```

> Provider ids follow Medusa's `pp_<provider>_<id>` scheme. Confirm yours from
> `GET /store/payment-providers`.

## Minimal styles

```css
.nmi-pay-grid { display:grid; grid-template-columns:2fr 1fr 1fr; gap:12px; }
.nmi-field { border:1px solid #d1d5db; border-radius:8px; padding:6px 10px; min-height:44px; }
.nmi-input { width:100%; border:1px solid #d1d5db; border-radius:8px; padding:10px 12px; margin-bottom:10px; }
.nmi-submit { width:100%; padding:12px; border-radius:8px; background:#111827; color:#fff; font-weight:700; border:0; cursor:pointer; margin-top:12px; }
.nmi-submit:disabled { opacity:.5; cursor:not-allowed; }
.nmi-ach-note { font-size:12px; color:#6b7280; } .nmi-pay-error { color:#dc2626; font-size:13px; }
```
