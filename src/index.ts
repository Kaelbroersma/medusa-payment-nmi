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
 *         webhookSecret: process.env.NMI_WEBHOOK_SECRET,
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
