import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as http from "node:http"
import { EventEmitter } from "node:events"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { decodeAttentionItem } from "@coolie/protocol"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { AttentionInbox, AttentionInboxLive } from "../src/repo/attention.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { EventsBus } from "../src/events/bus.js"
import { createApp, newToken } from "../src/http/app.js"

describe("attention HTTP + CLI surface (Task 2A.4)", () => {
  let server: http.Server
  let base = ""
  let token = ""
  let db: Database.Database
  let itemId = ""

  const layer = () => Layer.mergeAll(EventsRepoLive, AttentionInboxLive).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(EventsBus, new EventEmitter()))),
  )

  beforeEach(async () => {
    db = new Database(":memory:")
    runMigrations(db)
    db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)`).run()
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w1','p1','usa-zion','/tmp/w1','coolie/a','main','r','active',0,1,NULL,'{}')`).run()
    db.prepare(`INSERT INTO tabs (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
      VALUES ('t1','w1','engine','claude','sess-1',1,'Claude','awaiting-input','{}')`).run()
    db.prepare(`INSERT INTO events (workspace_id, type, payload, ts) VALUES ('w1','tab.status.changed','{}',1)`).run()

    itemId = (await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).record({
        workspaceId: "w1",
        tabId: "t1",
        kind: "turn-finished",
        source: "hook",
        sourceEventSeq: 1,
        sessionTurnId: "sess-1",
        summary: "Turn finished",
      })
    }), layer()))).id

    token = newToken()
    server = http.createServer(createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer()) as Effect.Effect<any, any, never>),
      token,
      onShutdown: () => {},
    }))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
    db.close()
  })

  const req = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })

  it("requires auth for attention routes", async () => {
    expect((await fetch(`${base}/attention`)).status).toBe(401)
  })

  it("lists attention items with workspace/kind/state filters", async () => {
    const all = await req("/attention")
    expect(all.status).toBe(200)
    expect((await all.json()).map((item: { id: string }) => item.id)).toEqual([itemId])

    const filtered = await req("/attention?workspace=w1&kind=turn-finished&state=open")
    expect(filtered.status).toBe(200)
    expect((await filtered.json())).toHaveLength(1)

    const empty = await req("/attention?workspace=w2")
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual([])

    const badKind = await req("/attention?kind=unknown")
    expect(badKind.status).toBe(400)
  })

  it("gets one attention item", async () => {
    const response = await req(`/attention/${itemId}`)
    expect(response.status).toBe(200)
    const item = decodeAttentionItem(await response.json())
    expect(item.id).toBe(itemId)
    expect(item.state).toBe("open")
  })

  it("acknowledges idempotently and writes attention.acknowledged once", async () => {
    const first = await req(`/attention/${itemId}/ack`, { method: "POST", body: "{}" })
    expect(first.status).toBe(200)
    expect(decodeAttentionItem(await first.json()).state).toBe("acknowledged")

    const events = db.prepare("SELECT type FROM events ORDER BY seq").all() as Array<{ type: string }>
    expect(events.filter((event) => event.type === "attention.acknowledged")).toHaveLength(1)

    const second = await req(`/attention/${itemId}/ack`, { method: "POST", body: "{}" })
    expect(second.status).toBe(200)
    const eventsAfter = db.prepare("SELECT type FROM events ORDER BY seq").all() as Array<{ type: string }>
    expect(eventsAfter.filter((event) => event.type === "attention.acknowledged")).toHaveLength(1)
  })

  it("rejects stale expectedEpisode on ack", async () => {
    const response = await req(`/attention/${itemId}/ack`, {
      method: "POST",
      body: JSON.stringify({ expectedEpisode: "wrong" }),
    })
    expect(response.status).toBe(409)
  })
})
