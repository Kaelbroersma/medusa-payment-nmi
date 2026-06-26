"use client"
/**
 * NMI Collect.js — card payment element for a Medusa v2 (Next.js) storefront.
 *
 * Collect.js renders secure iframe fields and tokenizes the card into a single-use
 * `payment_token` (the PAN never touches your storefront or backend — PCI SAQ-A-EP).
 * We write that token onto the payment session's `data`, then complete the cart;
 * the nmi-card provider charges the token server-side in authorizePayment.
 *
 * The payment session's `data` (from initiatePayment) carries:
 *   { tokenizationKey, collectScriptUrl, amount, currency_code }
 */
import { useEffect, useRef, useState } from "react"

declare const CollectJS: any

type Session = {
  id: string
  data?: { tokenizationKey?: string; collectScriptUrl?: string }
}

export function NmiHostedFields({
  session,
  onToken,
  onError,
}: {
  session: Session
  /** Write { payment_token } onto the payment session, then complete the cart. */
  onToken: (paymentToken: string) => void | Promise<void>
  onError?: (e: unknown) => void
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "processing" | "error">("loading")
  const [message, setMessage] = useState("")
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
            ccnumber: { selector: "#nmi-ccnumber", placeholder: "Card number" },
            ccexp: { selector: "#nmi-ccexp", placeholder: "MM/YY" },
            cvv: { selector: "#nmi-cvv", placeholder: "CVV" },
          },
          fieldsAvailableCallback: () => setStatus("ready"),
          validationCallback: (_field: string, valid: boolean, msg: string) => {
            if (!valid) setMessage(msg)
          },
          callback: async (response: any) => {
            if (response?.token) {
              try {
                await onToken(response.token)
              } catch (err) {
                setStatus("error"); onError?.(err)
              }
            } else {
              setStatus("error"); setMessage("Could not tokenize the card. Please try again.")
            }
          },
        })
      })
      .catch((err) => { setStatus("error"); setMessage(String(err)); onError?.(err) })

    return () => { cancelled = true }
  }, [tokenizationKey, scriptUrl])

  if (!tokenizationKey) return <div className="nmi-pay-error">Payment session not ready.</div>

  const pay = () => { setStatus("processing"); CollectJS.startPaymentRequest() }

  return (
    <div className="nmi-pay">
      <div className="nmi-pay-grid">
        <div id="nmi-ccnumber" className="nmi-field" />
        <div id="nmi-ccexp" className="nmi-field" />
        <div id="nmi-cvv" className="nmi-field" />
      </div>
      <button className="nmi-submit" type="button" disabled={status !== "ready"} onClick={pay}>
        {status === "processing" ? "Processing…" : "Pay"}
      </button>
      <p className="nmi-pay-status" aria-live="polite">
        {status === "loading" && "Loading secure card fields…"}
        {status === "error" && message}
      </p>
    </div>
  )
}

export default NmiHostedFields
