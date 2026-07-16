import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { AttentionCompletion, AttentionCompletionLive } from "../src/attention/service.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { createApp, newToken } from "../src/http/app.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"

describe("completion single-transaction writes (Task 2A.3)", () => {
  let server: http.Server
  let base = ""
  let token = ""
  let db: Database.Database
  let tabId = ""
  let claudeHome = ""
  let wsPath = ""

  const layer = () => Layer.mergeAll(
    ProjectsRepoLive,
    EventsRepoLive,
    WorkspacesRepoLive,
    TabsRepoLive,
    EngineRegistryLive,
    AttentionCompletionLive,
  ).pipe(Layer.provide(Layer.succeed(Db, db)))

  beforeEach(async () => {
    db = new Database(":memory:")
    runMigrations(db)
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-attn-sig-"))
    wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-attn-ws-"))
    db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)`).run()
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w1','p1','usa-zion',?,'coolie/a','main','r','active',0,1,NULL,'{}')`).run(wsPath)

    tabId = (await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "sess-1", tmuxWindow: 0 })
    }), layer()))).id

    token = newToken()
    server = http.createServer(createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer()) as Effect.Effect<any, any, never>),
      token,
      onShutdown: () => {},
      claudeHome,
    }))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
    db.close()
    fs.rmSync(claudeHome, { recursive: true, force: true })
    fs.rmSync(wsPath, { recursive: true, force: true })
  })

  const postHook = (body: unknown) => fetch(`${base}/hooks/claude?workspace=w1`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  const postNotify = (body: unknown) => fetch(`${base}/notify/codex?workspace=w1&tabId=${tabId}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  it("hook Stop writes tab, events, and attention in one transaction", async () => {
    db.prepare("UPDATE tabs SET status = 'working' WHERE id = ?").run(tabId)
    const response = await postHook({ hook_event_name: "Stop", session_id: "sess-1" })
    expect(response.status).toBe(200)

    expect((db.prepare("SELECT status FROM tabs WHERE id = ?").get(tabId) as any).status).toBe("awaiting-input")
    const events = db.prepare("SELECT type FROM events ORDER BY seq").all() as Array<{ type: string }>
    expect(events.map((e) => e.type).filter((t) => t !== "tab.created")).toEqual(["tab.status.changed", "engine.turn.finished"])
    expect(db.prepare("SELECT COUNT(*) c FROM attention_items").get()).toEqual({ c: 1 })
    expect(db.prepare("SELECT kind, source FROM attention_items").get()).toEqual({
      kind: "turn-finished",
      source: "hook",
    })
  })

  it("deduplicates duplicate hook completion by sourceEventSeq", async () => {
    db.prepare("UPDATE tabs SET status = 'working' WHERE id = ?").run(tabId)
    const first = await postHook({ hook_event_name: "Stop", session_id: "sess-1" })
    const second = await postHook({ hook_event_name: "Stop", session_id: "sess-1" })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(db.prepare("SELECT COUNT(*) c FROM attention_items").get()).toEqual({ c: 1 })
    expect(db.prepare("SELECT COUNT(*) c FROM events WHERE type = 'engine.turn.finished'").get()).toEqual({ c: 1 })
  })

  it("rolls back tab status when attention insert fails", async () => {
    db.prepare("UPDATE tabs SET status = 'working' WHERE id = ?").run(tabId)
    db.exec(`
      CREATE TRIGGER break_attention BEFORE INSERT ON attention_items
      BEGIN SELECT RAISE(ABORT, 'boom'); END
    `)
    const response = await postHook({ hook_event_name: "Stop", session_id: "sess-1" })
    expect(response.status).not.toBe(200)
    expect((db.prepare("SELECT status FROM tabs WHERE id = ?").get(tabId) as any).status).toBe("working")
    expect(db.prepare("SELECT COUNT(*) c FROM events WHERE type = 'tab.status.changed'").get()).toEqual({ c: 0 })
    db.exec("DROP TRIGGER break_attention")
  })

  it("poller inferred completion marks kind=inferred and only once per cycle", async () => {
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const completion = yield* AttentionCompletion
      const tabs = yield* TabsRepo
      const tab = yield* tabs.get(tabId)
      db.prepare("UPDATE tabs SET status = 'working' WHERE id = ?").run(tabId)
      yield* completion.apply({
        tabId,
        workspaceId: "w1",
        status: "awaiting-input",
        statusSource: "poller",
        kind: "inferred",
        attentionSource: "transcript-poller",
        sessionTurnId: tab.engineSessionId,
        summary: "Inferred idle",
      })
      yield* completion.apply({
        tabId,
        workspaceId: "w1",
        status: "awaiting-input",
        statusSource: "poller",
        kind: "inferred",
        attentionSource: "transcript-poller",
        sessionTurnId: tab.engineSessionId,
        summary: "Inferred idle",
      })
    }), layer()))

    expect(db.prepare("SELECT COUNT(*) c FROM attention_items").get()).toEqual({ c: 1 })
    expect(db.prepare("SELECT kind, source FROM attention_items").get()).toEqual({
      kind: "inferred",
      source: "transcript-poller",
    })
  })
})
