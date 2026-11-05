// scanner.test.mjs — the tool-call scanner must never lose or leak text.
import assert from "node:assert/strict"
import { _internal } from "./index.mjs"

const { createToolCallScanner, pickToolCall, conversation, commitThread, promptOf, flattenMessages } = _internal
const FENCE = String.fromCharCode(96).repeat(3)

function run(chunks) {
  const s = createToolCallScanner()
  let text = ""
  for (const c of chunks) text += s.push(c)
  text += s.finish()
  return { text, call: s.found() }
}

// 1. a bare call
{
  const r = run([JSON.stringify({ tool: "read", args: { path: "a.txt" } })])
  assert.equal(r.text, "", "a bare call is not text")
  assert.deepEqual(r.call, { name: "read", args: { path: "a.txt" } })
}

// 2. prose in front of a call
{
  const raw = "我先看一下文件。\n" + JSON.stringify({ tool: "read", args: { path: "a.txt" } })
  const r = run([raw])
  assert.equal(r.text, "我先看一下文件。\n")
  assert.equal(r.call.name, "read")
}

// 3. streaming one character at a time gives the same answer
{
  const call = JSON.stringify({ tool: "read", args: { path: "a.txt", limit: 20 } })
  const r = run([..."先读文件\n" + call].map((c) => c))
  assert.equal(r.text, "先读文件\n")
  assert.deepEqual(r.call.args, { path: "a.txt", limit: 20 })
}

// 4. long prose with no call is fully released while streaming
{
  const prose = "这是一段很长的回答。".repeat(200)
  const r = run(prose.match(/[\s\S]{1,7}/g))
  assert.equal(r.call, null)
  assert.equal(r.text, prose)
}

// 5. an object that never closes is text, not a lost answer
{
  const raw = "说明\n" + JSON.stringify({ tool: "read", args: { path: "a.tx" }}).slice(0, -12)
  const r = run([raw])
  assert.equal(r.call, null)
  assert.equal(r.text, raw)
}

// 6. a JSON code block in the answer is prose, and a later call still works
{
  const raw = "配置如下：\n" + FENCE + "json\n" + JSON.stringify({ a: 1 }) + "\n" + FENCE + "\n" + JSON.stringify({ tool: "write", args: { path: "b" } })
  const r = run(raw.match(/[\s\S]{1,5}/g))
  assert.equal(r.call.name, "write")
  assert.match(r.text, /配置如下/)
}

// 7. braces inside strings do not end the object
{
  const command = "if ($a -eq x) { echo hi }"
  const raw = JSON.stringify({ tool: "powershell", args: { command } })
  const r = run([...raw])
  assert.equal(r.call.name, "powershell")
  assert.equal(r.call.args.command, command)
}

// 8. arguments as a JSON string, and name instead of tool
{
  const r = pickToolCall(JSON.stringify({ name: "edit", arguments: JSON.stringify({ path: "c" }) }))
  assert.deepEqual(r, { name: "edit", args: { path: "c" } })
}

// 9. prose only, non-streaming path
{
  assert.equal(pickToolCall("没有工具调用。"), null)
}

// 10. conversation segments only what the thread has not seen
{
  const profile = { keepSystem: false }
  const flat = (parts) => flattenMessages(parts.map((t) => ({ role: "user", content: t })), profile)
  const first = conversation("sys", flat(["你好"]).parts)
  assert.equal(first.prompt, "sys\n\n你好")
  first.threadId = "t1"
  commitThread(first)
  const second = conversation("sys", flat(["你好", "再问一句"]).parts)
  assert.equal(second.threadId, "t1")
  assert.equal(second.prompt, "User: 再问一句")
  assert.equal(conversation("sys", flat(["别的话题"]).parts).threadId, null)
  assert.equal(conversation("sys", flat(["改过的第一句"]).parts).threadId, null, "an edited first turn starts a new thread")
}

// 11. flattenMessages keeps the first user turn bare and labels later ones
{
  const flat = flattenMessages([
    { role: "system", content: "SYS" },
    { role: "user", content: "第一问" },
    { role: "assistant", content: "答" },
    { role: "user", content: "第二问" },
  ], { keepSystem: true })
  assert.deepEqual(flat.parts, ["第一问", "Assistant: 答", "User: 第二问"])
  assert.equal(promptOf(flat), "SYS\n\n第一问\n\nAssistant: 答\n\nUser: 第二问")
}

