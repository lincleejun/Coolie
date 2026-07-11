import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { execSync } from "node:child_process"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { createApp, newToken } from "../src/http/app.js"

let server: http.Server, base: string, token: string, shutdownCalled = false

beforeEach(async () => {
  const db = new Database(":memory:"); runMigrations(db)
  const layer = ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer)),
    token,
    onShutdown: () => { shutdownCalled = true },
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})
afterEach(() => server.close())

const req = (p: string, init: RequestInit = {}) =>
  fetch(base + p, { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })

describe("http app", () => {
  it("health needs no token", async () => {
    const r = await fetch(base + "/health")
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })
  it("rejects missing token elsewhere", async () => {
    const r = await fetch(base + "/projects")
    expect(r.status).toBe(401)
  })
  it("projects CRUD happy path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-http-"))
    execSync("git init -b main", { cwd: dir })
    const created = await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot: dir }) })
    expect(created.status).toBe(201)
    const p = await created.json()
    const list = await (await req("/projects")).json()
    expect(list.map((x: any) => x.id)).toContain(p.id)
    expect((await req(`/projects/${p.id}`, { method: "DELETE" })).status).toBe(204)
    expect((await req(`/projects/${p.id}`, { method: "DELETE" })).status).toBe(404)
  })
  it("bad repoRoot -> 400", async () => {
    const r = await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot: "/nonexistent-xyz" }) })
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe("Validation")
  })
  it("shutdown calls hook", async () => {
    expect((await req("/shutdown", { method: "POST" })).status).toBe(202)
    expect(shutdownCalled).toBe(true)
  })
})
