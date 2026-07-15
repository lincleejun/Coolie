import { describe, it, expect, afterEach, afterAll } from "vitest"
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { readServerInfo } from "../src/daemon/info.js"
import Database from "better-sqlite3"
import { runMigrations } from "../src/db/migrations.js"
import { runtimeTmuxKillSessions } from "./helpers/runtime-env.js"

let child: ChildProcess | undefined
let home: string
let childStderr = ""
const MAIN = path.resolve(__dirname, "../src/main.ts")
const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const DAEMON_TMUX_SOCK = process.env.COOLIE_TMUX_SOCKET!

const startServer = async (extraEnv: Record<string, string> = {}, preparedHome?: string) => {
  home = preparedHome ?? fs.mkdtempSync(path.join(os.tmpdir(), "coolie-daemon-"))
  childStderr = ""
  // detached: true → child leads its own process group. tsx's CLI re-execs into a
  // grandchild node process, so killing only child.pid orphans the actual server;
  // cleanup must kill the whole group (see afterEach).
  child = spawn(TSX, [MAIN, "start"], {
    env: {
      ...process.env, COOLIE_HOME: home, COOLIE_TMUX_SOCKET: DAEMON_TMUX_SOCK, COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_CONFIG: path.join(home, "claude.json"), // trust 种子绝不能写真实 ~/.claude.json
      ...extraEnv,
    },
    stdio: "pipe", detached: true,
  })
  child.stderr?.on("data", (chunk) => { childStderr += String(chunk) })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const info = readServerInfo(path.join(home, "server.json"))
    if (info) {
      const r = await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null)
      if (r?.ok) return info
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server did not become healthy${childStderr ? `: ${childStderr.trim()}` : ""}`)
}
afterEach(() => {
  // Kill the entire process group (negative pid) to reach tsx's re-exec'd grandchild,
  // then the direct child as fallback.
  if (child?.pid) { try { process.kill(-child.pid, "SIGKILL") } catch { /* group already gone */ } }
  child?.kill("SIGKILL")
  child = undefined
})
afterAll(() => {
  // best-effort: control client is lazy-spawned (only on first sendKey), so daemon-only
  // tests likely never created this tmux server — this is just a safety net.
  runtimeTmuxKillSessions()
})

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
  it("startup reloads force/error archive intent and reconciles it before health", async () => {
    const preparedHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-daemon-archive-"))
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-daemon-archive-repo-"))
    const workspacePath = path.join(
      fs.realpathSync(path.dirname(repo)),
      `archive-wt-${path.basename(preparedHome)}`,
    )
    execFileSync("git", ["init", "-b", "main"], { cwd: repo })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
    execFileSync("git", ["worktree", "add", "-b", "feature/archive-restart", workspacePath, "main"], { cwd: repo })
    fs.writeFileSync(path.join(workspacePath, "dirty.txt"), "force must survive restart\n")
    const dbPath = path.join(preparedHome, "coolie.db")
    const seed = new Database(dbPath)
    runMigrations(seed)
    seed.prepare("INSERT INTO projects VALUES ('p-archive', 'archive', ?, 'main', 1)").run(repo)
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
    seed.prepare(`INSERT INTO workspaces
      (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data,
       task_status, kind, materialized, sort_order)
      VALUES ('w-archive', 'p-archive', 'archive-restart', ?, 'feature/archive-restart', 'main', ?,
        'archiving', 0, 10, NULL, ?, 'in_progress', 'task', 1, 10)`)
      .run(workspacePath, baseRef, JSON.stringify({
        ownership: "managed",
        portBase: 42000,
        archiveOperation: {
          force: true,
          startedAt: 111,
          lastError: { tag: "GitError", stage: "worktree-remove", message: "prior failure", at: 222 },
        },
      }))
    seed.close()

    await startServer({
      COOLIE_WORKSPACES_ROOT: path.join(preparedHome, "workspaces"),
      COOLIE_CLAUDE_HOME: path.join(preparedHome, "claude"),
      COOLIE_CODEX_HOME: path.join(preparedHome, "codex"),
    }, preparedHome)

    const observed = new Database(dbPath, { readonly: true })
    try {
      expect(observed.prepare("SELECT status, task_status AS taskStatus FROM workspaces WHERE id = 'w-archive'").get())
        .toEqual({ status: "archived", taskStatus: "done" })
      const data = JSON.parse((observed.prepare("SELECT data FROM workspaces WHERE id = 'w-archive'").get() as any).data)
      expect(data.archiveOperation).toBeUndefined()
      const event = observed.prepare(
        "SELECT payload FROM events WHERE workspace_id = 'w-archive' AND type = 'workspace.archive.reconciling'",
      ).get() as { payload: string }
      expect(JSON.parse(event.payload)).toEqual({
        id: "w-archive",
        force: true,
        startedAt: 111,
        lastError: { tag: "GitError", stage: "worktree-remove", at: 222 },
      })
      expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }))
        .not.toContain(workspacePath)
    } finally {
      observed.close()
      fs.rmSync(workspacePath, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)
})

const unixGet = (sockPath: string, p: string, token?: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: sockPath, path: p, method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let b = ""; res.on("data", (c) => { b += c }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b })) },
    )
    req.on("error", reject)
    req.end()
  })

describe("unix socket listener", () => {
  it("serves the same app on <home>/coolie.sock with the same token", async () => {
    const info = await startServer()
    const sockPath = path.join(home, "coolie.sock")
    expect(info.sock).toBe(sockPath)
    expect(fs.existsSync(sockPath)).toBe(true)
    expect((await unixGet(sockPath, "/health")).status).toBe(200)
    expect((await unixGet(sockPath, "/projects")).status).toBe(401)          // unix socket 不豁免 token
    expect((await unixGet(sockPath, "/projects", info.token)).status).toBe(200)
  })
})

describe("engine ownership（不可违背原则）", () => {
  it("tmux session survives server SIGKILL", async () => {
    const sock = process.env.COOLIE_TMUX_SOCKET!
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-surv-home-"))
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-surv-ws-"))
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-surv-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: repo })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
    const env = {
      ...process.env, COOLIE_HOME: home2, COOLIE_WORKSPACES_ROOT: wsRoot,
      COOLIE_TMUX_SOCKET: sock, COOLIE_CLAUDE_CMD: "cat", COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_HOME: path.join(home2, "claude-home"),
      COOLIE_CLAUDE_CONFIG: path.join(home2, "claude.json"), // trust 种子绝不能写真实 ~/.claude.json
    }
    const srv = spawn(TSX, [MAIN, "start"], { env, stdio: "pipe", detached: true })
    try {
      let info: ReturnType<typeof readServerInfo> = null
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        info = readServerInfo(path.join(home2, "server.json"))
        if (info && (await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null))?.ok) break
        await new Promise((r) => setTimeout(r, 100))
      }
      if (!info) throw new Error("server did not become healthy")
      const auth = { "content-type": "application/json", Authorization: `Bearer ${info.token}` }
      const proj = await (await fetch(`http://127.0.0.1:${info.port}/projects`, {
        method: "POST", headers: auth, body: JSON.stringify({ repoRoot: repo }),
      })).json()
      const created = await fetch(`http://127.0.0.1:${info.port}/workspaces`, {
        method: "POST", headers: auth, body: JSON.stringify({ projectId: proj.id }),
      })
      expect(created.status).toBe(201)
      const ws: any = await created.json()
      const ensured = await fetch(`http://127.0.0.1:${info.port}/workspaces/${ws.id}/ensure`, {
        method: "POST", headers: auth, body: "{}",
      })
      expect(ensured.status).toBe(200)
      const session = `coolie-${ws.id}`
      expect(spawnSync("tmux", ["-L", sock, "has-session", "-t", `=${session}`]).status).toBe(0)

      // ★ 杀 server（整个进程组，Plan 1 tsx 孙进程教训）——engine 归 tmux，session 必须活着
      try { process.kill(-srv.pid!, "SIGKILL") } catch { srv.kill("SIGKILL") }
      await new Promise((r) => setTimeout(r, 500))
      expect(spawnSync("tmux", ["-L", sock, "has-session", "-t", `=${session}`]).status).toBe(0)
    } finally {
      try { process.kill(-srv.pid!, "SIGKILL") } catch { /* already dead */ }
      runtimeTmuxKillSessions()
    }
  })
})

