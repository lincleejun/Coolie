import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { execSync } from "node:child_process"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { createApp, newToken } from "../src/http/app.js"

const layer = () => {
  const db = new Database(":memory:"); runMigrations(db)
  return EventsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
}
const run = <A, E>(eff: Effect.Effect<A, E, EventsRepo>) =>
  Effect.runPromise(Effect.provide(eff, layer()) as Effect.Effect<A, E, never>)

describe("EventsRepo", () => {
  it("appends and reads back after a cursor", async () => {
    const out = await run(Effect.gen(function* () {
      const ev = yield* EventsRepo
      const s1 = yield* ev.append({ workspaceId: null, type: "project.added", payload: { id: "p1" } })
      const s2 = yield* ev.append({ workspaceId: "w1", type: "workspace.created", payload: {} })
      expect(s2).toBeGreaterThan(s1)
      const all = yield* ev.listAfter({ after: 0 })
      const tail = yield* ev.listAfter({ after: s1 })
      const scoped = yield* ev.listAfter({ after: 0, workspaceId: "w1" })
      return { all, tail, scoped }
    }))
    expect(out.all).toHaveLength(2)
    expect(out.all[0]!.payload).toEqual({ id: "p1" })
    expect(out.tail).toHaveLength(1)
    expect(out.tail[0]!.type).toBe("workspace.created")
    expect(out.scoped).toHaveLength(1)
  })
})

describe("http app events integration", () => {
  let server: http.Server, base: string, token: string

  beforeEach(async () => {
    const db = new Database(":memory:"); runMigrations(db)
    const l = Layer.mergeAll(ProjectsRepoLive, EventsRepoLive).pipe(Layer.provide(Layer.succeed(Db, db)))
    token = newToken()
    const app = createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, l) as Effect.Effect<any, any, never>),
      token,
      onShutdown: () => {},
    })
    server = http.createServer(app)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const addr = server.address() as { port: number }
    base = `http://127.0.0.1:${addr.port}`
  })
  afterEach(() => server.close())

  const req = (p: string, init: RequestInit = {}) =>
    fetch(base + p, { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })

  it("POST /projects emits project.added readable via GET /events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ev-"))
    execSync("git init -b main", { cwd: dir })
    await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot: dir }) })
    const events = await (await req("/events?after=0")).json()
    expect(events.map((e: any) => e.type)).toContain("project.added")
  })

  it("DELETE /projects/:id emits project.removed readable via GET /events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ev-"))
    execSync("git init -b main", { cwd: dir })
    const created = await (await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot: dir }) })).json()
    await req(`/projects/${created.id}`, { method: "DELETE" })
    const events = await (await req("/events?after=0")).json()
    expect(events.map((e: any) => e.type)).toContain("project.removed")
  })

  it("GET /events requires a token", async () => {
    const r = await fetch(base + "/events?after=0")
    expect(r.status).toBe(401)
  })
})
