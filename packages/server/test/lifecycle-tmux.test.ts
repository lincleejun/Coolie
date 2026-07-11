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
    workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"),
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
afterAll(() => { try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ } })

const eventTypes = () => (db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type)
const cap = (target: string) => Effect.runPromise(tmux.capturePane(target))
const waitFor = async (fn: () => Promise<boolean>, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error("waitFor timeout")
}

describe("lifecycle × tmux × engine bootstrap", () => {
  it("create 建 session/启 engine/写 tab/投首条 prompt；archive/delete 拆干净", async () => {
    const layer = buildLayer([fakeClaude])
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const tabs = yield* TabsRepo
      const project = yield* projects.add(repoRoot)
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
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 0 })
    expect(eventTypes()).toContain("workspace.tmux.killed")
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
