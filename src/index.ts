import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { NmiProviderService } from "./providers/nmi"

/**
 * Registers the unified NMI payment provider (card + ACH + Apple/Google Pay).
 * In medusa-config.ts:
 *
 *   modules: [
 *     {
 *       resolve: "@medusajs/medusa/payment",
 *       options: {
 *         providers: [
 *           {
 *             resolve: "medusa-payment-nmi/providers/nmi",
 *             options: {
 *               securityKey: process.env.NMI_SECURITY_KEY,
 *               tokenizationKey: process.env.NMI_TOKENIZATION_KEY,
 *               webhookSecret: process.env.NMI_WEBHOOK_SECRET,
 *               captureMethod: "auth",   // card/wallet: "auth" or "sale"
 *               secCode: "WEB",          // ACH SEC code
 *               sandbox: process.env.NODE_ENV !== "production",
 *             },
 *           },
 *         ],
 *       },
 *     },
 *   ]
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [NmiProviderService],
})

export { NmiProviderService }
