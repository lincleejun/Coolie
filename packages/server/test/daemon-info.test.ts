import { describe, it, expect } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { probeAlive, claimServerInfo, readServerInfo, writeServerInfo } from "../src/daemon/info.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-claim-"))
const DEAD_PID = 2 ** 30 // macOS pid_max 远小于此，必不存在

const withHealthServer = async <T>(fn: (port: number) => Promise<T>): Promise<T> => {
  const srv = http.createServer((_q, s) => s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })))
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  try { return await fn((srv.address() as { port: number }).port) }
  finally { srv.close() }
}

describe("probeAlive pid 预检", () => {
  it("pid 已死 → false，且走快速路径（无 500ms fetch 超时）", async () => {
    const t0 = Date.now()
    expect(await probeAlive({ port: 1, token: "x", pid: DEAD_PID })).toBe(false)
    expect(Date.now() - t0).toBeLessThan(200)
  })
  it("pid 活着但端口无人听 → false（仍会 HTTP 探测）", async () => {
    expect(await probeAlive({ port: 1, token: "x", pid: process.pid })).toBe(false)
  })
  it("pid 活着且 /health ok → true", async () => {
    await withHealthServer(async (port) => {
      expect(await probeAlive({ port, token: "x", pid: process.pid })).toBe(true)
    })
  })
})

describe("claimServerInfo（post-listen 单实例收口）", () => {
  it("无既有文件 → 独占写入成功，mode 0600", async () => {
    const p = path.join(tmp(), "server.json")
    expect(await claimServerInfo(p, { port: 1234, token: "t", pid: process.pid })).toBe(true)
    expect(readServerInfo(p)?.port).toBe(1234)
    expect(fs.statSync(p).mode & 0o777).toBe(0o600)
  })
  it("既有文件的 pid 已死 → 视为陈旧，清掉重写成功", async () => {
    const p = path.join(tmp(), "server.json")
    writeServerInfo(p, { port: 9, token: "old", pid: DEAD_PID })
    expect(await claimServerInfo(p, { port: 1234, token: "new", pid: process.pid })).toBe(true)
    expect(readServerInfo(p)?.token).toBe("new")
  })
  it("既有 server 活着且不是自己 → 认输，不覆盖对方", async () => {
    await withHealthServer(async (port) => {
      const p = path.join(tmp(), "server.json")
      writeServerInfo(p, { port, token: "winner", pid: process.pid }) // 活 pid + 活 /health
      expect(await claimServerInfo(p, { port: 4321, token: "loser", pid: process.pid + 1 })).toBe(false)
      expect(readServerInfo(p)?.token).toBe("winner")
    })
  })
  it("坏 JSON（损坏残留）→ 清掉重写成功", async () => {
    const p = path.join(tmp(), "server.json")
    fs.writeFileSync(p, "{corrupt")
    expect(await claimServerInfo(p, { port: 7, token: "t", pid: process.pid })).toBe(true)
    expect(readServerInfo(p)?.port).toBe(7)
  })
})
