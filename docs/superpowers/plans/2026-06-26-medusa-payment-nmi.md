# medusa-payment-nmi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Medusa v2 payment provider package (`medusa-payment-nmi`) that takes card and ACH payments through the NMI Gateway using Collect.js hosted fields, with synchronous card authorization and webhook-driven ACH settlement.

**Architecture:** Two `AbstractPaymentProvider` services (`nmi-card`, `nmi-ach`) registered under the Medusa Payment module. The browser tokenizes card/bank data via NMI Collect.js into a single-use `payment_token`; the backend charges it server-side via the NMI Payment API (`transact.php`, Direct Post). Cards authorize synchronously; ACH submits and settles via signed webhooks. Pure logic (HTTP response parsing, webhook signature verification, event→action mapping) is factored into `lib/` for unit testing; the Medusa plumbing mirrors the existing `medusa-payment-kadima` package.

**Tech Stack:** TypeScript (ESM), `@medusajs/framework`, `tsup` (build), `vitest` (test), Node `crypto`/`fetch` (no third-party NMI SDK — Direct Post is plain HTTP). React copy-paste storefront components (shipped as source).

**Reference:** Mirror the sibling package at `../medusa-payment-kadima`. **Spec:** `docs/superpowers/specs/2026-06-26-medusa-payment-nmi-design.md`.

**Working directory for all paths below:** `C:\Users\fatal\projects\github.com\medusa-payment-nmi`

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `.gitignore`, `vitest.config.ts`, `LICENSE`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "medusa-payment-nmi",
  "version": "0.1.0",
  "description": "Medusa v2 payment provider for the NMI Gateway — card + ACH via Collect.js hosted fields",
  "license": "MIT",
  "private": false,
  "type": "module",
  "author": "Kael Broersma",
  "keywords": [
    "medusa", "medusa-plugin", "medusa-v2", "payment", "payment-provider",
    "nmi", "collect.js", "card", "ach", "echeck", "hosted-fields"
  ],
  "exports": {
    ".": {
      "types": "./.medusa/server/src/index.d.ts",
      "import": "./.medusa/server/src/index.js",
      "default": "./.medusa/server/src/index.js"
    },
    "./providers/nmi-card": {
      "types": "./.medusa/server/src/providers/nmi-card.d.ts",
      "import": "./.medusa/server/src/providers/nmi-card.js",
      "default": "./.medusa/server/src/providers/nmi-card.js"
    },
    "./providers/nmi-ach": {
      "types": "./.medusa/server/src/providers/nmi-ach.d.ts",
      "import": "./.medusa/server/src/providers/nmi-ach.js",
      "default": "./.medusa/server/src/providers/nmi-ach.js"
    }
  },
  "files": [".medusa/server", "src", "storefront", "README.md"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "prepare": "npm run build",
    "prepublishOnly": "npm run build"
  },
  "peerDependencies": {
    "@medusajs/framework": "^2.0.0"
  },
  "devDependencies": {
    "@medusajs/framework": "^2.17.1",
    "ts-node": "^10.9.2",
    "tsup": "^8.5.1",
    "typescript": "^5.6.3",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "ignoreDeprecations": "6.0",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": ".medusa/server",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", ".medusa", "**/*.test.ts"]
}
```

- [ ] **Step 3: Create `tsup.config.ts`**

```ts
import { defineConfig } from "tsup"
export default defineConfig({
  entry: ["src/index.ts", "src/providers/nmi-card.ts", "src/providers/nmi-ach.ts"],
  outDir: ".medusa/server/src",
  format: ["esm"],
  dts: true,
  clean: true,
  bundle: true,
  target: "node20",
  external: [/^@medusajs\//],
})
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config"
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
})
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules
.medusa
*.log
.env
```

- [ ] **Step 6: Create `LICENSE`** — copy the MIT text from `../medusa-payment-kadima/LICENSE`, keeping the same year and replacing the copyright holder line with `Copyright (c) 2026 Kael Broersma`.

- [ ] **Step 7: Install dependencies**

Run: `npm install`
Expected: completes, creates `node_modules` and `package-lock.json`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold medusa-payment-nmi package"
```

---

### Task 2: Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create `src/types.ts`**

