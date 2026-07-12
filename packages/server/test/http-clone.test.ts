import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { createApp, newToken, deriveRepoName } from "../src/http/app.js"

let server: http.Server, base: string, token: string
let reposRoot: string
let cloneCalls: Array<{ url: string; dest: string }>
let cloneImpl: (url: string, dest: string) => Promise<void>

beforeEach(async () => {
  const db = new Database(":memory:"); runMigrations(db)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clone-home-"))
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clone-repos-"))
  cloneCalls = []
  // fake clone：造一个带 .git 的目录（ProjectsRepo.add 要求 .git 存在）
  cloneImpl = async (url, dest) => {
    cloneCalls.push({ url, dest })
    fs.mkdirSync(path.join(dest, ".git"), { recursive: true })
  }
  const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: path.join(home, "ws") }
  const layer = Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive).pipe(
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(Layer.succeed(CoolieConfig, cfg as any)),
  )
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
    config: { tmuxSocket: "coolie-test", reposRoot },
    cloneRepo: (url, dest) => cloneImpl(url, dest),
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => server.close())

const req = (p: string, init: RequestInit = {}) =>
  fetch(base + p, { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })

describe("deriveRepoName", () => {
  it("strips .git and trailing slash, takes basename", () => {
    expect(deriveRepoName("https://github.com/acme/widget.git")).toBe("widget")
    expect(deriveRepoName("https://github.com/acme/widget/")).toBe("widget")
    expect(deriveRepoName("git@github.com:acme/widget.git")).toBe("widget")
    expect(deriveRepoName("https://example.com/a/b/deep-repo")).toBe("deep-repo")
  })
  it("rejects empty / dotted names", () => {
    expect(deriveRepoName("")).toBeNull()
    expect(deriveRepoName("///")).toBeNull()
    expect(deriveRepoName(".git")).toBeNull()
  })
})

describe("POST /projects/clone", () => {
  it("clones into reposRoot/<name>, registers project -> 201", async () => {
    const r = await req("/projects/clone", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/widget.git" }) })
    expect(r.status).toBe(201)
    const p = await r.json()
    expect(p.name).toBe("widget")
    expect(p.repoRoot).toBe(path.join(reposRoot, "widget"))
    expect(cloneCalls).toEqual([{ url: "https://github.com/acme/widget.git", dest: path.join(reposRoot, "widget") }])
    const list = await (await req("/projects")).json()
    expect(list).toHaveLength(1)
  })
  it("honors explicit absolute dest", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clone-dest-")) + "/repo"
    const r = await req("/projects/clone", { method: "POST", body: JSON.stringify({ url: "https://x/y.git", dest }) })
    expect(r.status).toBe(201)
    expect((await r.json()).repoRoot).toBe(dest)
  })
  it("rejects missing url -> 400", async () => {
    expect((await req("/projects/clone", { method: "POST", body: JSON.stringify({}) })).status).toBe(400)
  })
  it("rejects url starting with - (arg injection) -> 400", async () => {
    const r = await req("/projects/clone", { method: "POST", body: JSON.stringify({ url: "--upload-pack=evil" }) })
    expect(r.status).toBe(400)
    expect(cloneCalls).toHaveLength(0)
  })
  it("rejects relative dest -> 400", async () => {
    const r = await req("/projects/clone", { method: "POST", body: JSON.stringify({ url: "https://x/y.git", dest: "rel/path" }) })
    expect(r.status).toBe(400)
  })
  it("409 when target dir already exists", async () => {
    fs.mkdirSync(path.join(reposRoot, "widget"), { recursive: true })
    const r = await req("/projects/clone", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/widget.git" }) })
    expect(r.status).toBe(409)
  })
  it("maps clone failure -> 500 GitError", async () => {
    cloneImpl = async () => { throw new Error("fatal: repository not found") }
    const r = await req("/projects/clone", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/nope.git" }) })
    expect(r.status).toBe(500)
    expect((await r.json()).code).toBe("GitError")
  })
})