describe("keep-alive 闭环（wrapper → /hooks/engine-exit → engine.exited）", () => {
  it("engine 非零退出：事件落库 + tab=error + session 不塌", async () => {
    const sock = process.env.COOLIE_TMUX_SOCKET!
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka2-home-"))
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka2-ws-"))
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka2-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: repo })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
    // engine 替身：先睡 1s（保证 tabs 行已插入）再以 7 退出——COOLIE_CLAUDE_CMD 是空白分词，
    // 不能写 "sh -c 'exit 7'"（引号不解析），用脚本文件。
    const exit7 = path.join(home2, "exit7.sh")
    fs.mkdirSync(home2, { recursive: true })
    fs.writeFileSync(exit7, "#!/bin/sh\nsleep 1\nexit 7\n", { mode: 0o755 })
    const env = {
      ...process.env, COOLIE_HOME: home2, COOLIE_WORKSPACES_ROOT: wsRoot,
      COOLIE_TMUX_SOCKET: sock, COOLIE_CLAUDE_CMD: exit7, COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_HOME: path.join(home2, "claude-home"),
      COOLIE_CLAUDE_CONFIG: path.join(home2, "claude.json"), // trust 种子绝不能写真实 ~/.claude.json
    }
    const srv = spawn(TSX, [MAIN, "start"], { env, stdio: "pipe", detached: true })
    try {
      let info: ReturnType<typeof readServerInfo> = null
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        info = readServerInfo(path.join(home2, "server.json"))
        if (info && (await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null))?.ok) break
        await new Promise((r) => setTimeout(r, 100))
      }
      if (!info) throw new Error("server did not become healthy")
      const auth = { "content-type": "application/json", Authorization: `Bearer ${info.token}` }
      const proj = await (await fetch(`http://127.0.0.1:${info.port}/projects`, {
        method: "POST", headers: auth, body: JSON.stringify({ repoRoot: repo }),
      })).json()
      const created = await fetch(`http://127.0.0.1:${info.port}/workspaces`, {
        method: "POST", headers: auth, body: JSON.stringify({ projectId: proj.id }),
      })
      expect(created.status).toBe(201)
      const ws: any = await created.json()
      const ensured = await fetch(`http://127.0.0.1:${info.port}/workspaces/${ws.id}/ensure`, {
        method: "POST", headers: auth, body: "{}",
      })
      expect(ensured.status).toBe(200)
      // 等 engine.exited(exitCode=7) 经 wrapper curl 回报落库
      let exited: any = null
      const d2 = Date.now() + 10_000
      while (Date.now() < d2 && !exited) {
        const evs: any[] = await (await fetch(`http://127.0.0.1:${info.port}/events?after=0`, { headers: auth })).json()
        exited = evs.find((e) => e.type === "engine.exited" && e.payload?.exitCode === 7) ?? null
        if (!exited) await new Promise((r) => setTimeout(r, 200))
      }
      expect(exited).not.toBeNull()
      const tabs: any[] = await (await fetch(`http://127.0.0.1:${info.port}/workspaces/${ws.id}/tabs`, { headers: auth })).json()
      expect(tabs[0].status).toBe("error")
      // 不塌布局：session 仍在（wrapper 已 exec 成 shell）
      expect(spawnSync("tmux", ["-L", sock, "has-session", "-t", `=coolie-${ws.id}`]).status).toBe(0)
    } finally {
      try { process.kill(-srv.pid!, "SIGKILL") } catch { /* dead */ }
      runtimeTmuxKillSessions()
    }
  })
})

