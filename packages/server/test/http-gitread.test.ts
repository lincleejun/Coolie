import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { createApp, newToken } from "../src/http/app.js"

let server: http.Server, base: string, token: string, db: Database.Database
let claudeHome: string

const fakeGitRead = {
  calls: [] as string[][],
  diffstat: async (wt: string, baseRef: string) => {
    fakeGitRead.calls.push(["diffstat", wt, baseRef])
    return { filesChanged: 2, insertions: 10, deletions: 3 }
  },
  changes: async (wt: string, baseRef: string) => {
    fakeGitRead.calls.push(["changes", wt, baseRef])
    return { againstBase: [], committed: [], staged: [], unstaged: [], untracked: ["u.txt"] }
  },
  files: async () => ["a.ts", "b.ts"],
  diff: async (wt: string, baseRef: string, section: string, filePath: string) => {
    fakeGitRead.calls.push(["diff", wt, baseRef, section, filePath])
    return { path: filePath, section, unified: "@@ -1 +1 @@\n-one\n+ONE\n", binary: false }
  },
}

// 直接插一行 workspace（照 hooks-endpoint.test.ts 姿势）；返回 {id, path, baseRef}
const insertWorkspace = (status: string, wsPath: string, baseRef: string, kind = "task") => {
  const id = "ws-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at)
    VALUES (?, 'x', ?, 'main', 1)`).run("p-" + id, "/tmp/repo-" + id)
  db.prepare(`INSERT INTO workspaces
    (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at,
     archived_at, data, kind, materialized)
    VALUES (?, ?, ?, ?, ?, 'main', ?, ?, 0, 1, NULL, '{}', ?, 1)`)
    .run(id, "p-" + id, "n-" + id, wsPath, kind === "main" ? "main" : "coolie/a", baseRef, status, kind)
  return { id, path: wsPath, baseRef }
}

beforeEach(async () => {
  fakeGitRead.calls = []
  db = new Database(":memory:"); runMigrations(db)
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-gr-home-"))
  const layer = Layer.mergeAll(WorkspacesRepoLive, EngineRegistryLive)
    .pipe(Layer.provide(Layer.succeed(Db, db)))
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
    gitRead: fakeGitRead,
    config: { tmuxSocket: "coolie-test" },
    claudeHome,
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => server.close())

const rawFetch = (p: string, init: RequestInit = {}) => fetch(base + p, init)
const get = async (p: string) => {
  const r = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : undefined }
}

describe("GET /config", () => {
  it("返回 tmuxSocket 与 engines（含能力位与模型列表）", async () => {
    const r = await get("/config")
    expect(r.status).toBe(200)
    expect(r.body.tmuxSocket).toBe("coolie-test")
    const claude = r.body.engines.find((e: any) => e.id === "claude")
    expect(claude.capabilities.nativeQueue).toBe(true)
    expect(claude.models).toContain("opus")
    expect(r.body.namePools).toEqual([
      { id: "national-parks", displayName: "National Parks" },
      { id: "cities", displayName: "Cities" },
      { id: "animals", displayName: "Animals" },
      { id: "custom", displayName: "Custom" },
    ])
  })
})

describe("git read routes", () => {
  it("active workspace：diffstat 走 gitRead 并带 worktree 路径与 baseRef", async () => {
    const ws = insertWorkspace("active", "/tmp/wt-active", "BASEREF1")
    const r = await get(`/workspaces/${ws.id}/git/diffstat`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ filesChanged: 2, insertions: 10, deletions: 3 })
    expect(fakeGitRead.calls.at(-1)).toEqual(["diffstat", ws.path, ws.baseRef])
  })
  it("非 active → 409；未知 id → 404", async () => {
    const archived = insertWorkspace("archived", "/tmp/wt-arch", "R")
    expect((await get(`/workspaces/${archived.id}/git/diffstat`)).status).toBe(409)
    const r404 = await get("/workspaces/does-not-exist/git/diffstat")
    expect(r404.status).toBe(404)
  })
  it("changes/files 路由 200", async () => {
    const ws = insertWorkspace("active", "/tmp/wt-cf", "R")
    const c = await get(`/workspaces/${ws.id}/git/changes`)
    expect(c.status).toBe(200)
    expect(c.body.untracked).toEqual(["u.txt"])
    const f = await get(`/workspaces/${ws.id}/files`)
    expect(f.status).toBe(200)
    expect(f.body).toEqual({ files: ["a.ts", "b.ts"] })
  })
  it("main task diffstat and changes always inspect against HEAD", async () => {
    const ws = insertWorkspace("active", "/tmp/repo-main", "", "main")
    expect((await get(`/workspaces/${ws.id}/git/diffstat`)).status).toBe(200)
    expect(fakeGitRead.calls.at(-1)).toEqual(["diffstat", ws.path, "HEAD"])
    expect((await get(`/workspaces/${ws.id}/git/changes`)).status).toBe(200)
    expect(fakeGitRead.calls.at(-1)).toEqual(["changes", ws.path, "HEAD"])
  })
  it("single-file diff validates parameters before workspace lookup and delegates section/path", async () => {
    const ws = insertWorkspace("active", "/tmp/wt-diff", "BASE")
    const ok = await get(`/workspaces/${ws.id}/git/diff?section=unstaged&path=${encodeURIComponent("src/a.ts")}`)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ path: "src/a.ts", section: "unstaged", binary: false })
    expect(ok.body.unified).toContain("+ONE")
    expect(fakeGitRead.calls.at(-1)).toEqual(["diff", ws.path, ws.baseRef, "unstaged", "src/a.ts"])

    expect((await get(`/workspaces/${ws.id}/git/diff?section=unstaged`)).status).toBe(400)
    expect((await get(`/workspaces/${ws.id}/git/diff?section=bogus&path=a.txt`)).status).toBe(400)
    expect((await get(`/workspaces/${ws.id}/git/diff?section=unstaged&path=${encodeURIComponent("../../etc/passwd")}`)).status).toBe(400)
    expect((await get("/workspaces/does-not-exist/git/diff?section=bogus&path=a.txt")).status).toBe(400)
  })
  it("commands：扫描 repo .claude/commands + claudeHome/commands，source 正确", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-gr-wt-"))
    fs.mkdirSync(path.join(wt, ".claude", "commands"), { recursive: true })
    fs.writeFileSync(path.join(wt, ".claude", "commands", "review.md"), "x")
    fs.mkdirSync(path.join(claudeHome, "commands"), { recursive: true })
    fs.writeFileSync(path.join(claudeHome, "commands", "deploy.md"), "x")
    const ws = insertWorkspace("active", wt, "R")
    const r = await get(`/workspaces/${ws.id}/commands`)
    expect(r.status).toBe(200)
    expect(r.body.commands).toEqual([
      { name: "deploy", source: "user" },
      { name: "review", source: "repo" },
    ])
  })
})

describe("CORS", () => {
  it("OPTIONS 预检 → 204 + allow 头；GET 响应带 ACAO", async () => {
    const pre = await rawFetch("/projects", { method: "OPTIONS" })
    expect(pre.status).toBe(204)
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/authorization/i)
    const r = await rawFetch("/health", { method: "GET" })
    expect(r.headers.get("access-control-allow-origin")).toBe("*")
  })
})
