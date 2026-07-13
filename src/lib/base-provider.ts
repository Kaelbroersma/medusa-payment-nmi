import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
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
  UpdateAccountHolderInput, UpdateAccountHolderOutput,
  DeleteAccountHolderInput, DeleteAccountHolderOutput,
} from "@medusajs/framework/types"
import { NmiClient } from "./nmi-client"
import { toNmiBilling } from "./billing"
import { verifySignature, extractSessionId, mapNmiEvent } from "./webhook"
import { NmiOptions } from "../types"

/**
 * Coerce Medusa's BigNumberInput shapes (number | string | BigNumber class |
 * raw { value, precision }) to a plain number. `Number(bigNumberObject)` is
 * NaN, which NMI rejects as "Invalid amount" — refunds from the admin arrive
 * as BigNumber instances, so this must handle every shape.
 */
export function toAmountNumber(input: unknown): number {
  if (typeof input === "number") return input
  if (typeof input === "string") return Number(input)
  if (input && typeof input === "object") {
    const o = input as { numeric?: unknown; value?: unknown }
    if (typeof o.numeric === "number") return o.numeric
    if (typeof o.value === "string" || typeof o.value === "number") {
      return Number(o.value)
    }
  }
  return Number(input)
}

/**
 * Shared NMI lifecycle for every provider variant (unified, card, ach, wallet).
 * The browser tokenizes the chosen method (Collect.js hosted fields or the
 * NmiPayments element) into a single-use `payment_token`; providers charge it
 * server-side via transact.php. Subclasses set `static identifier` and implement
 * `authorizePayment` — everything else is method-agnostic.
 */
export abstract class NmiBaseProvider extends AbstractPaymentProvider<NmiOptions> {
  protected client: NmiClient
  protected options_: NmiOptions

  constructor(container: Record<string, unknown>, options: NmiOptions) {
    super(container, options)
    this.options_ = options
    this.client = new NmiClient(options.securityKey, options.sandbox)
  }

  static validateOptions(options: Record<string, unknown>): void {
    for (const key of ["securityKey", "tokenizationKey", "webhookSecret"]) {
      if (!options[key]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `NMI provider: required option \`${key}\` is missing`
        )
      }
    }
  }

  /** No money moves; hand the storefront the public tokenization key. */
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    return {
      id: `nmi_${input.data?.session_id ?? "init"}`,
      data: {
        session_id: input.data?.session_id,
        tokenizationKey: this.options_.tokenizationKey,
        // Lets the storefront load Collect.js from the matching gateway host.
        sandbox: !!this.options_.sandbox,
        amount: toAmountNumber(input.amount),
        currency_code: input.currency_code,
      },
    }
  }

  /** Card/wallet: synchronous auth or sale against the Collect.js token. */
  protected async authorizeCard(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const paymentToken = input.data?.payment_token as string | undefined
    const sessionId =
      (input.data?.session_id as string) ?? (input.context?.idempotency_key as string)
    // Cardholder billing address for AVS, threaded onto the session data by the
    // storefront from the trusted cart. NMI's portal-configured AVS rules act on
    // it; a hard reject comes back as a decline.
    const billing = toNmiBilling(input.data?.billing)
    if (!paymentToken) {
      return { status: "pending", data: { ...input.data } }
    }

    const method = this.options_.captureMethod ?? "auth"
    const txn = await this.client.transact({
      type: method === "sale" ? "sale" : "auth",
      amount: toAmountNumber(input.data?.amount),
      paymentToken,
      sessionId,
      billing,
    })
    return {
      status: method === "sale" ? "captured" : "authorized",
      data: {
        payment_method: "card",
        transactionid: txn.transactionid,
        authcode: txn.authcode,
        avs_response: txn.avsresponse,
        cvv_response: txn.cvvresponse,
        raw: txn,
      },
    }
  }

  /** ACH: asynchronous — submit the sale now; the settlement webhook captures it. */
  protected async authorizeAch(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const paymentToken = input.data?.payment_token as string | undefined
    const sessionId =
      (input.data?.session_id as string) ?? (input.context?.idempotency_key as string)
    const billing = toNmiBilling(input.data?.billing)
    if (!paymentToken) {
      return { status: "pending", data: { ...input.data } }
    }

    const txn = await this.client.transact({
      type: "sale",
      amount: toAmountNumber(input.data?.amount),
      paymentToken,
      sessionId,
      billing,
      ach: {
        secCode: this.options_.secCode ?? "WEB",
        accountType: input.data?.account_type as "checking" | "savings" | undefined,
        accountHolderType: input.data?.account_holder_type as "personal" | "business" | undefined,
      },
    })
    // Accepted, not yet settled — settlement webhook drives "captured".
    return {
      status: "authorized",
      data: {
        payment_method: "ach",
        transactionid: txn.transactionid,
        avs_response: txn.avsresponse,
        cvv_response: txn.cvvresponse,
        raw: txn,
      },
    }
  }

  abstract authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput>

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    // ACH settles asynchronously (settlement webhook) — capture is a no-op.
    if (input.data?.payment_method === "ach") return { data: input.data ?? {} }
    const transactionId = String(input.data?.transactionid)
    const txn = await this.client.transact({ type: "capture", transactionId })
    return { data: { ...input.data, captured: true, raw: txn } }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const transactionId = String(input.data?.transactionid)
    const txn = await this.client.transact({
      type: "refund", transactionId, amount: toAmountNumber(input.amount),
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
    if (d.settled || d.captured || d.refundId) return { status: "captured", data: d }
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

  /** Vault out of scope: satisfy the account-holder step with a synthetic id. */
  async createAccountHolder(input: CreateAccountHolderInput): Promise<CreateAccountHolderOutput> {
    return { id: `nmi_novault_${input.context.customer.id}`, data: { novault: true } }
  }

  async updateAccountHolder(input: UpdateAccountHolderInput): Promise<UpdateAccountHolderOutput> {
    // Nothing stored at NMI while vaulting is out of scope.
    return { data: input.data ?? {} }
  }

  async deleteAccountHolder(_input: DeleteAccountHolderInput): Promise<DeleteAccountHolderOutput> {
    return { data: {} }
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
    const action = mapNmiEvent(body.event_type as string, eventBody)
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
