import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, StatusBadge, Text } from "@medusajs/ui"
import {
  isNmiPayment,
  summarizeNmiPayment,
  type NmiPaymentSummary,
  type PaymentLike,
} from "../../lib/payment-summary"

/**
 * Order page: what actually happened at NMI for each payment.
 *
 * Medusa labels a same-day full refund "refunded" even when this provider
 * reversed it with a void, which is right for the totals but hides that no
 * charge will ever settle. This widget says which it was, and shows the NMI
 * transaction id, approval code and AVS/CVV results that otherwise only exist
 * as raw JSON on the payment.
 *
 * It reads the order the page already loaded (the order query includes
 * `*payment_collections.payments` and their refunds), so it makes no request
 * of its own and refreshes whenever the page does, e.g. after a refund.
 */
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-2 items-start gap-x-4 px-6 py-3">
    <Text size="small" leading="compact" weight="plus">
      {label}
    </Text>
    <div className="flex flex-col gap-y-1">{children}</div>
  </div>
)

const Value = ({ children }: { children: React.ReactNode }) => (
  <Text size="small" leading="compact" className="text-ui-fg-subtle break-words">
    {children}
  </Text>
)

const money = (amount: number, currency?: string) => {
  if (!Number.isFinite(amount)) return ""
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format(amount)
  } catch {
    return amount.toFixed(2)
  }
}

const PaymentBlock = ({
  summary,
  currency,
}: {
  summary: NmiPaymentSummary
  currency?: string
}) => (
  <div className="divide-y">
    <div className="flex flex-col gap-y-2 px-6 py-4">
      <div className="flex items-center justify-between gap-x-2">
        <Text size="small" leading="compact" weight="plus">
          {summary.card ?? (summary.method === "ach" ? "Bank account (ACH)" : "Card")}
          {Number.isFinite(summary.amount) ? ` · ${money(summary.amount, currency)}` : ""}
        </Text>
        <StatusBadge color={summary.tone}>{summary.label}</StatusBadge>
      </div>
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {summary.detail}
      </Text>
    </div>
    {summary.transactionId && (
      <Row label="NMI transaction">
        <Value>{summary.transactionId}</Value>
      </Row>
    )}
    {summary.authCode && (
      <Row label="Approval code">
        <Value>{summary.authCode}</Value>
      </Row>
    )}
    {summary.refundId && (
      <Row label="Latest NMI refund">
        <Value>{summary.refundId}</Value>
        {summary.refundedAmount > 0 && (
          <Value>{money(summary.refundedAmount, currency)} refunded in total</Value>
        )}
      </Row>
    )}
    {summary.avs && (
      <Row label="Address check (AVS)">
        <Value>
          {summary.avs.text} ({summary.avs.code})
        </Value>
      </Row>
    )}
    {summary.cvv && (
      <Row label="Security code (CVV)">
        <Value>
          {summary.cvv.text} ({summary.cvv.code})
        </Value>
      </Row>
    )}
    {summary.recovered && (
      <Row label="Note">
        <Value>
          NMI's response to this charge was lost; it was confirmed afterwards through the Query
          API.
        </Value>
      </Row>
    )}
  </div>
)

const NmiPaymentDetailsWidget = ({ data: order }: DetailWidgetProps<AdminOrder>) => {
  const payments = (order?.payment_collections ?? [])
    .flatMap((pc) => (pc?.payments ?? []) as unknown as PaymentLike[])
    .filter(isNmiPayment)

  // Not an NMI order: render nothing rather than an empty card.
  if (!payments.length) return null

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">NMI payment</Heading>
      </div>
      {payments.map((payment, i) => (
        <PaymentBlock
          key={payment.id ?? i}
          summary={summarizeNmiPayment(payment)}
          currency={payment.currency_code ?? order.currency_code}
        />
      ))}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default NmiPaymentDetailsWidget
