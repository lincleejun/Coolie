import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Effect, Layer, Exit } from "effect"
import Database from "better-sqlite3"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { GitServiceLive } from "../src/git/service.js"
import { SetupRunnerLive } from "../src/workspace/setup.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive } from "../src/workspace/lifecycle.js"
import { EngineRegistry } from "../src/engine/registry.js"
import type { Engine } from "../src/engine/types.js"
import { EngineBootstrapHookLive, sessionNameFor } from "../src/engine/bootstrap.js"
import { makeTmuxService, TmuxService } from "../src/tmux/service.js"

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const tmux = makeTmuxService(SOCK)
let home: string, wsRoot: string, repoRoot: string, db: Database.Database

const fakeClaude: Engine = {
  id: "claude", displayName: "Fake Claude",
  capabilities: { nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: false, effort: false },
  terminalTitle: "none",
  newSessionId: () => "sess-fixed-1",
  launchCommand: () => ["cat"],
  statusFromHookEvent: () => null,
  transcriptPath: ({ home: h, cwd, sessionId }) => path.join(h, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`),
  deriveTitle: () => null,
  resumeArgs: (s) => ["--resume", s],
}

const buildLayer = (engines: ReadonlyArray<Engine>) => {
  const cfgLayer = Layer.succeed(CoolieConfig, {
    home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
    workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"), codexHome: path.join(home, "codex-home"),
  })
  return WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(EngineBootstrapHookLive),
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive, SetupRunnerLive,
      Layer.succeed(TmuxService, tmux),
      Layer.succeed(EngineRegistry, new Map(engines.map((e) => [e.id, e]))),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(cfgLayer),
  )
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lt-home-"))
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lt-ws-"))
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lt-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repoRoot })
  db = new Database(":memory:"); runMigrations(db)
})
afterAll(() => {
  try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ }
  db.close()
  for (const dir of [home, wsRoot, repoRoot]) fs.rmSync(dir, { recursive: true, force: true })
})

const eventTypes = () => (db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type)
const cap = (target: string) => Effect.runPromise(tmux.capturePane(target))
const waitFor = async (fn: () => Promise<boolean>, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error("waitFor timeout")
}

describe("lifecycle × tmux × engine bootstrap", () => {
  it("有 setup 时保持 engine@0 占位，setup@1 可见；成功后才 respawn engine 并保留输出", async () => {
    const layer = buildLayer([fakeClaude])
    const project = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      return (yield* projects.list())[0] ?? (yield* projects.add(repoRoot))
    }), layer) as Effect.Effect<any, never, never>)
    const machine = path.join(home, "projects", project.id, "setup.sh")
    fs.mkdirSync(path.dirname(machine), { recursive: true })
    fs.writeFileSync(machine, 'printf "SETUP_VISIBLE_MARK\\n"; echo ok > setup-ok\n')
    try {
      const { ws, tabs } = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
        const created = yield* (yield* WorkspaceLifecycle).create({ projectId: project.id, name: "visible-setup" })
        return { ws: created, tabs: yield* (yield* TabsRepo).listByWorkspace(created.id) }
      }), layer) as Effect.Effect<any, never, never>)
      const session = sessionNameFor(ws.id)
      expect(await Effect.runPromise(tmux.listWindows(session))).toEqual([
        expect.objectContaining({ index: 0, name: "engine", role: "engine", workspaceId: ws.id }),
        expect.objectContaining({ index: 1, name: "setup", role: "ops", workspaceId: ws.id }),
      ])
      expect(tabs.map((t: any) => [t.kind, t.tmuxWindow])).toEqual([["engine", 0], ["setup", 1]])
      expect(fs.readFileSync(path.join(ws.path, "setup-ok"), "utf8").trim()).toBe("ok")
      expect(await cap(`${session}:1`)).toContain("SETUP_VISIBLE_MARK")
      await Effect.runPromise(Effect.provide(Effect.gen(function* () {
        yield* (yield* WorkspaceLifecycle).archive(ws.id, { force: true })
      }), layer) as Effect.Effect<any, never, never>)
      expect((db.prepare("SELECT kind FROM tabs WHERE workspace_id=?").all(ws.id) as any[]).map((r) => r.kind)).toEqual(["engine"])
    } finally {
      fs.rmSync(machine, { force: true })
    }
  })

  it("setup 失败即停止并清除 session/tabs/worktree，workspace 进入 error", async () => {
    const layer = buildLayer([fakeClaude])
    const project = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      return (yield* projects.list())[0] ?? (yield* projects.add(repoRoot))
    }), layer) as Effect.Effect<any, never, never>)
    const machine = path.join(home, "projects", project.id, "setup.sh")
    fs.mkdirSync(path.dirname(machine), { recursive: true })
    fs.writeFileSync(machine, 'echo SETUP_FAIL_MARK; exit 7\n')
    try {
      const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
        return yield* (yield* WorkspaceLifecycle).create({ projectId: project.id, name: "failed-setup" })
      }), layer) as Effect.Effect<any, any, never>)
      expect(Exit.isFailure(exit)).toBe(true)
      const row = db.prepare("SELECT id, path, status, data FROM workspaces WHERE name='failed-setup'").get() as any
      expect(row.status).toBe("error")
      expect(JSON.parse(row.data).lastError.tag).toBe("SetupScriptError")
      expect(await Effect.runPromise(tmux.hasSession(sessionNameFor(row.id)))).toBe(false)
      expect((db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id=?").get(row.id) as any).c).toBe(0)
      expect(fs.existsSync(row.path)).toBe(false)
    } finally {
      fs.rmSync(machine, { force: true })
    }
  })

  it("setup tab 持久化 defect 映射 SetupScriptError 并完整回滚", async () => {
    const layer = buildLayer([fakeClaude])
    const project = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      return (yield* projects.list())[0] ?? (yield* projects.add(repoRoot))
    }), layer) as Effect.Effect<any, never, never>)
    const machine = path.join(home, "projects", project.id, "setup.sh")
    fs.mkdirSync(path.dirname(machine), { recursive: true })
    fs.writeFileSync(machine, "echo should-not-complete\n")
    db.exec(`CREATE TRIGGER fail_setup_tab BEFORE INSERT ON tabs
      WHEN NEW.kind = 'setup' BEGIN SELECT RAISE(FAIL, 'injected setup tab failure'); END`)
    try {
      const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
        return yield* (yield* WorkspaceLifecycle).create({ projectId: project.id, name: "setup-tab-defect" })
      }), layer) as Effect.Effect<any, any, never>)
      expect(Exit.isFailure(exit)).toBe(true)
      const row = db.prepare("SELECT id, path, status, data FROM workspaces WHERE name='setup-tab-defect'").get() as any
      expect(row.status).toBe("error")
      expect(JSON.parse(row.data).lastError.tag).toBe("SetupScriptError")
      expect(await Effect.runPromise(tmux.hasSession(sessionNameFor(row.id)))).toBe(false)
      expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id=?").get(row.id)).toEqual({ c: 0 })
      expect(fs.existsSync(row.path)).toBe(false)
      expect(eventTypes()).toContain("workspace.error")
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_setup_tab")
      fs.rmSync(machine, { force: true })
    }
  })

  it("create 建 session/启 engine/写 tab/投首条 prompt；archive/delete 拆干净", async () => {
    const layer = buildLayer([fakeClaude])
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const tabs = yield* TabsRepo
      const project = (yield* projects.list())[0] ?? (yield* projects.add(repoRoot))
      const ws = yield* lc.create({ projectId: project.id, initialPrompt: "hello from coolie" })
      const tabList = yield* tabs.listByWorkspace(ws.id)
      return { ws, tabList }
    })
    const { ws, tabList } = await Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<any, never, never>)

    expect(ws.status).toBe("active")
    const session = sessionNameFor(ws.id)
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)
    expect(tabList).toHaveLength(1)
    expect(tabList[0].kind).toBe("engine")
    expect(tabList[0].tmuxWindow).toBe(0)
    expect(tabList[0].engineSessionId).toBe("sess-fixed-1")
    for (const t of ["workspace.tmux.created", "tab.created", "engine.started", "prompt.delivered", "workspace.created"])
      expect(eventTypes()).toContain(t)
    await waitFor(async () => (await cap(`${session}:0`)).includes("hello from coolie")) // cat 回显 = 投递成功

    // archive：先拆 session/tabs 再删 worktree
    const archived = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const lc = yield* WorkspaceLifecycle
      return yield* lc.archive(ws.id)
    }), layer) as Effect.Effect<any, never, never>)
    expect(archived.status).toBe("archived")
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(false)
    // Plan 4 行为变更：archive 保留 tabs 行——engineSessionId 是 unarchive 后 --resume 复活的钥匙
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 1 })
    expect((db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s).toBe("sess-fixed-1")
    expect(eventTypes()).toContain("workspace.tmux.killed")
  })

  it("delete 仍删 tabs 行（与 archive 保留分野：engineSessionId 复活钥匙只在 delete 时丢弃）", async () => {
    const layer = buildLayer([fakeClaude])
    const ws = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      return yield* lc.create({ projectId: list[0]!.id, name: "delete-tabs" })
    }), layer) as Effect.Effect<any, never, never>)
    // create 落一行 engine tab
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 1 })
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      yield* (yield* WorkspaceLifecycle).delete(ws.id, { force: true })
    }), layer) as Effect.Effect<any, never, never>)
    // delete 清空 tabs 行 + 拆 session（archive 保留 tabs、delete 才删——teardownRuntime reason 分野）
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 0 })
    expect(await Effect.runPromise(tmux.hasSession(sessionNameFor(ws.id)))).toBe(false)
  })

  it("keep-alive：杀掉 engine（cat）后 pane 落回 shell，session/window/pane 不塌", async () => {
    const layer = buildLayer([fakeClaude])
    const ws = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      return yield* lc.create({ projectId: list[0]!.id, name: "keepalive-one" })
    }), layer) as Effect.Effect<any, never, never>)
    const session = sessionNameFor(ws.id)
    const panePid = execFileSync("tmux", ["-L", SOCK, "list-panes", "-t", `=${session}:0`, "-F", "#{pane_pid}"])
      .toString().trim() // = 包装脚本的 /bin/sh
    // cat 是包装 sh 的子进程；等它出现再杀（构成「杀 pane 内进程」的验收）
    let catPid = ""
    await waitFor(async () => {
      try { catPid = execFileSync("pgrep", ["-P", panePid]).toString().trim().split("\n")[0] ?? ""; return catPid !== "" }
      catch { return false }
    })
    process.kill(Number(catPid), "SIGKILL")
    await waitFor(async () => (await cap(`${session}:0`)).includes("engine exited"))
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)
    // exec 落回 shell：pane pid 不变 = 布局与 pane 完整保留
    const panePid2 = execFileSync("tmux", ["-L", SOCK, "list-panes", "-t", `=${session}:0`, "-F", "#{pane_pid}"]).toString().trim()
    expect(panePid2).toBe(panePid)
    // 清场
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      yield* (yield* WorkspaceLifecycle).delete(ws.id, { force: true })
    }), layer) as Effect.Effect<any, never, never>)
  })

  it("bootstrap 失败（registry 缺 claude）→ status=error，无孤儿 session/tab", async () => {
    const layer = buildLayer([]) // 空 registry
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      return yield* lc.create({ projectId: list[0]!.id, name: "broken-one" })
    }), layer) as Effect.Effect<any, any, never>)
    expect(Exit.isFailure(exit)).toBe(true)
    const row = db.prepare("SELECT * FROM workspaces WHERE name = 'broken-one'").get() as any
    expect(row.status).toBe("error")
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(row.id)).toEqual({ c: 0 })
    const sessions = await Effect.runPromise(tmux.listSessions())
    expect(sessions.filter((s) => s === sessionNameFor(row.id))).toEqual([])
  })

  it("bootstrap 中途失败（session/tab 已建，投递 prompt 时死 pane）→ tapError 拆干净 + lifecycle 回滚", async () => {
    // 包装后 engine 秒退不再塌 session（keep-alive exec 回 shell），旧「死 pane」注入失效。
    // 改用「画面永不稳定」（死循环打印）让 deliverPrompt 的 waitStable 用尽 attempts 报 TmuxError，
    // 从而在 tabs.insert 之后触发失败，练到 bootstrap.ts 的 tapError 清理路径（不是空 registry 那条早退路径）。
    const deadPaneClaude: Engine = {
      ...fakeClaude,
      // 包装后秒退不再塌 session；改用「画面永不稳定」让 waitStable 用尽 attempts 报 TmuxError，
      // 同样练到 tabs.insert 之后的 tapError 清理路径。运行时长 ≈ waitStable 预算（默认 24×250ms）。
      launchCommand: () => ["sh", "-c", "while true; do date +%s%N; sleep 0.05; done"],
    }
    const layer = buildLayer([deadPaneClaude])
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      return yield* lc.create({ projectId: list[0]!.id, name: "dead-pane", initialPrompt: "will never land" })
    }), layer) as Effect.Effect<any, any, never>)

    expect(Exit.isFailure(exit)).toBe(true)
    const row = db.prepare("SELECT * FROM workspaces WHERE name = 'dead-pane'").get() as any
    expect(row.status).toBe("error")
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(row.id)).toEqual({ c: 0 })
    const sessions = await Effect.runPromise(tmux.listSessions())
    expect(sessions.filter((s) => s === sessionNameFor(row.id))).toEqual([])
    expect(fs.existsSync(row.path)).toBe(false)
  })

  it("delete 拆 session + tabs + 记录", async () => {
    const layer = buildLayer([fakeClaude])
    const ws = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      return yield* lc.create({ projectId: list[0]!.id, name: "to-delete" })
    }), layer) as Effect.Effect<any, never, never>)
    const session = sessionNameFor(ws.id)
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      yield* (yield* WorkspaceLifecycle).delete(ws.id)
    }), layer) as Effect.Effect<any, never, never>)
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(false)
    expect(db.prepare("SELECT COUNT(*) c FROM workspaces WHERE id = ?").get(ws.id)).toEqual({ c: 0 })
  })
})