```ts
/**
 * Per-merchant NMI configuration. NMI uses two distinct keys:
 *  - securityKey:     PRIVATE API key for server-side Payment API (transact.php).
 *  - tokenizationKey: PUBLIC Collect.js key, safe to send to the browser.
 *  - webhookSecret:   the signing key from Merchant Portal > Settings > Webhooks.
 */
export interface NmiCardOptions {
  /** Private API security key (transact.php `security_key`). */
  securityKey: string
  /** Public Collect.js tokenization key (sent to the storefront). */
  tokenizationKey: string
  /** Webhook signing key (HMAC-SHA256). */
  webhookSecret: string
  /** "auth" = authorize then capture later; "sale" = auth + capture together. Default "auth". */
  captureMethod?: "auth" | "sale"
  /** Use the NMI sandbox host. */
  sandbox?: boolean
}

export interface NmiAchOptions {
  /** Private API security key. */
  securityKey: string
  /** Public Collect.js tokenization key. */
  tokenizationKey: string
  /** Webhook signing key (HMAC-SHA256). */
  webhookSecret: string
  /** NMI `sec_code`. Default "WEB" (internet-initiated consumer debit). */
  secCode?: "PPD" | "CCD" | "WEB" | "TEL"
  /** Use the NMI sandbox host. */
  sandbox?: boolean
}

/** Payment API (Direct Post) hosts. */
export const TRANSACT_HOSTS = {
  prod: "https://secure.nmi.com",
  sandbox: "https://sandbox.nmi.com",
} as const

/** Collect.js is always served from securepay.nmi.com; the tokenization key selects the env. */
export const COLLECT_SCRIPT_URL = "https://securepay.nmi.com/collect.js"

/** transact.php `response` field. */
export type NmiResponseCode = "1" | "2" | "3" // 1 approved, 2 declined, 3 error
```

- [ ] **Step 2: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

```bash
git add -A
git commit -m "feat: NMI provider option + host types"
```

---

### Task 3: Errors

**Files:**
- Create: `src/lib/errors.ts`
- Test: `src/lib/errors.test.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/errors.test.ts`

```ts
import { describe, it, expect } from "vitest"
import { NmiError, isRetryableCode, assertApproved } from "./errors"

describe("NMI errors", () => {
  it("assertApproved passes when response === '1'", () => {
    expect(() => assertApproved({ response: "1", responsetext: "Approved", response_code: "100" })).not.toThrow()
  })

  it("assertApproved throws NmiError on decline (response '2')", () => {
    try {
      assertApproved({ response: "2", responsetext: "DECLINE", response_code: "200" })
      throw new Error("did not throw")
    } catch (e) {
      expect(e).toBeInstanceOf(NmiError)
      expect((e as NmiError).responseCode).toBe("200")
      expect((e as NmiError).message).toContain("DECLINE")
    }
  })

  it("classifies gateway/timeout codes as retryable", () => {
    expect(isRetryableCode("420")).toBe(true)  // communication error
    expect(isRetryableCode("421")).toBe(true)  // communication error with issuer
    expect(isRetryableCode("200")).toBe(false) // hard decline
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/errors.test.ts`
Expected: FAIL ("Cannot find module './errors'").

- [ ] **Step 3: Write `src/lib/errors.ts`**

```ts
/**
 * NMI transact.php returns a flat set of fields. We classify the outcome:
 *   response: "1" approved | "2" declined | "3" error
 *   response_code: numeric reason (100 = approved; 4xx = gateway/processing).
 * See https://docs.nmi.com/reference/transactions-processing
 */
export interface NmiTransactResult {
  response: string
  responsetext?: string
  response_code?: string
  transactionid?: string
  authcode?: string
  [k: string]: string | undefined
}

export class NmiError extends Error {
  constructor(
    message: string,
    readonly response: string,
    readonly responseCode?: string,
    readonly raw?: NmiTransactResult
  ) {
    super(message)
    this.name = "NmiError"
  }
}

// 4xx response_codes are gateway/communication failures worth retrying.
const RETRYABLE = new Set(["420", "421", "430", "431", "440", "441"])

export function isRetryableCode(code?: string): boolean {
  return code ? RETRYABLE.has(code) : false
}

/** Throw if NMI did not approve (response !== "1"). */
export function assertApproved(r: NmiTransactResult): void {
  if (r.response !== "1") {
    throw new NmiError(
      `NMI transaction ${r.response === "2" ? "declined" : "error"}: ${r.responsetext ?? "unknown"}`,
      r.response,
      r.response_code,
      r
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/errors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: NmiError + response_code classification"
```

---

### Task 4: Webhook signature verification + event mapping

**Files:**
- Create: `src/lib/webhook.ts`
- Test: `src/lib/webhook.test.ts`

NMI signs webhooks with header `Webhook-Signature: t=<nonce>,s=<sig>` where
`sig = HMAC_SHA256(nonce + "." + rawBody, signingKey)` (hex). The card and ACH
providers map NMI event types to Medusa actions differently (see spec §6).

- [ ] **Step 1: Write the failing test** — `src/lib/webhook.test.ts`

