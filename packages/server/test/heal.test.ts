import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Effect, Layer, Exit } from "effect"
import Database from "better-sqlite3"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { decideHeal, SessionEnsurer, SessionEnsurerLive } from "../src/workspace/heal.js"

describe("decideHeal（observe→decide 纯决策）", () => {
  const tab = { id: "t1", engineSessionId: "s1" }
  it("session 在 → none（有无 tab/转录都一样）", () => {
    expect(decideHeal({ hasSession: true, engineTab: tab, transcriptExists: true, freshSessionId: "f" })).toEqual({ kind: "none" })
    expect(decideHeal({ hasSession: true, engineTab: null, transcriptExists: false, freshSessionId: "f" })).toEqual({ kind: "none" })
  })
  it("session 丢 + 有 tab + 转录在 → resume 旧 id", () => {
    expect(decideHeal({ hasSession: false, engineTab: tab, transcriptExists: true, freshSessionId: "f" }))
      .toEqual({ kind: "recreate", resume: true, sessionId: "s1", needsTabRow: false })
  })
  it("session 丢 + 有 tab + 转录不在 → 全新 id（不 resume）", () => {
    expect(decideHeal({ hasSession: false, engineTab: tab, transcriptExists: false, freshSessionId: "f" }))
      .toEqual({ kind: "recreate", resume: false, sessionId: "f", needsTabRow: false })
  })
  it("session 丢 + tab 无 sessionId → 全新 id", () => {
    expect(decideHeal({ hasSession: false, engineTab: { id: "t1", engineSessionId: null }, transcriptExists: false, freshSessionId: "f" }))
      .toEqual({ kind: "recreate", resume: false, sessionId: "f", needsTabRow: false })
  })
  it("session 丢 + 无 tab → 全新 id + 补 tab 行", () => {
    expect(decideHeal({ hasSession: false, engineTab: null, transcriptExists: false, freshSessionId: "f" }))
      .toEqual({ kind: "recreate", resume: false, sessionId: "f", needsTabRow: true })
  })
})

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
const launches: Array<{ sessionId: string; resume?: boolean }> = []
let nextId = 0

