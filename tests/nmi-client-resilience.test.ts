import { describe, it, expect, vi, afterEach } from "vitest"
import {
  NmiClient,
  buildChargeParams,
  parseQueryResponse,
} from "../src/lib/nmi-client"
import { NmiError } from "../src/lib/errors"

/**
 * These tests drive NmiClient against a scripted `fetch`. Each transact.php call
 * takes the next entry of `transact`; each query.php call takes the next entry of
 * `query` (the last one repeats). Nothing here talks to NMI.
 */
type Step = string | Error | { status: number; body?: string }

const APPROVED = "response=1&responsetext=SUCCESS&authcode=123456&transactionid=111&response_code=100"
const DECLINED = "response=2&responsetext=DECLINE&transactionid=112&response_code=200"

const queryXml = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<nm_response>${inner}</nm_response>`
const QUERY_EMPTY = queryXml("")
const QUERY_REFUSED = queryXml(
  "<error_response>Specified API key not found REFID:1</error_response>"
)
const txnXml = (o: {
  id?: string
  order?: string
  condition: string
  type?: string
  amount?: string
  success?: string
  text?: string
  code?: string
}) => `
  <transaction>
    <transaction_id>${o.id ?? "777"}</transaction_id>
    <transaction_type>cc</transaction_type>
    <condition>${o.condition}</condition>
    <order_id>${o.order ?? "payses_1"}</order_id>
    <authorization_code>A1B2C3</authorization_code>
    <avs_response>Y</avs_response>
    <csc_response>M</csc_response>
    <action>
      <amount>${o.amount ?? "50.00"}</amount>
      <action_type>${o.type ?? "sale"}</action_type>
      <success>${o.success ?? "1"}</success>
      <response_text>${o.text ?? "SUCCESS"}</response_text>
      <response_code>${o.code ?? "100"}</response_code>
    </action>
  </transaction>`

function netError(code: string, name = "TypeError"): Error {
  const e = new Error("fetch failed")
  e.name = name
  ;(e as any).cause = { code }
  return e
}
const timeoutError = () => {
  const e = new Error("The operation was aborted due to timeout")
  e.name = "TimeoutError"
  return e
}

function script(transact: Step[], query: Step[] = [QUERY_EMPTY]) {
  const calls = { transact: [] as URLSearchParams[], query: [] as URLSearchParams[], signals: [] as unknown[] }
  let t = 0
  let q = 0
  const respond = (step: Step) => {
    if (step instanceof Error) throw step
    if (typeof step === "string") return new Response(step, { status: 200 })
    return new Response(step.body ?? "", { status: step.status })
  }
  const fetchMock = vi.fn(async (url: string, init: any) => {
    calls.signals.push(init.signal)
    if (String(url).includes("query.php")) {
      calls.query.push(new URLSearchParams(init.body))
      return respond(query[Math.min(q++, query.length - 1)])
    }
    calls.transact.push(new URLSearchParams(init.body))
    if (t >= transact.length) throw new Error("unexpected extra transact.php call")
    return respond(transact[t++])
  })
  vi.stubGlobal("fetch", fetchMock)
  const logger = { warn: vi.fn(), error: vi.fn() }
  const client = new NmiClient("sk_test", false, { logger, sleep: async () => {} })
  return { client, calls, logger }
}

const SALE = { type: "sale" as const, amount: 50, paymentToken: "tok_1", sessionId: "payses_1" }

afterEach(() => vi.unstubAllGlobals())

describe("NmiClient: the normal path", () => {
  it("returns an approved sale after exactly one request, with a timeout signal", async () => {
    const { client, calls } = script([APPROVED])
    const r = await client.transact(SALE)
    expect(r.transactionid).toBe("111")
    expect(calls.transact).toHaveLength(1)
    expect(calls.query).toHaveLength(0)
    expect(calls.signals[0]).toBeInstanceOf(AbortSignal)
  })

  it("throws a decline without retrying or querying", async () => {
    const { client, calls } = script([DECLINED])
    await expect(client.transact(SALE)).rejects.toMatchObject({
      response: "2",
      responseCode: "200",
      outcomeUnknown: false,
    })
    expect(calls.transact).toHaveLength(1)
    expect(calls.query).toHaveLength(0)
  })

  it("uses the live hosts in production and the sandbox hosts in sandbox", async () => {
    const fetchMock = vi.fn(async () => new Response(APPROVED))
    vi.stubGlobal("fetch", fetchMock)
    await new NmiClient("sk").transact(SALE)
    await new NmiClient("sk", true).transact(SALE)
    expect(fetchMock.mock.calls[0][0]).toBe("https://secure.nmi.com/api/transact.php")
    expect(fetchMock.mock.calls[1][0]).toBe("https://sandbox.nmi.com/api/transact.php")
  })
})

describe("NmiClient: definitive errors are never retried", () => {
  it.each(["430", "440", "441", "300", "400"])("response_code %s", async (code) => {
    const { client, calls } = script([
      `response=3&responsetext=Nope&transactionid=0&response_code=${code}`,
    ])
    await expect(client.transact(SALE)).rejects.toMatchObject({
      responseCode: code,
      outcomeUnknown: false,
    })
    expect(calls.transact).toHaveLength(1)
    expect(calls.query).toHaveLength(0)
  })

  it("does not retry a rate limit reported as response_code 301", async () => {
    const { client, calls } = script([
      "response=3&responsetext=Rate limit exceeded&response_code=301",
    ])
    await expect(client.transact(SALE)).rejects.toMatchObject({ responseCode: "301" })
    expect(calls.transact).toHaveLength(1)
    expect(calls.query).toHaveLength(0)
  })

  it("does not retry a rate limit reported as HTTP 429", async () => {
    const { client, calls } = script([{ status: 429, body: "Too Many Requests" }])
    await expect(client.transact(SALE)).rejects.toMatchObject({
      responseCode: "301",
      outcomeUnknown: false,
    })
    expect(calls.transact).toHaveLength(1)
    expect(calls.query).toHaveLength(0)
  })
})

describe("NmiClient: a lost response on a charge", () => {
  it.each([
    ["a timeout", timeoutError()],
    ["a dropped connection", netError("ECONNRESET")],
    ["HTTP 502", { status: 502, body: "<html>Bad Gateway</html>" }],
    ["an unreadable 200", "<html>proxy error</html>"],
    ["response_code 420", "response=3&responsetext=Communication Error&response_code=420"],
    ["response_code 421", "response=3&responsetext=Issuer Comm Error&response_code=421"],
  ] as [string, Step][])(
    "after %s, adopts the approved transaction found by order id and never re-sends",
    async (_name, step) => {
      const { client, calls } = script([step], [queryXml(txnXml({ condition: "pendingsettlement" }))])
      const r = await client.transact(SALE)
      expect(r.response).toBe("1")
      expect(r.transactionid).toBe("777")
      expect(r.authcode).toBe("A1B2C3")
      expect(r.avsresponse).toBe("Y")
      expect(r.cvvresponse).toBe("M")
      expect(r.recovered).toBe("query")
      expect(calls.transact).toHaveLength(1)
      expect(calls.query[0].get("order_id")).toBe("payses_1")
      expect(calls.query[0].get("security_key")).toBe("sk_test")
    }
  )

  it("adopts an approved auth that is awaiting capture", async () => {
    const { client } = script(
      [timeoutError()],
      [queryXml(txnXml({ condition: "pending", type: "auth" }))]
    )
    const r = await client.transact({ ...SALE, type: "auth" })
    expect(r.transactionid).toBe("777")
  })

  it("finds the transaction on a later poll if it is not visible at first", async () => {
    const { client, calls } = script(
      [timeoutError()],
      [QUERY_EMPTY, queryXml(txnXml({ condition: "pendingsettlement" }))]
    )
    const r = await client.transact(SALE)
    expect(r.transactionid).toBe("777")
    expect(calls.query).toHaveLength(2)
    expect(calls.transact).toHaveLength(1)
  })

  it("fails cleanly, without re-sending, when no transaction exists", async () => {
    const { client, calls } = script([timeoutError()], [QUERY_EMPTY])
    const err = await client.transact(SALE).catch((e) => e)
    expect(err).toBeInstanceOf(NmiError)
    expect(err.outcomeUnknown).toBe(false)
    expect(calls.transact).toHaveLength(1)
    expect(calls.query).toHaveLength(3) // polled, then gave up
  })

  it("reports the decline when the lookup shows the transaction failed", async () => {
    const { client, calls } = script(
      [timeoutError()],
      [queryXml(txnXml({ condition: "failed", success: "0", text: "DECLINE", code: "200" }))]
    )
    await expect(client.transact(SALE)).rejects.toMatchObject({
      response: "2",
      responseCode: "200",
      outcomeUnknown: false,
    })
    expect(calls.transact).toHaveLength(1)
  })

  it("ignores transactions that belong to a different order id", async () => {
    const { client } = script(
      [timeoutError()],
      [queryXml(txnXml({ condition: "pendingsettlement", order: "payses_other" }))]
    )
    await expect(client.transact(SALE)).rejects.toMatchObject({ outcomeUnknown: false })
  })

  it("does not adopt a voided transaction", async () => {
    const { client } = script([timeoutError()], [queryXml(txnXml({ condition: "canceled" }))])
    await expect(client.transact(SALE)).rejects.toBeInstanceOf(NmiError)
  })

  it("refuses to adopt a transaction for a different amount", async () => {
    const { client, calls } = script(
      [timeoutError()],
      [queryXml(txnXml({ condition: "pendingsettlement", amount: "75.00" }))]
    )
    await expect(client.transact(SALE)).rejects.toMatchObject({ outcomeUnknown: true })
    expect(calls.transact).toHaveLength(1)
  })

  it("reports an unknown outcome when NMI itself does not know", async () => {
    const { client, logger } = script([timeoutError()], [queryXml(txnXml({ condition: "unknown" }))])
    await expect(client.transact(SALE)).rejects.toMatchObject({ outcomeUnknown: true })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("OUTCOME UNKNOWN"))
  })
})

describe("NmiClient: a lost response when the Query API is not available", () => {
  it("re-sends the single-use token and returns the approval", async () => {
    const { client, calls, logger } = script([timeoutError(), APPROVED], [QUERY_REFUSED])
    const r = await client.transact(SALE)
    expect(r.transactionid).toBe("111")
    expect(calls.transact).toHaveLength(2)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Query API permission"))
  })

  it("treats a rejected re-send as an unknown outcome, not a failure", async () => {
    // The first submission most likely consumed the token, i.e. it was processed.
    const { client } = script(
      [timeoutError(), "response=3&responsetext=Payment Token does not exist&response_code=300"],
      [QUERY_REFUSED]
    )
    await expect(client.transact(SALE)).rejects.toMatchObject({ outcomeUnknown: true })
  })

  it("accepts a decline on the re-send as a real decline", async () => {
    // A decline means the token was still valid, so the first attempt never ran.
    const { client } = script([timeoutError(), DECLINED], [QUERY_REFUSED])
    await expect(client.transact(SALE)).rejects.toMatchObject({
      response: "2",
      outcomeUnknown: false,
    })
  })

  it("gives up as unknown after three unanswered attempts", async () => {
    const { client, calls } = script(
      [timeoutError(), timeoutError(), timeoutError()],
      [{ status: 500 }]
    )
    await expect(client.transact(SALE)).rejects.toMatchObject({ outcomeUnknown: true })
    expect(calls.transact).toHaveLength(3)
  })

  it("warns about the Query permission only once", async () => {
    const { client, logger } = script(
      [timeoutError(), timeoutError(), timeoutError()],
      [QUERY_REFUSED]
    )
    await client.transact(SALE).catch(() => {})
    const mentions = logger.error.mock.calls.filter((c) =>
      String(c[0]).includes("Query API permission")
    )
    expect(mentions).toHaveLength(1)
  })
})

describe("NmiClient: requests that never left the machine", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])(
    "retries after %s without consulting the Query API",
    async (code) => {
      const { client, calls } = script([netError(code), APPROVED])
      const r = await client.transact(SALE)
      expect(r.transactionid).toBe("111")
      expect(calls.transact).toHaveLength(2)
      expect(calls.query).toHaveLength(0)
    }
  )

  it("fails as a plain network error, not an unknown outcome, if NMI is never reached", async () => {
    const { client } = script([
      netError("ECONNREFUSED"),
      netError("ECONNREFUSED"),
      netError("ECONNREFUSED"),
    ])
    await expect(client.transact(SALE)).rejects.toMatchObject({ outcomeUnknown: false })
  })
})

describe("NmiClient: refunds", () => {
  const REFUND = { type: "refund" as const, transactionId: "555", amount: 20 }

  it("never retries a refund whose response was lost", async () => {
    const { client, calls } = script([timeoutError()])
    await expect(client.transact(REFUND)).rejects.toMatchObject({ outcomeUnknown: true })
    expect(calls.transact).toHaveLength(1)
    expect(calls.query).toHaveLength(0)
  })

  it("never retries a refund on HTTP 5xx or response_code 420", async () => {
    for (const step of [
      { status: 503 },
      "response=3&responsetext=Communication Error&response_code=420",
    ] as Step[]) {
      const { client, calls } = script([step])
      await expect(client.transact(REFUND)).rejects.toMatchObject({ outcomeUnknown: true })
      expect(calls.transact).toHaveLength(1)
    }
  })

  it("does retry a refund that provably never reached NMI", async () => {
    const { client, calls } = script([
      netError("ECONNREFUSED"),
      "response=1&responsetext=SUCCESS&transactionid=999&response_code=100",
    ])
    const r = await client.transact(REFUND)
    expect(r.transactionid).toBe("999")
    expect(calls.transact).toHaveLength(2)
  })
})

describe("NmiClient: voids and captures", () => {
  it("treats a void as done when the transaction is already canceled", async () => {
    const { client, calls } = script(
      [timeoutError()],
      [queryXml(txnXml({ id: "555", condition: "canceled" }))]
    )
    const r = await client.transact({ type: "void", transactionId: "555" })
    expect(r.response).toBe("1")
    expect(calls.transact).toHaveLength(1)
    expect(calls.query[0].get("transaction_id")).toBe("555")
  })

  it("retries a void that did not take effect", async () => {
    const { client, calls } = script(
      [timeoutError(), "response=1&responsetext=Transaction Void Successful&transactionid=555&response_code=100"],
      [queryXml(txnXml({ id: "555", condition: "pendingsettlement" }))]
    )
    const r = await client.transact({ type: "void", transactionId: "555" })
    expect(r.response).toBe("1")
    expect(calls.transact).toHaveLength(2)
  })

  it("treats a capture as done when the transaction is pending settlement", async () => {
    const { client, calls } = script(
      [{ status: 504 }],
      [queryXml(txnXml({ id: "555", condition: "pendingsettlement", type: "auth" }))]
    )
    const r = await client.transact({ type: "capture", transactionId: "555", amount: 50 })
    expect(r.response).toBe("1")
    expect(calls.transact).toHaveLength(1)
  })

  it("retries a capture while the authorization is still only pending", async () => {
    const { client, calls } = script(
      [timeoutError(), "response=1&responsetext=SUCCESS&transactionid=555&response_code=100"],
      [queryXml(txnXml({ id: "555", condition: "pending", type: "auth" }))]
    )
    await client.transact({ type: "capture", transactionId: "555", amount: 50 })
    expect(calls.transact).toHaveLength(2)
  })

  it("fails a capture of a voided authorization instead of retrying", async () => {
    const { client, calls } = script(
      [timeoutError()],
      [queryXml(txnXml({ id: "555", condition: "canceled", type: "auth" }))]
    )
    await expect(
      client.transact({ type: "capture", transactionId: "555" })
    ).rejects.toMatchObject({ outcomeUnknown: false })
    expect(calls.transact).toHaveLength(1)
  })
})

describe("NmiClient.condition", () => {
  it("returns the transaction's condition", async () => {
    const { client } = script([], [queryXml(txnXml({ id: "555", condition: "complete" }))])
    expect(await client.condition("555")).toBe("complete")
  })

  it("returns null when the lookup is refused, fails, or finds nothing", async () => {
    for (const q of [QUERY_REFUSED, QUERY_EMPTY, { status: 500 }, netError("ECONNRESET"), "<html/>"] as Step[]) {
      const { client } = script([], [q])
      expect(await client.condition("555")).toBeNull()
    }
  })
})

describe("parseQueryResponse", () => {
  it("parses transactions and their actions", () => {
    const parsed = parseQueryResponse(
      queryXml(
        txnXml({ id: "1", condition: "complete" }) +
          `<transaction><transaction_id>2</transaction_id><condition>failed</condition>
           <order_id>a &amp; b</order_id>
           <action><action_type>sale</action_type><success>0</success></action>
           <action><action_type>void</action_type><success>1</success></action></transaction>`
      )
    )!
    expect(parsed.transactions).toHaveLength(2)
    expect(parsed.transactions[0].condition).toBe("complete")
    expect(parsed.transactions[0].actions[0].amount).toBe("50.00")
    expect(parsed.transactions[1].order_id).toBe("a & b")
    expect(parsed.transactions[1].actions.map((a) => a.action_type)).toEqual(["sale", "void"])
    // Action fields must not leak up into the transaction.
    expect(parsed.transactions[1].action_type).toBeUndefined()
  })

  it("reports a refusal", () => {
    expect(parseQueryResponse(QUERY_REFUSED)).toEqual({
      error: "Specified API key not found REFID:1",
      transactions: [],
    })
  })

  it("returns an empty list for an empty result and null for a non-Query body", () => {
    expect(parseQueryResponse(QUERY_EMPTY)).toEqual({ transactions: [] })
    expect(parseQueryResponse("<nm_response/>")).toEqual({ transactions: [] })
    expect(parseQueryResponse("<html>502</html>")).toBeNull()
    expect(parseQueryResponse("")).toBeNull()
  })
})

describe("buildChargeParams: 0.5 additions", () => {
  it("marks an ACH void or refund as a check transaction", () => {
    const p = buildChargeParams({ securityKey: "sk", type: "void", transactionId: "5", ach: {} })
    expect(p.get("payment")).toBe("check")
    expect(p.has("sec_code")).toBe(false)
  })

  it("does not send `payment` for a card void", () => {
    const p = buildChargeParams({ securityKey: "sk", type: "void", transactionId: "5" })
    expect(p.has("payment")).toBe(false)
  })

  it("sends the buyer IP and a truncated order description when given", () => {
    const p = buildChargeParams({
      securityKey: "sk",
      type: "sale",
      amount: 1,
      paymentToken: "t",
      ipAddress: "203.0.113.9",
      orderDescription: "x".repeat(300),
    })
    expect(p.get("ipaddress")).toBe("203.0.113.9")
    expect(p.get("order_description")).toHaveLength(255)
  })
})
