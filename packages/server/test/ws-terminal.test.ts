import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as http from "node:http"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import WebSocket from "ws"
import { Effect } from "effect"
import { makeTmuxService } from "../src/tmux/service.js"
import { attachTerminalWs } from "../src/http/ws.js"
import { newToken } from "../src/http/app.js"

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

  it("bad token → 401 refusal; unknown workspace → close 4404", async () => {
    const bad = new WebSocket(`${base}?workspace=w1&token=wrong`)
    const err = await new Promise<any>((r) => { bad.once("unexpected-response", (_q, res) => r(res.statusCode)); bad.once("error", () => r(401)) })
    expect(err).toBe(401)
    const unknown = new WebSocket(`${base}?workspace=nope&token=${token}`)
    const code = await new Promise<number>((r) => unknown.once("close", (c) => r(c)))
    expect(code).toBe(4404)
  })
})
