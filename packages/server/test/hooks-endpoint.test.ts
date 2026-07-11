import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { ensureHookScript, injectClaudeHooks, hookScriptPath, hooksDisabled } from "../src/engine/claude/hooks.js"
import { encodeCwd } from "../src/engine/claude/adapter.js"
import { createApp, newToken } from "../src/http/app.js"

describe("hook script + settings injection（纯 fs）", () => {
  let home: string, worktree: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hooks-home-"))
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hooks-wt-"))
  })

  it("ensureHookScript writes an executable sh forwarder that always exits 0", () => {
    const p = ensureHookScript(home)
    expect(p).toBe(hookScriptPath(home))
    const st = fs.statSync(p)
    expect(st.mode & 0o111).not.toBe(0)
    const body = fs.readFileSync(p, "utf8")
    expect(body).toContain("/hooks/claude?workspace=$COOLIE_WORKSPACE")
    expect(body.trim().endsWith("exit 0")).toBe(true)
    expect(body).toContain(`${home}/server.json`)
  })

  it("injectClaudeHooks is idempotent and preserves foreign hooks", () => {
    const script = ensureHookScript(home)
    const file = path.join(worktree, ".claude", "settings.local.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook" }] }] }, other: 1 }))
    injectClaudeHooks({ worktreePath: worktree, workspaceId: "w1", scriptPath: script })
    injectClaudeHooks({ worktreePath: worktree, workspaceId: "w1", scriptPath: script }) // 幂等
    const s = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(s.other).toBe(1)
    const stopCmds = s.hooks.Stop.flatMap((e: any) => e.hooks.map((h: any) => h.command))
    expect(stopCmds.filter((c: string) => c.includes(script))).toHaveLength(1) // 只有一条 coolie 条目
    expect(stopCmds).toContain("my-own-hook")                                   // 用户 hook 保留
    for (const evt of ["UserPromptSubmit", "Stop", "Notification", "SessionEnd"]) expect(s.hooks[evt]).toBeDefined()
    expect(stopCmds.find((c: string) => c.includes(script))).toContain("COOLIE_WORKSPACE=w1")
  })

  it("hooksDisabled honors COOLIE_DISABLE_HOOKS=1", () => {
    expect(hooksDisabled({ COOLIE_DISABLE_HOOKS: "1" })).toBe(true)
    expect(hooksDisabled({})).toBe(false)
  })
})

describe("POST /hooks/claude endpoint", () => {
  let server: http.Server, base: string, token: string, db: Database.Database
  let claudeHome: string, wsPath: string, tabId: string
  const SESSION_ID = "11111111-2222-4333-8444-555555555555"

  beforeEach(async () => {
    db = new Database(":memory:"); runMigrations(db)
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-claude-home-"))
    wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hooks-ws-"))
    db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)`).run()
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w1','p1','usa-zion',?,'coolie/a','main','r','active',0,1,NULL,'{}')`).run(wsPath)
    const layer = Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive, EngineRegistryLive)
      .pipe(Layer.provide(Layer.succeed(Db, db)))
    const runtime = (eff: any) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, never, never>)
    tabId = (await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: SESSION_ID, tmuxWindow: 0 })
    }), layer) as Effect.Effect<any, never, never>)).id
    token = newToken()
    server = http.createServer(createApp({ runtime, token, onShutdown: () => {}, claudeHome }))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => server.close())

  const post = (qs: string, body: unknown) => fetch(`${base}/hooks/claude${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const tabRow = () => db.prepare("SELECT * FROM tabs WHERE id = ?").get(tabId) as any
  const eventTypes = () => (db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type)

  it("UserPromptSubmit → status working + engine.turn.started + lastHookAt", async () => {
    const r = await post("?workspace=w1", { hook_event_name: "UserPromptSubmit", session_id: SESSION_ID })
    expect(r.status).toBe(200)
    expect(tabRow().status).toBe("working")
    expect(JSON.parse(tabRow().data).lastHookAt).toBeGreaterThan(0)
    expect(eventTypes()).toContain("engine.turn.started")
  })

  it("Stop → awaiting-input + engine.turn.finished + 转录标题派生", async () => {
    const dir = path.join(claudeHome, "projects", encodeCwd(wsPath))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`),
      JSON.stringify({ type: "user", message: { role: "user", content: "Summarize this repo" } }) + "\n")
    await post("?workspace=w1", { hook_event_name: "Stop", session_id: SESSION_ID })
    expect(tabRow().status).toBe("awaiting-input")
    expect(tabRow().title).toBe("Summarize this repo")
    expect(eventTypes()).toContain("engine.turn.finished")
    expect(eventTypes()).toContain("tab.title.changed")
  })

  it("missing workspace param → 400; unknown workspace → 200 ok（hook 永远成功）", async () => {
    expect((await post("", { hook_event_name: "Stop" })).status).toBe(400)
    const r = await post("?workspace=nope", { hook_event_name: "Stop" })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it("no token → 401", async () => {
    const r = await fetch(`${base}/hooks/claude?workspace=w1`, { method: "POST", body: "{}" })
    expect(r.status).toBe(401)
  })

  it("GET /workspaces/:id/tabs lists tabs", async () => {
    const r = await fetch(`${base}/workspaces/w1/tabs`, { headers: { Authorization: `Bearer ${token}` } })
    expect(r.status).toBe(200)
    const list = await r.json()
    expect(list).toHaveLength(1)
    expect(list[0].kind).toBe("engine")
  })
})
