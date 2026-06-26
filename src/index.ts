import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { NmiCardProviderService } from "./providers/nmi-card"
import { NmiAchProviderService } from "./providers/nmi-ach"

/**
 * Registers BOTH providers under the Payment module. In medusa-config.ts:
 *
 *   modules: [
 *     {
 *       resolve: "@medusajs/medusa/payment",
 *       options: {
 *         providers: [
 *           {
 *             resolve: "medusa-payment-nmi/providers/nmi-card",
 *             options: {
 *               securityKey: process.env.NMI_SECURITY_KEY,
 *               tokenizationKey: process.env.NMI_TOKENIZATION_KEY,
 *               webhookSecret: process.env.NMI_WEBHOOK_SECRET,
 *               captureMethod: "auth",
 *               sandbox: process.env.NODE_ENV !== "production",
 *             },
 *           },
 *           {
 *             resolve: "medusa-payment-nmi/providers/nmi-ach",
 *             options: {
 *               securityKey: process.env.NMI_SECURITY_KEY,
 *               tokenizationKey: process.env.NMI_TOKENIZATION_KEY,
 *               webhookSecret: process.env.NMI_WEBHOOK_SECRET,
 *               secCode: "WEB",
 *               sandbox: process.env.NODE_ENV !== "production",
 *             },
 *           },
 *         ],
 *       },
 *     },
 *   ]
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [NmiCardProviderService, NmiAchProviderService],
})

export { NmiCardProviderService, NmiAchProviderService }