```ts
import { describe, it, expect } from "vitest"
import { createHmac } from "crypto"
import {
  parseSignatureHeader,
  verifySignature,
  extractSessionId,
  mapCardEvent,
  mapAchEvent,
} from "./webhook"

const SECRET = "whsec_test_123"
const NONCE = "1700000000"
const BODY = JSON.stringify({ event_type: "transaction.sale.success", event_body: { transaction_id: "99" } })
const SIG = createHmac("sha256", SECRET).update(`${NONCE}.${BODY}`).digest("hex")
const HEADER = `t=${NONCE},s=${SIG}`

describe("NMI webhook signature", () => {
  it("parses t=<nonce>,s=<sig> header", () => {
    expect(parseSignatureHeader(HEADER)).toEqual({ nonce: NONCE, signature: SIG })
  })

  it("verifies a correct signature over nonce + '.' + body", () => {
    expect(verifySignature(SECRET, BODY, HEADER)).toBe(true)
  })

  it("rejects a tampered body", () => {
    expect(verifySignature(SECRET, BODY + "x", HEADER)).toBe(false)
  })

  it("rejects a wrong secret", () => {
    expect(verifySignature("nope", BODY, HEADER)).toBe(false)
  })

  it("rejects a missing/garbage header", () => {
    expect(verifySignature(SECRET, BODY, undefined)).toBe(false)
    expect(verifySignature(SECRET, BODY, "garbage")).toBe(false)
  })
})

describe("session id extraction", () => {
  it("reads order_id first", () => {
    expect(extractSessionId({ order_id: "ps_1" })).toBe("ps_1")
  })
  it("falls back to merchant_defined_field_1 / merchant_defined_fields", () => {
    expect(extractSessionId({ merchant_defined_field_1: "ps_2" })).toBe("ps_2")
    expect(extractSessionId({ merchant_defined_fields: { "1": "ps_3" } })).toBe("ps_3")
  })
  it("returns empty string when absent", () => {
    expect(extractSessionId({})).toBe("")
  })
})

describe("card event mapping", () => {
  it("maps auth/sale/capture/refund/void", () => {
    expect(mapCardEvent("transaction.auth.success", {})).toBe("authorized")
    expect(mapCardEvent("transaction.sale.success", {})).toBe("captured")
    expect(mapCardEvent("transaction.capture.success", {})).toBe("captured")
    expect(mapCardEvent("transaction.refund.success", {})).toBe("captured")
    expect(mapCardEvent("transaction.void.success", {})).toBe("canceled")
  })
  it("ignores ACH (check) events and unknown types", () => {
    expect(mapCardEvent("transaction.sale.success", { check: {} })).toBeNull()
    expect(mapCardEvent("transaction.sale.failure", {})).toBeNull()
  })
})

describe("ach event mapping", () => {
  it("maps sale (accepted) → authorized, settlement/refund → captured, failure → failed", () => {
    expect(mapAchEvent("transaction.sale.success", {})).toBe("authorized")
    expect(mapAchEvent("settlement.batch.complete", {})).toBe("captured")
    expect(mapAchEvent("transaction.refund.success", {})).toBe("captured")
    expect(mapAchEvent("transaction.sale.failure", {})).toBe("failed")
    expect(mapAchEvent("transaction.void.success", {})).toBe("canceled")
  })
  it("ignores card events and unknown types", () => {
    expect(mapAchEvent("transaction.sale.success", { card: {} })).toBeNull()
    expect(mapAchEvent("transaction.auth.success", {})).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/webhook.test.ts`
Expected: FAIL ("Cannot find module './webhook'").

- [ ] **Step 3: Write `src/lib/webhook.ts`**

```ts
import { createHmac, timingSafeEqual } from "crypto"

/** Medusa payment action strings returned from getWebhookActionAndData. */
export type CardAction = "authorized" | "captured" | "canceled"
export type AchAction = "authorized" | "captured" | "canceled" | "failed"

/** Parse `Webhook-Signature: t=<nonce>,s=<sig>`. */
export function parseSignatureHeader(
  header: string | undefined
): { nonce: string; signature: string } | null {
  if (!header) return null
  let nonce = "", signature = ""
  for (const part of header.split(",")) {
    const [k, v] = part.split("=")
    if (k?.trim() === "t") nonce = v?.trim() ?? ""
    if (k?.trim() === "s") signature = v?.trim() ?? ""
  }
  if (!nonce || !signature) return null
  return { nonce, signature }
}

/** Verify HMAC-SHA256(nonce + "." + rawBody, secret) against the header signature. */
export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | undefined
): boolean {
  const parsed = parseSignatureHeader(header)
  if (!parsed) return false
  const expected = createHmac("sha256", secret)
    .update(`${parsed.nonce}.${rawBody}`)
    .digest("hex")
  if (expected.length !== parsed.signature.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.signature))
}

/**
 * Recover the Medusa payment session id we stamped on the transaction.
 * We send it as both `orderid` and `merchant_defined_field_1`, so read either.
 */
export function extractSessionId(eventBody: Record<string, any>): string {
  return (
    eventBody.order_id ??
    eventBody.order?.order_id ??
    eventBody.merchant_defined_field_1 ??
    eventBody.merchant_defined_fields?.["1"] ??
    ""
  )
}

const isAch = (b: Record<string, any>) => !!b.check
const isCard = (b: Record<string, any>) => !!b.card

/** Card webhook is a reconciliation backstop (card auth is synchronous). */
export function mapCardEvent(
  eventType: string,
  eventBody: Record<string, any>
): CardAction | null {
  if (isAch(eventBody)) return null // not our rail
  switch (eventType) {
    case "transaction.auth.success": return "authorized"
    case "transaction.sale.success":
    case "transaction.capture.success":
    case "transaction.refund.success": return "captured"
    case "transaction.void.success": return "canceled"
    default: return null
  }
}

/** ACH webhook is the PRIMARY capture/fail signal (settlement is async). */
export function mapAchEvent(
  eventType: string,
  eventBody: Record<string, any>
): AchAction | null {
  if (isCard(eventBody)) return null // not our rail
  switch (eventType) {
    case "transaction.sale.success": return "authorized" // accepted, not yet settled
    case "settlement.batch.complete":
    case "transaction.refund.success": return "captured"
    case "transaction.sale.failure": return "failed" // includes ACH returns
    case "transaction.void.success": return "canceled"
    default: return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/webhook.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: NMI webhook signature verify + event mapping"
```

