import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { NmiProviderService } from "./providers/nmi"
import { NmiCardProviderService } from "./providers/nmi-card"
import { NmiAchProviderService } from "./providers/nmi-ach"
import { NmiWalletProviderService } from "./providers/nmi-wallet"

/**
 * One-stop registration: resolves every NMI provider variant. Enable the ones
 * you want per region in the Medusa admin (registration ≠ exposure).
 *
 *   providers: [
 *     {
 *       resolve: "medusa-payment-nmi",
 *       options: {
 *         securityKey: process.env.NMI_SECURITY_KEY,
 *         tokenizationKey: process.env.NMI_TOKENIZATION_KEY,
 *         webhookSecret: process.env.NMI_WEBHOOK_SECRET, // ACH only
 *       },
 *     },
 *   ]
 *
 * À la carte: resolve "medusa-payment-nmi/providers/nmi-card" (etc.) to
 * register a single variant.
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [
    NmiProviderService,
    NmiCardProviderService,
    NmiAchProviderService,
    NmiWalletProviderService,
  ],
})

export {
  NmiProviderService,
  NmiCardProviderService,
  NmiAchProviderService,
  NmiWalletProviderService,
}

/**
 * Webhook helpers, exported so a `payment.webhook_received` subscriber can reuse the
 * same signature verification and event classification the providers use. Needed
 * because Medusa core drops `failed` outcomes — an ACH return never reaches the
 * payment workflow, so reconciling one is application-side work.
 * See the ACH reconciliation section of the README.
 */
export {
  verifySignature,
  parseSignatureHeader,
  extractSessionId,
  isMedusaSessionId,
  mapNmiEvent,
  classifyAchEvent,
} from "./lib/webhook"
export type { NmiAction, AchState } from "./lib/webhook"
export { NmiError, buyerMessageFor } from "./lib/errors"
/**
 * The plain-language payment summary the order-details admin widget shows,
 * for use anywhere else a store wants it.
 */
export {
  isNmiPayment,
  summarizeNmiPayment,
  describeAvs,
  describeCvv,
} from "./lib/payment-summary"
export type { NmiPaymentSummary, NmiPaymentState, PaymentLike } from "./lib/payment-summary"
export type { NmiOptions } from "./types"