const recordingClaude: Engine = {
  id: "claude", displayName: "Recording Claude",
  capabilities: { nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: false, effort: false },
  terminalTitle: "none",
  newSessionId: () => `sess-${++nextId}`,
  launchCommand: (o) => { launches.push({ sessionId: o.sessionId, ...(o.resume !== undefined ? { resume: o.resume } : {}) }); return ["cat"] },
  statusFromHookEvent: () => null,
  transcriptPath: ({ home: h, cwd, sessionId }) => path.join(h, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`),
  deriveTitle: () => null,
  resumeArgs: (s) => ["--resume", s],
}

const buildLayer = () => {
  const cfgLayer = Layer.succeed(CoolieConfig, {
    home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
    workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"), codexHome: path.join(home, "codex-home"),
  })
  return WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(EngineBootstrapHookLive, SessionEnsurerLive)),
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive, SetupRunnerLive,
      Layer.succeed(TmuxService, tmux),
      Layer.succeed(EngineRegistry, new Map([[recordingClaude.id, recordingClaude]])),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(cfgLayer),
  )
}

// realpathSync：macOS 上 git 把 worktree 路径归一到 /private/var（/var 是符号链接），
// 而 path.resolve 不解符号链接——worktreePresent 会因 /var ≠ /private/var 误判 worktree 不在，
// 导致 archive 静默跳过删除、unarchive 再 add 时 “already exists”。与 integration-lifecycle.test.ts 同款。
beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-heal-home-")))
  wsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-heal-ws-")))
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-heal-repo-")))
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repoRoot })
  db = new Database(":memory:"); runMigrations(db)
})
afterAll(() => {
  try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ }
  db.close()
  for (const dir of [home, wsRoot, repoRoot]) fs.rmSync(dir, { recursive: true, force: true })
})

const runIn = <A>(layer: ReturnType<typeof buildLayer>, eff: Effect.Effect<A, any, any>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<A, never, never>)
const eventTypes = () => (db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type)

describe("SessionEnsurer.ensure（真 tmux）", () => {
  it("session 在 → action=none，零副作用", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const project = yield* (yield* ProjectsRepo).add(repoRoot)
      return yield* (yield* WorkspaceLifecycle).create({ projectId: project.id, name: "heal-alive" })
    }))
    const before = eventTypes().length
    const out = await runIn(layer, Effect.gen(function* () { return yield* (yield* SessionEnsurer).ensure(ws.id) }))
    expect(out.action).toBe("none")
    expect(eventTypes().length).toBe(before) // 无新事件
  })

  it("session 被外力清理 + 转录在 → 重建并 --resume 旧 id + workspace.tmux.healed", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const list = yield* (yield* ProjectsRepo).list()
      return yield* (yield* WorkspaceLifecycle).create({ projectId: list[0]!.id, name: "heal-resume" })
    }))
    const session = sessionNameFor(ws.id)
    const oldSid = (db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s as string
    // 伪造转录文件（historyReader 的 observe 依据）
    const tp = recordingClaude.transcriptPath({ home: path.join(home, "claude-home"), cwd: ws.path, sessionId: oldSid })
    fs.mkdirSync(path.dirname(tp), { recursive: true })
    fs.writeFileSync(tp, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n")
    execFileSync("tmux", ["-L", SOCK, "kill-session", "-t", `=${session}`]) // 外力清理
    launches.length = 0

    const out = await runIn(layer, Effect.gen(function* () { return yield* (yield* SessionEnsurer).ensure(ws.id) }))
    expect(out).toMatchObject({ action: "recreated", resumed: true, sessionName: session, sessionId: oldSid })
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)
    expect(launches).toEqual([{ sessionId: oldSid, resume: true }])
    expect(eventTypes()).toContain("workspace.tmux.healed")
  })

  it("session 丢 + 无转录 → 全新 id 重建 + tab.session.changed", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const list = yield* (yield* ProjectsRepo).list()
      return yield* (yield* WorkspaceLifecycle).create({ projectId: list[0]!.id, name: "heal-fresh" })
    }))
    const session = sessionNameFor(ws.id)
    const oldSid = (db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s as string
    execFileSync("tmux", ["-L", SOCK, "kill-session", "-t", `=${session}`])
    const out = await runIn(layer, Effect.gen(function* () { return yield* (yield* SessionEnsurer).ensure(ws.id) }))
    expect(out.action).toBe("recreated")
    expect(out.resumed).toBe(false)
    expect(out.sessionId).not.toBe(oldSid)
    expect((db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s).toBe(out.sessionId)
    expect(eventTypes()).toContain("tab.session.changed")
  })

  it("非 active（archived）→ ConflictError；未知 ws → NotFoundError", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const list = yield* (yield* ProjectsRepo).list()
      const created = yield* (yield* WorkspaceLifecycle).create({ projectId: list[0]!.id, name: "heal-gate" })
      return yield* (yield* WorkspaceLifecycle).archive(created.id, { force: true })
    }))
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      return yield* (yield* SessionEnsurer).ensure(ws.id)
    }), layer) as Effect.Effect<any, any, never>)
    expect(Exit.isFailure(exit)).toBe(true)
    const exit2 = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      return yield* (yield* SessionEnsurer).ensure("ghost")
    }), layer) as Effect.Effect<any, any, never>)
    expect(Exit.isFailure(exit2)).toBe(true)
  })

  it("unarchive → worktree 恢复 + session 自动重建（--resume 复活，archive 保留的 tabs 行是钥匙）", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const list = yield* (yield* ProjectsRepo).list()
      return yield* (yield* WorkspaceLifecycle).create({ projectId: list[0]!.id, name: "heal-unarchive" })
    }))
    const session = sessionNameFor(ws.id)
    const sid = (db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s as string
    const tp = recordingClaude.transcriptPath({ home: path.join(home, "claude-home"), cwd: ws.path, sessionId: sid })
    fs.mkdirSync(path.dirname(tp), { recursive: true })
    fs.writeFileSync(tp, "{}\n")
    await runIn(layer, Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).archive(ws.id, { force: true }) }))
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(false)
    launches.length = 0
    const back = await runIn(layer, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).unarchive(ws.id) }))
    expect(back.status).toBe("active")
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)   // 重建了
    expect(launches).toEqual([{ sessionId: sid, resume: true }])            // 且是 --resume 复活
    expect(eventTypes()).toContain("workspace.tmux.healed")
  })

  it("D3：archive 带 shell tab → unarchive 后死 shell tab 行被 prune，engine tab 存活", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const list = yield* (yield* ProjectsRepo).list()
      return yield* (yield* WorkspaceLifecycle).create({ projectId: list[0]!.id, name: "heal-prune" })
    }))
    const session = sessionNameFor(ws.id)
    const sid = (db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s as string
    const tp = recordingClaude.transcriptPath({ home: path.join(home, "claude-home"), cwd: ws.path, sessionId: sid })
    fs.mkdirSync(path.dirname(tp), { recursive: true }); fs.writeFileSync(tp, "{}\n")
    // 真 tmux 开一个 shell window（idx 1）+ 落一条 shell tab 行，指向 window 1
    execFileSync("tmux", ["-L", SOCK, "new-window", "-t", `=${session}:`, "-n", "shell", "-c", ws.path, "/bin/sh"])
    await runIn(layer, Effect.gen(function* () { yield* (yield* TabsRepo).insert({ workspaceId: ws.id, kind: "shell", tmuxWindow: 1 }) }))
    const engineTabId = (db.prepare("SELECT id FROM tabs WHERE workspace_id = ? AND kind = 'engine'").get(ws.id) as any).id as string
    expect((db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id) as any).c).toBe(2)

    await runIn(layer, Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).archive(ws.id, { force: true }) }))
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(false)
    const back = await runIn(layer, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).unarchive(ws.id) }))
    expect(back.status).toBe("active")

    // recreate 的 session 只余 window 0（engine）；window 1 的 shell tab 行是死记录 → 应被 prune
    const rows = db.prepare("SELECT id, kind, tmux_window FROM tabs WHERE workspace_id = ?").all(ws.id) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(engineTabId)      // engine tab 存活
    expect(rows[0].kind).toBe("engine")
    expect(rows[0].tmux_window).toBe(0)
    const closed = (db.prepare("SELECT payload FROM events WHERE type = 'tab.closed'").all() as any[])
      .map((r) => JSON.parse(r.payload))
    expect(closed.some((p) => p.kind === "shell")).toBe(true) // 死 shell tab 发了 tab.closed
  })
})
