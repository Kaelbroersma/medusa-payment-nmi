"use client"
/**
 * Inline hosted ACH/eCheck fields for the `nmi-ach` provider (Collect.js).
 * Account name / routing / account number live in NMI's iframes; the
 * checking-vs-savings and personal-vs-business selectors are plain form
 * state, merged into the onToken payload so the backend can pass them to
 * NMI (sec_code handling). Write the payload onto the Medusa payment
 * session and complete the cart.
 */
import { forwardRef, useImperativeHandle, useState } from "react"
import { useCollectJs, type CollectJsResponse } from "./use-collect-js"
import type { NmiFieldsHandle } from "./NmiCardFields"

export type NmiAchTokenData = {
  payment_token: string
  payment_method: "ach"
  account_type: "checking" | "savings"
  account_holder_type: "personal" | "business"
}

type Session = { data?: { tokenizationKey?: string; sandbox?: boolean } }

export const NmiAchFields = forwardRef<
  NmiFieldsHandle,
  {
    session: Session
    onToken: (data: NmiAchTokenData) => void
    customCss?: Parameters<typeof useCollectJs>[0]["customCss"]
    className?: string
    fieldClassName?: string
    labelClassName?: string
    selectClassName?: string
  }
>(function NmiAchFields(
  { session, onToken, customCss, className, fieldClassName, labelClassName, selectClassName },
  ref
) {
  const [accountType, setAccountType] = useState<"checking" | "savings">("checking")
  const [holderType, setHolderType] = useState<"personal" | "business">("personal")

  const { ready, isValid, error, requestToken } = useCollectJs({
    tokenizationKey: session?.data?.tokenizationKey,
    sandbox: session?.data?.sandbox,
    fields: {
      checkname: { selector: "#nmi-checkname", placeholder: "Name on account" },
      checkaba: { selector: "#nmi-checkaba", placeholder: "Routing number" },
      checkaccount: { selector: "#nmi-checkaccount", placeholder: "Account number" },
    },
    paymentType: "ck",
    customCss,
    onToken: (response: CollectJsResponse) =>
      onToken({
        payment_token: response.token,
        payment_method: "ach",
        account_type: accountType,
        account_holder_type: holderType,
      }),
  })

  useImperativeHandle(ref, () => ({ requestToken, isValid }), [requestToken, isValid])

  if (!session?.data?.tokenizationKey) {
    return <div className="nmi-pay-error">Payment session not ready.</div>
  }

  return (
    <div className={className} aria-busy={!ready}>
      <label className={labelClassName} htmlFor="nmi-checkname">
        Name on account
      </label>
      <div id="nmi-checkname" className={fieldClassName} />
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label className={labelClassName} htmlFor="nmi-checkaba">
            Routing number
          </label>
          <div id="nmi-checkaba" className={fieldClassName} />
        </div>
        <div style={{ flex: 1 }}>
          <label className={labelClassName} htmlFor="nmi-checkaccount">
            Account number
          </label>
          <div id="nmi-checkaccount" className={fieldClassName} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label className={labelClassName} htmlFor="nmi-account-type">
            Account type
          </label>
          <select
            id="nmi-account-type"
            className={selectClassName}
            value={accountType}
            onChange={(e) => setAccountType(e.target.value as "checking" | "savings")}
          >
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label className={labelClassName} htmlFor="nmi-holder-type">
            Account holder
          </label>
          <select
            id="nmi-holder-type"
            className={selectClassName}
            value={holderType}
            onChange={(e) => setHolderType(e.target.value as "personal" | "business")}
          >
            <option value="personal">Personal</option>
            <option value="business">Business</option>
          </select>
        </div>
      </div>
      {error ? <div className="nmi-pay-error">{error}</div> : null}
    </div>
  )
})

export default NmiAchFields
