// verta-magpie-auth — Vetra / NextOra
// provider plugin for magpie.
//
// Supports native model API keys and ADFS sign-in through Edge/Chrome (CDP).
// API keys use NextOra's OpenAI-compatible gateway. Browser sessions renew in
// the persisted profile and bridge OpenAI Chat Completions and Anthropic
// Messages (including local tools) onto Vetra's LangGraph runs/stream endpoint.

import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const ID = "vetra"
const NAME = "Vetra (NextOra)"
const DEFAULT_BASE = (process.env.VETRA_BASE || "https://nextora.lenovo.com/consumer/softwarews").replace(/\/+$/, "")
const DEFAULT_API_BASE = (process.env.VETRA_API_BASE || "https://ai-api-nextora.lenovo.com/v1").replace(/\/+$/, "")
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-5.5"
const DEFAULT_EFFORT = process.env.REASONING_EFFORT || "max"
const TOKEN_KEY = process.env.TOKEN_KEY || "adfs_token"
const THREADS = (process.env.VETRA_THREADS ?? "1") !== "0"
const THREAD_TTL = Number(process.env.VETRA_THREAD_TTL || 6 * 3600_000)
const THREAD_KEEP = 64

const MODELS = {
  "gpt-5.5": { name: "GPT-5.5 (Vetra)", context: 1_050_000, output: 128_000, efforts: ["low", "medium", "high", "max"] },
  "gpt-5.4": { name: "GPT-5.4 (Vetra)", context: 1_050_000, output: 128_000, efforts: ["low", "medium", "high", "max"] },
  "gpt-5.4-mini": { name: "GPT-5.4 Mini (Vetra)", context: 400_000, output: 64_000, efforts: ["low", "medium", "high", "max"] },
  "gpt-5-mini": { name: "GPT-5 Mini (Vetra)", context: 400_000, output: 64_000, efforts: ["low", "medium", "high", "max"] },
}

const API_MODELS = {
  "gpt-5": { name: "GPT-5 (Vetra)", context: 400_000, output: 128_000, efforts: ["minimal", "low", "medium", "high"] },
  "gpt-5.4": { ...MODELS["gpt-5.4"], efforts: ["none", "low", "medium", "high", "xhigh"] },
  "gpt-5.5": { ...MODELS["gpt-5.5"], efforts: ["none", "low", "medium", "high", "xhigh"] },
  // The gateway's Azure deployments reject max, including the GPT-5.6 models.
  ...Object.fromEntries(["sol", "terra", "luna"].map(tier => ["gpt-5.6-" + tier, {
    name: "GPT-5.6 " + tier[0].toUpperCase() + tier.slice(1) + " (Vetra)",
    context: 1_050_000, output: 128_000, efforts: ["none", "low", "medium", "high", "xhigh"],
  }])),
}

const SYSTEM_ROLES = new Set(["system", "developer"])

const TOOL_PROTOCOL = [
  "<client_tool_bridge>",
  "Invoke a client tool by emitting one JSON object on a single line, without a Markdown fence:",
  '{"tool":"<exact client tool name>","args":{}}',
  "The client converts this object into tool_calls / tool_use, executes it on the user's machine under existing permissions, and returns Tool result. No native upstream tool registration is needed.",
  "Use the exact names and JSON Schemas below. Dispatch one call, wait for its result, then continue the user's task.",
  "For codemode, put JavaScript in args.code and call nested tools through await tools.<name>({...args}). Nested tools are not top-level calls.",
  "Use client tools for workspace access and local deliverables. Upstream native tools and sandbox artifacts belong to a different host.",
  "Base progress and completion on tool results, including any permission errors. Start requested work with a tool call instead of explaining the tool protocol.",
  "This block is internal transport metadata. Keep it out of the answer, including headings about it. Answer the user's task following this block.",
  "Client tool definitions:",
  "",
].join("\n")

