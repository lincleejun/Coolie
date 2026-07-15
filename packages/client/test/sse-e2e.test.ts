import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn, execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { startEventStream } from "../src/api/sse.js"
import { runtimeTmuxKillSessions } from "../../server/test/helpers/runtime-env.js"

// 真 daemon 集成（模式抄 packages/cli/test/cli-e2e.test.ts 的环境隔离）。
// Task 4（makeApi/probeHealth/ServerInfo）尚未在本分支落地，故本文件自带 daemon 起停 +
// 用裸 fetch 触发 project.added，只依赖 Task 5 自身的 startEventStream。
const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const SERVER_MAIN = path.resolve(__dirname, "../../server/src/main.ts")
const TMUX_SOCK = process.env.COOLIE_TMUX_SOCKET!
let home: string, info: { port: number; token: string }, child: ReturnType<typeof spawn>

const probe = async (port: number): Promise<boolean> => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })
    return r.ok
  } catch { return false }
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clientsse-"))
  child = spawn(TSX, [SERVER_MAIN, "start"], {
    env: {
      ...process.env, COOLIE_HOME: home, COOLIE_TMUX_SOCKET: TMUX_SOCK,
      COOLIE_CLAUDE_CMD: "cat", COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_HOME: path.join(home, "claude-home"),
      COOLIE_CLAUDE_CONFIG: path.join(home, "claude.json"),
      COOLIE_WORKSPACES_ROOT: path.join(home, "ws"),
    },
    stdio: "ignore",
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"))
      if (await probe(parsed.port)) { info = { port: parsed.port, token: parsed.token }; return }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error("daemon 未在 10s 内就绪")
}, 20_000)

afterAll(() => {
  try { child.kill("SIGTERM") } catch { /* gone */ }
  runtimeTmuxKillSessions()
})

describe("startEventStream against real daemon", () => {
  it("收到 project.added（live 或 replay 均可）", async () => {
    const events: { type: string }[] = []
    const stop = startEventStream({
      getInfo: async () => info, after: 0,
      onEvent: (e) => events.push(e), onStatus: () => {},
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-sse-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    const r = await fetch(`http://127.0.0.1:${info.port}/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: dir }),
    })
    expect(r.ok).toBe(true)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !events.some((e) => e.type === "project.added"))
      await new Promise((r) => setTimeout(r, 100))
    stop()
    expect(events.some((e) => e.type === "project.added")).toBe(true)
  }, 15_000)
})
