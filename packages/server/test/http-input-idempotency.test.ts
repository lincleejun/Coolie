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
import { InputReceiptsRepoLive, getStoredInputReceipt } from "../src/repo/input-receipts.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { createApp, newToken } from "../src/http/app.js"
import { createWorkspaceSerial } from "../src/engine/queue-drain.js"

let server: http.Server, base: string, token: string, db: Database.Database

const fakeOps = {
  calls: [] as any[],
  input: async (target: string, o: any) => { fakeOps.calls.push(["input", target, o]) },
  newShellWindow: async (session: string) => { fakeOps.calls.push(["newWindow", session]); return 3 },
  killWindow: async (session: string, idx: number) => { fakeOps.calls.push(["killWindow", session, idx]) },
}

const insertWorkspace = (status: string): string => {
  const id = "ws-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at)
    VALUES (?, 'x', ?, 'main', 1)`).run("p-" + id, "/tmp/repo-" + id)
  db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
    VALUES (?, ?, ?, ?, 'coolie/a', 'main', 'r', ?, 0, 1, NULL, '{}')`).run(id, "p-" + id, "n-" + id, "/tmp/wt-" + id, status)
  return id
}

const insertEngineTab = (wsId: string, engineId: string, status: string, tmuxWindow: number): string => {
  const tabId = "tab-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`INSERT INTO tabs (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
    VALUES (?, ?, 'engine', ?, NULL, ?, NULL, ?, '{}')`).run(tabId, wsId, engineId, tmuxWindow, status)
  return tabId
}

beforeEach(async () => {
  fakeOps.calls = []
  db = new Database(":memory:")
  runMigrations(db)
  const layer = Layer.mergeAll(
    WorkspacesRepoLive, TabsRepoLive, EventsRepoLive, QueueRepoLive, InputReceiptsRepoLive, EngineRegistryLive,
  ).pipe(Layer.provide(Layer.succeed(Db, db)))
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

const post = async (p: string, body: unknown, idempotencyKey?: string) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  }
  const r = await fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : undefined }
}

describe("POST /workspaces/:id/input idempotency", () => {
  it("replays confirmed delivery without a second tmux input", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "claude", "awaiting-input", 0)
    const key = "deliver-key"
    const payload = { text: "hello", mode: "send" }
    const first = await post(`/workspaces/${id}/input`, payload, key)
    expect(first).toMatchObject({ status: 200, body: { ok: true } })
    expect(fakeOps.calls).toHaveLength(1)

    const second = await post(`/workspaces/${id}/input`, payload, key)
    expect(second).toMatchObject({ status: 200, body: { ok: true } })
    expect(fakeOps.calls).toHaveLength(1)
    expect(getStoredInputReceipt(db, id, key)).not.toBeNull()
  })

  it("replays durable enqueue without creating a second queue item", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "codex", "working", 0)
    const key = "queue-key"
    const payload = { text: "queued text", mode: "send" }
    const first = await post(`/workspaces/${id}/input`, payload, key)
    expect(first).toMatchObject({ status: 202, body: { queued: true, position: 1 } })
    expect(fakeOps.calls).toHaveLength(0)

    const second = await post(`/workspaces/${id}/input`, payload, key)
    expect(second.status).toBe(202)
    expect(second.body).toEqual(first.body)
    expect(db.prepare("SELECT COUNT(*) AS n FROM prompt_queue WHERE workspace_id = ?").get(id)).toEqual({ n: 1 })
  })

  it("returns 409 when the same key is reused with a different body", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "claude", "awaiting-input", 0)
    const key = "conflict-key"
    expect((await post(`/workspaces/${id}/input`, { text: "one", mode: "send" }, key)).status).toBe(200)
    const conflict = await post(`/workspaces/${id}/input`, { text: "two", mode: "send" }, key)
    expect(conflict.status).toBe(409)
    expect(conflict.body.code).toBe("Conflict")
    expect(fakeOps.calls).toHaveLength(1)
  })

  it("accepts idempotencyKey in the JSON body", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "claude", "awaiting-input", 0)
    const payload = { text: "body-key", mode: "send", idempotencyKey: "from-body" }
    const first = await post(`/workspaces/${id}/input`, payload)
    const second = await post(`/workspaces/${id}/input`, payload)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(fakeOps.calls).toHaveLength(1)
  })

  it("without idempotency key behaves as before", async () => {
    const id = insertWorkspace("active")
    insertEngineTab(id, "claude", "awaiting-input", 0)
    const payload = { text: "no-key", mode: "send" }
    expect((await post(`/workspaces/${id}/input`, payload)).status).toBe(200)
    expect((await post(`/workspaces/${id}/input`, payload)).status).toBe(200)
    expect(fakeOps.calls).toHaveLength(2)
    expect(getStoredInputReceipt(db, id, "missing")).toBeNull()
  })
})