// 12. sandbox paths never reach the client, even when split across deltas
{
  const { createSandboxFilter, scrubSandbox } = _internal
  const artifact = "sandbox:/mnt/user-data/outputs/graph.html"
  assert.equal(scrubSandbox("文件已生成：" + artifact), "文件已生成：（远端沙箱路径，本机不可见）")
  assert.equal(scrubSandbox("/mnt/user-data/outputs/a.md 与 /mnt/c/real/file"), "（远端沙箱路径，本机不可见） 与 （远端沙箱路径，本机不可见）")
  const raw = "已写入 " + artifact + " 请查收"
  const f = createSandboxFilter()
  let out = ""
  for (const ch of raw) out += f.push(ch)
  out += f.finish()
  assert.equal(out, "已写入 （远端沙箱路径，本机不可见） 请查收")
  assert.ok(!out.includes("/mnt/"), "no sandbox path survives")
  const plain = createSandboxFilter()
  let kept = ""
  for (const ch of "正常的回答，没有路径。") kept += plain.push(ch)
  kept += plain.finish()
  assert.equal(kept, "正常的回答，没有路径。")
}

// 13. a heading the model leaves for the rules it was handed never reaches the client
{
  const { createReplyFilter, createHeadingFilter, isRuleHeading, dropTrailingHeading } = _internal
  for (const head of [
    "本地 Coding Agent 操作与限制",
    "本地 coding agent 操作规则",
    "本机编码代理与访问规则",
    "## 本地工具操作与限制",
    "本机 Coding Agent 使用规范",
    "本机运行的 Coding Agent 指引",
    "Local Coding Agent Access Restrictions",
    "Guidelines for Coding Agents Running on the Local Machine",
  ]) {
    assert.ok(isRuleHeading(head), "a rule heading: " + head)
    const answer = "已完成本机文件读写。"
    const filter = createReplyFilter()
    let streamed = ""
    for (const chunk of answer + "\n\n" + head) streamed += filter.push(chunk)
    streamed += filter.finish()
    assert.equal(streamed.trim(), answer, "a dangling heading is removed: " + head)
    assert.equal(dropTrailingHeading(answer + "\n\n" + head), answer)
    const withBody = answer + "\n\n" + head + "\n用户要求说明的实际内容。"
    assert.equal(dropTrailingHeading(withBody), withBody, "headings with content stay intact")
  }
  for (const line of [
    "已写入：`D:/sign/hello world.html`",
    "完成",
    "改完了，需要重启 magpie。",
    "## 小结",
    "工具调用返回如下：",
    "本机操作已完成",
  ]) {
    assert.equal(isRuleHeading(line), false, "not a rule heading: " + line)
  }

  const raw = "已写入：`D:/sign/hello world.html`\n\n本地 Coding Agent 操作与限制"
  const filter = createReplyFilter()
  let out = ""
  for (const ch of raw) out += filter.push(ch)
  out += filter.finish()
  assert.equal(out.trim(), "已写入：`D:/sign/hello world.html`", "the heading is dropped, the answer stays")
  assert.equal(dropTrailingHeading(raw).trim(), "已写入：`D:/sign/hello world.html`")
  assert.equal(dropTrailingHeading("本地 Coding Agent 操作与限制"), "本地 Coding Agent 操作与限制", "the only line of a reply is never dropped")

  const lone = createHeadingFilter()
  let only = ""
  for (const ch of "本地 Coding Agent 操作与限制") only += lone.push(ch)
  only += lone.finish()
  assert.equal(only, "本地 Coding Agent 操作与限制", "a reply that is only a heading keeps it")

  const padded = "已写入：`D:/sign/hello world.html`\n\n本地 Coding Agent 操作与限制\n\n"
  const pad = createHeadingFilter()
  let flushed = ""
  for (const ch of padded) flushed += pad.push(ch)
  flushed += pad.finish()
  assert.equal(flushed.trim(), "已写入：`D:/sign/hello world.html`", "a heading with a trailing newline goes too")
  assert.ok(!flushed.includes("操作与限制"))

  const answered = "## 小结\n\n本地 Coding Agent 操作与限制\n- 只能通过客户端工具在本机操作\n- 不写沙箱路径"
  const keep = createHeadingFilter()
  let body = ""
  for (const ch of answered) body += keep.push(ch)
  body += keep.finish()
  assert.equal(body, answered, "a heading a body follows is content and stays")
}

// 14. final state replaces even a syntactically valid but damaged command.
{
  const command = "python -c \"" + "print('原文\\\\regex {value}')\\n".repeat(100) + "\""
  const complete = { tool: "Bash", args: { command, timeout: 600000, description: "Inspect local source" } }
  const damaged = { ...complete, args: { ...complete.args, command: command.slice(40) } }
  const scanner = createToolCallScanner({ holdMalformed: true })
  assert.equal(scanner.push(JSON.stringify(damaged)), "")
  scanner.reconcile(JSON.stringify(complete))
  assert.equal(scanner.finish(), "")
  assert.deepEqual(scanner.found(), { name: "Bash", args: complete.args })
  assert.equal(pickToolCall('{"tool":"Bash","args":"invalid JSON"}'), null)
  assert.equal(pickToolCall('{"tool":"Bash","args":null}'), null)
}

console.log("scanner + thread + sandbox + heading tests passed")