---

### Task 5: NMI Payment API client (transact.php)

**Files:**
- Create: `src/lib/nmi-client.ts`
- Test: `src/lib/nmi-client.test.ts`

The client posts `application/x-www-form-urlencoded` to `transact.php` and parses the
URL-encoded response. The pure `parseTransactResponse` and `buildParams` functions are
unit-tested; the network `request` method is exercised by the providers/build.

- [ ] **Step 1: Write the failing test** — `src/lib/nmi-client.test.ts`

```ts
import { describe, it, expect } from "vitest"
import { parseTransactResponse, buildChargeParams } from "./nmi-client"

describe("parseTransactResponse", () => {
  it("parses NMI's URL-encoded response into fields", () => {
    const text =
      "response=1&responsetext=Approved&authcode=123456&transactionid=9999&response_code=100"
    const r = parseTransactResponse(text)
    expect(r.response).toBe("1")
    expect(r.transactionid).toBe("9999")
    expect(r.response_code).toBe("100")
    expect(r.responsetext).toBe("Approved")
  })
})

describe("buildChargeParams", () => {
  it("formats amount as dollars x.xx (no cents conversion) and includes correlation", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 49.9,
      paymentToken: "tok_1",
      sessionId: "ps_1",
    })
    expect(p.get("security_key")).toBe("sk")
    expect(p.get("type")).toBe("sale")
    expect(p.get("amount")).toBe("49.90")
    expect(p.get("payment_token")).toBe("tok_1")
    expect(p.get("orderid")).toBe("ps_1")
    expect(p.get("merchant_defined_field_1")).toBe("ps_1")
  })

  it("includes ACH fields when provided", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 10,
      paymentToken: "tok_ach",
      sessionId: "ps_2",
      ach: { secCode: "WEB", accountType: "checking", accountHolderType: "personal" },
    })
    expect(p.get("sec_code")).toBe("WEB")
    expect(p.get("account_type")).toBe("checking")
    expect(p.get("account_holder_type")).toBe("personal")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/nmi-client.test.ts`
Expected: FAIL ("Cannot find module './nmi-client'").

- [ ] **Step 3: Write `src/lib/nmi-client.ts`**

```ts
import { TRANSACT_HOSTS } from "../types"
import { assertApproved, isRetryableCode, NmiError, NmiTransactResult } from "./errors"

export interface ChargeParamsInput {
  securityKey: string
  type: "sale" | "auth" | "capture" | "refund" | "void"
  amount?: number
  paymentToken?: string
  transactionId?: string
  sessionId?: string
  ach?: {
    secCode?: "PPD" | "CCD" | "WEB" | "TEL"
    accountType?: "checking" | "savings"
    accountHolderType?: "personal" | "business"
  }
}

/** Parse NMI's URL-encoded transact.php response into a flat object. */
export function parseTransactResponse(text: string): NmiTransactResult {
  const params = new URLSearchParams(text)
  const out: NmiTransactResult = { response: params.get("response") ?? "3" }
  for (const [k, v] of params.entries()) out[k] = v
  return out
}

/** Build the form body for a transact.php request. Amount is dollars x.xx. */
export function buildChargeParams(input: ChargeParamsInput): URLSearchParams {
  const p = new URLSearchParams()
  p.set("security_key", input.securityKey)
  p.set("type", input.type)
  if (input.amount != null) p.set("amount", input.amount.toFixed(2))
  if (input.paymentToken) p.set("payment_token", input.paymentToken)
  if (input.transactionId) p.set("transactionid", input.transactionId)
  if (input.sessionId) {
    p.set("orderid", input.sessionId)
    p.set("merchant_defined_field_1", input.sessionId)
  }
  if (input.ach) {
    if (input.ach.secCode) p.set("sec_code", input.ach.secCode)
    if (input.ach.accountType) p.set("account_type", input.ach.accountType)
    if (input.ach.accountHolderType) p.set("account_holder_type", input.ach.accountHolderType)
  }
  return p
}

/** Thin client over NMI Direct Post (transact.php). */
export class NmiClient {
  private readonly base: string
  constructor(private readonly securityKey: string, sandbox?: boolean) {
    this.base = (sandbox ? TRANSACT_HOSTS.sandbox : TRANSACT_HOSTS.prod) + "/api/transact.php"
  }

  /** Run a transaction; throws NmiError unless approved. */
  async transact(input: Omit<ChargeParamsInput, "securityKey">): Promise<NmiTransactResult> {
    const params = buildChargeParams({ ...input, securityKey: this.securityKey })
    const result = await this.post(params)
    assertApproved(result)
    return result
  }

  private async post(params: URLSearchParams, attempt = 0): Promise<NmiTransactResult> {
    let resp: Response
    try {
      resp = await fetch(this.base, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      })
    } catch (e) {
      if (attempt < 2) return this.post(params, attempt + 1)
      throw new NmiError(`Network error calling NMI: ${String(e)}`, "3")
    }
    const text = await resp.text()
    if (resp.status >= 500 && attempt < 2) {
      await delay(2 ** attempt * 500)
      return this.post(params, attempt + 1)
    }
    const result = parseTransactResponse(text)
    if (isRetryableCode(result.response_code) && attempt < 2) {
      await delay(2 ** attempt * 500)
      return this.post(params, attempt + 1)
    }
    return result
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/nmi-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: NMI transact.php client + response parsing"
```

