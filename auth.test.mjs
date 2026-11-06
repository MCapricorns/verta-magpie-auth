// auth.test.mjs — browser startup must preserve an interactive sign-in.
import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { VetraAuthPlugin, _internal } from "./index.mjs"

function fixture(t, { readyAt = 0, launcherExited = false, spawnError = null, token = "", tokenAfterNavigate, hasPage = false, loginPage = false, pagePath = "/workspace/chats/new" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "vetra-auth-test-"))
  const marker = join(directory, "browser-profile", "cdp-port")
  const environment = { DATA_DIR: process.env.DATA_DIR, VETRA_BROWSER: process.env.VETRA_BROWSER }
  process.env.DATA_DIR = directory
  process.env.VETRA_BROWSER = process.execPath
  let now = 0
  const children = []
  const signals = []
  const calls = []
  t.mock.method(Date, "now", () => now)
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    // Advance polling delays while successful CDP replies arrive in microtasks.
    if (delay <= 750) queueMicrotask(() => { now += delay; callback(...args) })
    return 0
  })
  t.mock.method(childProcess, "spawn", (command, args) => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: launcherExited ? 0 : null,
      signalCode: null,
      unref() {},
      kill(signal) { signals.push(signal); this.exitCode = 0; this.emit("exit", 0); return true },
    })
    children.push({ command, args, child })
    if (spawnError) queueMicrotask(() => child.emit("error", spawnError))
    return child
  })
  syncBuiltinESMExports()
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input)
    if (url.endsWith("/json/version")) return Response.json({ webSocketDebuggerUrl: "ws://browser.test/browser" }, { status: now >= readyAt ? 200 : 503 })
    if (url.endsWith("/json/list")) {
      const targets = token || hasPage ? [{ type: "page", url: "https://vetra.test" + pagePath, webSocketDebuggerUrl: "ws://browser.test/page" }] : []
      if (loginPage) targets.push({ type: "page", url: "https://adfs.test/adfs/ls/?session=pending", webSocketDebuggerUrl: "ws://browser.test/login" })
      return Response.json(targets)
    }
    throw new Error("Unexpected fetch: " + url)
  })
  const originalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor() { queueMicrotask(() => this.onopen?.()) }
    send(raw) {
      const message = JSON.parse(raw)
      calls.push(message)
      if (message.method === "Page.navigate" && tokenAfterNavigate !== undefined) token = tokenAfterNavigate
      if (message.method === "Browser.close") {
        readyAt = Infinity
        for (const { child } of children) { child.exitCode = 0; child.emit("exit", 0) }
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: { result: { value: token || null } } }) }))
    }
    close() {}
  }
  t.after(() => {
    globalThis.WebSocket = originalWebSocket
    t.mock.restoreAll()
    syncBuiltinESMExports()
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    marker, children, signals, calls, get now() { return now },
    ready() { readyAt = 0 }, unavailable() { readyAt = Infinity },
    setToken(value) { token = value },
  }
}

test("a debug port taking more than six seconds does not restart the browser", async (t) => {
  const state = fixture(t, { readyAt: 7200 })
  const session = await _internal.openBrowserLogin("https://vetra.test")
  assert.ok(state.now >= 7200)
  assert.equal(state.children.length, 1)
  assert.deepEqual(state.signals, [])
  assert.equal(state.children[0].command, process.execPath)
  assert.ok(state.children[0].args.includes("--new-window"))
  assert.equal(state.children[0].args.at(-1), "https://vetra.test/")
  assert.ok(state.children[0].args.every(arg => !arg.startsWith("--disable-blink-features") && !arg.startsWith("--user-agent=")))
  assert.ok(state.children[0].args.every((arg) => !arg.startsWith("--window-position=") && !arg.startsWith("--window-size=")))
  await session.close()
  assert.equal(existsSync(state.marker), false)
})

test("an explicit sign-in reuses the live profile and keeps its marker", async (t) => {
  const state = fixture(t)
  mkdirSync(join(state.marker, ".."), { recursive: true })
  writeFileSync(state.marker, "12345")
  const session = await _internal.openBrowserLogin("https://vetra.test")
  await session.close()
  assert.equal(state.children.length, 0)
  assert.deepEqual(state.signals, [])
  assert.equal(readFileSync(state.marker, "utf8"), "12345")
})

test("unavailable debugging preserves the window so a retry can resume it", async (t) => {
  const state = fixture(t, { readyAt: Infinity })
  await assert.rejects(_internal.openBrowserLogin("https://vetra.test"), /30 秒.*调试端口/)
  assert.ok(state.now >= 30_000)
  assert.equal(state.children.length, 1)
  assert.deepEqual(state.signals, [])
  assert.equal(existsSync(state.marker), true)
  state.ready()
  const session = await _internal.openBrowserLogin("https://vetra.test")
  await session.close()
  assert.equal(state.children.length, 1)
  assert.deepEqual(state.signals, [])
  assert.equal(existsSync(state.marker), true)
})