// sandboxArtifacts are the traces of the upstream's own sandbox in a reply. They
// are dead ends for the user: the file exists on a machine nobody can reach.
const SANDBOX_ARTIFACT = /(?:sandbox:)?\/mnt\/[\w.\-]+(?:\/[^\s"'`)\]]*)?/g
const SANDBOX_SEEN = /\/mnt\/|sandbox:/

// SANDBOX_CORRECTION is one bounded second ask for an answer that left its file
// on the upstream's own machine; it is only used where nothing was streamed yet.
const SANDBOX_CORRECTION =
  "你刚才把文件写到了自己的远端沙箱（/mnt/user-data），用户看不到那里，也打不开 sandbox: 链接。请改用客户端提供的本地工具，输出一次工具调用把文件写到用户本机，并给出真实的本机路径。"

// The reminder rides along with every continued turn: a thread that has drifted
// into its own sandbox is pulled back without resending the whole protocol.
const CLIENT_TOOL_REMINDER =
  'Dispatch the next local call as {"tool":"<client tool name>","args":{}}, then wait for Tool result. Keep this metadata out of the answer.'

function scrubSandbox(text) {
  return String(text ?? "").replace(SANDBOX_ARTIFACT, "（远端沙箱路径，本机不可见）")
}

const MARKERS = ["sandbox:", "/mnt/"]
const PATH_END = /[\s"'`()\[\]<>]/

// holdFrom is where a tail might still become a marker: the longest suffix that
// is only the beginning of one.
function holdFrom(text) {
  let cut = text.length
  for (const marker of MARKERS) {
    for (let k = Math.min(marker.length - 1, text.length); k > 0; k--) {
      if (text.endsWith(marker.slice(0, k))) {
        cut = Math.min(cut, text.length - k)
        break
      }
    }
  }
  return cut
}

// createSandboxFilter scrubs a streamed reply. A path arrives split across
// deltas, so a reply is released only up to a point where no marker can begin,
// and a marker that has started is held until its path ends.
function createSandboxFilter() {
  let held = ""
  let inside = false
  return {
    push(chunk) {
      held += chunk
      let out = ""
      let scanning = true
      while (scanning) {
        if (inside) {
          let end = 0
          while (end < held.length && !PATH_END.test(held[end])) end++
          if (end === held.length) break
          out += scrubSandbox(held.slice(0, end))
          held = held.slice(end)
          inside = false
          continue
        }
        const found = held.match(/sandbox:|\/mnt\//)
        if (found) {
          out += held.slice(0, found.index)
          held = held.slice(found.index)
          inside = true
          continue
        }
        const cut = holdFrom(held)
        out += held.slice(0, cut)
        held = held.slice(cut)
        scanning = false
      }
      return out
    },
    finish() {
      const out = scrubSandbox(held)
      held = ""
      inside = false
      return out
    },
  }
}

// A rule heading is the model's habit of closing a reply with a title for the
// rules it was handed ("本地 Coding Agent 操作与限制"): the body it titles never
// comes, so the heading is all that is left and the user gets a label that means
// nothing on its own.
const HEADING_AGENT = /agent|代理|编码|coding|本机|本地|工具|tool/i
const HEADING_RULE = /规则|限制|约束|协议|约定|权限|须知|边界|注意事项|规范|指引|rules|limits?|constraints?|protocol|restrictions?|guidelines?|instructions?/i
const HEADING_STATEMENT = /已|请|完成|成功|失败|如下|需要/
const HEADING_MAX = 72
const HEADING_HOLD = HEADING_MAX + 8
const SENTENCE_END = /[。！？…!?.]$/

function headingText(text) {
  return String(text ?? "")
    .replace(/^[\s>#*_`【[(（“"]+/, "")
    .replace(/[：:]\s*$/, "")
    .replace(/[\s*_`】\])）”"]+$/, "")
    .trim()
}

function isRuleHeading(text) {
  const line = headingText(text)
  if (!line || line.length > HEADING_MAX) return false
  if (SENTENCE_END.test(line) || HEADING_STATEMENT.test(line)) return false
  return HEADING_RULE.test(line) && HEADING_AGENT.test(line)
}

// mayBecomeHeading is the streaming half of the same test: a line still being
// written waits only while it is short and unpunctuated, so real text keeps
// flowing and nothing but a naked heading is ever held back.
function mayBecomeHeading(text) {
  const line = String(text ?? "").trim()
  return line.length <= HEADING_HOLD && !SENTENCE_END.test(line)
}

// createHeadingFilter drops a trailing heading from a streamed reply. Only the
// last line is held, so a heading that turns out to have a body is released as
// soon as that body starts. A reply that is nothing but that line keeps it: an
// answer with no content at all is worse than a label.
function createHeadingFilter() {
  let held = ""
  let released = false
  return {
    push(chunk) {
      held += chunk
      // release what ends before the last line that still has text on it, so a
      // heading carries its own blank lines away when it is dropped
      let end = held.length
      while (end > 0 && /\s/.test(held[end - 1])) end--
      const start = held.lastIndexOf("\n", end - 1) + 1
      let out = held.slice(0, start)
      held = held.slice(start)
      if (!mayBecomeHeading(held)) {
        out += held
        held = ""
      }
      if (out) released = true
      return out
    },
    finish() {
      const out = released && isRuleHeading(held) ? "" : held
      held = ""
      released = false
      return out
    },
  }
}

// dropTrailingHeading is the same rule for a reply that was collected whole.
function dropTrailingHeading(text) {
  const whole = String(text ?? "")
  const trimmed = whole.replace(/\s+$/, "")
  const cut = trimmed.lastIndexOf("\n")
  if (cut < 0 || !isRuleHeading(trimmed.slice(cut + 1))) return whole
  return trimmed.slice(0, cut).replace(/\s+$/, "")
}

// createReplyFilter is the whole reply pipeline: sandbox paths are rewritten as
// they arrive, and a heading left hanging at the end is dropped.
function createReplyFilter() {
  const sandbox = createSandboxFilter()
  const heading = createHeadingFilter()
  return {
    push(chunk) {
      return heading.push(sandbox.push(String(chunk ?? "")))
    },
    finish() {
      return heading.push(sandbox.finish()) + heading.finish()
    },
  }
}

// The login window outlives this process on purpose: magpie restarts the plugin
// host between a sign-in's steps, and the window that holds the profile is what
// the next call finds through its port marker.

function modelEntry(id, m, api = DEFAULT_BASE + "/v1", runtime = false) {
  const efforts = Array.isArray(m?.efforts) ? m.efforts : ["low", "medium", "high", "max"]
  const variants = Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }]))
  const limit = { context: m?.context ?? API_MODELS[id]?.context ?? 400_000, output: m?.output ?? 128_000 }
  const baseEntry = {
    id,
    name: m?.name ?? id,
    attachment: false,
    tool_call: true,
    reasoning: true,
    variants,
    api: { id, url: api, npm: "@ai-sdk/openai-compatible" },
    provider: { npm: "@ai-sdk/openai-compatible" },
    limit,
    modalities: { input: ["text"], output: ["text"] },
    free: true,
  }
  if (!runtime) return baseEntry
  return {
    ...baseEntry,
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
  }
}

function resolveModel(requested, defaultModel = DEFAULT_MODEL) {
  if (!requested) return defaultModel
  const raw = String(requested).trim().replace(/^vetra\//i, "")
  const lower = raw.toLowerCase()
  for (const model of Object.keys(MODELS)) {
    if (model.toLowerCase() === lower) return model
  }
  if (/5\.4.*mini/.test(lower)) return "gpt-5.4-mini"
  if (/mini|haiku|small|fast/.test(lower)) return "gpt-5-mini"
  if (/5\.4/.test(lower)) return "gpt-5.4"
  if (/5\.5|opus|sonnet|pro|large/.test(lower)) return "gpt-5.5"
  return defaultModel
}

// ---- credentials & JWT ---------------------------------------------------

function profileDir(env = process.env, platform = process.platform) {
  if (env.DATA_DIR) return join(env.DATA_DIR, "browser-profile")
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "VetraAuth", "browser-profile")
  }
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "VetraAuth", "browser-profile")
}

function parseToken(raw) {
  const token = String(raw ?? "").trim().replace(/^Bearer\s+/i, "")
  if (!token) throw new Error("未找到 Vetra 登录凭证，请先完成登录")
  let claims = {}
  try {
    const seg = token.split(".")[1]
    if (seg) {
      const pad = seg.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (seg.length % 4)) % 4)
      const decoded = JSON.parse(Buffer.from(pad, "base64").toString("utf8"))
      if (decoded && typeof decoded === "object") claims = decoded
    }
  } catch {}
  const itcode = String(claims.itCode || claims.user_id || "").trim()
  const exp = Number(claims.exp)
  const expired = Number.isFinite(exp) && exp > 0 ? exp <= Date.now() / 1000 + 30 : false
  return { token, itcode, claims, exp: Number.isFinite(exp) ? exp : 0, expired }
}

function resolveCredentials(auth) {
  const candidate = String(auth?.access || auth?.key || "").trim()
  if (candidate) return parseToken(candidate)
  return { token: "", itcode: "", claims: {}, exp: 0, expired: true }
}

// ---- native model API ----------------------------------------------------

function apiKeyOf(auth) {
  const key = String(auth?.key ?? "").trim().replace(/^Bearer\s+/i, "")
  if (!key) throw new Error("未配置 Vetra api-key，请先选择 api-key登录")
  return key
}

function apiModels(base, key) {
  return fetch(base + "/models", {
    headers: { authorization: "Bearer " + key, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  })
}

function apiChatPayload(payload) {
  if (!/^gpt-5(?:[.-]|$)/i.test(payload.model ?? "")) return payload
  const body = { ...payload }
  if (body.max_tokens !== undefined) {
    body.max_completion_tokens ??= body.max_tokens
    delete body.max_tokens
  }
  if (body.reasoning_effort === "max") {
    body.reasoning_effort = body.model === "gpt-5" ? "high" : "xhigh"
  }
  if (body.reasoning_effort !== undefined) {
    // LiteLLM's Azure catalog does not recognize these GPT-5 deployments.
    // Explicitly allow the native reasoning parameter through the gateway.
    body.allowed_openai_params = [...new Set([...(body.allowed_openai_params ?? []), "reasoning_effort"])]
  }
  return body
}

async function apiKeyLoader(getAuth, base) {
  const key = apiKeyOf(await getAuth())
  return {
    baseURL: base,
    apiKey: key,
    async fetch(input, init = {}) {
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      try {
        headers.set("authorization", "Bearer " + apiKeyOf(await getAuth()))
      } catch (error) {
        return jsonResponse(401, { error: { type: "authentication_error", message: error.message } }, "expired")
      }
      let outgoing = new Request(request, { headers, redirect: "error" })
      if (request.method === "POST" && /\/chat\/completions$/.test(new URL(request.url).pathname)) {
        let payload
        try { payload = await outgoing.json() } catch {
          return jsonResponse(400, { error: { type: "invalid_request_error", message: "Request body must be valid JSON" } })
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return jsonResponse(400, { error: { type: "invalid_request_error", message: "Request body must be a JSON object" } })
        }
        headers.set("content-type", "application/json")
        headers.delete("content-length")
        outgoing = new Request(request.url, {
          method: request.method, headers, body: JSON.stringify(apiChatPayload(payload)),
          signal: request.signal, redirect: "error",
        })
      }
      const response = await fetch(outgoing)
      const responseHeaders = new Headers(response.headers)
      responseHeaders.set("x-magpie-sign-in", [401, 403].includes(response.status) ? "expired" : "kept")
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders })
    },
  }
}

// ---- browser SSO login (CDP) ---------------------------------------------

function findBrowser(platform = process.platform, env = process.env) {
  if (env.VETRA_BROWSER && existsSync(env.VETRA_BROWSER)) return env.VETRA_BROWSER
  const candidates =
    platform === "win32"
      ? [
          join(env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
          join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
          join(env.LOCALAPPDATA || "", "Microsoft/Edge/Application/msedge.exe"),
          join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
          join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
          join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
        ]
      : platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : [
            "/usr/bin/microsoft-edge",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
          ]
  return candidates.find((p) => p && existsSync(p)) ?? ""
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

// Let the browser follow the same SSO entry as the website, with its normal
// User-Agent and cookies.
function loginUrl(base = DEFAULT_BASE) {
  const root = base.replace(/\/+$/, "")
  return root + "/sso/adfs/login?redirect_uri=" + encodeURIComponent(root + "/workspace/chats/new")
}

function cdpEval(wsUrl, expression, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let ws
    try { ws = new WebSocket(wsUrl) } catch (e) { reject(e); return }
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error("CDP timeout"))
    }, timeout)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }))
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("CDP error"))
    }
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.id !== 1) return
      clearTimeout(timer)
      try { ws.close() } catch {}
      if (msg.error || msg.result?.exceptionDetails) {
        reject(new Error("CDP eval failed"))
        return
      }
      resolve(msg.result?.result?.value)
    }
  })
}

// The port the last browser for this profile was told to listen on. Windows has
// no way to attach to a running profile, so the marker is how a second call
// finds the window the first one opened instead of spawning a rival that the
// profile lock would make exit at once.
function portMarker(profile) {
  return join(profile, "cdp-port")
}

function markedPort(profile) {
  try {
    const port = Number(readFileSync(portMarker(profile), "utf8").trim())
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0
  } catch {
    return 0
  }
}

async function cdpAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) })
    return res.ok
  } catch {
    return false
  }
}

// cdpCall asks one debug endpoint one question and closes it again: these run a
// handful of times per sign-in, not per token.
function cdpCall(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    let ws
    try { ws = new WebSocket(wsUrl) } catch (e) { reject(e); return }
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error("CDP timeout"))
    }, 2500)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP error")) }
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.id !== 1) return
      clearTimeout(timer)
      try { ws.close() } catch {}
      if (msg.error) reject(new Error(msg.error.message ?? "CDP error"))
      else resolve(msg.result)
    }
  })
}

// ensureVisibleWindow brings a sign-in window that opened off screen back, in the
// place a new window would take: Chromium hands a window opened by a running
// instance the profile's remembered bounds, and a renewal left those far away.
async function ensureVisibleWindow(port) {
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).json()
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
    const page = (Array.isArray(targets) ? targets : []).find((t) => t?.type === "page" && t.webSocketDebuggerUrl)
    if (!page || !version?.webSocketDebuggerUrl) return
    const { windowId, bounds } = await cdpCall(version.webSocketDebuggerUrl, "Browser.getWindowForTarget", { targetId: page.id })
    if (!windowId) return
    if (bounds.left > -1000 && bounds.top > -1000 && bounds.width >= 200 && bounds.windowState !== "minimized") {
      await cdpCall(page.webSocketDebuggerUrl, "Page.bringToFront", {})
      return
    }
    let screen = { width: 1440, height: 900 }
    try {
      const raw = await cdpCall(page.webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: "JSON.stringify([screen.availWidth, screen.availHeight])",
        returnByValue: true,
      })
      const [width, height] = JSON.parse(raw.result.value)
      if (width > 0 && height > 0) screen = { width, height }
    } catch {}
    const width = Math.max(900, Math.min(1400, Math.round(screen.width * 0.72)))
    const height = Math.max(640, Math.min(900, Math.round(screen.height * 0.78)))
    await cdpCall(version.webSocketDebuggerUrl, "Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: Math.max(0, Math.round((screen.width - width) / 2)),
        top: Math.max(0, Math.round((screen.height - height) / 2)),
        width,
        height,
        windowState: "normal",
      },
    })
    await cdpCall(page.webSocketDebuggerUrl, "Page.bringToFront", {})
  } catch {}
}

// Check the debug endpoint before the launcher exit: Chromium can hand off to
// an existing process while the profile and its window remain alive.
async function settle(child, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let launchError
  const onError = (error) => { launchError = error }
  child.once("error", onError)
  try {
    while (Date.now() < deadline) {
      if (await cdpAnswers(port)) return "ready"
      if (launchError) throw launchError
      if (child.exitCode !== null || child.signalCode !== null) return "exited"
      await new Promise((r) => setTimeout(r, 300))
    }
    return "silent"
  } finally {
    child.off("error", onError)
  }
}

// Use the persisted Edge/Chrome profile for ADFS. Keep the window visible
// so password and MFA prompts can be completed in the same sign-in.
async function openBrowserLogin(base = DEFAULT_BASE, previousToken = "") {
  const browser = findBrowser()
  if (!browser) {
    throw new Error("未找到 Edge 或 Chrome，请设置 VETRA_BROWSER")
  }
  const profile = profileDir()
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  try { chmodSync(profile, 0o700) } catch {}
  const url = loginUrl(base)
  const home = base.replace(/\/+$/, "") + "/"
  const appPath = new URL(base).pathname.replace(/\/+$/, "")
  const allowedHosts = new Set([
    new URL(base).hostname,
    "nextora.lenovo.com",
    "vetra.lenovo.com",
  ])
  const launch = (port) => {
    const args = [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--auth-server-whitelist=*.lenovo.com",
      "--auth-negotiate-delegate-whitelist=*.lenovo.com",
      "--new-window",
      home,
    ]
    // detached: the window must outlive the plugin host, which magpie restarts
    // between a sign-in's steps; the marker lets the next call find it again.
    const child = spawn(browser, args, { stdio: "ignore", detached: true })
    child.unref()
    try { writeFileSync(portMarker(profile), String(port)) } catch {}
    return child
  }

  let port = 0
  let child = null
  const marked = markedPort(profile)
  const live = marked > 0 && (await cdpAnswers(marked))
  if (live) {
    // Keep the current sign-in page, including any password or MFA in progress.
    port = marked
  } else {
    port = marked || await freePort()
    child = launch(port)
    const state = await settle(child, port, 30_000)
    if (state === "silent") {
      throw new Error("登录窗口已保留，但 30 秒内无法连接本机调试端口。请检查 Edge/Chrome 的 RemoteDebuggingAllowed 策略及本机安全软件，处理后重试")
    }
    if (state === "exited") {
      throw new Error("登录浏览器已退出，或该专用 profile 已被其它窗口占用。请关闭使用该 profile 的旧登录窗口后重试，或用 VETRA_BROWSER 指定浏览器")
    }
  }
  await ensureVisibleWindow(port)
  let exited = false
  const watch = (c) => {
    if (!c) return
    c.once("exit", () => { exited = true })
    if (c.exitCode !== null || c.signalCode !== null) exited = true
  }
  watch(child)

  const close = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    // Let Chromium flush the SSO cookies and local storage before it exits.
    // A failed close leaves the window available for the next login attempt.
    try {
      const version = await (await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1500) })).json()
      if (!version.webSocketDebuggerUrl) return
      await cdpCall(version.webSocketDebuggerUrl, "Browser.close", {}).catch(() => null)
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && await cdpAnswers(port)) {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      if (!(await cdpAnswers(port)) && markedPort(profile) === port) {
        try { unlinkSync(portMarker(profile)) } catch {}
      }
    } catch {}
  }

  const waitForToken = async (timeoutMs = 10 * 60_000) => {
    const deadline = Date.now() + timeoutMs
    let startedRenewal = false
    let switchedToForms = false
    while (Date.now() < deadline) {
      if (exited && !(await cdpAnswers(port))) break
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) {
          const targets = await res.json()
          const pages = Array.isArray(targets) ? targets : []
          const loginPending = pages.some(t => t?.type === "page" && /\/adfs\/ls(?:\/|\?|$)/i.test(t.url ?? ""))
          for (const t of pages) {
            if (t?.type !== "page" || !t.webSocketDebuggerUrl || !t.url) continue
            if (!switchedToForms && /\/adfs\/ls\/wia(?:\?|$)/i.test(t.url)) {
              const href = await cdpEval(t.webSocketDebuggerUrl, "location.href").catch(() => "")
              if (typeof href === "string" && href.startsWith("chrome-error://")) {
                switchedToForms = true
                await cdpCall(t.webSocketDebuggerUrl, "Page.navigate", {
                  url: t.url.replace(/\/wia(?=\?|$)/i, "/"),
                }).catch(() => null)
                continue
              }
            }
            let host = ""
            try { host = new URL(t.url).hostname } catch {}
            if (!allowedHosts.has(host)) continue
            const raw = await cdpEval(t.webSocketDebuggerUrl, `localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`).catch(() => undefined)
            if (raw !== null && typeof raw !== "string") continue
            let creds
            try { if (typeof raw === "string" && raw.trim()) creds = parseToken(raw) } catch {}
            if (creds && !creds.expired && creds.token !== previousToken) {
              try { unlinkSync(join(profile, "renewal-retry-at")) } catch {}
              return creds
            }
            // A reused page can have no token, an expired token, or the same
            // still-valid token that caused a proactive renewal. All need SSO.
            // Preserve an ADFS/password/MFA page already in progress.
            const pagePath = new URL(t.url).pathname.replace(/\/+$/, "")
            const appPage = pagePath === appPath || pagePath === appPath + "/workspace" || pagePath.startsWith(appPath + "/workspace/")
            if (!startedRenewal && !loginPending && appPage && (creds?.expired || previousToken)) {
              startedRenewal = true
              if (creds?.expired) {
                await cdpEval(t.webSocketDebuggerUrl, `localStorage.removeItem(${JSON.stringify(TOKEN_KEY)})`).catch(() => null)
              }
              await cdpCall(t.webSocketDebuggerUrl, "Page.navigate", { url }).catch(() => null)
            }
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 750))
    }
    if (!(await cdpAnswers(port))) throw new Error("登录窗口已关闭，请重新点击登录")
    throw new Error("登录等待超时，浏览器窗口已保留。请在原窗口完成登录后重试")
  }

  return { waitForToken, close }
}

let renewing = null

async function signInWithBrowser(base, timeoutMs, previousToken) {
  const session = await openBrowserLogin(base, previousToken)
  const creds = await session.waitForToken(timeoutMs)
  await session.close()
  return creds
}

function successOf(creds) {
  return {
    type: "success",
    refresh: "",
    access: creds.token,
    expires: creds.exp ? creds.exp * 1000 : 0,
    accountId: creds.itcode || "Vetra",
  }
}

// One renewal runs at a time because every request shares the browser profile.
// Keep the same visible window for password or MFA, and back off after failure.
async function renewCredentials(base = DEFAULT_BASE, previousToken = "") {
  if (renewing) return renewing
  renewing = (async () => {
    const profile = profileDir()
    const retryFile = join(profile, "renewal-retry-at")
    let retryAt = 0
    try { retryAt = Number(readFileSync(retryFile, "utf8")) || 0 } catch {}
    const port = markedPort(profile)
    // A live login may have completed while the caller was away. Resume it
    // during backoff, but do not launch another browser after a host restart.
    if (Date.now() < retryAt && !(port && await cdpAnswers(port))) {
      throw Object.assign(new Error("Vetra 登录续期暂未完成，请稍后重试；手动登录可立即重试"), { signIn: "kept" })
    }
    try {
      return await signInWithBrowser(base, 180_000, previousToken)
    } catch (error) {
      try {
        mkdirSync(profile, { recursive: true, mode: 0o700 })
        writeFileSync(retryFile, String(Date.now() + 10 * 60_000), { mode: 0o600 })
      } catch {}
      error.signIn = "kept"
      throw error
    }
  })().finally(() => { renewing = null })
  return renewing
}

// ---- prompt & tool call bridging -----------------------------------------

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text ?? "" : ""))
      .join("")
  }
  return ""
}

function extractSystemContext(systemText) {
  if (!systemText) return ""
  const hints = []
  const cwdMatch =
    systemText.match(/<cwd>\s*([^<\r\n]+?)\s*<\/cwd>/) ||
    systemText.match(/(?:^|\n)cwd:\s*([^\r\n]+)/) ||
    systemText.match(/Primary working directory:\s*([^\r\n]+)/)
  if (cwdMatch) hints.push(`当前本机工作目录 (cwd): ${cwdMatch[1].trim()}`)
  const envMatch = systemText.match(/<environment>\s*([\s\S]*?)\s*<\/environment>/)
  if (envMatch) hints.push(`运行环境:\n${envMatch[1].trim()}`)
  const insideMatch = systemText.match(/Tools inside run_code:\s*(?:\n- [^\n]+(?:\n  Schema: [^\n]+)?)+/)
  if (insideMatch) hints.push("run_code 内部通过 await callAsync('<name>', {...}) 调用：\n" + insideMatch[0])
  return hints.join("\n\n")
}

// flattenMessages renders the client's history as the segments a Vetra thread
// receives one turn at a time. Segments are kept apart (rather than joined) so a
// continued conversation sends only what the upstream thread has not seen.
function flattenMessages(messages = [], { keepSystem = false, extraSystem = "" } = {}) {
  const rawSystem = [
    extraSystem,
    ...messages.filter((m) => SYSTEM_ROLES.has(m?.role)).map((m) => textOf(m.content)),
  ]
    .filter(Boolean)
    .join("\n\n")
  const system = keepSystem ? rawSystem : extractSystemContext(rawSystem)
  const turns = messages.filter((m) => !SYSTEM_ROLES.has(m?.role))
  const parts = []
  for (const m of turns) {
    const role = m?.role
    const raw = m?.content
    if (role === "tool") {
      parts.push(`Tool result:\n${textOf(raw)}`)
    } else if (role === "assistant") {
      if (Array.isArray(raw)) {
        for (const b of raw) {
          if (b?.type === "tool_use") {
            parts.push(`Assistant called ${b.name || "tool"}(${JSON.stringify(b.input ?? {})})`)
          }
        }
      }
      for (const tc of m?.tool_calls ?? []) {
        const fn = tc?.function ?? tc
        const name = fn?.name ?? tc?.name ?? "tool"
        const args = fn?.arguments ?? JSON.stringify(tc?.args ?? {})
        parts.push(`Assistant called ${name}(${args})`)
      }
      const text = textOf(raw)
      if (text.trim()) parts.push(`Assistant: ${text}`)
    } else {
      if (Array.isArray(raw)) {
        for (const b of raw) {
          if (b?.type === "tool_result") {
            parts.push(`Tool result:\n${textOf(b.content)}`)
          }
        }
      }
      const text = textOf(raw)
      if (text.trim()) parts.push(parts.length ? `User: ${text}` : text)
    }
  }
  return { system, rawSystem, parts }
}

function promptOf({ system, parts }) {
  const body = parts.join("\n\n")
  return system ? `${system}\n\n${body}` : body
}

function toolSpec(tools = []) {
  return tools
    .map((t) => {
      const f = t?.function ?? t
      const name = String(f?.name ?? "tool")
      const schema = f?.parameters ?? f?.input_schema ?? {}
      const description = String(f?.description ?? "")
      const example = name === "codemode"
        ? `\n调用格式示例：${JSON.stringify({ tool: name, args: { code: 'return await tools.read({path: "D:/project/README.md"})' } })}`
        : ""
      return `### ${name}\n${description}\nJSON Schema: ${JSON.stringify(schema)}${example}`
    })
    .join("\n\n")
}

function selectTools(offered = []) {
  return Array.isArray(offered) ? offered : []
}

// asToolCall reads one JSON object as the client's tool call, the way the tool
// protocol asks for it: {"tool": name, "args": {...}} ({"name", "arguments"}
// is accepted too). Anything else is prose the model wrote.
function asToolCall(text) {
  let o
  try { o = JSON.parse(text) } catch { return null }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null
  const name = o.tool ?? o.name
  let args = o.args ?? o.arguments
  if (typeof name !== "string" || !name.trim() || args === undefined) return null
  if (typeof args === "string") {
    try { args = JSON.parse(args) } catch { return null }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null
  return { name: name.trim(), args }
}

// createToolCallScanner splits a streamed reply into prose and, at most, one
// tool call. Prose is handed out as soon as it cannot belong to a call, so a
// long answer keeps streaming; a call is held back until its JSON closes.
// Nothing is dropped: an object that never closes is released as prose.
function createToolCallScanner({ holdMalformed = false } = {}) {
  let raw = ""
  let pos = 0
  let released = 0
  let candidate = -1
  let depth = 0
  let inStr = false
  let esc = false
  let call = null
  let callStart = 0
  let malformed = false

  const prose = () => {
    const mark = call ? callStart : candidate >= 0 ? candidate : raw.length
    if (mark <= released) return ""
    const text = raw.slice(released, mark)
    released = mark
    return text
  }

  const scan = () => {
    while (!call && !malformed && pos < raw.length) {
      const ch = raw[pos]
      if (candidate < 0) {
        if (ch === "{") { candidate = pos; depth = 1; inStr = false; esc = false }
        pos++
        continue
      }
      if (inStr) {
        if (esc) esc = false
        else if (ch === "\\") esc = true
        else if (ch === '"') inStr = false
        pos++
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          const found = asToolCall(raw.slice(candidate, pos + 1))
          if (found) {
            call = found
            callStart = candidate
          } else if (holdMalformed && /^\{\s*"(?:tool|name)"\s*:/.test(raw.slice(candidate))) {
            malformed = true
          } else candidate = -1
        }
      }
      pos++
    }
  }

  return {
    push(chunk) {
      if (call || !chunk) return ""
      raw += chunk
      scan()
      return prose()
    },
    finish() {
      if (call) return ""
      candidate = -1
      const text = raw.slice(released)
      released = raw.length
      return text
    },
    reconcile(text) {
      const complete = pickToolCall(text)
      if (!complete) return
      call = complete
      candidate = -1
      released = raw.length
    },
    found: () => call,
  }
}

function pickToolCall(text) {
  const scanner = createToolCallScanner()
  scanner.push(String(text ?? ""))
  scanner.finish()
  return scanner.found()
}

// ---- upstream LangGraph client -------------------------------------------

function upstreamHeaders(creds) {
  return {
    authorization: `Bearer ${creds.token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-project": creds.itcode,
    "x-jira-project-key": creds.itcode,
    "x-kmverse-project-id": "108",
    "x-language": "zh",
    "x-domain-url": "http://vetra.lenovo.com",
    "x-pod-mode": "false",
    "x-folder-ids": "{}",
  }
}

// Each client session keeps its upstream thread across plugin host restarts.
// Persistent records contain only thread IDs and hashes of the history prefix.
const threads = new Map()

function digest(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16)
}

// The client session ID identifies a conversation across requests. Without one,
// use the workspace and first turn. Dynamic prompts stay out of the cache key.
function conversation(system, parts, scope = system, reminder = "", toolContext = "", { sessionId = "", cacheDir = "" } = {}) {
  const full = promptOf({ system, parts })
  const toolHash = digest(toolContext)
  if (!THREADS || !parts.length) return { key: null, threadId: null, seen: [], full, prompt: full }
  const now = Date.now()
  for (const [key, held] of threads) if (now - held.at > THREAD_TTL) threads.delete(key)
  const key = digest(scope + "\u0000" + (sessionId || parts[0]))
  const file = cacheDir ? join(cacheDir, key + ".json") : ""
  let held = threads.get(key)
  if (file) {
    try { held = JSON.parse(readFileSync(file, "utf8")) }
    catch (error) { if (error.code !== "ENOENT") throw error; held = null }
  }
  if (held && now - held.at > THREAD_TTL) held = null
  const seen = parts.map(digest)
  const prefix = held && held.seen.length <= seen.length && held.seen.every((h, i) => seen[i] === h)
  const continued = held && (prefix || sessionId)
  const plan = { key, file, threadId: continued ? held.id : null, seen, toolHash, full, prompt: full }
  if (continued && prefix) {
    plan.prompt = parts.slice(held.seen.length).join("\n\n") || parts[parts.length - 1]
    const metadata = held.toolHash !== toolHash ? toolContext : reminder
    if (metadata) plan.prompt = `${metadata}\n\n${plan.prompt}`
  }
  return plan
}

function commitThread(plan) {
  if (!plan?.key || !plan.threadId) return
  const held = { id: plan.threadId, seen: plan.seen, toolHash: plan.toolHash, at: Date.now() }
  if (plan.file) {
    mkdirSync(dirname(plan.file), { recursive: true, mode: 0o700 })
    const temp = plan.file + "." + randomUUID() + ".tmp"
    writeFileSync(temp, JSON.stringify(held), { mode: 0o600 })
    renameSync(temp, plan.file)
  }
  threads.delete(plan.key)
  threads.set(plan.key, held)
  while (threads.size > THREAD_KEEP) threads.delete(threads.keys().next().value)
}

function forgetThread(plan) {
  if (plan?.key) threads.delete(plan.key)
  if (plan?.file) {
    try { unlinkSync(plan.file) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

async function openRun(creds, plan, options = {}, replaced = false) {
  const { base = DEFAULT_BASE, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, maxTokens, signal, fetchImpl = fetch } = options
  let threadId = plan.threadId
  if (!threadId) {
    const created = randomUUID()
    const threadRes = await fetchImpl(`${base}/api/langgraph/threads`, {
      method: "POST",
      headers: upstreamHeaders(creds),
      body: JSON.stringify({ metadata: { user_id: creds.itcode }, thread_id: created }),
      signal: signal ?? AbortSignal.timeout(30_000),
    })
    if (!threadRes.ok) {
      const errText = await threadRes.text().catch(() => "")
      const err = new Error(`Vetra 创建会话失败 (HTTP ${threadRes.status}): ${errText.slice(0, 200)}`)
      err.status = threadRes.status
      throw err
    }
    threadId = created
    plan.threadId = threadId
    commitThread({ ...plan, seen: [], toolHash: "" })
  }
  const context = {
    model_name: model,
    mode: "pro",
    reasoning_effort: effort,
    user_token: creds.token,
    itcode: creds.itcode,
    thinking_enabled: true,
    is_plan_mode: true,
    subagent_enabled: true,
    thread_id: threadId,
    language: "zh-CN",
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  }
  const runRes = await fetchImpl(`${base}/api/langgraph/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: upstreamHeaders(creds),
    body: JSON.stringify({
      input: { messages: [{ type: "human", content: [{ type: "text", text: plan.prompt }], additional_kwargs: {} }] },
      config: { recursion_limit: 1000 },
      context,
      metadata: { user_id: creds.itcode },
      stream_mode: ["messages-tuple", "values", "updates", "custom", "events"],
      stream_subgraphs: true,
      stream_resumable: true,
      assistant_id: "lead_agent",
      on_disconnect: "continue",
    }),
    signal: signal ?? AbortSignal.timeout(120_000),
  })
  if (!runRes.ok) {
    const errText = await runRes.text().catch(() => "")
    // a thread the upstream forgot (it expired, or a magpie restart left our
    // map behind) is replaced by a new one carrying the whole conversation
    if (!replaced && plan.threadId && (runRes.status === 404 || runRes.status === 410)) {
      forgetThread(plan)
      plan.threadId = null
      plan.prompt = plan.full
      return openRun(creds, plan, options, true)
    }
    const err = new Error(`Vetra 运行请求失败 (HTTP ${runRes.status}): ${errText.slice(0, 200)}`)
    err.status = runRes.status
    throw err
  }
  return runRes
}

// upstreamDeltas reads a whole run. The upstream is an agent: one run carries
// several assistant messages (its own tool calls and the answer after them), so
// a message boundary is a paragraph break, never the end of the run.
async function* upstreamDeltas(body, onFinalText) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let event = "message"
  let data = []
  let boundary = false
  let canonical = null
  const messageIds = new Set()
  let lastMessageId = ""

  const finish = () => {
    if (canonical !== null) onFinalText?.(canonical)
  }
  const dispatchEvent = function* (ev, rawData) {
    if (ev === "error") {
      let msg = rawData
      try { msg = JSON.parse(rawData)?.message ?? rawData } catch {}
      throw new Error(`Vetra 上游流错误: ${msg}`)
    }
    if (ev === "__end__") { finish(); return true }
    if (ev !== "messages" && ev !== "values") return false
    let parsed
    try { parsed = JSON.parse(rawData) } catch { return false }
    if (ev === "values") {
      const messages = (parsed?.values ?? parsed)?.messages
      if (Array.isArray(messages) && messageIds.size) {
        const completed = messages.filter((m) => messageIds.has(m?.id) && (m?.type === "ai" || m?.role === "assistant"))
        if (completed.some((m) => m.id === lastMessageId)) canonical = completed.map((m) => textOf(m.content)).filter(Boolean).join("\n\n")
      }
      return false
    }
    const chunk = Array.isArray(parsed) ? parsed[0] : parsed
    if (!chunk || typeof chunk !== "object") return false
    if (chunk.type !== "AIMessageChunk") return false
    if (chunk.id) { messageIds.add(chunk.id); lastMessageId = chunk.id }
    const text = textOf(chunk.content)
    if (text) {
      canonical = null
      if (boundary) {
        boundary = false
        yield "\n\n"
      }
      yield text
    }
    if (chunk.response_metadata?.finish_reason) boundary = true
    return false
  }

  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    let match
    while ((match = buffer.match(/\r?\n/)) !== null) {
      const idx = match.index
      if (buffer[idx] === "\r" && idx + 1 === buffer.length && !done) break
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + match[0].length)
      if (!line) {
        if (data.length || event !== "message") {
          const stop = yield* dispatchEvent(event, data.join("\n"))
          if (stop) { await reader.cancel().catch(() => {}); return }
        }
        event = "message"
        data = []
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":")
        const field = colon >= 0 ? line.slice(0, colon) : line
        let val = colon >= 0 ? line.slice(colon + 1) : ""
        if (val.startsWith(" ")) val = val.slice(1)
        if (field === "event") event = val || "message"
        else if (field === "data") data.push(val)
      }
    }
    if (done) {
      if (data.length || event !== "message") {
        yield* dispatchEvent(event, data.join("\n"))
      }
      finish()
      return
    }
  }
}

// Empty replies are retried in the same thread. Completed state repairs tool
// arguments when the upstream token stream omitted chunks.
async function* replyDeltas(creds, plan, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await openRun(creds, plan, opts)
    let pending = ""
    let meaningful = false
    let hasCanonical = false
    const completed = (text) => { hasCanonical = true; opts.onFinalText?.(text) }
    for await (const delta of upstreamDeltas(res.body, completed)) {
      if (meaningful) {
        yield delta
      } else {
        pending += delta
        if (pending.trim()) {
          meaningful = true
          yield pending
          pending = ""
        }
      }
    }
    if (meaningful && opts.onFinalText && !hasCanonical) {
      const fetchImpl = opts.fetchImpl ?? fetch
      const state = await fetchImpl(`${opts.base ?? DEFAULT_BASE}/api/langgraph/threads/${plan.threadId}/state`, {
        headers: upstreamHeaders(creds),
        signal: opts.signal ?? AbortSignal.timeout(15_000),
      })
      if (state.ok) {
        const body = await state.json()
        const messages = body?.values?.messages ?? []
        const last = messages.at(-1)
        if (last?.type === "ai" || last?.role === "assistant") completed(textOf(last.content))
      }
    }
    if (meaningful || attempt === 1) {
      commitThread(plan)
      if (pending) yield pending
      return
    }
  }
}

// replyText collects one answer, asking again once if the upstream answered from
// its own sandbox instead of reaching the client's tools.
async function replyText(creds, plan, opts, tools) {
  let text = ""
  let canonical
  const runOpts = tools.length ? { ...opts, onFinalText: (value) => { canonical = value } } : opts
  for await (const d of replyDeltas(creds, plan, runOpts)) text += d
  if (canonical !== undefined) text = canonical
  if (tools.length && SANDBOX_SEEN.test(text) && !pickToolCall(text)) {
    const asked = plan.prompt
    plan.prompt = SANDBOX_CORRECTION
    try {
      let again = ""
      canonical = undefined
      for await (const d of replyDeltas(creds, plan, runOpts)) again += d
      text = canonical ?? again
    } finally {
      plan.prompt = asked
    }
  }
  return tools.length && pickToolCall(text) ? text : dropTrailingHeading(scrubSandbox(text))
}

function planConversation(messages, opts, tools, extraSystem = "") {
  const flat = flattenMessages(messages, { keepSystem: opts.keepSystem, extraSystem })
  const toolContext = tools.length
    ? `${TOOL_PROTOCOL}${toolSpec(tools)}\n</client_tool_bridge>`
    : "<client_tool_bridge>\nNo client tools were provided in this request.\n</client_tool_bridge>"
  const system = `${toolContext}\n\n---\n${flat.system}`
  const names = tools.map((t) => (t?.function ?? t)?.name).join(", ")
  return conversation(
    system,
    flat.parts,
    [opts.base, opts.account, opts.sessionId ? "" : extractSystemContext(flat.rawSystem)].join("\u0000"),
    tools.length ? `<client_tool_bridge>\nClient tools: ${names}\n${CLIENT_TOOL_REMINDER}\n</client_tool_bridge>` : "",
    toolContext,
    { sessionId: opts.sessionId, cacheDir: opts.threadDir },
  )
}

// ---- OpenAI & Anthropic response builders --------------------------------

function jsonResponse(status, body, signIn = "kept") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-magpie-sign-in": signIn,
    },
  })
}