describe("daemon 加固（Plan 4）", () => {
  it("shutdown：挂着 SSE 长连接也在时限内退出，server.json 与 coolie.sock 都清掉", async () => {
    const info = await startServer()
    // C7：deadline 收紧到 1500ms 真钉 closeAllConnections——若它失灵，挂着 SSE 的 server.close
    // 只能等 2000ms shutdown 兜底，socket 必然无法在本断言时限内清掉。
    const req = http.get({
      host: "127.0.0.1", port: info.port, path: "/events/stream?after=0",
      headers: { Authorization: `Bearer ${info.token}` },
    })
    await new Promise<void>((resolve, reject) => { req.on("response", () => resolve()); req.on("error", reject) })
    await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      method: "POST", headers: { Authorization: `Bearer ${info.token}` },
    })
    const deadline = Date.now() + 1_500
    while (Date.now() < deadline) {
      if (!fs.existsSync(path.join(home, "server.json")) && !fs.existsSync(path.join(home, "coolie.sock"))) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false)
    expect(fs.existsSync(path.join(home, "coolie.sock"))).toBe(false)
    // 进程真的退了：/health 不再应答
    expect((await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null))).toBe(null)
    req.destroy()
  })

  it("并发 shutdown（SIGTERM + POST /shutdown 同时到达）→ 恰好一次干净退出、无 double-rm/double-close 抛错", async () => {
    const info = await startServer()
    // 一条开着的 SSE 长连接：迫使 closeAllConnections 真正参与（否则 close 永不完成 → 只能靠兜底超时退）
    const sse = http.get({
      host: "127.0.0.1", port: info.port, path: "/events/stream?after=0",
      headers: { Authorization: `Bearer ${info.token}` },
    })
    await new Promise<void>((resolve, reject) => { sse.on("response", () => resolve()); sse.on("error", reject) })
    let stderr = ""
    child.stderr?.on("data", (b) => { stderr += String(b) })
    const exits: Array<number | null> = []
    child.on("exit", (code) => exits.push(code))
    // 两条自退路径并发触发同一个 shutdown()：POST /shutdown 与 SIGTERM 竞相进入
    await Promise.all([
      fetch(`http://127.0.0.1:${info.port}/shutdown`, {
        method: "POST", headers: { Authorization: `Bearer ${info.token}` },
      }).catch(() => {}),
      Promise.resolve().then(() => { try { process.kill(child!.pid!, "SIGTERM") } catch { /* 已退 */ } }),
    ])
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && exits.length === 0) await new Promise((r) => setTimeout(r, 50))
    // 幂等 guard（shuttingDown）保证只跑一次：恰好退一次、且是干净码 0（非双次、非崩溃码）
    expect(exits).toEqual([0])
    // 第二次进入 shutdown 若无 guard：un-forced `fs.rmSync(sockPath)` 抛 ENOENT / Scope.close 二次关抛错 → 落 crash-net stderr
    expect(stderr).not.toMatch(/ENOENT|UnhandledPromiseRejection|Error:/)
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false)
    expect(fs.existsSync(path.join(home, "coolie.sock"))).toBe(false)
    sse.destroy()
  })
})