test("an exited launcher cannot hide a live browser or end token polling", async (t) => {
  const payload = Buffer.from(JSON.stringify({ itCode: "fixture", exp: 3600 })).toString("base64url")
  const token = "fixture." + payload + ".signature"
  const state = fixture(t, { launcherExited: true, token })
  const session = await _internal.openBrowserLogin("https://vetra.test")
  assert.equal((await session.waitForToken(1000)).token, token)
  await session.close()
  assert.deepEqual(state.signals, [])
  assert.equal(existsSync(state.marker), true)
})

test("a launcher handoff waits for the debug port before completing sign-in", async (t) => {
  const token = tokenFor(3600)
  const state = fixture(t, { launcherExited: true, readyAt: 7200, token })
  const plugin = await VetraAuthPlugin({}, { base: "https://vetra.test" })
  const login = await plugin.auth.methods[0].authorize()
  const result = await login.callback()
  assert.equal(result.type, "success")
  assert.equal(result.access, token)
  assert.ok(state.now >= 7200 && state.now < 30_000)
  assert.equal(state.children.length, 1)
  assert.deepEqual(state.signals, [])
  assert.equal(state.calls.some(call => call.method === "Browser.close"), false)
  assert.ok(existsSync(state.marker))
})

test("a failed launcher is reported once without terminating profile browsers", async (t) => {
  const state = fixture(t, { readyAt: Infinity, launcherExited: true })
  await assert.rejects(_internal.openBrowserLogin("https://vetra.test"), /登录浏览器已退出/)
  assert.ok(state.now >= 30_000 && state.now < 31_000)
  assert.equal(state.children.length, 1)
  assert.deepEqual(state.signals, [])
})

test("spawn errors retain the operating system error", async (t) => {
  const state = fixture(t, { readyAt: Infinity, spawnError: new Error("fixture spawn failure") })
  await assert.rejects(_internal.openBrowserLogin("https://vetra.test"), /fixture spawn failure/)
  assert.equal(state.children.length, 1)
  assert.deepEqual(state.signals, [])
})

test("a rejected WIA endpoint navigates to the ADFS forms page and completes renewal", async (t) => {
  const payload = Buffer.from(JSON.stringify({ itCode: "fixture", exp: 3600 })).toString("base64url")
  const token = "fixture." + payload + ".signature"
  const state = fixture(t, { token })
  const navigations = []
  let wiaFailed = true
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input)
    if (url.endsWith("/json/version")) return Response.json({}, { status: 200 })
    if (url.endsWith("/json/list")) {
      return Response.json([
        wiaFailed
          ? { type: "page", url: "https://adfs.test/adfs/ls/wia?SAMLRequest=abc", webSocketDebuggerUrl: "ws://browser.test/page" }
          : { type: "page", url: "https://vetra.test/workspace/chats/new", webSocketDebuggerUrl: "ws://browser.test/page" },
      ])
    }
    throw new Error("Unexpected fetch: " + url)
  })
  globalThis.WebSocket = class {
    constructor() { queueMicrotask(() => this.onopen?.()) }
    send(raw) {
      const msg = JSON.parse(raw)
      if (msg.method === "Page.navigate") {
        navigations.push(msg.params.url)
        wiaFailed = false
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: {} }) }))
        return
      }
      const value = msg.params?.expression === "location.href" ? "chrome-error://chromewebdata/" : token
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { result: { value } } }) }))
    }
    close() {}
  }
  const plugin = await VetraAuthPlugin({}, { base: "https://vetra.test" })
  const usage = await plugin.auth.usage(async () => ({}))
  assert.equal(usage.user, "fixture")
  assert.equal(state.children.length, 1)
  assert.ok(state.children[0].args.every(arg => !arg.startsWith("--user-agent=")))
  assert.deepEqual(navigations, ["https://adfs.test/adfs/ls/?SAMLRequest=abc"])
})

function tokenFor(exp) {
  return "fixture." + Buffer.from(JSON.stringify({ itCode: "fixture", exp })).toString("base64url") + ".signature"
}

test("proactive renewal obtains a new token and closes Chromium gracefully", async (t) => {
  const oldToken = tokenFor(1200)
  const newToken = tokenFor(7200)
  const state = fixture(t, { token: oldToken, tokenAfterNavigate: newToken })
  const plugin = await VetraAuthPlugin({}, { base: "https://vetra.test" })
  const renewed = await plugin.auth.refresh({ type: "oauth", access: oldToken, expires: 1200_000 })
  assert.equal(renewed.access, newToken)
  assert.equal(renewed.expires, 7200_000)
  const navigations = state.calls.filter(call => call.method === "Page.navigate")
  assert.equal(navigations.length, 1)
  const destination = new URL(navigations[0].params.url)
  assert.equal(destination.pathname, "/sso/adfs/login")
  assert.equal(destination.searchParams.get("redirect_uri"), "https://vetra.test/workspace/chats/new")
  assert.ok(state.calls.some(call => call.method === "Browser.close"))
  assert.deepEqual(state.signals, [])
  assert.equal(existsSync(state.marker), false)
})

