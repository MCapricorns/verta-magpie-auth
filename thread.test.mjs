// thread.test.mjs — conversation identity survives plugin host restarts.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VetraAuthPlugin, _internal } from "./index.mjs"

const fixture = mkdtempSync(join(tmpdir(), "vetra-thread-test-"))
const moduleUrl = new URL("./index.mjs", import.meta.url).href
const worker = `
  const { _internal } = await import(${JSON.stringify(moduleUrl)})
  const input = JSON.parse(process.argv[1])
  const plan = _internal.conversation("SYSTEM", input.parts, input.scope, "REMINDER", "TOOLS", { sessionId: input.sessionId, cacheDir: input.cacheDir })
  if (input.save) { plan.threadId = input.save; _internal.commitThread(plan) }
  console.log(JSON.stringify(plan))
`
const run = (overrides = {}) => {
  const input = { scope: "server/account", sessionId: "main-session", cacheDir: fixture, parts: ["first user turn"], ...overrides }
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", worker, JSON.stringify(input)], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

try {
  const first = run({ save: "upstream-thread" })
  const next = run({ parts: ["first user turn", "User: second turn"] })
  assert.equal(next.threadId, first.threadId, "a fresh plugin process continues the same upstream thread")
  assert.equal(next.prompt, "REMINDER\n\nUser: second turn", "only the new turn is sent")
  assert.ok(!next.prompt.includes("SYSTEM"), "the stable prefix is retained upstream")

  const compacted = run({ parts: ["Compacted history", "User: new question"] })
  assert.equal(compacted.threadId, first.threadId, "client compaction keeps the session's thread")
  assert.ok(compacted.prompt.includes("Compacted history"), "changed client context is synchronized")
  assert.equal(run({ sessionId: "subagent-session" }).threadId, null, "subagents keep independent context")
  assert.equal(run({ scope: "server/other-account" }).threadId, null, "accounts never share a thread")
  const state = JSON.parse(readFileSync(first.file, "utf8"))
  assert.deepEqual(Object.keys(state).sort(), ["at", "id", "seen", "toolHash"], "disk state contains IDs and hashes only")

  const plugin = await VetraAuthPlugin()
  const output = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "vetra" }, sessionID: "subagent-session" }, output)
  assert.equal(output.headers["x-vetra-session-id"], "subagent-session", "magpie forwards the client session identity")

  const reserved = _internal.conversation("SYSTEM", ["interrupted request"], "reservation", "", "TOOLS", { sessionId: "interrupted", cacheDir: fixture })
  let created = 0
  await assert.rejects(_internal.openRun({ token: "fixture", itcode: "account" }, reserved, {
    base: "http://vetra.test",
    fetchImpl: async (url) => {
      if (url.endsWith("/threads")) { created++; return new Response("{}") }
      return new Response("unavailable", { status: 503 })
    },
  }), /503/)
  assert.equal(created, 1)
  const resumed = run({ scope: "reservation", sessionId: "interrupted", parts: ["interrupted request"] })
  assert.equal(resumed.threadId, reserved.threadId, "a failed run does not orphan its created thread")
  assert.equal(resumed.seen.length, 1)

  const missing = _internal.conversation("SYSTEM", ["missing"], "missing", "", "", { sessionId: "missing", cacheDir: fixture })
  let replacements = 0
  await assert.rejects(_internal.openRun({ token: "fixture", itcode: "account" }, missing, {
    base: "http://vetra.test",
    fetchImpl: async (url) => {
      if (url.endsWith("/threads")) { replacements++; return new Response("{}") }
      return new Response("not found", { status: 404 })
    },
  }), /404/)
  assert.equal(replacements, 2, "missing threads are replaced only once")

  const empty = _internal.conversation("SYSTEM", ["empty reply"], "empty", "", "", { sessionId: "empty", cacheDir: fixture })
  let emptyThreads = 0
  let emptyRuns = 0
  let answer = ""
  for await (const text of _internal.replyDeltas({ token: "fixture", itcode: "account" }, empty, {
    base: "http://vetra.test",
    fetchImpl: async (url) => {
      if (url.endsWith("/threads")) { emptyThreads++; return new Response("{}") }
      emptyRuns++
      const event = emptyRuns === 1 ? "" : `event: messages\ndata: ${JSON.stringify([{ type: "AIMessageChunk", content: "answer" }])}\n\n`
      return new Response(event + "event: __end__\ndata: {}\n\n")
    },
  })) answer += text
  assert.equal(answer, "answer")
  assert.equal(emptyThreads, 1, "empty-response retries do not create another thread")
  assert.equal(emptyRuns, 2)

  state.at = 0
  writeFileSync(first.file, JSON.stringify(state))
  assert.equal(run().threadId, null, "expired mappings are not reused")
  console.log("thread persistence, incremental turns, session isolation, and bounded recovery passed")
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
