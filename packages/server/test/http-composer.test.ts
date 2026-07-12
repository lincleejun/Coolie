import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { TabsRepoLive } from "../src/repo/tabs.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { createApp, newToken } from "../src/http/app.js"

let server: http.Server, base: string, token: string, db: Database.Database

const fakeOps = {
  calls: [] as any[],
  input: async (target: string, o: any) => { fakeOps.calls.push(["input", target, o]) },
  newShellWindow: async (session: string) => { fakeOps.calls.push(["newWindow", session]); return 3 },
  killWindow: async (session: string, idx: number) => { fakeOps.calls.push(["killWindow", session, idx]) },
}

// 直接插一行 workspace（照 http-gitread.test.ts 姿势）
const insertWorkspace = (status: string): string => {
  const id = "ws-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at)
    VALUES (?, 'x', ?, 'main', 1)`).run("p-" + id, "/tmp/repo-" + id)
  db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
    VALUES (?, ?, ?, ?, 'coolie/a', 'main', 'r', ?, 0, 1, NULL, '{}')`).run(id, "p-" + id, "n-" + id, "/tmp/wt-" + id, status)
  return id
}
const insertTab = (wsId: string, kind: string, tmuxWindow: number | null): string => {
  const tabId = "tab-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`INSERT INTO tabs (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
    VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'idle', '{}')`).run(tabId, wsId, kind, tmuxWindow)
  return tabId
}
const createActiveWorkspaceWithEngineTab = ({ tmuxWindow }: { tmuxWindow: number }) => {
  const id = insertWorkspace("active")
  insertTab(id, "engine", tmuxWindow)
  return { id }
}
// F6：seed 一个 engine tab 带 engineId + status（send-while-busy 守卫用）
const insertEngineTab = (wsId: string, engineId: string, status: string, tmuxWindow: number): string => {
  const tabId = "tab-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`INSERT INTO tabs (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
    VALUES (?, ?, 'engine', ?, NULL, ?, NULL, ?, '{}')`).run(tabId, wsId, engineId, tmuxWindow, status)
  return tabId
}

beforeEach(async () => {
  fakeOps.calls = []
  db = new Database(":memory:"); runMigrations(db)
  const layer = Layer.mergeAll(WorkspacesRepoLive, TabsRepoLive, EventsRepoLive, EngineRegistryLive)
    .pipe(Layer.provide(Layer.succeed(Db, db)))
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
    composerOps: fakeOps,
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => server.close())

const req = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : undefined }
}
const post = (p: string, body?: unknown) => req("POST", p, body)
const del = (p: string) => req("DELETE", p)

describe("POST /workspaces/:id/input", () => {
  it("send：目标是 engine tab 的 session:window，透传 skipStable", async () => {
    const ws = createActiveWorkspaceWithEngineTab({ tmuxWindow: 0 })
    const r = await post(`/workspaces/${ws.id}/input`, { text: "hi", mode: "send", skipStable: true })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(fakeOps.calls.at(-1)).toEqual(["input", `coolie-${ws.id}:0`, { text: "hi", mode: "send", skipStable: true }])
  })
  it("空 text + mode=send → 400；mode=interrupt 空 text OK", async () => {
    const ws = createActiveWorkspaceWithEngineTab({ tmuxWindow: 0 })
    expect((await post(`/workspaces/${ws.id}/input`, { text: "   ", mode: "send" })).status).toBe(400)
    const r = await post(`/workspaces/${ws.id}/input`, { text: "", mode: "interrupt" })
    expect(r.status).toBe(200)
    expect(fakeOps.calls.at(-1)).toEqual(["input", `coolie-${ws.id}:0`, { text: "", mode: "interrupt", skipStable: false }])
  })
  it("非法 mode → 400；text 非 string → 400", async () => {
    const ws = createActiveWorkspaceWithEngineTab({ tmuxWindow: 0 })
    expect((await post(`/workspaces/${ws.id}/input`, { text: "hi", mode: "nope" })).status).toBe(400)
    expect((await post(`/workspaces/${ws.id}/input`, { text: 5, mode: "send" })).status).toBe(400)
  })
  it("投递后 events 含 composer.delivered（payload mode/tabId/chars）", async () => {
    const ws = createActiveWorkspaceWithEngineTab({ tmuxWindow: 0 })
    await post(`/workspaces/${ws.id}/input`, { text: "hello", mode: "send" })
    const evs = await req("GET", `/events?workspace=${ws.id}`)
    const delivered = evs.body.find((e: any) => e.type === "composer.delivered")
    expect(delivered).toBeDefined()
    expect(delivered.payload).toMatchObject({ mode: "send", chars: 5 })
  })
  it("非 active → 409", async () => {
    const id = insertWorkspace("archived")
    insertTab(id, "engine", 0)
    expect((await post(`/workspaces/${id}/input`, { text: "hi", mode: "send" })).status).toBe(409)
  })
  it("无 engine tab → 404", async () => {
    const id = insertWorkspace("active")
    expect((await post(`/workspaces/${id}/input`, { text: "hi", mode: "send" })).status).toBe(404)
  })
})

describe("F6：send-while-busy 守卫（非 nativeQueue 引擎）", () => {
  it("codex（nativeQueue=false）忙时 mode:send → 409 EngineBusy", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "codex", "working", 0)
    const r = await post(`/workspaces/${id}/input`, { text: "hi", mode: "send" })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe("EngineBusy") // 机器可读错误码
  })
  it("claude（nativeQueue=true）忙时 send → 不 409（原生 mid-turn 队列放行）", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "claude", "working", 0)
    const r = await post(`/workspaces/${id}/input`, { text: "hi", mode: "send" })
    expect(r.status).not.toBe(409)
  })
  it("codex 忙时 interrupt 仍放行（守卫只挡 send）", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "codex", "working", 0)
    const r = await post(`/workspaces/${id}/input`, { text: "", mode: "interrupt" })
    expect(r.status).not.toBe(409)
  })
})

describe("shell tabs", () => {
  it("POST {kind:shell} → 201 Tab（tmuxWindow=3 来自 ops）+ tabs 行落库", async () => {
    const id = insertWorkspace("active")
    const r = await post(`/workspaces/${id}/tabs`, { kind: "shell" })
    expect(r.status).toBe(201)
    expect(r.body.kind).toBe("shell")
    expect(r.body.tmuxWindow).toBe(3)
    expect(fakeOps.calls.at(-1)).toEqual(["newWindow", `coolie-${id}`])
    const row = db.prepare("SELECT * FROM tabs WHERE id = ?").get(r.body.id) as any
    expect(row.kind).toBe("shell")
    expect(row.tmux_window).toBe(3)
  })
  it("POST {kind:engine} → 400", async () => {
    const id = insertWorkspace("active")
    expect((await post(`/workspaces/${id}/tabs`, { kind: "engine" })).status).toBe(400)
  })
  it("非 active → 409", async () => {
    const id = insertWorkspace("archived")
    expect((await post(`/workspaces/${id}/tabs`, { kind: "shell" })).status).toBe(409)
  })
  it("DELETE shell tab → 204 + killWindow 被调 + 行已删；DELETE engine tab → 409", async () => {
    const id = insertWorkspace("active")
    const shellTab = insertTab(id, "shell", 3)
    const r = await del(`/workspaces/${id}/tabs/${shellTab}`)
    expect(r.status).toBe(204)
    expect(fakeOps.calls.at(-1)).toEqual(["killWindow", `coolie-${id}`, 3])
    expect(db.prepare("SELECT * FROM tabs WHERE id = ?").get(shellTab)).toBeUndefined()
    const engineTab = insertTab(id, "engine", 0)
    expect((await del(`/workspaces/${id}/tabs/${engineTab}`)).status).toBe(409)
  })
})