for (const pagePath of ["/", "/workspace/chats/new"]) test("renewal starts SSO in the reused app page " + pagePath, async (t) => {
  const newToken = tokenFor(7200)
  const state = fixture(t, { hasPage: true, tokenAfterNavigate: newToken, pagePath })
  mkdirSync(join(state.marker, ".."), { recursive: true })
  writeFileSync(state.marker, "12345")
  const plugin = await VetraAuthPlugin({}, { base: "https://vetra.test" })
  const renewed = await plugin.auth.refresh({ type: "oauth", access: tokenFor(1), expires: 1000 })
  assert.equal(renewed.access, newToken)
  assert.equal(state.children.length, 0)
  assert.equal(state.calls.filter(call => call.method === "Page.navigate").length, 1)
  assert.deepEqual(state.signals, [])
})

test("explicit login stays on the website and preserves its window when incomplete", async (t) => {
  const state = fixture(t, { hasPage: true, pagePath: "/" })
  const plugin = await VetraAuthPlugin({}, { base: "https://vetra.test" })
  const login = await plugin.auth.methods[0].authorize()
  const result = await login.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /窗口已保留/)
  assert.equal(state.children.length, 1)
  assert.equal(state.children[0].args.at(-1), "https://vetra.test/")
  assert.equal(state.calls.filter(call => ["Page.navigate", "Browser.close"].includes(call.method)).length, 0)
  assert.deepEqual(state.signals, [])
  assert.ok(existsSync(state.marker))
})

test("a closed reused browser is reported as closed instead of preserved", async (t) => {
  const state = fixture(t, { hasPage: true, pagePath: "/" })
  mkdirSync(join(state.marker, ".."), { recursive: true })
  writeFileSync(state.marker, "12345")
  const session = await _internal.openBrowserLogin("https://vetra.test")
  state.unavailable()
  await assert.rejects(session.waitForToken(1000), /登录窗口已关闭/)
  assert.equal(state.children.length, 0)
})

test("pending expiry renewal preserves MFA, keeps the account retryable and resumes the same window", async (t) => {
  const oldToken = tokenFor(1)
  const state = fixture(t, { token: oldToken, loginPage: true })
  const plugin = await VetraAuthPlugin({}, { base: "https://vetra.test" })
  const getAuth = async () => ({ type: "oauth", access: oldToken, expires: 1000 })
  const usage = await plugin.auth.usage(getAuth)
  assert.equal(usage.signIn, "kept")
  assert.match(usage.error, /窗口已保留/)
  assert.equal(state.children.length, 1)
  assert.deepEqual(state.signals, [])
  assert.ok(existsSync(state.marker))
  assert.ok(existsSync(join(state.marker, "..", "renewal-retry-at")))
  assert.equal(state.calls.filter(call => call.method === "Page.navigate").length, 0)
  assert.equal(state.calls.filter(call => call.method === "Browser.close").length, 0)

  const client = await plugin.auth.loader(getAuth)
  const response = await client.fetch("https://vetra.test/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "Hello" }] }),
  })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(state.children.length, 1)

  state.setToken(tokenFor(7200))
  const resumed = await plugin.auth.usage(getAuth)
  assert.equal(resumed.error, undefined)
  assert.equal(resumed.user, "fixture")
  assert.equal(state.children.length, 1)
  assert.deepEqual(state.signals, [])
  assert.equal(existsSync(join(state.marker, "..", "renewal-retry-at")), false)
})

test("renewal backoff survives a host restart and explicit login can finish it", async (t) => {
  const state = fixture(t, { readyAt: Infinity, launcherExited: true })
  const plugin = await VetraAuthPlugin({}, { base: "https://vetra.test" })
  await assert.rejects(plugin.auth.refresh({}), error => error.signIn === "kept")
  assert.equal(state.children.length, 1)
  const restarted = await import("./index.mjs?renewal-backoff-restart")
  const afterRestart = await restarted.VetraAuthPlugin({}, { base: "https://vetra.test" })
  await assert.rejects(afterRestart.auth.refresh({}), error => error.signIn === "kept" && /稍后重试/.test(error.message))
  assert.equal(state.children.length, 1)

  state.ready()
  state.setToken(tokenFor(7200))
  const login = await afterRestart.auth.methods[0].authorize()
  assert.equal((await login.callback()).type, "success")
  assert.equal(existsSync(join(state.marker, "..", "renewal-retry-at")), false)
})

test("a failed relaunch retains the profile's debugging port", async (t) => {
  const state = fixture(t, { readyAt: Infinity, launcherExited: true })
  mkdirSync(join(state.marker, ".."), { recursive: true })
  writeFileSync(state.marker, "12345")
  await assert.rejects(_internal.openBrowserLogin("https://vetra.test"), /登录浏览器已退出/)
  assert.ok(state.children[0].args.includes("--remote-debugging-port=12345"))
  assert.equal(readFileSync(state.marker, "utf8"), "12345")
})
