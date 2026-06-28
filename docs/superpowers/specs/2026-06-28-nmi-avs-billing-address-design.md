# NMI AVS / Billing Address — Design

Date: 2026-06-28
Status: Approved (build)
Repos: `medusa-payment-nmi` (this repo, branch `feat/avs`) + `my-store` storefront

## Problem

The NMI provider charges a Collect.js `payment_token` via `transact.php` but sends
**no billing address fields**. With no `address1`/`zip`/etc. in the POST, NMI's
Address Verification Service (AVS) has nothing to evaluate, so AVS-based fraud
rules and decline filters never fire. For an NFA/suppressor store this is a
meaningful fraud-control gap. CVV is already covered (captured inside the token);
the gap is specifically address verification.

## Goal / Non-goals

**Goal:** every card and ACH `sale`/`auth` POST to `transact.php` carries the
cardholder billing address so NMI's portal-configured AVS rules can evaluate it,
and the returned `avsresponse` / `cvvresponse` are recorded on the payment for
observability.

**Non-goals:**
- No accept/reject logic in code. **Enforcement lives in the NMI Merchant Portal**
  (configurable AVS reject rules) — chosen for adaptability without redeploys. A
  hard AVS reject surfaces as `response=2`, which the existing `assertApproved`
  path already turns into a decline.
- No checkout UI work. A separate effort is adding a dedicated billing-address
  step + "same as shipping" toggle; this design consumes whatever
  `cart.billing_address` holds.
- No card vaulting changes.

## Key constraint discovered

Medusa's cart-completion calls `authorizePaymentSessionStep({ id })` with **no
context**, and the payment module forwards only
`{ data: session.data, context: { idempotency_key } }` to the provider. So
`context.customer.billing_address` is **empty at authorize time** — the
framework-native channel is unusable here. The payment session's stored `data`
is the only reliable channel, so the billing address must be threaded into
session `data` server-side (mirroring how `payment_token` already flows).

## Data flow

```
checkout (separate effort) -> cart.billing_address          [trusted, server-side]
  -> submitPayment() reads cart.billing_address, adds billing.* to session data
    -> session.data { payment_token, payment_method, amount, billing }
      -> provider.authorizePayment(input.data) -> client.transact({ billing })
        -> buildChargeParams() emits NMI AVS keys -> transact.php
          -> NMI portal AVS rules decide; avsresponse/cvvresponse returned
            -> stored on payment.data; a hard AVS reject = response 2 -> decline
```

The browser contract is unchanged — it still sends only
`{ payment_token, payment_method }`. The address is read from the trusted,
server-side cart, never from the client.

## Changes

### A. Storefront — `apps/storefront/src/lib/data/checkout.ts` (my-store, not git)
In `submitPayment`, after `retrieveCart()`, read `cart.billing_address` and add a
`billing` object to the `initiatePaymentSession` `data`. Omit it entirely if the
cart has no billing address (AVS no-ops for that order rather than erroring).
Map Medusa address -> a flat billing shape:
`first_name, last_name, company?, address_1, address_2?, city, province,
postal_code, country_code, phone?` plus `cart.email`.

### B. Client — `medusa-payment-nmi/src/lib/nmi-client.ts`
- Add optional `billing?: NmiBilling` to `ChargeParamsInput`.
- In `buildChargeParams`, when `billing` is present, emit NMI keys:
  `firstname, lastname, company?, address1, address2?, city, state, zip,
  country, email?, phone?`. Only the card/ACH `sale`/`auth` path passes billing;
  `capture`/`refund`/`void` (transaction-id only) never do.
- Normalize `country` to upper-case 2-char (`us` -> `US`); skip empty/undefined
  fields rather than sending blanks.

`NmiBilling` shape (provider maps Medusa -> this):
`{ firstName, lastName, company?, address1, address2?, city, state, zip,
country?, email?, phone? }`.

### C. Provider — `medusa-payment-nmi/src/providers/nmi.ts`
- In `authorizePayment`, read `input.data.billing` and pass it to
  `client.transact(...)` on **both** the card and ACH branches (AVS is card-only
  at NMI; sending address on ACH is harmless and aids fraud scoring).
- Record `avs_response: txn.avsresponse` and `cvv_response: txn.cvvresponse` onto
  the returned `data` (alongside existing `raw`) for queryable observability.

### D. Errors — none needed
`assertApproved` already attaches the full result as `NmiError.raw`, so
`avsresponse`/`cvvresponse` on a decline are already reachable via `error.raw`.

## Testing

- `buildChargeParams`: new unit tests (vitest, matching `nmi-client.test.ts`) —
  emits all AVS keys when `billing` present; uppercases country; omits absent
  optional fields; emits nothing when `billing` absent; never emitted for
  `capture`/`refund`/`void`.
- Provider mapping covered by reasoning + the client tests (no existing provider
  test harness; keep the mapping a thin pass-through).

## Consumption / rollout

1. Implement B/C on `feat/avs`, commit, push.
2. Repoint `my-store` backend dep to
   `github:Kaelbroersma/medusa-payment-nmi#feat/avs`; reinstall (the package's
   `prepare` script runs `tsup`, building `.medusa/server`).
3. Apply storefront change A.
4. Configure AVS reject rules in the NMI Merchant Portal (operational step,
   outside this repo).

## Open dependency

AVS quality depends on `cart.billing_address` being a real card-billing address
(the separate checkout effort). Until then it evaluates the shipping copy; the
code is order-correct regardless.
