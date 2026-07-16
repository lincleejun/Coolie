import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import { EventEmitter } from "node:events"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { decodeCoolieStateSnapshot } from "@coolie/protocol"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { StateRepoLive } from "../src/repo/state.js"
import { EventsBus } from "../src/events/bus.js"
import { createApp, newToken } from "../src/http/app.js"

const seedProject = (db: Database.Database, id = "p1"): void => {
  db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
    .run(id, `project-${id}`, `/tmp/${id}`, "main", 1)
}

const seedWorkspace = (db: Database.Database, id: string, projectId: string, sortOrder = 1): void => {
  db.prepare(`INSERT INTO workspaces
    (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at,
     task_status, kind, materialized, sort_order, data)
    VALUES (?,?,?,?,?,?,?,'active',0,1,'in_progress','task',1,?,?)`).run(
    id, projectId, id, `/tmp/${id}`, `coolie/${id}`, "main", "HEAD", sortOrder,
    JSON.stringify({ portBase: 40000, ownership: "managed" }),
  )
}

const seedTab = (db: Database.Database, id: string, workspaceId: string): void => {
  db.prepare(`INSERT INTO tabs
    (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, workspaceId, "engine", "claude", "sess-1", 1, "Claude", "idle", "{}")
}

describe("GET /state", () => {
  let server: http.Server
  let base: string
  let token: string
  let db: Database.Database
  let bus: EventEmitter
  let append: (workspaceId: string | null, type: string) => Promise<unknown>

  beforeEach(async () => {
    db = new Database(":memory:")
    runMigrations(db)
    bus = new EventEmitter()
    const layer = Layer.mergeAll(EventsRepoLive, StateRepoLive).pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(EventsBus, bus))),
    )
    const runtime = (eff: Effect.Effect<any, any, any>) =>
      Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>)
    append = (workspaceId, type) =>
      runtime(Effect.gen(function* () {
        return yield* (yield* EventsRepo).append({ workspaceId, type, payload: { t: type } })
      }))
    token = newToken()
    const app = createApp({
      runtime, token, onShutdown: () => {},
      bus, sseHeartbeatMs: 60,
    })
    server = http.createServer(app)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => server.close())

  const req = (p: string, init: RequestInit = {}) =>
    fetch(base + p, {
      ...init,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })

  it("requires a token", async () => {
    const r = await fetch(`${base}/state`)
    expect(r.status).toBe(401)
    expect((await r.json()).code).toBe("Validation")
  })

  it("returns a valid empty snapshot for a greenfield database", async () => {
    const r = await req("/state")
    expect(r.status).toBe(200)
    const snapshot = decodeCoolieStateSnapshot(await r.json())
    expect(snapshot.asOfSeq).toBe(0)
    expect(snapshot.scope).toBeNull()
    expect(snapshot.projects).toEqual([])
    expect(snapshot.workspaces).toEqual([])
    expect(snapshot.tabs).toEqual([])
  })

  it("returns canonical resources and asOfSeq from one read transaction", async () => {
    seedProject(db, "p1")
    seedWorkspace(db, "w1", "p1")
    seedTab(db, "t1", "w1")
    await append("w1", "workspace.created")

    const r = await req("/state")
    expect(r.status).toBe(200)
    const snapshot = decodeCoolieStateSnapshot(await r.json())
    expect(snapshot.asOfSeq).toBe(1)
    expect(snapshot.projects).toHaveLength(1)
    expect(snapshot.workspaces).toHaveLength(1)
    expect(snapshot.workspaces[0]!.id).toBe("w1")
    expect(snapshot.tabs).toHaveLength(1)
    expect(snapshot.tabs[0]!.id).toBe("t1")
  })

  it("scopes queue and resources to ?workspace=", async () => {
    seedProject(db, "p1")
    seedWorkspace(db, "w1", "p1", 1)
    seedWorkspace(db, "w2", "p1", 2)
    seedTab(db, "t1", "w1")
    seedTab(db, "t2", "w2")
    db.prepare(`INSERT INTO prompt_queue
      (workspace_id, tab_id, text, mode, state, created_at)
      VALUES (?,?,?,?,?,?)`).run("w1", "t1", "hello w1", "send", "queued", 1)
    db.prepare(`INSERT INTO prompt_queue
      (workspace_id, tab_id, text, mode, state, created_at)
      VALUES (?,?,?,?,?,?)`).run("w2", "t2", "hello w2", "send", "queued", 2)

    const r = await req("/state?workspace=w1")
    expect(r.status).toBe(200)
    const snapshot = decodeCoolieStateSnapshot(await r.json())
    expect(snapshot.scope).toEqual({ workspaceId: "w1" })
    expect(snapshot.workspaces).toHaveLength(1)
    expect(snapshot.workspaces[0]!.id).toBe("w1")
    expect(snapshot.tabs).toHaveLength(1)
    expect(snapshot.tabs[0]!.workspaceId).toBe("w1")
    expect(snapshot.queuedPrompts).toHaveLength(1)
    expect(snapshot.queuedPrompts[0]!.text).toBe("hello w1")
  })

  it("returns 404 for unknown workspace scope", async () => {
    const r = await req("/state?workspace=missing")
    expect(r.status).toBe(404)
    expect((await r.json()).code).toBe("NotFound")
  })

  it("snapshot asOfSeq seeds SSE replay without a loss window", async () => {
    await append("w1", "workspace.creating")
    const snapshot = decodeCoolieStateSnapshot(await (await req("/state")).json())
    const asOfSeq = snapshot.asOfSeq
    expect(asOfSeq).toBe(1)

    await append("w1", "workspace.created")
    const ac = new AbortController()
    const stream = await fetch(`${base}/events/stream?after=${asOfSeq}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    })
    expect(stream.status).toBe(200)

    const reader = stream.body!.getReader()
    const dec = new TextDecoder()
    let buf = ""
    const deadline = Date.now() + 5000
    while (!buf.includes("workspace.created") && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
    }
    ac.abort()
    expect(buf).toContain("workspace.created")
    expect(buf).not.toContain("workspace.creating")
  })
})
