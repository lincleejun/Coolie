import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { AttentionCompletionLive } from "../src/attention/service.js"
import { createApp, newToken } from "../src/http/app.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { TabsRepoLive } from "../src/repo/tabs.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"

describe("POST /notify/:engine", () => {
  let server: http.Server
  let base = ""
  let token = ""
  let db: Database.Database
  let testHome = ""

  beforeEach(async () => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-http-notify-"))
    process.env.COOLIE_CODEX_HOME = path.join(testHome, "codex-home")
    process.env.COOLIE_CODEX_CONFIG = path.join(testHome, "config.toml")
    process.env.COOLIE_CODEX_HOOKS = "0"

    db = new Database(":memory:")
    runMigrations(db)
    db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at)
      VALUES ('p1', 'x', '/tmp/x', 'main', 1)`).run()
    db.prepare(`INSERT INTO workspaces
      (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w1', 'p1', 'codex', '/tmp/w1', 'coolie/w1', 'main', 'r', 'active', 0, 1, NULL, '{}')`).run()
    db.prepare(`INSERT INTO tabs
      (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
      VALUES ('t1', 'w1', 'engine', 'codex', 's1', 0, NULL, 'working', '{}')`).run()

    const layer = Layer.mergeAll(TabsRepoLive, EventsRepoLive, WorkspacesRepoLive, EngineRegistryLive, AttentionCompletionLive)
      .pipe(Layer.provide(Layer.succeed(Db, db)))
    token = newToken()
    server = http.createServer(createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
      token,
      onShutdown: () => {},
    }))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
    db.close()
    delete process.env.COOLIE_CODEX_HOME
    delete process.env.COOLIE_CODEX_CONFIG
    delete process.env.COOLIE_CODEX_HOOKS
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  const post = (pathName: string, body: unknown, bearer = token) => fetch(base + pathName, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  })

  it("agent-turn-complete 置 awaiting-input 并发 source=notify 的完成事件", async () => {
    const response = await post("/notify/codex?workspace=w1", {
      type: "agent-turn-complete",
      "turn-id": "turn-1",
      "last-assistant-message": "done",
    })
    expect(response.status).toBe(200)

    const tab = db.prepare("SELECT status, data FROM tabs WHERE id = 't1'").get() as any
    expect(tab.status).toBe("awaiting-input")
    expect(JSON.parse(tab.data).lastHookAt).toBeGreaterThan(0)
    const finished = db.prepare("SELECT payload FROM events WHERE type = 'engine.turn.finished'").get() as any
    expect(JSON.parse(finished.payload)).toMatchObject({ tabId: "t1", sessionId: "s1", source: "notify" })
    const status = db.prepare("SELECT payload FROM events WHERE type = 'tab.status.changed' ORDER BY seq DESC").get() as any
    expect(JSON.parse(status.payload).source).toBe("notify")
  })

  it("非 agent-turn-complete 语义静默成功且不改变状态", async () => {
    const response = await post("/notify/codex?workspace=w1", { type: "thread-started" })
    expect(response.status).toBe(200)
    expect((db.prepare("SELECT status FROM tabs WHERE id = 't1'").get() as any).status).toBe("working")
    expect((db.prepare("SELECT count(*) AS n FROM events").get() as any).n).toBe(0)
  })

  it("routes by tabId and degrades safely when legacy context is ambiguous", async () => {
    db.prepare(`INSERT INTO tabs
      (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
      VALUES ('t2', 'w1', 'engine', 'codex', 's2', 2, NULL, 'working', '{}')`).run()
    await post("/notify/codex?workspace=w1", { type: "agent-turn-complete" })
    expect((db.prepare("SELECT status FROM tabs WHERE id='t1'").get() as any).status).toBe("working")
    expect((db.prepare("SELECT status FROM tabs WHERE id='t2'").get() as any).status).toBe("working")

    await post("/notify/codex?workspace=w1&tabId=t2", { type: "agent-turn-complete" })
    expect((db.prepare("SELECT status FROM tabs WHERE id='t1'").get() as any).status).toBe("working")
    expect((db.prepare("SELECT status FROM tabs WHERE id='t2'").get() as any).status).toBe("awaiting-input")
  })

  it("要求 workspace 与 Bearer token，未知引擎静默成功", async () => {
    expect((await post("/notify/codex", { type: "agent-turn-complete" })).status).toBe(400)
    expect((await post("/notify/codex?workspace=w1", { type: "agent-turn-complete" }, "")).status).toBe(401)
    const unknown = await post("/notify/missing?workspace=w1", { type: "agent-turn-complete" })
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({ ok: true })
  })

  it("archiving 时静默忽略迟到 notify，不改恢复元数据", async () => {
    db.prepare("UPDATE workspaces SET status = 'archiving' WHERE id = 'w1'").run()
    const response = await post("/notify/codex?workspace=w1", {
      type: "agent-turn-complete", "thread-id": "late-session",
    })
    expect(response.status).toBe(200)
    expect(db.prepare("SELECT status, engine_session_id AS sessionId FROM tabs WHERE id = 't1'").get())
      .toEqual({ status: "working", sessionId: "s1" })
  })
})
