"use client"
/**
 * Shared Collect.js loader + configuration hook for the inline hosted-fields
 * components (NmiCardFields / NmiAchFields). Collect.js is a single global —
 * one payment form may be configured at a time, so mount exactly one of the
 * field components at once (remounting on method switch reconfigures it).
 */
import { useCallback, useEffect, useRef, useState } from "react"

declare global {
  interface Window {
    CollectJS?: {
      configure: (config: Record<string, unknown>) => void
      startPaymentRequest: () => void
    }
  }
}

export type CollectJsResponse = {
  token: string
  card?: { number?: string; type?: string }
  check?: { name?: string; account?: string; aba?: string }
}

type FieldConfig = Record<string, { selector: string; title?: string; placeholder?: string }>

let scriptPromise: Promise<void> | null = null
let scriptEl: HTMLScriptElement | null = null
let walletNoiseFiltered = false

// Collect.js does not support being configure()d twice on one page — after a
// reconfigure (e.g. switching card <-> bank), it rebuilds the iframes but the
// validation/token events never reach the new config, leaving the form dead.
// So on unmount we tear the script down completely; the next mount loads it
// fresh (browser-cached) and always gets a working first configure.
function teardownCollectJs() {
  if (typeof window === "undefined") return
  scriptEl?.remove()
  scriptEl = null
  scriptPromise = null
  delete (window as { CollectJS?: unknown }).CollectJS
}

// Collect.js probes Apple/Google Pay support on init and logs a console.error
// ("Could not create PaymentRequestAbstraction…") when the merchant account has
// no wallets provisioned — benign for a card/ACH-only integration, but dev
// overlays (e.g. Next.js) surface any console.error as a full-screen error.
// Drop that one message; everything else passes through untouched.
function filterWalletProbeNoise() {
  if (walletNoiseFiltered || typeof window === "undefined") return
  walletNoiseFiltered = true
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      args[0].includes("Could not create PaymentRequestAbstraction")
    ) {
      return
    }
    original(...args)
  }
}

function loadCollectJs(tokenizationKey: string, sandbox?: boolean): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  filterWalletProbeNoise()
  if (window.CollectJS) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script")
    const host = sandbox ? "https://sandbox.nmi.com" : "https://secure.nmi.com"
    script.src = `${host}/token/Collect.js`
    script.dataset.tokenizationKey = tokenizationKey
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      scriptPromise = null
      reject(new Error("Failed to load Collect.js"))
    }
    document.head.appendChild(script)
    scriptEl = script
  })
  return scriptPromise
}

export function useCollectJs({
  tokenizationKey,
  sandbox,
  fields,
  paymentType,
  customCss,
  onToken,
}: {
  tokenizationKey: string | undefined
  sandbox?: boolean
  fields: FieldConfig
  /** "cc" (card) or "ck" (check/ACH) — keeps Collect.js from probing wallet
   *  PaymentRequest support it doesn't need ("Could not create
   *  PaymentRequestAbstraction" console error, which can break init). */
  paymentType: "cc" | "ck"
  /** Collect.js CSS objects for the inputs inside NMI's iframes. NOTE: the
   *  iframe document is white by default — on a dark site, set an explicit
   *  background-color or light text disappears. */
  customCss?: {
    base?: Record<string, string>
    focus?: Record<string, string>
    invalid?: Record<string, string>
    placeholder?: Record<string, string>
  }
  onToken: (response: CollectJsResponse) => void
}) {
  const [ready, setReady] = useState(false)
  const [validity, setValidity] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken

  useEffect(() => {
    if (!tokenizationKey) return
    let cancelled = false
    loadCollectJs(tokenizationKey, sandbox)
      .then(() => {
        if (cancelled || !window.CollectJS) return
        window.CollectJS.configure({
          variant: "inline",
          tokenizationKey,
          fields,
          paymentType,
          country: "US",
          currency: "USD",
          styleSniffer: false,
          customCss: customCss?.base,
          focusCss: customCss?.focus,
          invalidCss: customCss?.invalid,
          placeholderCss: customCss?.placeholder,
          fieldsAvailableCallback: () => setReady(true),
          validationCallback: (field: string, valid: boolean) => {
            setValidity((v) => ({ ...v, [field]: valid }))
          },
          callback: (response: CollectJsResponse) => {
            if (!response?.token) {
              setError("Payment could not be tokenized. Please re-check your details.")
              return
            }
            setError(null)
            onTokenRef.current(response)
          },
        })
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
      // Full teardown so the next mount (or the other payment method's
      // fields) gets a fresh, working configure — see teardownCollectJs.
      teardownCollectJs()
      setReady(false)
      setValidity({})
    }
    // fields/customCss are static per mount by convention
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenizationKey, sandbox])

  const fieldNames = Object.keys(fields)
  const isValid =
    ready && fieldNames.every((name) => validity[name] === true)

  /** Tokenize the mounted fields; the result arrives via onToken. */
  const requestToken = useCallback(() => {
    setError(null)
    window.CollectJS?.startPaymentRequest()
  }, [])

  return { ready, isValid, error, requestToken }
}
