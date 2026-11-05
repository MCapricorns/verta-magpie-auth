// bridge.test.mjs — client tools survive prompt forwarding and API conversion.
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VetraAuthPlugin, _internal } from "./index.mjs"

const { selectTools, toolSpec } = _internal
const codemodeDescription = [
  "Run raw JavaScript via tools.<name>. Use searchTools and describeTool for unlisted tools.",
  "Nested tools:",
  "### `read`",
  "Read a local file. Return its text.",
  "```ts",
  "declare const tools: { read(args: { path: string; limit?: number }): Promise<string> }",
  "```",
  "### `write`",
  "Write a local file. Preserve the complete content.",
  "```ts",
  "declare const tools: { write(args: { path: string; content: string }): Promise<string> }",
  "```",
].join("\n")
const codemode = {
  name: "codemode",
  description: codemodeDescription,
  input_schema: {
    type: "object",
    properties: { code: { type: "string", description: "Raw JavaScript source." } },
    required: ["code"],
    additionalProperties: false,
  },
}
const probe = {
  name: "workspace_probe",
  description: "Inspect the workspace supplied by the client.",
  input_schema: { type: "object", properties: { root: { type: "string" } }, required: ["root"] },
}
const updatedProbe = { ...probe, input_schema: { ...probe.input_schema, properties: { root: { type: "string", minLength: 1 } } } }
const openAITool = ({ name, description, input_schema }) => ({
  type: "function", function: { name, description, parameters: input_schema },
})

assert.deepEqual(selectTools([codemode, probe]), [codemode, probe], "all offered client tools remain available")
assert.deepEqual(selectTools([openAITool(codemode), openAITool(probe)]), [openAITool(codemode), openAITool(probe)])
assert.deepEqual(selectTools(undefined), [])
for (const tool of [codemode, openAITool(codemode)]) {
  const spec = toolSpec([tool])
  assert.ok(spec.includes(codemodeDescription), "nested declarations and discovery helpers stay intact")
  assert.ok(spec.includes(JSON.stringify(codemode.input_schema)), "argument types and required fields are forwarded")
  const example = JSON.parse(spec.split("调用格式示例：")[1])
  assert.equal(example.tool, "codemode")
  new (Object.getPrototypeOf(async function () {}).constructor)("tools", example.args.code)
}
const config = { provider: { vetra: { name: "Stale provider name" } } }
await (await VetraAuthPlugin()).config(config)
assert.equal(config.provider.vetra.name, "Vetra (NextOra)")
const nestedSchema = JSON.stringify(probe.input_schema)
assert.ok(_internal.extractSystemContext(`Tools inside run_code:\n- workspace_probe: Inspect local files\n  Schema: ${nestedSchema}`).includes(nestedSchema), "run_code nested argument schemas stay intact")

function upstreamReply(text, includeValues = true) {
  const damaged = text.startsWith('{"tool":') ? text.replace('"args":', '"args"') : text
  const chunks = damaged.match(/[\s\S]{1,9}/g) ?? []
  const events = chunks.map((part) => `event: messages\ndata: ${JSON.stringify([{ type: "AIMessageChunk", id: "current-reply", content: part }])}\n\n`)
  if (includeValues) events.push(`event: values\ndata: ${JSON.stringify({ messages: [
    { type: "ai", id: "previous-reply", content: '{"tool":"wrong_tool","args":{}}' },
    { type: "ai", id: "current-reply", content: text },
  ] })}\n\n`)
  return new Response(events.join("") + "event: __end__\ndata: {}\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

async function decodeReply(response, anthropic, stream) {
  assert.equal(response.status, 200)
  if (!stream) {
    const body = await response.json()
    if (anthropic) {
      const call = body.content.find((block) => block.type === "tool_use")
      return { call: call && { id: call.id, name: call.name, args: call.input }, text: body.content.filter((block) => block.type === "text").map((block) => block.text).join(""), stop: body.stop_reason }
    }
    const choice = body.choices[0]
    const call = choice.message.tool_calls?.[0]
    return { call: call && { id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) }, text: choice.message.content ?? "", stop: choice.finish_reason }
  }
  const raw = await response.text()
  const events = raw.split(/\r?\n/).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)))
  let call
  let text = ""
  let stop
  for (const event of events) {
    assert.ok(!event.error, JSON.stringify(event.error))
    if (anthropic) {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        call = { id: event.content_block.id, name: event.content_block.name, args: {} }
      }
      if (event.delta?.type === "input_json_delta") call.args = JSON.parse(event.delta.partial_json)
      if (event.delta?.type === "text_delta") text += event.delta.text
      if (event.type === "message_delta") stop = event.delta.stop_reason
    } else {
      const choice = event.choices?.[0]
      const tool = choice?.delta?.tool_calls?.[0]
      if (tool) call = { id: tool.id, name: tool.function.name, args: JSON.parse(tool.function.arguments) }
      text += choice?.delta?.content ?? ""
      if (choice?.finish_reason) stop = choice.finish_reason
    }
  }
  return { call, text, stop }
}

