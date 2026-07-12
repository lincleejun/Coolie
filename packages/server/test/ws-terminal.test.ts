import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import * as http from "node:http"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import WebSocket from "ws"
import { Effect } from "effect"
import { makeTmuxService } from "../src/tmux/service.js"
import { attachTerminalWs } from "../src/http/ws.js"
import { newToken } from "../src/http/app.js"

// 注入点：默认委托真 pty；置入 fakePtyHolder.current 后该 conn 用 fake pty 捕获 write 入参。
// 让「二进制输入原样透传」用例能字节级断言 ws.ts 交给 p.write 的内容，而其余用例仍跑真 tmux。
const { fakePtyHolder } = vi.hoisted(() => ({ fakePtyHolder: { current: null as null | import("node-pty").IPty } }))
vi.mock("../src/pty/attach.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/pty/attach.js")>()
  return {
    ...real,
    spawnTmuxAttach: (opts: Parameters<typeof real.spawnTmuxAttach>[0]) =>
      fakePtyHolder.current ?? real.spawnTmuxAttach(opts),
  }
})

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const svc = makeTmuxService(SOCK)
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ws-"))
let server: http.Server, base: string
const token = newToken()

beforeAll(async () => {
  await Effect.runPromise(svc.newSession({ name: "coolie-w1", cwd, windowName: "engine", command: ["/bin/sh"] }))
  server = http.createServer((_req, res) => { res.writeHead(404).end() })
  attachTerminalWs(server, {
    token, tmuxSocket: SOCK,
    resolveSession: async (id) => (id === "w1" ? "coolie-w1" : null),
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/terminal`
})
afterAll(() => {
  server.close()
  try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ }
})

const collectUntil = (ws: WebSocket, pred: (all: string) => boolean, ms = 8000): Promise<string> =>
  new Promise((resolve, reject) => {
    let all = ""
    const timer = setTimeout(() => reject(new Error(`timeout; got: ${all.slice(-200)}`)), ms)
    ws.on("message", (d: Buffer, isBinary: boolean) => {
      if (!isBinary) return
      all += d.toString("utf8")
      if (pred(all)) { clearTimeout(timer); resolve(all) }
    })
  })

describe("WS terminal channel", () => {
  it("streams pty bytes both ways as binary frames", async () => {
    const ws = new WebSocket(`${base}?workspace=w1&window=0&cols=100&rows=30&token=${token}`)
    await new Promise<void>((r) => ws.once("open", () => r()))
    ws.send(Buffer.from("printf 'MARK-%s\\n' okay\r"), { binary: true })
    const out = await collectUntil(ws, (s) => s.includes("MARK-okay"))
    expect(out).toContain("MARK-okay")
    ws.close()
  })

  it("二进制输入原样透传（非 UTF8 字节不被 utf8 往返损坏）", async () => {
    const written: Buffer[] = []
    const fakePty = {
      write: (d: string | Buffer) => { written.push(typeof d === "string" ? Buffer.from(d, "utf8") : Buffer.from(d)) },
      onData: () => {}, onExit: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {},
    } as unknown as import("node-pty").IPty
    fakePtyHolder.current = fakePty
    try {
      const ws = new WebSocket(`${base}?workspace=w1&window=0&cols=80&rows=24&token=${token}`)
      await new Promise<void>((r) => ws.once("open", () => r()))
      const raw = Buffer.from([0x1b, 0x5b, 0x41, 0xff, 0xfe]) // ESC [ A + 非法 utf8 尾字节
      ws.send(raw, { binary: true })
      await vi.waitFor(() => { expect(written.length).toBeGreaterThan(0) }, { timeout: 3000, interval: 20 })
      expect(written[0]!.equals(raw)).toBe(true) // 字节级一致，绝不 replacement-char 化
      ws.close()
    } finally {
      fakePtyHolder.current = null
    }
  })

  it("resize control frame reaches tmux (window-size latest)", async () => {
    const ws = new WebSocket(`${base}?workspace=w1&window=0&cols=100&rows=30&token=${token}`)
    await new Promise<void>((r) => ws.once("open", () => r()))
    ws.send(JSON.stringify({ type: "resize", cols: 91, rows: 21 }))
    const deadline = Date.now() + 5000
    let width = ""
    while (Date.now() < deadline) {
      width = execFileSync("tmux", ["-L", SOCK, "display-message", "-p", "-t", "=coolie-w1:0", "#{window_width}"], { encoding: "utf8" }).trim()
      if (width === "91") break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(width).toBe("91")
    ws.close()
  })

  it("closing the WS kills the attach client (no leaked clients)", async () => {
    const ws = new WebSocket(`${base}?workspace=w1&window=0&cols=80&rows=24&token=${token}`)
    await new Promise<void>((r) => ws.once("open", () => r()))
    await collectUntil(ws, (s) => s.length > 0) // attach 已建立
    ws.close()
    const deadline = Date.now() + 5000
    let clients: string[] = ["pending"]
    while (Date.now() < deadline) {
      clients = await Effect.runPromise(svc.listClients())
      if (clients.length === 0) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(clients).toEqual([]) // 零泄漏：attach client 全部退场
  })

  it("D1: two clients on different windows see DIFFERENT content simultaneously (grouped views)", async () => {
    // 真 tmux：session coolie-w1 加第 2 个 window，各 window 种入可区分的标记
    execFileSync("tmux", ["-L", SOCK, "new-window", "-t", "=coolie-w1:", "-n", "win1", "-c", cwd, "/bin/sh"])
    execFileSync("tmux", ["-L", SOCK, "send-keys", "-t", "=coolie-w1:0", "echo WINDOW_ZERO_MARK", "Enter"])
    execFileSync("tmux", ["-L", SOCK, "send-keys", "-t", "=coolie-w1:1", "echo WINDOW_ONE_MARK", "Enter"])
    await new Promise((r) => setTimeout(r, 300))

    const a = new WebSocket(`${base}?workspace=w1&window=0&cols=100&rows=30&token=${token}`)
    let aBuf = ""
    a.on("message", (d: Buffer, isBinary: boolean) => { if (isBinary) aBuf += d.toString("utf8") })
    await new Promise<void>((r) => a.once("open", () => r()))
    await vi.waitFor(() => { expect(aBuf).toContain("WINDOW_ZERO_MARK") }, { timeout: 6000, interval: 50 })

    // 第二个客户端接 window 1——旧代码此刻会把共享 session 的 current-window 翻到 1，A 被迫重绘成 window 1
    const b = new WebSocket(`${base}?workspace=w1&window=1&cols=100&rows=30&token=${token}`)
    let bBuf = ""
    b.on("message", (d: Buffer, isBinary: boolean) => { if (isBinary) bBuf += d.toString("utf8") })
    await new Promise<void>((r) => b.once("open", () => r()))
    await vi.waitFor(() => { expect(bBuf).toContain("WINDOW_ONE_MARK") }, { timeout: 6000, interval: 50 })

    // 给潜在的串扰重绘留足时间；grouped view 下两者应始终各看各的 window
    await new Promise((r) => setTimeout(r, 600))
    expect(bBuf).toContain("WINDOW_ONE_MARK")
    expect(bBuf).not.toContain("WINDOW_ZERO_MARK")
    expect(aBuf).toContain("WINDOW_ZERO_MARK")
    expect(aBuf).not.toContain("WINDOW_ONE_MARK") // ← 旧代码在此失败（A 被翻到 window 1）
    a.close(); b.close()
    await new Promise((r) => setTimeout(r, 300))
  })

  it("D1: view sessions cleaned up on disconnect (no leak) + real session & windows survive", async () => {
    const noViews = async () => (await Effect.runPromise(svc.listSessions())).filter((s) => s.includes("-view-"))
    // 连接期间恰有一个 view session 存活
    const ws = new WebSocket(`${base}?workspace=w1&window=0&cols=80&rows=24&token=${token}`)
    ws.on("message", () => {}) // 真 xterm 客户端始终在读 pty 输出——drain 之
    await new Promise<void>((r) => ws.once("open", () => r()))
    await vi.waitFor(async () => { expect((await noViews()).length).toBe(1) }, { timeout: 5000, interval: 50 })
    ws.close()
    // 断开后 view 被回收：零 -view- session 泄漏
    await vi.waitFor(async () => { expect(await noViews()).toEqual([]) }, { timeout: 5000, interval: 50 })
    const sessions = await Effect.runPromise(svc.listSessions())
    expect(sessions).toContain("coolie-w1") // 真 session 完好
    const wins = await Effect.runPromise(svc.listWindows("coolie-w1"))
    expect(wins.length).toBeGreaterThanOrEqual(1) // 真 windows 未被 view kill 波及
  })

  it("bad token → 401 refusal; unknown workspace → close 4404", async () => {
    const bad = new WebSocket(`${base}?workspace=w1&token=wrong`)
    const err = await new Promise<any>((r) => { bad.once("unexpected-response", (_q, res) => r(res.statusCode)); bad.once("error", () => r(401)) })
    expect(err).toBe(401)
    const unknown = new WebSocket(`${base}?workspace=nope&token=${token}`)
    const code = await new Promise<number>((r) => unknown.once("close", (c) => r(c)))
    expect(code).toBe(4404)
  })
})