describe("refcount 惰性退出（真实 SSE 客户端 + 短 grace）", () => {
  const openSse = (info: { port: number; token: string }, role?: string): Promise<http.ClientRequest> =>
    new Promise((resolve, reject) => {
      const req = http.get({
        host: "127.0.0.1", port: info.port,
        path: `/events/stream?after=0${role ? `&role=${role}` : ""}`,
        headers: { Authorization: `Bearer ${info.token}` },
      })
      req.on("response", (res) => { res.resume(); resolve(req) })
      req.on("error", reject)
    })
  const serverGone = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (
        !fs.existsSync(path.join(home, "server.json")) &&
        !fs.existsSync(path.join(home, "coolie.sock"))
      ) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  it("最后一个 gui 断开 → grace 后 server 自退并清理 server.json/sock", async () => {
    const info = await startServer({ COOLIE_LINGER_MS: "400" })
    const gui = await openSse(info, "gui")
    const cs = await (await fetch(`http://127.0.0.1:${info.port}/clients`, {
      headers: { Authorization: `Bearer ${info.token}` },
    })).json()
    expect(cs.guiHolders).toBe(1)
    expect(cs.lingerMs).toBe(400)
    gui.destroy()
    expect(await serverGone(8_000)).toBe(true)
    expect(fs.existsSync(path.join(home, "coolie.sock"))).toBe(false)
  })

  it("宽限期内 gui 重连 → 不退", async () => {
    const info = await startServer({ COOLIE_LINGER_MS: "800" })
    const g1 = await openSse(info, "gui")
    g1.destroy()
    await new Promise((r) => setTimeout(r, 200))
    const g2 = await openSse(info, "gui") // 回归：取消退出
    await new Promise((r) => setTimeout(r, 1_500))
    expect((await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null))?.ok).toBe(true)
    g2.destroy()
  })

  it("无 role 的 SSE 连接不持有：断开后 server 不退（从未有 gui → 永不布防）", async () => {
    const info = await startServer({ COOLIE_LINGER_MS: "300" })
    const plain = await openSse(info)
    plain.destroy()
    await new Promise((r) => setTimeout(r, 1_000))
    expect((await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null))?.ok).toBe(true)
  })

  it("非法 role → 400；GET /clients 无 token → 401", async () => {
    const info = await startServer()
    const r = await fetch(`http://127.0.0.1:${info.port}/events/stream?after=0&role=browser`, {
      headers: { Authorization: `Bearer ${info.token}` },
    })
    expect(r.status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${info.port}/clients`)).status).toBe(401)
  })
})
