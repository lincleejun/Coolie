import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { TabsRepoLive } from "../src/repo/tabs.js"
import { QueueRepoLive } from "../src/repo/queue.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { createApp, newToken } from "../src/http/app.js"
import { createWorkspaceSerial } from "../src/engine/queue-drain.js"

let server: http.Server, base: string, token: string, db: Database.Database
let inputGate: Promise<void> | null

const fakeOps = {
  calls: [] as any[],
  input: async (target: string, o: any) => { fakeOps.calls.push(["input", target, o]); await inputGate },
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
  inputGate = null
  db = new Database(":memory:"); runMigrations(db)
  const layer = Layer.mergeAll(WorkspacesRepoLive, TabsRepoLive, EventsRepoLive, QueueRepoLive, EngineRegistryLive)
    .pipe(Layer.provide(Layer.succeed(Db, db)))
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
    composerOps: fakeOps,
    workspaceSerial: createWorkspaceSerial(),
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

describe("server prompt queue（非 nativeQueue 引擎）", () => {
  it("codex 忙时 send → 202 入队；队列非空时 idle send 继续排队", async () => {
    const id = insertWorkspace("active")
    const tabId = insertEngineTab(id, "codex", "working", 0)
    const first = await post(`/workspaces/${id}/input`, { text: "一", mode: "send" })
    expect(first).toMatchObject({ status: 202, body: { queued: true, position: 1 } })
    expect(first.body).toMatchObject({
      id: first.body.queueId,
      messageId: `queue:${first.body.queueId}`,
      deliveryGuarantee: "at-least-once",
    })
    db.prepare("UPDATE tabs SET status = 'awaiting-input' WHERE id = ?").run(tabId)
    const second = await post(`/workspaces/${id}/input`, { text: "二", mode: "send" })
    expect(second).toMatchObject({ status: 202, body: { queued: true, position: 2 } })
    expect(fakeOps.calls).toHaveLength(0)
  })
  it("claude（nativeQueue=true）忙时 send → 直投", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "claude", "working", 0)
    const r = await post(`/workspaces/${id}/input`, { text: "hi", mode: "send" })
    expect(r.status).toBe(200)
  })
  it("codex 忙时 interrupt 仍放行（守卫只挡 send）", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "codex", "working", 0)
    const r = await post(`/workspaces/${id}/input`, { text: "", mode: "interrupt" })
    expect(r.status).toBe(200)
  })
  it("codex working 时裸 interrupt 乐观收敛为 awaiting-input，source=interrupt", async () => {
    const id = insertWorkspace("active")
    const tabId = insertEngineTab(id, "codex", "working", 0)
    expect((await post(`/workspaces/${id}/input`, { text: "", mode: "interrupt" })).status).toBe(200)
    const tab = db.prepare("SELECT status, data FROM tabs WHERE id = ?").get(tabId) as any
    expect(tab.status).toBe("awaiting-input")
    expect(JSON.parse(tab.data).lastHookAt).toEqual(expect.any(Number))
    const events = await req("GET", `/events?workspace=${id}`)
    expect(events.body.filter((e: any) => e.type === "tab.status.changed").at(-1)?.payload)
      .toMatchObject({ tabId, status: "awaiting-input", source: "interrupt" })
  })
  it("codex working 时 interrupt-send 保持 working", async () => {
    const id = insertWorkspace("active")
    const tabId = insertEngineTab(id, "codex", "working", 0)
    expect((await post(`/workspaces/${id}/input`, { text: "继续", mode: "interrupt-send" })).status).toBe(200)
    expect((db.prepare("SELECT status FROM tabs WHERE id = ?").get(tabId) as any).status).toBe("working")
  })

  it("serializes concurrent sends per workspace and queues the second behind the first", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "codex", "awaiting-input", 0)
    let open!: () => void
    inputGate = new Promise<void>((resolve) => { open = resolve })
    const first = post(`/workspaces/${id}/input`, { text: "一", mode: "send" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = post(`/workspaces/${id}/input`, { text: "二", mode: "send" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fakeOps.calls).toHaveLength(1)
    open()
    expect((await first).status).toBe(200)
    expect(await second).toMatchObject({ status: 202, body: { queued: true, position: 1 } })
    expect(fakeOps.calls).toHaveLength(1)
  })
  it("claude working 时 interrupt 不伪造收敛，留给 hooks", async () => {
    const id = insertWorkspace("active")
    const tabId = insertEngineTab(id, "claude", "working", 0)
    expect((await post(`/workspaces/${id}/input`, { text: "", mode: "interrupt" })).status).toBe(200)
    expect((db.prepare("SELECT status FROM tabs WHERE id = ?").get(tabId) as any).status).toBe("working")
  })

  it("GET lists FIFO positions; DELETE withdraws only matching workspace prompt", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "codex", "working", 0)
    const first = await post(`/workspaces/${id}/input`, { text: "一", mode: "send" })
    await post(`/workspaces/${id}/input`, { text: "二", mode: "send" })
    const listed = await req("GET", `/workspaces/${id}/queue`)
    expect(listed.body.deliveryGuarantee).toBe("at-least-once")
    expect(listed.body.queue.map((q: any) => [q.position, q.text])).toEqual([[1, "一"], [2, "二"]])
    expect(listed.body.queue[0]).toMatchObject({
      id: first.body.id,
      queueId: first.body.queueId,
      messageId: first.body.messageId,
      deliveryGuarantee: "at-least-once",
    })
    expect((await del(`/workspaces/${id}/queue/${first.body.id}`)).status).toBe(200)
    expect((await del(`/workspaces/${id}/queue/${first.body.id}`)).status).toBe(404)
    expect((await del(`/workspaces/${id}/queue/nope`)).status).toBe(400)
  })

  it("DELETE returns conflict once a prompt is inflight", async () => {
    const id = insertWorkspace("active")
    const tabId = insertEngineTab(id, "codex", "working", 0)
    const queued = await post(`/workspaces/${id}/input`, { text: "一", mode: "send" })
    db.prepare("UPDATE prompt_queue SET state = 'inflight' WHERE id = ?").run(queued.body.id)
    db.prepare("UPDATE tabs SET status = 'awaiting-input' WHERE id = ?").run(tabId)
    expect((await del(`/workspaces/${id}/queue/${queued.body.id}`)).status).toBe(409)
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