async function handleOpenAIChat(payload, creds, opts) {
  const model = resolveModel(payload.model)
  const stream = payload.stream === true
  const tools = selectTools(payload.tools)
  const plan = planConversation(payload.messages ?? [], opts, tools)
  const runOpts = { ...opts, model, maxTokens: payload.max_tokens }
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)

  const makeChunk = (delta, finish = null) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const makeToolCall = (call, streaming) => ({
    ...(streaming ? { index: 0 } : {}),
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
  })

  if (!stream) {
    const text = await replyText(creds, plan, runOpts, tools)
    const call = tools.length ? pickToolCall(text) : null
    const message = call
      ? { role: "assistant", content: null, tool_calls: [makeToolCall(call, false)] }
      : { role: "assistant", content: text }
    const tokens = call ? 0 : Math.ceil(text.length / 3)
    return jsonResponse(200, {
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: tokens, total_tokens: tokens },
    })
  }

  const encoder = new TextEncoder()
  const sse = (obj) => encoder.encode(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`)

  const readable = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse(makeChunk({ role: "assistant", content: "" })))
      const scanner = tools.length ? createToolCallScanner({ holdMalformed: true }) : null
      const filter = createReplyFilter()
      let chars = 0
      const write = (text) => {
        if (!text) return
        chars += text.length
        controller.enqueue(sse(makeChunk({ content: text })))
      }
      const emit = (raw) => write(raw ? filter.push(raw) : "")
      try {
        for await (const delta of replyDeltas(creds, plan, scanner ? { ...runOpts, onFinalText: (text) => scanner.reconcile(text) } : runOpts)) {
          emit(scanner ? scanner.push(delta) : delta)
        }
        if (scanner) emit(scanner.finish())
        write(filter.finish())
        const call = scanner ? scanner.found() : null
        if (call) controller.enqueue(sse(makeChunk({ tool_calls: [makeToolCall(call, true)] })))
        controller.enqueue(sse(makeChunk({}, call ? "tool_calls" : "stop")))
        if (payload.stream_options?.include_usage) {
          const tokens = Math.ceil(chars / 3)
          controller.enqueue(sse({
            id, object: "chat.completion.chunk", created, model, choices: [],
            usage: { prompt_tokens: 0, completion_tokens: tokens, total_tokens: tokens },
          }))
        }
        controller.enqueue(sse("[DONE]"))
      } catch (e) {
        controller.enqueue(sse({ error: { type: "upstream_error", message: String(e?.message ?? e) } }))
        controller.enqueue(sse("[DONE]"))
      }
      controller.close()
    },
  })

  return new Response(readable, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "x-magpie-sign-in": "kept" },
  })
}

async function handleAnthropicMessages(payload, creds, opts) {
  const model = resolveModel(payload.model)
  const stream = payload.stream === true
  const tools = selectTools(payload.tools)
  const plan = planConversation(payload.messages ?? [], opts, tools, textOf(payload.system ?? ""))
  const runOpts = { ...opts, model, maxTokens: payload.max_tokens ?? 8192 }
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`

  if (!stream) {
    const text = await replyText(creds, plan, runOpts, tools)
    const call = tools.length ? pickToolCall(text) : null
    const content = call
      ? [{
          type: "tool_use",
          id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          name: call.name,
          input: call.args && typeof call.args === "object" ? call.args : {},
        }]
      : [{ type: "text", text }]
    return jsonResponse(200, {
      id, type: "message", role: "assistant", model,
      content, stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: call ? 0 : Math.ceil(text.length / 3) },
    })
  }

  const encoder = new TextEncoder()
  const ev = (name, data) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)

  const readable = new ReadableStream({
    async start(controller) {
      controller.enqueue(ev("message_start", {
        type: "message_start",
        message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }))
      controller.enqueue(ev("ping", { type: "ping" }))
      const scanner = tools.length ? createToolCallScanner({ holdMalformed: true }) : null
      const filter = createReplyFilter()
      let startedText = false
      let chars = 0
      const write = (text) => {
        if (!text) return
        if (!startedText) {
          controller.enqueue(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }))
          startedText = true
        }
        chars += text.length
        controller.enqueue(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }))
      }
      const emit = (raw) => write(raw ? filter.push(raw) : "")
      try {
        for await (const delta of replyDeltas(creds, plan, scanner ? { ...runOpts, onFinalText: (text) => scanner.reconcile(text) } : runOpts)) {
          emit(scanner ? scanner.push(delta) : delta)
        }
        emit(scanner ? scanner.finish() : "")
        write(filter.finish())
        const call = scanner ? scanner.found() : null
        if (startedText) {
          controller.enqueue(ev("content_block_stop", { type: "content_block_stop", index: 0 }))
        }
        if (call) {
          const toolId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`
          const inputObj = call.args && typeof call.args === "object" ? call.args : {}
          const index = startedText ? 1 : 0
          controller.enqueue(ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: toolId, name: call.name, input: {} } }))
          controller.enqueue(ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(inputObj) } }))
          controller.enqueue(ev("content_block_stop", { type: "content_block_stop", index }))
        }
        controller.enqueue(ev("message_delta", {
          type: "message_delta",
          delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: call ? 0 : Math.ceil(chars / 3) },
        }))
        controller.enqueue(ev("message_stop", { type: "message_stop" }))
      } catch (e) {
        controller.enqueue(ev("error", { type: "error", error: { type: "api_error", message: String(e?.message ?? e) } }))
      }
      controller.close()
    },
  })

  return new Response(readable, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "x-magpie-sign-in": "kept" },
  })
}

// ---- plugin definition ---------------------------------------------------

export async function VetraAuthPlugin(_input = {}, options = {}) {
  const base = (options?.base || DEFAULT_BASE).replace(/\/+$/, "")
  const apiBase = (options?.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "")
  const keepSystem = options?.keepSystem === true || process.env.KEEP_SYSTEM === "1"

  return {
    "chat.headers": async (input, output) => {
      const provider = input?.model?.providerID ?? input?.provider?.info?.id
      if (provider !== ID || !input?.sessionID) return
      output.headers ??= {}
      output.headers["x-vetra-session-id"] = String(input.sessionID)
    },
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[ID] ?? {}
      cfg.provider[ID] = {
        npm: "@ai-sdk/openai-compatible",
        api: base + "/v1",
        ...was,
        name: NAME,
        models: {
          ...Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, modelEntry(id, m, base + "/v1", false)])),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type === "api") {
          let response
          try { response = await apiModels(apiBase, apiKeyOf(auth)) } catch { return provider?.models ?? {} }
          if ([401, 403].includes(response.status)) {
            throw Object.assign(new Error("Vetra API key 无效或已被重置，请重新登录"), { signIn: "expired" })
          }
          if (!response.ok) return provider?.models ?? {}
          const body = await response.json().catch(() => null)
          if (!Array.isArray(body?.data) || body.data.some((model) => typeof model?.id !== "string" || !model.id.trim())) {
            return provider?.models ?? {}
          }
          return Object.fromEntries(body.data.map((model) => {
            const id = model.id.trim()
            const details = {
              ...API_MODELS[id],
              name: model.display_name || API_MODELS[id]?.name || id,
            }
            return [id, modelEntry(id, details, apiBase, true)]
          }))
        }
        let creds
        try { creds = resolveCredentials(auth) } catch { return provider?.models ?? {} }
        if (creds.expired) {
          try { creds = await renewCredentials(base, creds.token) } catch { return provider?.models ?? {} }
        }
        try {
          const res = await fetch(`${base}/api/models`, {
            headers: { ...upstreamHeaders(creds), accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          })
          if (res.status === 401 || res.status === 403) {
            throw Object.assign(new Error("Vetra 登录已过期，请重新登录"), { signIn: "expired" })
          }
          if (!res.ok) return provider?.models ?? {}
          const body = await res.json().catch(() => null)
          const list = Array.isArray(body) ? body : body?.models ?? body?.data
          if (!Array.isArray(list) || !list.length) return provider?.models ?? {}
          const out = {}
          for (const item of list) {
            const id = String(item?.name || item?.id || "").trim()
            if (!id) continue
            out[id] = modelEntry(id, MODELS[id] ?? { name: item?.display_name || id }, base + "/v1", true)
          }
          return Object.keys(out).length ? out : provider?.models ?? {}
        } catch (e) {
          if (e?.signIn === "expired") throw e
          return provider?.models ?? {}
        }
      },
    },

    auth: {
      provider: ID,
      // The session JWT returned after ADFS sign-in has no refresh-token grant.
      // Renew through the persisted browser profile so the ADFS session and
      // Windows authentication can complete the next sign-in.
      refreshLead: 60 * 60_000,
      refresh: async (auth) => {
        const creds = await renewCredentials(base, auth?.access)
        return { access: creds.token, expires: creds.exp ? creds.exp * 1000 : 0, accountId: creds.itcode || "Vetra" }
      },
      methods: [
        {
          type: "oauth",
          label: "网页登录",
          authorize: async () => {
            // Show the current login window for an explicit sign-in.
            const session = await openBrowserLogin(base)
            return {
              url: "",
              instructions: "在弹出的网页中完成登录，即可完成绑定。到期后会自动尝试续期；需要输入密码或验证码时，请在原窗口继续操作。",
              method: "auto",
              opened: true,
              callback: async () => {
                try {
                  const creds = await session.waitForToken()
                  await session.close()
                  return successOf(creds)
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e) }
                }
              },
            }
          },
        },
        { type: "api", label: "api-key登录", placeholder: "输入 api-key" },
      ],

      async usage(getAuth) {
        let auth
        try { auth = await getAuth() } catch (error) {
          return { error: String(error?.message ?? error), windows: [], signIn: "expired" }
        }
        if (auth?.type === "api") {
          let key
          try { key = apiKeyOf(auth) } catch (error) {
            return { error: error.message, windows: [], signIn: "expired" }
          }
          try {
            const response = await apiModels(apiBase, key)
            if ([401, 403].includes(response.status)) {
              return { error: "Vetra API key 无效或已被重置，请重新登录", windows: [], signIn: "expired" }
            }
            if (!response.ok) return { error: "Vetra API 返回 HTTP " + response.status, windows: [] }
            return { plan: "Vetra api-key", windows: [] }
          } catch (error) {
            return { error: "Vetra API 连接失败: " + (error?.message ?? error), windows: [] }
          }
        }
        let creds
        try {
          creds = resolveCredentials(auth)
        } catch (e) {
          return { error: String(e?.message ?? e), windows: [], signIn: "expired" }
        }
        if (creds.expired) {
          try {
            creds = await renewCredentials(base, creds.token)
          } catch (e) {
            return { error: String(e?.message ?? e), windows: [], signIn: e?.signIn ?? "expired" }
          }
        }
        const windows = []
        if (creds.exp > 0) {
          const totalSec = 24 * 3600
          const leftSec = Math.max(0, creds.exp - Date.now() / 1000)
          const usedPct = Math.round(Math.max(0, Math.min(100, ((totalSec - leftSec) / totalSec) * 100)) * 10) / 10
          const hoursLeft = (leftSec / 3600).toFixed(1)
          windows.push({
            name: "JWT 有效期",
            used: usedPct,
            resetsAt: new Date(creds.exp * 1000).toISOString(),
            display: `剩余 ${hoursLeft}h`,
            aside: true,
          })
        }
        return {
          plan: "Vetra Pro",
          user: creds.itcode || "Vetra",
          windows,
        }
      },

      async loader(getAuth) {
        if ((await getAuth())?.type === "api") return apiKeyLoader(getAuth, apiBase)
        return {
          baseURL: base + "/v1",
          apiKey: "vetra",
          async fetch(input, init = {}) {
            const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            const url = new URL(urlStr)
            const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
            const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)

            if (method === "GET" && /\/models$/.test(url.pathname)) {
              const created = Math.floor(Date.now() / 1000)
              const data = Object.keys(MODELS).map((id) => ({ id, object: "model", created, owned_by: "vetra" }))
              return jsonResponse(200, { object: "list", data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id })
            }

            let rawBody = init.body ?? (input instanceof Request ? await input.clone().text() : "")
            if (typeof rawBody !== "string") {
              rawBody = rawBody ? new TextDecoder().decode(rawBody) : ""
            }
            let payload = {}
            try { payload = rawBody ? JSON.parse(rawBody) : {} } catch {
              return jsonResponse(400, { error: { type: "invalid_request_error", message: "Request body must be valid JSON" } })
            }

            if (/\/messages\/count_tokens$/.test(url.pathname)) {
              const chars = JSON.stringify(payload.messages ?? []).length + JSON.stringify(payload.system ?? "").length
              return jsonResponse(200, { input_tokens: Math.ceil(chars / 3) })
            }

            let creds
            try {
              creds = resolveCredentials(await getAuth())
              // A token this close to its end is renewed before it can fail
              // mid-answer; magpie renews too, this covers a direct fetch.
              if (creds.expired || (creds.exp > 0 && creds.exp - Date.now() / 1000 < 120)) {
                // a renewal that fails while the token still works is not fatal
                try { creds = await renewCredentials(base, creds.token) } catch (e) { if (creds.expired) throw e }
              }
            } catch (e) {
              return jsonResponse(401, { error: { type: "authentication_error", message: String(e?.message ?? e) } }, e?.signIn ?? "expired")
            }

            try {
              const effort = payload.reasoning_effort || payload.reasoning?.effort || DEFAULT_EFFORT
              const requestHeaders = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
              const sessionId = requestHeaders.get("x-vetra-session-id") || requestHeaders.get("x-session-id") || ""
              const opts = { base, effort, keepSystem, signal, sessionId, account: creds.itcode, threadDir: join(profileDir(), "..", "threads") }
              const route = /\/messages$/.test(url.pathname)
                ? handleAnthropicMessages
                : /\/chat\/completions$/.test(url.pathname)
                  ? handleOpenAIChat
                  : null
              if (!route) {
                return jsonResponse(404, { error: { type: "not_found", message: `Unsupported route ${method} ${url.pathname}` } })
              }
              try {
                return await route(payload, creds, opts)
              } catch (e) {
                // the upstream turned the token away: renew once and try again
                if (![401, 403].includes(Number(e?.status))) throw e
                creds = await renewCredentials(base, creds.token).catch((error) => { throw Object.assign(error, { status: 401 }) })
                return await route(payload, creds, opts)
              }
            } catch (e) {
              const status = Number.isInteger(e?.status) ? e.status : 502
              return jsonResponse(status, { error: { type: "upstream_error", message: String(e?.message ?? e) } }, e?.signIn ?? (status === 401 ? "expired" : "kept"))
            }
          },
        }
      },
    },
  }
}

export const _internal = {
  ID,
  NAME,
  MODELS,
  resolveModel,
  parseToken,
  resolveCredentials,
  openBrowserLogin,
  renewCredentials,
  extractSystemContext,
  flattenMessages,
  toolSpec,
  selectTools,
  pickToolCall,
  createToolCallScanner,
  scrubSandbox,
  createSandboxFilter,
  isRuleHeading,
  dropTrailingHeading,
  createHeadingFilter,
  createReplyFilter,
  conversation,
  commitThread,
  openRun,
  upstreamDeltas,
  replyDeltas,
  promptOf,
}
