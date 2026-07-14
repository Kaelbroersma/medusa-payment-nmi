import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { CreditCard } from "@medusajs/icons"
import { Badge, Container, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import type { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { sdk } from "../lib/client"

/**
 * "Payment method" block on the order-details page for NMI payments: the
 * network and masked card ("Visa •••• 5545") or the ACH descriptor, per
 * payment, read from payment.data display metadata the provider records at
 * authorization. Ships with the plugin so every store gets it; renders
 * nothing when the order has no NMI payments.
 */

const NETWORK_LABELS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
}

type PaymentData = {
  payment_method?: string
  card_type?: string
  card_last4?: string
  card_exp?: string
}

type OrderPayment = {
  id: string
  provider_id?: string | null
  amount?: number
  currency_code?: string
  data?: PaymentData | null
}

const isNmiProvider = (providerId?: string | null) =>
  !!providerId && providerId.startsWith("pp_nmi")

const paymentLabel = (p: OrderPayment): string => {
  const d = p.data ?? {}
  if (d.card_last4) {
    const network =
      (d.card_type && NETWORK_LABELS[d.card_type]) || d.card_type || "Card"
    return `${network} •••• ${d.card_last4}`
  }
  if (d.payment_method === "ach") {
    return "ACH bank transfer"
  }
  return "Card"
}

const formatAmount = (amount?: number, currency?: string) => {
  if (typeof amount !== "number") return ""
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency ?? "usd").toUpperCase(),
  }).format(amount)
}

const NmiPaymentCardWidget = ({ data }: DetailWidgetProps<AdminOrder>) => {
  // Display query, on mount: the widget's order prop doesn't reliably include
  // payment.data, so fetch the payments explicitly.
  const { data: order, isLoading } = useQuery({
    queryKey: ["nmi-payment-card", data.id],
    queryFn: () =>
      sdk.client.fetch<{ order: { payment_collections?: { payments?: OrderPayment[] }[] } }>(
        `/admin/orders/${data.id}`,
        { query: { fields: "*payment_collections.payments" } }
      ),
  })

  const payments = (order?.order.payment_collections ?? [])
    .flatMap((pc) => pc.payments ?? [])
    .filter((p) => isNmiProvider(p.provider_id))

  if (isLoading || payments.length === 0) {
    return null
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Text size="small" leading="compact" weight="plus">
          Payment method
        </Text>
        <Badge size="2xsmall" color="grey">
          NMI
        </Badge>
      </div>
      {payments.map((p) => (
        <div key={p.id} className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-x-3">
            <CreditCard className="text-ui-fg-subtle" />
            <div>
              <Text size="small" leading="compact">
                {paymentLabel(p)}
              </Text>
              {p.data?.card_exp ? (
                <Text
                  size="xsmall"
                  leading="compact"
                  className="text-ui-fg-subtle"
                >
                  Expires {p.data.card_exp}
                </Text>
              ) : null}
            </div>
          </div>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {formatAmount(p.amount, p.currency_code)}
          </Text>
        </div>
      ))}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default NmiPaymentCardWidget
