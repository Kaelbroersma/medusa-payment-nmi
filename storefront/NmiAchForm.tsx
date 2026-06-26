"use client"
/**
 * NMI Collect.js — ACH / eCheck payment element for a Medusa v2 storefront.
 *
 * Collect.js tokenizes the bank account into a single-use `payment_token`. We write
 * the token plus account_type/account_holder_type onto the payment session, then
 * complete the cart. The nmi-ach provider submits the debit (authorized); the
 * settlement webhook later captures or fails it.
 *
 * ACH is asynchronous: the order is placed as "authorized", not captured. Make that
 * clear to the customer (funds settle in 1–4 business days).
 */
import { useEffect, useRef, useState } from "react"

declare const CollectJS: any

type Session = {
  id: string
  data?: { tokenizationKey?: string; collectScriptUrl?: string }
}

export function NmiAchForm({
  session,
  onToken,
  onError,
}: {
  session: Session
  /** Write { payment_token, account_type, account_holder_type } onto the session, then complete the cart. */
  onToken: (data: { payment_token: string; account_type: string; account_holder_type: string }) => void | Promise<void>
  onError?: (e: unknown) => void
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "processing" | "error">("loading")
  const [message, setMessage] = useState("")
  const [accountType, setAccountType] = useState("checking")
  const [accountHolderType, setAccountHolderType] = useState("personal")
  const configured = useRef(false)

  const tokenizationKey = session?.data?.tokenizationKey
  const scriptUrl = session?.data?.collectScriptUrl || "https://securepay.nmi.com/collect.js"

  useEffect(() => {
    if (!tokenizationKey || configured.current) return
    let cancelled = false

    const loadScript = () =>
      new Promise<void>((resolve, reject) => {
        if (typeof CollectJS !== "undefined") return resolve()
        const s = document.createElement("script")
        s.src = scriptUrl
        s.async = true
        s.setAttribute("data-tokenization-key", tokenizationKey)
        s.onload = () => resolve()
        s.onerror = () => reject(new Error("Failed to load Collect.js"))
        document.head.appendChild(s)
      })

    loadScript()
      .then(() => {
        if (cancelled) return
        configured.current = true
        CollectJS.configure({
          variant: "inline",
          fields: {
            checkname: { selector: "#nmi-checkname", placeholder: "Name on account" },
            checkaccount: { selector: "#nmi-checkaccount", placeholder: "Account number" },
            checkaba: { selector: "#nmi-checkaba", placeholder: "Routing number" },
          },
          fieldsAvailableCallback: () => setStatus("ready"),
          callback: async (response: any) => {
            if (response?.token) {
              try {
                await onToken({ payment_token: response.token, account_type: accountType, account_holder_type: accountHolderType })
              } catch (err) { setStatus("error"); onError?.(err) }
            } else {
              setStatus("error"); setMessage("Could not tokenize the bank account. Please try again.")
            }
          },
        })
      })
      .catch((err) => { setStatus("error"); setMessage(String(err)); onError?.(err) })

    return () => { cancelled = true }
  }, [tokenizationKey, scriptUrl, accountType, accountHolderType])

  if (!tokenizationKey) return <div className="nmi-pay-error">Payment session not ready.</div>

  const pay = () => { setStatus("processing"); CollectJS.startPaymentRequest() }

  return (
    <div className="nmi-ach">
      <div id="nmi-checkname" className="nmi-field" />
      <div id="nmi-checkaccount" className="nmi-field" />
      <div id="nmi-checkaba" className="nmi-field" />
      <select className="nmi-input" value={accountType} onChange={(e) => setAccountType(e.target.value)}>
        <option value="checking">Checking</option>
        <option value="savings">Savings</option>
      </select>
      <select className="nmi-input" value={accountHolderType} onChange={(e) => setAccountHolderType(e.target.value)}>
        <option value="personal">Personal</option>
        <option value="business">Business</option>
      </select>
      <p className="nmi-ach-note">Funds settle in 1–4 business days. Your order is confirmed once authorized.</p>
      <button className="nmi-submit" type="button" disabled={status !== "ready"} onClick={pay}>
        {status === "processing" ? "Submitting…" : "Pay by bank (ACH)"}
      </button>
      <p className="nmi-pay-status" aria-live="polite">{status === "error" && message}</p>
    </div>
  )
}

export default NmiAchForm