---

### Task 6: Card provider

**Files:**
- Create: `src/providers/nmi-card.ts`

- [ ] **Step 1: Create `src/providers/nmi-card.ts`**

```ts
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
    const sessionId = input.data?.session_id as string
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
```

- [ ] **Step 2: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: PASS.

```bash
git add -A
git commit -m "feat: nmi-card provider (synchronous Collect.js charge)"
```

---

### Task 7: ACH provider

**Files:**
- Create: `src/providers/nmi-ach.ts`

- [ ] **Step 1: Create `src/providers/nmi-ach.ts`**

```ts
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
```

- [ ] **Step 2: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: PASS.

```bash
git add -A
git commit -m "feat: nmi-ach provider (async submit + webhook settlement)"
```

---

### Task 8: Combined module entry

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Create `src/index.ts`**

```ts
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
 *             id: "nmi-card",
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
 *             id: "nmi-ach",
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
```

- [ ] **Step 2: Full build + test + typecheck**

Run: `npm run build && npm run typecheck && npm run test`
Expected: build emits `.medusa/server/src/{index,providers/nmi-card,providers/nmi-ach}.js`; typecheck PASS; all vitest tests PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: register nmi-card + nmi-ach under the Payment module"
```

---

### Task 9: Storefront Collect.js components

**Files:**
- Create: `storefront/NmiHostedFields.tsx`, `storefront/NmiAchForm.tsx`, `storefront/README.md`

These ship as copy-paste source (not built), like the Kadima storefront components.

- [ ] **Step 1: Create `storefront/NmiHostedFields.tsx`**

```tsx
"use client"
/**
 * NMI Collect.js — card payment element for a Medusa v2 (Next.js) storefront.
 *
 * Collect.js renders secure iframe fields and tokenizes the card into a single-use
 * `payment_token` (the PAN never touches your storefront or backend — PCI SAQ-A-EP).
 * We write that token onto the payment session's `data`, then complete the cart;
 * the nmi-card provider charges the token server-side in authorizePayment.
 *
 * The payment session's `data` (from initiatePayment) carries:
 *   { tokenizationKey, collectScriptUrl, amount, currency_code }
 */
import { useEffect, useRef, useState } from "react"

declare const CollectJS: any

type Session = {
  id: string
  data?: { tokenizationKey?: string; collectScriptUrl?: string }
}

