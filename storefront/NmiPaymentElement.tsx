"use client"
/**
 * NMI unified payment element — card, ACH, and Apple/Google Pay in one component,
 * via NMI's official @nmipayments/nmi-pay-react. Install it in your storefront:
 *
 *   npm install @nmipayments/nmi-pay-react
 *
 * The component tokenizes the chosen method into a single-use token (the PAN / bank
 * number never touches your storefront or backend). On a completed payment we derive
 * whether it's ACH (event.lookupData.check) vs card/wallet, write
 * { payment_token, payment_method } onto the Medusa payment session, then complete the
 * cart. The single `nmi` backend provider charges the token via the Payment API:
 * card/wallets synchronously, ACH submitted now and settled via webhook.
 *
 * The payment session's `data` (from the provider's initiatePayment) carries
 * { tokenizationKey } — the public Collect.js key the component needs.
 */
import { NmiPayments } from "@nmipayments/nmi-pay-react"

type Session = { id: string; data?: { tokenizationKey?: string } }

export function NmiPaymentElement({
  session,
  onToken,
  onError,
}: {
  session: Session
  /** Write { payment_token, payment_method } onto the session, then complete the cart. */
  onToken: (data: { payment_token: string; payment_method: "card" | "ach" }) => void | Promise<void>
  onError?: (e: unknown) => void
}) {
  const tokenizationKey = session?.data?.tokenizationKey
  if (!tokenizationKey) return <div className="nmi-pay-error">Payment session not ready.</div>

  return (
    <NmiPayments
      tokenizationKey={tokenizationKey}
      layout="multiLine"
      paymentMethods={["card", "ach", "google-pay", "apple-pay"]}
      preSelectFirstMethod={true}
      payButtonText="Pay"
      onPay={async (event: any) => {
        try {
          if (!event?.token) return
          const isAch = !!event?.lookupData?.check
          await onToken({ payment_token: event.token, payment_method: isAch ? "ach" : "card" })
        } catch (e) {
          onError?.(e)
        }
      }}
    />
  )
}

export default NmiPaymentElement
