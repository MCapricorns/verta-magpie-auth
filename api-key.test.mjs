// api-key.test.mjs — native requests preserve model IDs, tools, streams and account isolation.
import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import test from "node:test"
import { VetraAuthPlugin } from "./index.mjs"

const BASE = "https://api.vetra.test/v1"
const auth = { type: "api", key: "fixture-api-key" }

async function fixture(t, handler, credentials = auth) {
  t.mock.method(childProcess, "spawn", () => { throw new Error("API keys must not open a browser") })
  syncBuiltinESMExports()
  t.mock.method(globalThis, "fetch", (input, init) => handler(new Request(input, init)))
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const plugin = await VetraAuthPlugin({}, { apiBase: BASE + "/" })
  const getAuth = typeof credentials === "function" ? credentials : async () => credentials
  return { plugin, client: await plugin.auth.loader(getAuth), getAuth }
}

const tool = {
  type: "function",
  function: {
    name: "read_file", description: "Read a local file.", strict: true,
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
}

const messages = [
  { role: "system", content: "Use the supplied local tools." },
  { role: "user", content: "Read README.md." },
  { role: "assistant", content: null, tool_calls: [{ id: "call_native", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
  { role: "tool", tool_call_id: "call_native", content: "Native tool result." },
]

test("API key sign-in lists the account's native model IDs and endpoint", async (t) => {
  const { plugin, client } = await fixture(t, async request => {
    assert.equal(request.url, BASE + "/models")
    assert.equal(request.headers.get("authorization"), "Bearer " + auth.key)
    return Response.json({ object: "list", data: ["gpt-5", "gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(id => ({ id })) })
  })
  assert.deepEqual(plugin.auth.methods.map(method => ({ type: method.type, label: method.label })), [
    { type: "oauth", label: "网页登录" },
    { type: "api", label: "api-key登录" },
  ])
  assert.equal(client.baseURL, BASE)
  const models = await plugin.provider.models({ models: {} }, { auth })
  assert.deepEqual(Object.keys(models), ["gpt-5", "gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
  assert.equal(models["gpt-5.6-sol"].api.id, "gpt-5.6-sol")
  assert.equal(models["gpt-5.6-sol"].api.url, BASE)
  assert.equal(models["gpt-5.6-sol"].api.npm, "@ai-sdk/openai-compatible")
  assert.deepEqual(Object.keys(models["gpt-5"].variants), ["minimal", "low", "medium", "high"])
  assert.equal(models["gpt-5"].limit.context, 400_000)
  for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.deepEqual(Object.keys(models[id].variants), ["none", "low", "medium", "high", "xhigh"])
    assert.deepEqual(models[id].limit, { context: 1_050_000, output: 128_000 })
  }
  const config = {}
  await plugin.config(config)
  assert.equal(config.provider.vetra.models["gpt-5.4"].limit.context, 1_050_000)
  assert.equal(config.provider.vetra.models["gpt-5.5"].limit.context, 1_050_000)
  const usage = await plugin.auth.usage(async () => auth)
  assert.equal(usage.plan, "Vetra api-key")
  assert.deepEqual(usage.windows, [])
  assert.equal(await plugin.auth.refresh(auth), auth)
})

test("native chat keeps tools and history while adapting the gateway's GPT-5 parameters", async (t) => {
  const reply = { object: "chat.completion", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }], usage: { prompt_tokens: 42, completion_tokens: 3, total_tokens: 45 } }
  const payload = {
    model: "gpt-5.4", messages, tools: [tool], tool_choice: "auto", parallel_tool_calls: true,
    reasoning_effort: "max", max_tokens: 512, allowed_openai_params: ["verbosity"], stream: false,
  }
  const { client } = await fixture(t, async request => {
    assert.equal(request.url, BASE + "/chat/completions")
    assert.equal(request.method, "POST")
    assert.equal(request.headers.get("authorization"), "Bearer " + auth.key)
    assert.equal(request.headers.get("x-request-id"), "fixture-request")
    assert.equal(request.headers.get("content-type"), "application/json")
    assert.equal(request.headers.get("content-length"), null)
    assert.equal(request.redirect, "error")
    const body = await request.json()
    const { max_tokens, ...nativeFields } = payload
    assert.deepEqual(body, { ...nativeFields, max_completion_tokens: max_tokens, reasoning_effort: "xhigh", allowed_openai_params: ["verbosity", "reasoning_effort"] })
    return Response.json(reply)
  })
  const response = await client.fetch(new Request(BASE + "/chat/completions", {
    method: "POST", headers: { authorization: "Bearer client-gateway-key", "x-request-id": "fixture-request", "content-length": "1" }, body: JSON.stringify(payload),
  }))
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(await response.json(), reply)
  assert.equal(payload.reasoning_effort, "max")
})

test("streamed reasoning, tool arguments and usage pass through without buffering", async (t) => {
  const encoder = new TextEncoder()
  const first = "data: " + JSON.stringify({ choices: [{ delta: { reasoning_content: "Checking" } }] }) + "\n\n"
  const call = { index: 0, id: "call_native", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } }
  const last = "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { total_tokens: 45 } }) + "\n\ndata: [DONE]\n\n"
  let controller
  let currentAuth = auth
  const { client } = await fixture(t, async request => {
    assert.equal(request.headers.get("authorization"), "Bearer replacement-key")
    const body = await request.json()
    assert.equal(body.reasoning_effort, "low")
    assert.equal(body.max_completion_tokens, 256)
    assert.deepEqual(body.allowed_openai_params, ["reasoning_effort"])
    return new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(encoder.encode(first)) } }), {
      headers: { "content-type": "text/event-stream", "x-request-id": "native-stream" },
    })
  }, async () => currentAuth)
  currentAuth = { type: "api", key: " Bearer replacement-key " }
  const response = await client.fetch(new URL(BASE + "/chat/completions"), {
    method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages, tools: [tool], stream: true, reasoning_effort: "low", max_tokens: 100, max_completion_tokens: 256, allowed_openai_params: ["reasoning_effort"] }),
  })
  assert.equal(response.headers.get("x-request-id"), "native-stream")
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), first)
  controller.enqueue(encoder.encode(last))
  controller.close()
  assert.equal(new TextDecoder().decode((await reader.read()).value), last)
  assert.equal((await reader.read()).done, true)
})