export function NmiHostedFields({
  session,
  onToken,
  onError,
}: {
  session: Session
  /** Write { payment_token } onto the payment session, then complete the cart. */
  onToken: (paymentToken: string) => void | Promise<void>
  onError?: (e: unknown) => void
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "processing" | "error">("loading")
  const [message, setMessage] = useState("")
  const configured = useRef(false)

  const tokenizationKey = session?.data?.tokenizationKey
  const scriptUrl = session?.data?.collectScriptUrl || "https://securepay.nmi.com/collect.js"

  useEffect(() => {
    if (!tokenizationKey || configured.current) return
    let cancelled = false

    const loadScript = () =>
      new Promise<void>((resolve, reject) => {
        if (typeof CollectJS !== "undefined") return resolve()
        const s = document.createElement("script")
        s.src = scriptUrl
        s.async = true
        s.setAttribute("data-tokenization-key", tokenizationKey)
        s.onload = () => resolve()
        s.onerror = () => reject(new Error("Failed to load Collect.js"))
        document.head.appendChild(s)
      })

    loadScript()
      .then(() => {
        if (cancelled) return
        configured.current = true
        CollectJS.configure({
          variant: "inline",
          fields: {
            ccnumber: { selector: "#nmi-ccnumber", placeholder: "Card number" },
            ccexp: { selector: "#nmi-ccexp", placeholder: "MM/YY" },
            cvv: { selector: "#nmi-cvv", placeholder: "CVV" },
          },
          fieldsAvailableCallback: () => setStatus("ready"),
          validationCallback: (_field: string, valid: boolean, msg: string) => {
            if (!valid) setMessage(msg)
          },
          callback: async (response: any) => {
            if (response?.token) {
              try {
                await onToken(response.token)
              } catch (err) {
                setStatus("error"); onError?.(err)
              }
            } else {
              setStatus("error"); setMessage("Could not tokenize the card. Please try again.")
            }
          },
        })
      })
      .catch((err) => { setStatus("error"); setMessage(String(err)); onError?.(err) })

    return () => { cancelled = true }
  }, [tokenizationKey, scriptUrl])

  if (!tokenizationKey) return <div className="nmi-pay-error">Payment session not ready.</div>

  const pay = () => { setStatus("processing"); CollectJS.startPaymentRequest() }

  return (
    <div className="nmi-pay">
      <div className="nmi-pay-grid">
        <div id="nmi-ccnumber" className="nmi-field" />
        <div id="nmi-ccexp" className="nmi-field" />
        <div id="nmi-cvv" className="nmi-field" />
      </div>
      <button className="nmi-submit" type="button" disabled={status !== "ready"} onClick={pay}>
        {status === "processing" ? "Processing…" : "Pay"}
      </button>
      <p className="nmi-pay-status" aria-live="polite">
        {status === "loading" && "Loading secure card fields…"}
        {status === "error" && message}
      </p>
    </div>
  )
}

export default NmiHostedFields
```

- [ ] **Step 2: Create `storefront/NmiAchForm.tsx`**

```tsx
"use client"
/**
 * NMI Collect.js — ACH / eCheck payment element for a Medusa v2 storefront.
 *
 * Collect.js tokenizes the bank account into a single-use `payment_token`. We write
 * the token plus account_type/account_holder_type onto the payment session, then
 * complete the cart. The nmi-ach provider submits the debit (authorized); the
 * settlement webhook later captures or fails it.
 *
 * ACH is asynchronous: the order is placed as "authorized", not captured. Make that
 * clear to the customer (funds settle in 1–4 business days).
 */
import { useEffect, useRef, useState } from "react"

declare const CollectJS: any

type Session = {
  id: string
  data?: { tokenizationKey?: string; collectScriptUrl?: string }
}

export function NmiAchForm({
  session,
  onToken,
  onError,
}: {
  session: Session
  /** Write { payment_token, account_type, account_holder_type } onto the session, then complete the cart. */
  onToken: (data: { payment_token: string; account_type: string; account_holder_type: string }) => void | Promise<void>
  onError?: (e: unknown) => void
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "processing" | "error">("loading")
  const [message, setMessage] = useState("")
  const [accountType, setAccountType] = useState("checking")
  const [accountHolderType, setAccountHolderType] = useState("personal")
  const configured = useRef(false)

  const tokenizationKey = session?.data?.tokenizationKey
  const scriptUrl = session?.data?.collectScriptUrl || "https://securepay.nmi.com/collect.js"

  useEffect(() => {
    if (!tokenizationKey || configured.current) return
    let cancelled = false

    const loadScript = () =>
      new Promise<void>((resolve, reject) => {
        if (typeof CollectJS !== "undefined") return resolve()
        const s = document.createElement("script")
        s.src = scriptUrl
        s.async = true
        s.setAttribute("data-tokenization-key", tokenizationKey)
        s.onload = () => resolve()
        s.onerror = () => reject(new Error("Failed to load Collect.js"))
        document.head.appendChild(s)
      })

    loadScript()
      .then(() => {
        if (cancelled) return
        configured.current = true
        CollectJS.configure({
          variant: "inline",
          fields: {
            checkname: { selector: "#nmi-checkname", placeholder: "Name on account" },
            checkaccount: { selector: "#nmi-checkaccount", placeholder: "Account number" },
            checkaba: { selector: "#nmi-checkaba", placeholder: "Routing number" },
          },
          fieldsAvailableCallback: () => setStatus("ready"),
          callback: async (response: any) => {
            if (response?.token) {
              try {
                await onToken({ payment_token: response.token, account_type: accountType, account_holder_type: accountHolderType })
              } catch (err) { setStatus("error"); onError?.(err) }
            } else {
              setStatus("error"); setMessage("Could not tokenize the bank account. Please try again.")
            }
          },
        })
      })
      .catch((err) => { setStatus("error"); setMessage(String(err)); onError?.(err) })

    return () => { cancelled = true }
  }, [tokenizationKey, scriptUrl, accountType, accountHolderType])

  if (!tokenizationKey) return <div className="nmi-pay-error">Payment session not ready.</div>

  const pay = () => { setStatus("processing"); CollectJS.startPaymentRequest() }

  return (
    <div className="nmi-ach">
      <div id="nmi-checkname" className="nmi-field" />
      <div id="nmi-checkaccount" className="nmi-field" />
      <div id="nmi-checkaba" className="nmi-field" />
      <select className="nmi-input" value={accountType} onChange={(e) => setAccountType(e.target.value)}>
        <option value="checking">Checking</option>
        <option value="savings">Savings</option>
      </select>
      <select className="nmi-input" value={accountHolderType} onChange={(e) => setAccountHolderType(e.target.value)}>
        <option value="personal">Personal</option>
        <option value="business">Business</option>
      </select>
      <p className="nmi-ach-note">Funds settle in 1–4 business days. Your order is confirmed once authorized.</p>
      <button className="nmi-submit" type="button" disabled={status !== "ready"} onClick={pay}>
        {status === "processing" ? "Submitting…" : "Pay by bank (ACH)"}
      </button>
      <p className="nmi-pay-status" aria-live="polite">{status === "error" && message}</p>
    </div>
  )
}

export default NmiAchForm
```

- [ ] **Step 3: Create `storefront/README.md`**

````markdown
# Storefront integration (Medusa v2 / Next.js)

Two copy-paste components for your checkout payment step:

- `NmiHostedFields.tsx` — card, via NMI Collect.js (PCI SAQ-A-EP; the PAN is tokenized
  client-side and never touches your storefront or backend).
- `NmiAchForm.tsx` — ACH / eCheck bank debit, also via Collect.js.

Both take the active **payment session** and an `onToken` callback. In `onToken`, write
the returned `payment_token` onto the payment session's `data` and then complete the cart.

## Wiring

```tsx
import { sdk } from "@lib/config"

async function setSessionData(cartId: string, providerId: string, data: Record<string, unknown>) {
  await sdk.store.payment.initiatePaymentSession(cart, { provider_id: providerId, data })
}

async function completeCart(cartId: string) {
  const res = await sdk.store.cart.complete(cartId)
  if (res.type === "order") window.location.href = `/order/confirmed/${res.order.id}`
}

{session.provider_id === "pp_nmi-card_nmi-card" && (
  <NmiHostedFields
    session={session}
    onToken={async (payment_token) => {
      await setSessionData(cart.id, session.provider_id, { payment_token })
      await completeCart(cart.id)
    }}
  />
)}

{session.provider_id === "pp_nmi-ach_nmi-ach" && (
  <NmiAchForm
    session={session}
    onToken={async (data) => {
      await setSessionData(cart.id, session.provider_id, data)
      await completeCart(cart.id)
    }}
  />
)}
```

> Provider ids follow Medusa's `pp_<provider>_<id>` scheme. Confirm yours from
> `GET /store/payment-providers`.

## Minimal styles

```css
.nmi-pay-grid { display:grid; grid-template-columns:2fr 1fr 1fr; gap:12px; }
.nmi-field { border:1px solid #d1d5db; border-radius:8px; padding:6px 10px; min-height:44px; }
.nmi-input { width:100%; border:1px solid #d1d5db; border-radius:8px; padding:10px 12px; margin-bottom:10px; }
.nmi-submit { width:100%; padding:12px; border-radius:8px; background:#111827; color:#fff; font-weight:700; border:0; cursor:pointer; margin-top:12px; }
.nmi-submit:disabled { opacity:.5; cursor:not-allowed; }
.nmi-ach-note { font-size:12px; color:#6b7280; } .nmi-pay-error { color:#dc2626; font-size:13px; }
```
````

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: Collect.js storefront components (card + ACH)"
```

---

### Task 10: Top-level docs (README + .env.example)

**Files:**
- Create: `README.md`, `.env.example`

- [ ] **Step 1: Create `.env.example`**

```
# NMI Gateway credentials (per merchant).
# Private API security key — server-side Payment API (transact.php). Settings > Security Keys.
NMI_SECURITY_KEY=your_private_security_key
# Public Collect.js tokenization key — safe to expose to the browser. Settings > Security Keys > Public Key.
NMI_TOKENIZATION_KEY=your_public_tokenization_key
# Webhook signing key — Settings > Webhooks.
NMI_WEBHOOK_SECRET=your_webhook_signing_key
# Card capture model: "auth" (authorize then capture) or "sale" (auth+capture together).
NMI_CARD_CAPTURE_METHOD=auth
```

- [ ] **Step 2: Create `README.md`**

````markdown
# medusa-payment-nmi

A Medusa v2 payment provider for the **NMI Gateway** — card **and** ACH/eCheck, collected
through **NMI Collect.js** hosted fields. The card PAN / bank number is tokenized in the
browser and never touches your server (PCI SAQ-A-EP).

- **Card** authorizes **synchronously**: Collect.js tokenizes → the backend charges the
  token via the Payment API and knows the result immediately. Webhooks are a backstop.
- **ACH** is **asynchronous**: the backend submits the debit (`authorized`); a settlement
  webhook captures it, an ACH return fails it.

## Install

```bash
npm install medusa-payment-nmi
```

## Configure (`medusa-config.ts`)

```ts
module.exports = defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-nmi/providers/nmi-card",
            id: "nmi-card",
            options: {
              securityKey: process.env.NMI_SECURITY_KEY,
              tokenizationKey: process.env.NMI_TOKENIZATION_KEY,
              webhookSecret: process.env.NMI_WEBHOOK_SECRET,
              captureMethod: "auth",            // or "sale"
              sandbox: process.env.NODE_ENV !== "production",
            },
          },
          {
            resolve: "medusa-payment-nmi/providers/nmi-ach",
            id: "nmi-ach",
            options: {
              securityKey: process.env.NMI_SECURITY_KEY,
              tokenizationKey: process.env.NMI_TOKENIZATION_KEY,
              webhookSecret: process.env.NMI_WEBHOOK_SECRET,
              secCode: "WEB",                   // internet-initiated consumer debit
              sandbox: process.env.NODE_ENV !== "production",
            },
          },
        ],
      },
    },
  ],
})
```

| Option | Required | Notes |
|---|---|---|
| `securityKey` | ✅ | Private API key for `transact.php`. |
| `tokenizationKey` | ✅ | Public Collect.js key; sent to the storefront. |
| `webhookSecret` | ✅ | Webhook signing key (HMAC-SHA256). |
| `captureMethod` (card) | — | `auth` (default) or `sale`. |
| `secCode` (ACH) | — | `WEB` (default), `PPD`, `CCD`, `TEL`. |
| `sandbox` | — | Use `sandbox.nmi.com`. |

## Card flow

1. `initiatePayment` returns `{ tokenizationKey, collectScriptUrl, amount }`.
2. The storefront's `NmiHostedFields` loads Collect.js, tokenizes the card → `payment_token`.
3. Your `onToken` writes `{ payment_token }` onto the session and completes the cart.
4. `authorizePayment` charges the token (`auth` or `sale`) and returns the result synchronously.

## ACH flow

1. `NmiAchForm` tokenizes the bank account → `payment_token` (+ account type fields).
2. `authorizePayment` submits a `sale` → **authorized** (not yet settled).
3. The settlement webhook → **captured**; an ACH return → **failed**.

## Webhooks (required for ACH, recommended for card)

Medusa exposes one webhook route per provider:

- `POST https://<your-backend>/hooks/payment/nmi-card`
- `POST https://<your-backend>/hooks/payment/nmi-ach`

In **NMI Merchant Portal → Settings → Webhooks**, add an endpoint for each URL, paste the
signing key (that is your `webhookSecret`), and subscribe to:

| Endpoint | Events |
|---|---|
| `…/nmi-card` | `transaction.sale.success`, `transaction.auth.success`, `transaction.capture.success`, `transaction.refund.success`, `transaction.void.success` |
| `…/nmi-ach` | `transaction.sale.success`, `transaction.sale.failure`, `settlement.batch.complete` (+ ACH return) |

Each handler verifies the `Webhook-Signature` HMAC and **self-filters by rail** (the card
handler ignores ACH events and vice-versa), so over-subscribing is harmless. NMI requires
public HTTPS — for local dev, tunnel (e.g. `cloudflared`, `ngrok`) to your backend.

## Storefront

See [`storefront/README.md`](./storefront/README.md) for the copy-paste Collect.js
components and checkout wiring.

## Not in v1

Saved cards / NMI Customer Vault. The account-holder step is satisfied with a synthetic
holder; no card is stored. (Easy to add later.)

## License

MIT
````

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: README + .env.example (config, flows, webhook setup)"
```

---

### Task 11: Final validation

- [ ] **Step 1: Clean build + typecheck + tests**

Run: `npm run build && npm run typecheck && npm run test`
Expected: build emits all three provider entries under `.medusa/server/src/`; typecheck PASS; all vitest suites PASS (errors, webhook, nmi-client).

- [ ] **Step 2: Verify package exports resolve**

Run: `node -e "import('./.medusa/server/src/index.js').then(m => console.log(Object.keys(m)))"`
Expected: prints an array including `default`, `NmiCardProviderService`, `NmiAchProviderService`.

- [ ] **Step 3: Final commit (if anything changed)**

```bash
git add -A
git commit -m "chore: final build validation" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- §1 scope (card, ACH, webhooks, capture model, storefront, docs; vault deferred) → Tasks 2,6,7,9,10; vault stubbed in Task 6 `createAccountHolder`.
- §2/§3 NMI model & API facts → Tasks 5 (client), 4 (webhook), 6/7 (providers).
- §4 repo structure → all tasks; subpath exports Task 1.
- §5 provider contracts (synchronous card, async ACH, validateOptions, stubs) → Tasks 6,7.
- §6 webhook verify + self-filter + mapping table → Task 4 (pure, tested) + 6/7 (wiring).
- §7 config options → Task 2 + README table Task 10.
- §8 errors + tests → Tasks 3,4,5; build validation Task 11.
- §9 docs deliverables → Tasks 9,10 + inline JSDoc throughout.
- §10 open items (ACH-return event, orderid echo, sandbox host) → handled defensively:
  `mapAchEvent` treats `transaction.sale.failure` as the return signal; `extractSessionId`
  reads `orderid`/`order.order_id`/`merchant_defined_field(s)`; sandbox host is configurable.
  **Verify against a live NMI sandbox during execution; adjust the event string if needed.**

**Placeholder scan:** none — every code step shows full content.

**Type consistency:** `NmiClient.transact(input)` shape matches `ChargeParamsInput` (minus
`securityKey`); `buildChargeParams` field names (`payment_token`, `orderid`,
`merchant_defined_field_1`, `sec_code`, `account_type`, `account_holder_type`) match the
provider calls and tests; `mapCardEvent`/`mapAchEvent`/`extractSessionId`/`verifySignature`
signatures match their call sites in Tasks 6/7 and tests in Task 4.

