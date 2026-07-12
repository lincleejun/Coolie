import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn, execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { makeApi, probeHealth, ApiError, type ServerInfo } from "../src/api/client.js"

// 真 daemon 集成（模式抄 packages/cli/test/cli-e2e.test.ts / sse-e2e.test.ts 的环境隔离）。
// 注：T3 并发新增 POST /workspaces/:id/input + shell-tab（POST/DELETE tabs）路由——本分支尚无，
// 故这些 wrapper 的 request shape 在 api-client-shapes.test.ts 里用 mock fetch 单测（见该文件与报告）。
const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const SERVER_MAIN = path.resolve(__dirname, "../../server/src/main.ts")
const TMUX_SOCK = `coolie-test-${process.pid}-client`
let home: string, repo: string, info: ServerInfo, child: ReturnType<typeof spawn>

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clientapi-"))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clientapi-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repo })
  // base ref 必须存在（diffstat 靠它）——抄 cli-e2e 的初始空提交
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
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
      info = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"))
      if (await probeHealth(info)) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error("daemon 未在 10s 内就绪")
}, 20_000)

afterAll(() => {
  try { child.kill("SIGTERM") } catch { /* gone */ }
  try { execFileSync("tmux", ["-L", TMUX_SOCK, "kill-server"]) } catch { /* gone */ }
})

describe("makeApi against real daemon", () => {
  it("GET /config 带 token 成功，返回 engines", async () => {
    const api = makeApi(info)
    const cfg = await api.req("GET", "/config")
    expect(cfg.tmuxSocket).toBe(TMUX_SOCK)
    expect(cfg.engines[0].id).toBe("claude")
  })
  it("project add + workspace 全链路（create → tabs → diffstat → archive）", async () => {
    const api = makeApi(info)
    const p = await api.req("POST", "/projects", { repoRoot: repo })
    const ws = await api.req("POST", "/workspaces", { projectId: p.id, initialPrompt: "hello from gui test" })
    expect(ws.status).toBe("active")
    const tabs = await api.req("GET", `/workspaces/${ws.id}/tabs`)
    expect(tabs.some((t: any) => t.kind === "engine")).toBe(true)
    const stat = await api.req("GET", `/workspaces/${ws.id}/git/diffstat`)
    expect(stat).toHaveProperty("filesChanged")
    await api.req("POST", `/workspaces/${ws.id}/archive`, { force: true })
  }, 60_000)
  it("坏 token → ApiError（401）", async () => {
    const api = makeApi({ ...info, token: "bogus" })
    await expect(api.req("GET", "/projects")).rejects.toBeInstanceOf(ApiError)
  })
  it("wsTerminalUrl 拼出带 token 的 ws:// URL", () => {
    const api = makeApi(info)
    const u = api.wsTerminalUrl("W1", 0, 120, 32)
    expect(u).toBe(`ws://127.0.0.1:${info.port}/ws/terminal?workspace=W1&window=0&cols=120&rows=32&token=${encodeURIComponent(info.token)}`)
  })
})