test("GET models and request cancellation use the native transport", async (t) => {
  const controller = new AbortController()
  let outgoing
  const { client } = await fixture(t, async request => {
    outgoing = request
    return Response.json({ data: [{ id: "gpt-5.6-terra" }] })
  })
  const response = await client.fetch(BASE + "/models", { signal: controller.signal })
  assert.deepEqual(await response.json(), { data: [{ id: "gpt-5.6-terra" }] })
  controller.abort()
  assert.equal(outgoing.signal.aborted, true)
})

test("GPT-5 uses high for max and other model payloads stay intact", async (t) => {
  let expected
  const { client } = await fixture(t, async request => {
    assert.deepEqual(await request.json(), expected)
    return Response.json({ choices: [] })
  })
  expected = { model: "gpt-5", messages, reasoning_effort: "high", allowed_openai_params: ["reasoning_effort"] }
  await client.fetch(BASE + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5", messages, reasoning_effort: "max" }) })
  expected = { model: "gpt-5.6-sol", messages, tools: [tool], reasoning_effort: "none", allowed_openai_params: ["reasoning_effort"] }
  await client.fetch(BASE + "/chat/completions", { method: "POST", body: JSON.stringify(expected) })
  expected = { model: "other-model", messages, max_tokens: 50, reasoning_effort: "high" }
  await client.fetch(BASE + "/chat/completions", { method: "POST", body: JSON.stringify(expected) })
})

test("invalid requests and missing keys fail without opening SSO or sending a request", async (t) => {
  let currentAuth = auth
  const { plugin, client } = await fixture(t, () => { throw new Error("Unexpected network request") }, async () => currentAuth)
  for (const body of ["{", "null", "[]"]) {
    const response = await client.fetch(BASE + "/chat/completions", { method: "POST", body })
    assert.equal(response.status, 400)
  }
  currentAuth = { type: "api", key: " " }
  const response = await client.fetch(BASE + "/models")
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-magpie-sign-in"), "expired")
  assert.equal((await plugin.auth.usage(async () => currentAuth)).signIn, "expired")
  await assert.rejects(plugin.auth.loader(async () => currentAuth), /api-key/)
})

test("key rejection and rate limits retain upstream errors without browser retries", async (t) => {
  let status = 401
  let calls = 0
  const { plugin, client } = await fixture(t, () => {
    calls++
    return Response.json({ error: { code: status === 429 ? "rate_limit" : "invalid_token" } }, { status, headers: { "retry-after": "5" } })
  })
  for (const nextStatus of [401, 403, 429]) {
    status = nextStatus
    const before = calls
    const response = await client.fetch(BASE + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages }) })
    assert.equal(response.status, status)
    assert.equal(response.headers.get("retry-after"), "5")
    assert.equal(response.headers.get("x-magpie-sign-in"), status === 429 ? "kept" : "expired")
    assert.equal(calls, before + 1)
    assert.ok((await response.json()).error.code)
  }
  status = 401
  await assert.rejects(plugin.provider.models({ models: {} }, { auth }), error => error.signIn === "expired")
  assert.equal((await plugin.auth.usage(async () => auth)).signIn, "expired")
  status = 429
  assert.equal((await plugin.auth.usage(async () => auth)).signIn, undefined)
})

test("an empty account catalog replaces seeds while service failures retain prior models", async (t) => {
  let reply = { data: [] }
  let status = 200
  const { plugin } = await fixture(t, () => Response.json(reply, { status }))
  const provider = { models: { "gpt-5.4": { id: "gpt-5.4" } } }
  assert.deepEqual(await plugin.provider.models(provider, { auth }), {})
  reply = { data: [{ name: "invalid-model-row" }] }
  assert.equal(await plugin.provider.models(provider, { auth }), provider.models)
  status = 503
  assert.equal(await plugin.provider.models(provider, { auth }), provider.models)
})
