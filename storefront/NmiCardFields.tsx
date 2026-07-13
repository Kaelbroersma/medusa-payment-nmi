"use client"
/**
 * Inline hosted card fields for the `nmi-card` provider (Collect.js).
 * You own the layout and labels; NMI's iframes fill the field divs, so the
 * PAN never touches your storefront. Trigger tokenization from your Place
 * Order button via the forwarded ref's requestToken(); the single-use token
 * arrives in onToken — write it onto the Medusa payment session as
 * { payment_token, payment_method: "card" } and complete the cart.
 */
import { forwardRef, useImperativeHandle } from "react"
import { useCollectJs, type CollectJsResponse } from "./use-collect-js"

export type NmiFieldsHandle = {
  /** Tokenize the fields; result arrives via onToken. */
  requestToken: () => void
  isValid: boolean
}

type Session = { data?: { tokenizationKey?: string; sandbox?: boolean } }

export const NmiCardFields = forwardRef<
  NmiFieldsHandle,
  {
    session: Session
    onToken: (data: { payment_token: string; payment_method: "card" }) => void
    /** Optional Collect.js CSS for the inputs inside NMI's iframes. */
    customCss?: Parameters<typeof useCollectJs>[0]["customCss"]
    className?: string
    fieldClassName?: string
    labelClassName?: string
  }
>(function NmiCardFields(
  { session, onToken, customCss, className, fieldClassName, labelClassName },
  ref
) {
  const { ready, isValid, error, requestToken } = useCollectJs({
    tokenizationKey: session?.data?.tokenizationKey,
    sandbox: session?.data?.sandbox,
    fields: {
      ccnumber: { selector: "#nmi-ccnumber", placeholder: "Card number" },
      ccexp: { selector: "#nmi-ccexp", placeholder: "MM / YY" },
      cvv: { selector: "#nmi-cvv", placeholder: "CVV" },
    },
    paymentType: "cc",
    customCss,
    onToken: (response: CollectJsResponse) =>
      onToken({ payment_token: response.token, payment_method: "card" }),
  })

  useImperativeHandle(ref, () => ({ requestToken, isValid }), [requestToken, isValid])

  if (!session?.data?.tokenizationKey) {
    return <div className="nmi-pay-error">Payment session not ready.</div>
  }

  return (
    <div className={className} aria-busy={!ready}>
      <label className={labelClassName} htmlFor="nmi-ccnumber">
        Card number
      </label>
      <div id="nmi-ccnumber" className={fieldClassName} />
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label className={labelClassName} htmlFor="nmi-ccexp">
            Expiration
          </label>
          <div id="nmi-ccexp" className={fieldClassName} />
        </div>
        <div style={{ flex: 1 }}>
          <label className={labelClassName} htmlFor="nmi-cvv">
            CVV
          </label>
          <div id="nmi-cvv" className={fieldClassName} />
        </div>
      </div>
      {error ? <div className="nmi-pay-error">{error}</div> : null}
    </div>
  )
})

export default NmiCardFields
