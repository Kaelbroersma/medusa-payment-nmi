import {
  AbstractPaymentProvider,
  BigNumber,
  ModuleProvider,
  Modules,
} from "@medusajs/framework/utils"
import {
  AuthorizePaymentInput, AuthorizePaymentOutput,
  CapturePaymentInput, CapturePaymentOutput,
  CancelPaymentInput, CancelPaymentOutput,
  DeletePaymentInput, DeletePaymentOutput,
  GetPaymentStatusInput, GetPaymentStatusOutput,
  InitiatePaymentInput, InitiatePaymentOutput,
  ProviderWebhookPayload, WebhookActionResult,
  RefundPaymentInput, RefundPaymentOutput,
  RetrievePaymentInput, RetrievePaymentOutput,
  UpdatePaymentInput, UpdatePaymentOutput,
} from "@medusajs/framework/types"
import { NmiClient } from "../lib/nmi-client"
import { verifySignature, extractSessionId, mapAchEvent } from "../lib/webhook"
import { COLLECT_SCRIPT_URL, NmiAchOptions } from "../types"

/**
 * NMI ACH / eCheck provider. ASYNCHRONOUS. Collect.js tokenizes the bank account;
 * authorizePayment submits a `sale` (accepted → "authorized", funds NOT settled).
 * The settlement webhook drives "captured"; an ACH return drives "failed".
 */
class NmiAchProviderService extends AbstractPaymentProvider<NmiAchOptions> {
  static identifier = "nmi-ach"

  protected client: NmiClient
  protected options_: NmiAchOptions

  constructor(container: Record<string, unknown>, options: NmiAchOptions) {
    super(container, options)
    this.options_ = options
    this.client = new NmiClient(options.securityKey, options.sandbox)
  }

  static validateOptions(options: Record<string, unknown>): void {
    for (const key of ["securityKey", "tokenizationKey", "webhookSecret"]) {
      if (!options[key]) throw new Error(`NMI ACH provider: required option \`${key}\` is missing`)
    }
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    return {
      id: `nmi_ach_${input.data?.session_id ?? "init"}`,
      data: {
        tokenizationKey: this.options_.tokenizationKey,
        collectScriptUrl: COLLECT_SCRIPT_URL,
        amount: input.amount,
        currency_code: input.currency_code,
      },
    }
  }

  /** Submit the debit. Accepted → "authorized" (NOT captured; settlement is async). */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const paymentToken = input.data?.payment_token as string | undefined
    const sessionId = input.data?.session_id as string
    if (!paymentToken) return { status: "pending", data: { ...input.data } }
    const txn = await this.client.transact({
      type: "sale",
      amount: Number(input.data?.amount),
      paymentToken,
      sessionId,
      ach: {
        secCode: this.options_.secCode ?? "WEB",
        accountType: input.data?.account_type as "checking" | "savings" | undefined,
        accountHolderType: input.data?.account_holder_type as "personal" | "business" | undefined,
      },
    })
    return { status: "authorized", data: { transactionid: txn.transactionid, raw: txn } }
  }

  /** No synchronous capture for ACH — settlement is the webhook. */
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const transactionId = String(input.data?.transactionid)
    const txn = await this.client.transact({
      type: "refund", transactionId, amount: Number(input.amount),
    })
    return { data: { ...input.data, refundId: txn.transactionid, raw: txn } }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const transactionId = String(input.data?.transactionid)
    const txn = await this.client.transact({ type: "void", transactionId })
    return { data: { ...input.data, canceled: true, raw: txn } }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const d = input.data ?? {}
    if (d.settled || d.captured) return { status: "captured", data: d }
    if (d.transactionid) return { status: "authorized", data: d }
    return { status: "pending", data: d }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    return { data: { ...input.data, amount: input.amount } }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const rawBody = typeof payload.rawData === "string"
      ? payload.rawData
      : Buffer.from(payload.rawData).toString("utf8")
    const headers = payload.headers as Record<string, string>
    const sigHeader = headers["webhook-signature"] || headers["Webhook-Signature"]
    if (!verifySignature(this.options_.webhookSecret, rawBody, sigHeader)) {
      return { action: "not_supported" }
    }
    const body = payload.data as Record<string, any>
    const eventBody = (body.event_body ?? {}) as Record<string, any>
    const action = mapAchEvent(body.event_type as string, eventBody)
    if (!action) return { action: "not_supported" }
    return {
      action,
      data: {
        session_id: extractSessionId(eventBody),
        amount: new BigNumber(Number(eventBody.requested_amount ?? eventBody.action?.amount ?? 0)),
      },
    }
  }
}

export { NmiAchProviderService }

export default ModuleProvider(Modules.PAYMENT, {
  services: [NmiAchProviderService],
})
