import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Effect, Layer } from "effect"
import Database from "better-sqlite3"
import { execFileSync } from "node:child_process"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { SessionEnsurer, SessionEnsurerLive } from "../src/workspace/heal.js"
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
import { createApp, newToken } from "../src/http/app.js"

const SOCK = `coolie-test-${process.pid}-hh`
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
// 与 heal.test.ts 同款——避免 worktreePresent 误判。
beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hh-home-")))
  wsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hh-ws-")))
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hh-repo-")))
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

describe("ensure/resume HTTP 端点（真 tmux）", () => {
  let server: http.Server, base: string, token: string, layer: ReturnType<typeof buildLayer>, ws: any

  beforeAll(async () => {
    layer = buildLayer()
    ws = await runIn(layer, Effect.gen(function* () {
      const project = yield* (yield* ProjectsRepo).add(repoRoot)
      return yield* (yield* WorkspaceLifecycle).create({ projectId: project.id, name: "http-heal" })
    }))
    token = newToken()
    const runtime = (eff: any) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, never, never>)
    server = http.createServer(createApp({ runtime, token, onShutdown: () => {} }))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => server.close())

  const post = (p: string) => fetch(`${base}${p}`, {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: "{}",
  })
  const engineTabId = () => (db.prepare("SELECT id FROM tabs WHERE workspace_id = ? AND kind='engine'").get(ws.id) as any).id as string

  it("ensure：session 在 → 200 action=none", async () => {
    const r = await post(`/workspaces/${ws.id}/ensure`)
    expect(r.status).toBe(200)
    expect((await r.json()).action).toBe("none")
  })

  it("resume：session 在 → 200 action=respawned，pane 进程被替换、窗口数不变", async () => {
    const session = sessionNameFor(ws.id)
    const pidBefore = execFileSync("tmux", ["-L", SOCK, "list-panes", "-t", `=${session}:0`, "-F", "#{pane_pid}"]).toString().trim()
    const r = await post(`/workspaces/${ws.id}/tabs/${engineTabId()}/resume`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.action).toBe("respawned")
    const pidAfter = execFileSync("tmux", ["-L", SOCK, "list-panes", "-t", `=${session}:0`, "-F", "#{pane_pid}"]).toString().trim()
    expect(pidAfter).not.toBe(pidBefore) // respawn -k 换了 pane 进程
    expect(execFileSync("tmux", ["-L", SOCK, "list-windows", "-t", `=${session}`]).toString().trim().split("\n")).toHaveLength(1)
    expect(eventTypes()).toContain("engine.resumed")
  })

  it("resume：session 丢失 → 自动降级 ensure（action=recreated）", async () => {
    execFileSync("tmux", ["-L", SOCK, "kill-session", "-t", `=${sessionNameFor(ws.id)}`])
    const r = await post(`/workspaces/${ws.id}/tabs/${engineTabId()}/resume`)
    expect(r.status).toBe(200)
    expect((await r.json()).action).toBe("recreated")
    expect(await Effect.runPromise(tmux.hasSession(sessionNameFor(ws.id)))).toBe(true)
  })

  it("resume：非 engine tab → 409；未知 tab → 404；未知 ws 的 ensure → 404", async () => {
    const shellTab = await runIn(layer, Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: ws.id, kind: "shell", tmuxWindow: 9 })
    }))
    expect((await post(`/workspaces/${ws.id}/tabs/${shellTab.id}/resume`)).status).toBe(409)
    expect((await post(`/workspaces/${ws.id}/tabs/ghost/resume`)).status).toBe(404)
    expect((await post(`/workspaces/ghost/ensure`)).status).toBe(404)
  })
})
