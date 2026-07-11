import { describe, it, expect, afterEach } from "vitest"
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { readServerInfo } from "../src/daemon/info.js"

let child: ChildProcess | undefined
let home: string
const MAIN = path.resolve(__dirname, "../src/main.ts")
const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")

const startServer = async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-daemon-"))
  child = spawn(TSX, [MAIN, "start"], { env: { ...process.env, COOLIE_HOME: home }, stdio: "pipe" })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const info = readServerInfo(path.join(home, "server.json"))
    if (info) {
      const r = await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null)
      if (r?.ok) return info
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("server did not become healthy")
}
afterEach(() => { child?.kill("SIGKILL"); child = undefined })

describe("daemon", () => {
  it("start writes server.json and serves health; stop removes it", async () => {
    const info = await startServer()
    expect(info.pid).toBeGreaterThan(0)
    const st = execFileSync(TSX, [MAIN, "status"], { env: { ...process.env, COOLIE_HOME: home } }).toString()
    expect(st).toContain("running")
    execFileSync(TSX, [MAIN, "stop"], { env: { ...process.env, COOLIE_HOME: home } })
    const deadline = Date.now() + 5_000
    while (fs.existsSync(path.join(home, "server.json")) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100))
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false)
  })
  it("second start refuses while first is alive", async () => {
    await startServer()
    expect(() =>
      execFileSync(TSX, [MAIN, "start"], { env: { ...process.env, COOLIE_HOME: home }, stdio: "pipe" }),
    ).toThrow() // exit 1
  })
})