const originalFetch = globalThis.fetch
const fixture = await mkdtemp(join(tmpdir(), "vetra-bridge-"))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const originalDataDir = process.env.DATA_DIR
process.env.DATA_DIR = fixture
try {
  for (const anthropic of [false, true]) {
    for (const stream of [false, true]) {
      const label = `${anthropic ? "anthropic" : "openai"}-${stream ? "stream" : "json"}`
      const source = join(fixture, `${label}.txt`)
      const output = join(fixture, `${label}.html`)
      const sourceText = `fixture ${label}`
      const html = `<p>${sourceText}</p><code>/mnt/user-data/example</code>`
      await writeFile(source, sourceText)
      const calls = [
        { tool: "codemode", args: { code: `return await tools.read({path: ${JSON.stringify(source)}})` } },
        { tool: "codemode", args: { code: `return await tools.write({path: ${JSON.stringify(output)}, content: ${JSON.stringify(html)}})` } },
      ]
      let runs = 0
      let createdThreads = 0
      let thread
      let lastReply
      let stateReads = 0
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/state")) {
          stateReads++
          return new Response(JSON.stringify({ values: { messages: [{ type: "ai", content: lastReply }] } }))
        }
        const body = JSON.parse(init.body)
        if (String(url).endsWith("/threads")) {
          createdThreads++
          thread = body.thread_id
          return new Response("{}")
        }
        assert.ok(String(url).includes(`/threads/${thread}/runs/stream`), "continuations reuse their thread")
        const prompt = body.input.messages[0].content[0].text
        if (runs === 0) {
          assert.ok(prompt.includes(codemodeDescription), `${label}: complete codemode instructions reach the upstream`)
          assert.ok(prompt.includes(JSON.stringify(codemode.input_schema)))
          assert.ok(prompt.startsWith("<client_tool_bridge>"), "tool metadata has an explicit boundary")
          assert.doesNotMatch(prompt.slice(0, prompt.indexOf("</client_tool_bridge>")), /coding agent|指引|规范/i, "transport metadata does not introduce a persona heading")
          assert.ok(prompt.trim().endsWith(label), "the user task follows transport metadata")
        } else if (runs === 1) {
          assert.ok(prompt.trim().endsWith(sourceText), "the local read result follows transport metadata")
          assert.ok(prompt.includes("workspace_probe"), "tools added mid-conversation reach the reused thread")
          assert.ok(prompt.includes(JSON.stringify(probe.input_schema)))
        } else if (runs === 2) {
          assert.match(prompt, /codemode/, "an unchanged tool list stays available on tool-result turns")
          assert.ok(!prompt.includes(codemodeDescription), "unchanged declarations are not replayed")
        } else if (runs === 3) {
          assert.ok(prompt.includes(JSON.stringify(updatedProbe.input_schema)), "schema changes reach the reused thread")
        } else {
          assert.match(prompt, /No client tools were provided in this request/, "removing tools updates the reused thread")
        }
        const reply = runs < calls.length ? JSON.stringify(calls[runs]) : "Local tool round trip complete."
        runs++
        lastReply = reply
        return upstreamReply(reply, runs !== 2)
      }
      const plugin = await VetraAuthPlugin({}, { base: "http://vetra.test" })
      const client = await plugin.auth.loader(async () => ({ access: "fixture-token" }))
      const messages = anthropic
        ? [{ role: "user", content: `Read the local fixture and write HTML: ${label}` }]
        : [{ role: "system", content: `<cwd>${fixture}</cwd>` }, { role: "user", content: `Read the local fixture and write HTML: ${label}` }]
      const request = async (offered) => {
        const response = await client.fetch(`http://vetra.test/v1/${anthropic ? "messages" : "chat/completions"}`, {
          method: "POST",
          headers: { "x-session-id": label },
          body: JSON.stringify({ model: "gpt-5.5", stream, messages, tools: anthropic ? offered : offered.map(openAITool), ...(anthropic ? { system: `<cwd>${fixture}</cwd>` } : {}) }),
        })
        return decodeReply(response, anthropic, stream)
      }
      for (let turn = 0; turn < calls.length; turn++) {
        const result = await request(turn ? [codemode, probe] : [codemode])
        assert.equal(result.call?.name, "codemode", `${label}: client receives a callable tool`)
        assert.deepEqual(result.call.args, calls[turn].args, "JavaScript and path literals are unchanged")
        assert.equal(result.stop, anthropic ? "tool_use" : "tool_calls")
        assert.equal(result.text, "", "tool JSON does not leak as prose")
        const toolResult = await new AsyncFunction("tools", result.call.args.code)({
          read: ({ path }) => readFile(path, "utf8"),
          write: async ({ path, content }) => { await writeFile(path, content); return `Written: ${path}` },
        })
        if (anthropic) {
          messages.push({ role: "assistant", content: [{ type: "tool_use", id: result.call.id, name: result.call.name, input: result.call.args }] })
          messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: result.call.id, content: toolResult }] })
        } else {
          messages.push({ role: "assistant", content: null, tool_calls: [{ id: result.call.id, type: "function", function: { name: result.call.name, arguments: JSON.stringify(result.call.args) } }] })
          messages.push({ role: "tool", tool_call_id: result.call.id, content: toolResult })
        }
      }
      assert.equal(await readFile(output, "utf8"), html, `${label}: the dispatched local call writes the requested file`)
      const final = await request([codemode, probe])
      assert.equal(final.text, "Local tool round trip complete.")
      messages.push({ role: "assistant", content: final.text }, { role: "user", content: "Continue with the updated tool schema." })
      const updated = await request([codemode, updatedProbe])
      assert.equal(updated.text, final.text)
      messages.push({ role: "assistant", content: updated.text }, { role: "user", content: "Finish without tools." })
      const withoutTools = await request([])
      assert.equal(withoutTools.text, final.text)
      assert.equal(createdThreads, 1, "tool updates preserve the conversation thread")
      assert.equal(runs, 5)
      assert.equal(stateReads, 1, "missing final values are recovered from the thread state")
      console.log(`${label}: local read/write, tool results, and tool-list updates passed`)
    }
  }
} finally {
  globalThis.fetch = originalFetch
  if (originalDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalDataDir
  await rm(fixture, { recursive: true, force: true })
}
