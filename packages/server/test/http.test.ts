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
  it("duplicate POST /projects with same repoRoot -> 409 Conflict", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-http-"))
    execSync("git init -b main", { cwd: dir })
    const first = await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot: dir }) })
    expect(first.status).toBe(201)
    const dup = await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot: dir }) })
    expect(dup.status).toBe(409)
    expect((await dup.json()).code).toBe("Conflict")
  })
  it("unknown route -> 404 NotFound", async () => {
    const r = await req("/nope")
    expect(r.status).toBe(404)
    expect((await r.json()).code).toBe("NotFound")
  })
  it("wrong non-empty token -> 401", async () => {
    const r = await fetch(base + "/projects", { headers: { Authorization: `Bearer ${"f".repeat(token.length)}` } })
    expect(r.status).toBe(401)
  })
  it("malformed JSON body to POST /projects -> 400 Validation", async () => {
    const r = await req("/projects", { method: "POST", body: "{not json" })
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe("Validation")
  })
  it("onShutdown that throws: response is still 202 and the server survives", async () => {
    const db = new Database(":memory:"); runMigrations(db)
    const layer = ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
    const tok = newToken()
    const app = createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer)),
      token: tok,
      onShutdown: () => { throw new Error("shutdown hook boom") },
    })
    const s = http.createServer(app)
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
    const addr = s.address() as { port: number }
    const b = `http://127.0.0.1:${addr.port}`
    try {
      const r = await fetch(b + "/shutdown", { method: "POST", headers: { Authorization: `Bearer ${tok}` } })
      expect(r.status).toBe(202)
      // give the (thrown, swallowed) onShutdown rejection a tick to misbehave if it's going to
      await new Promise((resolve) => setTimeout(resolve, 10))
      const health = await fetch(b + "/health")
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true })
    } finally {
      s.close()
    }
  })
  it("unexpected internal defect -> 500 Internal (not misclassified as Validation)", async () => {
    const boomRuntime = (() => { throw new Error("internal defect: runtime broke its no-reject contract") }) as unknown as
      Parameters<typeof createApp>[0]["runtime"]
    const app = createApp({ runtime: boomRuntime, token, onShutdown: () => {} })
    const s = http.createServer(app)
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
    const addr = s.address() as { port: number }
    const b = `http://127.0.0.1:${addr.port}`
    try {
      const r = await fetch(b + "/projects", { headers: { Authorization: `Bearer ${token}` } })
      expect(r.status).toBe(500)
      expect((await r.json()).code).toBe("Internal")
    } finally {
      s.close()
    }
  })
})
