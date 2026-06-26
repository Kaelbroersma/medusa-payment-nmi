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
  CreateAccountHolderInput, CreateAccountHolderOutput,
} from "@medusajs/framework/types"
import { NmiClient } from "../lib/nmi-client"
import { verifySignature, extractSessionId, mapCardEvent } from "../lib/webhook"
import { COLLECT_SCRIPT_URL, NmiCardOptions } from "../types"

/**
 * NMI card provider. SYNCHRONOUS. The browser tokenizes the card via Collect.js
 * (public tokenizationKey); authorizePayment charges that single-use payment_token
 * server-side via transact.php and knows the result immediately. The webhook is a
 * reconciliation backstop.
 */
class NmiCardProviderService extends AbstractPaymentProvider<NmiCardOptions> {
  static identifier = "nmi-card"

  protected client: NmiClient
  protected options_: NmiCardOptions

  constructor(container: Record<string, unknown>, options: NmiCardOptions) {
    super(container, options)
    this.options_ = options
    this.client = new NmiClient(options.securityKey, options.sandbox)
  }

  static validateOptions(options: Record<string, unknown>): void {
    for (const key of ["securityKey", "tokenizationKey", "webhookSecret"]) {
      if (!options[key]) throw new Error(`NMI card provider: required option \`${key}\` is missing`)
    }
  }

  /** No money moves; hand the storefront everything Collect.js needs. */
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    return {
      id: `nmi_${input.data?.session_id ?? "init"}`,
      data: {
        session_id: input.data?.session_id,
        tokenizationKey: this.options_.tokenizationKey,
        collectScriptUrl: COLLECT_SCRIPT_URL,
        amount: input.amount,
        currency_code: input.currency_code,
      },
    }
  }

  /** Charge the Collect.js payment_token. auth → /auth; sale → /sale. */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const paymentToken = input.data?.payment_token as string | undefined
    const sessionId =
      (input.data?.session_id as string) ?? (input.context?.idempotency_key as string)
    if (!paymentToken) {
      // Storefront has not tokenized yet — keep the session pending.
      return { status: "pending", data: { ...input.data } }
    }
    const method = this.options_.captureMethod ?? "auth"
    const txn = await this.client.transact({
      type: method === "sale" ? "sale" : "auth",
      amount: Number(input.data?.amount),
      paymentToken,
      sessionId,
    })
    return {
      status: method === "sale" ? "captured" : "authorized",
      data: { transactionid: txn.transactionid, authcode: txn.authcode, raw: txn },
    }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const transactionId = String(input.data?.transactionid)
    const txn = await this.client.transact({ type: "capture", transactionId })
    return { data: { ...input.data, captured: true, raw: txn } }
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
    // Pre-settlement reversal = void. (Post-settlement use refund.)
    const txn = await this.client.transact({ type: "void", transactionId })
    return { data: { ...input.data, canceled: true, raw: txn } }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const d = input.data ?? {}
    if (d.refundId || d.captured) return { status: "captured", data: d }
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

  /** Vault is out of scope for v1: satisfy the account-holder step with a synthetic id. */
  async createAccountHolder(input: CreateAccountHolderInput): Promise<CreateAccountHolderOutput> {
    return { id: `nmi_novault_${input.context.customer.id}`, data: { novault: true } }
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
    const action = mapCardEvent(body.event_type as string, eventBody)
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

export { NmiCardProviderService }

export default ModuleProvider(Modules.PAYMENT, {
  services: [NmiCardProviderService],
})
