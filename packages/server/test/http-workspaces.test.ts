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
import { TabsRepoLive } from "../src/repo/tabs.js"
import { GitService } from "../src/git/service.js"
import { SetupRunner, SetupScriptError, type SetupRunnerShape } from "../src/workspace/setup.js"
import { WorkspaceLifecycleLive, PostCreateHooks } from "../src/workspace/lifecycle.js"
import { createApp, newToken } from "../src/http/app.js"
import { makeFakeGit } from "./helpers/fake-git.js"

let server: http.Server, base: string, token: string
let db: Database.Database
let fake: ReturnType<typeof makeFakeGit>
let setupFails = false
let repoRoot: string
let zenCalls: Array<{ workspaceId: string; zen: boolean; tabId: string | null | undefined }>
let seenCreateCtx: Array<{
  initialPrompt?: string; engineId?: string; model?: string; effort?: string; fanoutGroup?: string
}>
let hookGate: Promise<void> | null
let hookEntered: (() => void) | null

beforeEach(async () => {
  db = new Database(":memory:"); runMigrations(db)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hw-home-"))
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hw-ws-"))
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hw-repo-"))
  fs.mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true })
  const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: wsRoot }
  fake = makeFakeGit()
  setupFails = false
  seenCreateCtx = []
  zenCalls = []
  hookGate = null
  hookEntered = null
  const setup: SetupRunnerShape = {
    run: () => setupFails
      ? Effect.fail(new SetupScriptError({ script: "fake.sh", exitCode: 1, message: "setup 退出码 1", outputTail: "boom" }))
      : Effect.succeed([]),
  }
  const layer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(GitService, fake.git),
      Layer.succeed(SetupRunner, setup),
      Layer.succeed(PostCreateHooks, [
        (ws, ctx) => Effect.gen(function* () {
          seenCreateCtx.push({ ...ctx })
          if (hookGate !== null) {
            yield* Effect.sync(() => {
              db.prepare(`INSERT INTO tabs
                (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
                VALUES (?, ?, 'run', NULL, NULL, 1, 'race-runtime', 'idle', '{}')`)
                .run(`race-${ws.id}`, ws.id)
            })
          }
          hookEntered?.()
          if (hookGate !== null) yield* Effect.promise(() => hookGate!)
        }),
      ]),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
  )
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
    layoutOps: {
      reconcile: async () => ({ version: 1, zen: false, focusedTabId: null, restoreTabId: null, geometry: [] }),
      setZen: async (workspaceId, zen, tabId) => {
        zenCalls.push({ workspaceId, zen, tabId })
        return { version: 1, zen, focusedTabId: tabId ?? null, restoreTabId: null, geometry: [] }
      },
    },
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => server.close())

const req = (p: string, init: RequestInit = {}) =>
  fetch(base + p, { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })
const addProject = async (): Promise<string> => {
  const r = await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot }) })
  expect(r.status).toBe(201)
  return (await r.json()).id
}
const createWsIntent = async (projectId: string, extra: Record<string, unknown> = {}) =>
  req("/workspaces", { method: "POST", body: JSON.stringify({ projectId, ...extra }) })
const createWs = async (projectId: string, extra: Record<string, unknown> = {}) => {
  const created = await createWsIntent(projectId, extra)
  if (created.status !== 201) return created
  const intent = await created.json()
  const ensured = await req(`/workspaces/${intent.id}/ensure`, { method: "POST", body: "{}" })
  if (!ensured.ok) return ensured
  const rows = await (await req("/workspaces")).json()
  return new Response(JSON.stringify(rows.find((row: any) => row.id === intent.id)), {
    status: 201, headers: { "content-type": "application/json" },
  })
}

describe("workspace HTTP API", () => {
  it("toggles zen state through the layout operation", async () => {
    const projectId = await addProject()
    const created = await createWs(projectId, { name: "zen-task" })
    expect(created.status).toBe(201)
    const ws = await created.json()
    const response = await req(`/workspaces/${ws.id}/zen`, {
      method: "POST", body: JSON.stringify({ zen: true }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ zen: true })
    expect(zenCalls).toEqual([{ workspaceId: ws.id, zen: true, tabId: null }])
  })

  it("POST creates a lazy intent; ensure materializes it", async () => {
    const pid = await addProject()
    const created = await createWsIntent(pid, { branchSlug: "fix-x" })
    expect(created.status).toBe(201)
    const intent = await created.json()
    expect(intent.status).toBe("creating")
    expect(intent.materialized).toBe(false)
    expect(intent.taskStatus).toBe("backlog")
    expect(fake.state.worktrees.has(intent.path)).toBe(false)
    expect((await req(`/workspaces/${intent.id}/ensure`, { method: "POST", body: "{}" })).status).toBe(200)
    const list = await (await req("/workspaces")).json()
    const ws = list.find((workspace: any) => workspace.id === intent.id)
    expect(ws.status).toBe("active")
    expect(ws.materialized).toBe(true)
    expect(ws.branch).toBe("coolie/fix-x")
    const filtered = await (await req(`/workspaces?project=${pid}`)).json()
    expect(filtered.map((workspace: any) => workspace.kind).sort()).toEqual(["main", "task"])
    const empty = await (await req("/workspaces?project=nope")).json()
    expect(empty).toHaveLength(0)
  })
  it("serializes parallel ensure so the loser cannot roll back the materialized winner", async () => {
    const pid = await addProject()
    const created = await createWsIntent(pid, { branchSlug: "parallel-ensure" })
    const intent = await created.json()
    let releaseHook!: () => void
    hookGate = new Promise<void>((resolve) => { releaseHook = resolve })
    const entered = new Promise<void>((resolve) => { hookEntered = resolve })

    const first = req(`/workspaces/${intent.id}/ensure`, { method: "POST", body: "{}" })
    await entered
    const second = req(`/workspaces/${intent.id}/ensure`, { method: "POST", body: "{}" })
    releaseHook()
    const responses = await Promise.all([first, second])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(fake.state.calls.filter((call) => call[0] === "worktreeAdd")).toHaveLength(1)
    expect(fake.state.calls.some((call) => call[0] === "worktreeRemove")).toBe(false)
    const workspace = (await (await req("/workspaces")).json()).find((row: any) => row.id === intent.id)
    expect(workspace).toMatchObject({ status: "active", materialized: true })
  })
  it("serializes ensure before archive and leaves only the archived row", async () => {
    const pid = await addProject()
    const intent = await (await createWsIntent(pid, { branchSlug: "ensure-archive-race" })).json()
    let releaseHook!: () => void
    hookGate = new Promise<void>((resolve) => { releaseHook = resolve })
    const entered = new Promise<void>((resolve) => { hookEntered = resolve })

    const ensuring = req(`/workspaces/${intent.id}/ensure`, { method: "POST", body: "{}" })
    await entered
    const archiving = req(`/workspaces/${intent.id}/archive`, { method: "POST", body: "{}" })
    releaseHook()
    const [ensureResponse, archiveResponse] = await Promise.all([ensuring, archiving])

    expect(ensureResponse.status).toBe(200)
    expect(archiveResponse.status).toBe(200)
    expect(await archiveResponse.json()).toMatchObject({ status: "archived", materialized: true })
    expect(fake.state.worktrees.has(intent.path)).toBe(false)
    expect(db.prepare("SELECT status FROM workspaces WHERE id = ?").get(intent.id)).toEqual({ status: "archived" })
    expect(db.prepare("SELECT COUNT(*) AS count FROM tabs WHERE workspace_id = ?").get(intent.id)).toEqual({ count: 0 })
  })
  it("serializes ensure before delete and removes all workspace-owned state", async () => {
    const pid = await addProject()
    const intent = await (await createWsIntent(pid, { branchSlug: "ensure-delete-race" })).json()
    let releaseHook!: () => void
    hookGate = new Promise<void>((resolve) => { releaseHook = resolve })
    const entered = new Promise<void>((resolve) => { hookEntered = resolve })

    const ensuring = req(`/workspaces/${intent.id}/ensure`, { method: "POST", body: "{}" })
    await entered
    const deleting = req(`/workspaces/${intent.id}?force=1`, { method: "DELETE" })
    releaseHook()
    const [ensureResponse, deleteResponse] = await Promise.all([ensuring, deleting])

    expect(ensureResponse.status).toBe(200)
    expect(deleteResponse.status).toBe(204)
    expect(fake.state.worktrees.has(intent.path)).toBe(false)
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = ?").get(intent.id)).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM tabs WHERE workspace_id = ?").get(intent.id)).toEqual({ count: 0 })
  })
  it("orders archive/delete before a later ensure by persisted lifecycle state", async () => {
    const pid = await addProject()
    const archived = await (await createWs(pid, { branchSlug: "archive-then-ensure" })).json()
    expect((await req(`/workspaces/${archived.id}/archive`, { method: "POST", body: "{}" })).status).toBe(200)
    expect((await req(`/workspaces/${archived.id}/ensure`, { method: "POST", body: "{}" })).status).toBe(409)
    expect(fake.state.worktrees.has(archived.path)).toBe(false)
    expect(db.prepare("SELECT status FROM workspaces WHERE id = ?").get(archived.id)).toEqual({ status: "archived" })

    const deleted = await (await createWs(pid, { branchSlug: "delete-then-ensure" })).json()
    expect((await req(`/workspaces/${deleted.id}?force=1`, { method: "DELETE" })).status).toBe(204)
    expect((await req(`/workspaces/${deleted.id}/ensure`, { method: "POST", body: "{}" })).status).toBe(404)
    expect(fake.state.worktrees.has(deleted.path)).toBe(false)
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = ?").get(deleted.id)).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM tabs WHERE workspace_id IN (?, ?)").get(archived.id, deleted.id))
      .toEqual({ count: 0 })
  })
  it("validation: missing projectId -> 400; unknown project -> 404", async () => {
    const bad = await req("/workspaces", { method: "POST", body: JSON.stringify({}) })
    expect(bad.status).toBe(400)
    const missing = await createWsIntent("nope")
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe("NotFound")
  })
  it("creates from a selected built-in or sanitized custom name pool", async () => {
    const pid = await addProject()
    const city = await createWs(pid, { namePool: "cities" })
    expect(city.status).toBe(201)
    expect((await city.json()).name).toMatch(/^[a-z0-9-]+$/)

    const custom = await createWs(pid, {
      namePool: "custom",
      customNames: [" My Feature ", "my-feature", "Other"],
    })
    expect(custom.status).toBe(201)
    expect(["my-feature", "other"]).toContain((await custom.json()).name)
  })
  it("strictly validates namePool and customNames while explicit name wins", async () => {
    const pid = await addProject()
    for (const extra of [
      { namePool: 3 },
      { namePool: "unknown" },
      { namePool: "cities", customNames: ["x"] },
      { namePool: "custom" },
      { namePool: "custom", customNames: "x" },
      { namePool: "custom", customNames: [1] },
      { namePool: "custom", customNames: ["!!!"] },
      { customNames: ["x"] },
    ]) expect((await createWs(pid, extra)).status).toBe(400)

    const explicit = await createWs(pid, {
      name: "Chosen Name",
      namePool: "custom",
      customNames: [],
    })
    expect(explicit.status).toBe(201)
    expect((await explicit.json()).name).toBe("chosen-name")
  })
  it("archive: dirty -> 409 Conflict; force -> 200 archived; unarchive -> 200 active", async () => {
    const pid = await addProject()
    const ws = await (await createWs(pid)).json()
    fake.state.dirty.add(ws.path)
    const refused = await req(`/workspaces/${ws.id}/archive`, { method: "POST", body: JSON.stringify({}) })
    expect(refused.status).toBe(409)
    expect((await refused.json()).code).toBe("Conflict")
    const forced = await req(`/workspaces/${ws.id}/archive`, { method: "POST", body: JSON.stringify({ force: true }) })
    expect(forced.status).toBe(200)
    expect((await forced.json()).status).toBe("archived")
    const back = await req(`/workspaces/${ws.id}/unarchive`, { method: "POST", body: JSON.stringify({}) })
    expect(back.status).toBe(200)
    expect((await back.json()).status).toBe("active")
  })
  it("DELETE: dirty -> 409; ?force=1 -> 204 and row gone", async () => {
    const pid = await addProject()
    const ws = await (await createWs(pid)).json()
    fake.state.dirty.add(ws.path)
    expect((await req(`/workspaces/${ws.id}`, { method: "DELETE" })).status).toBe(409)
    expect((await req(`/workspaces/${ws.id}?force=1`, { method: "DELETE" })).status).toBe(204)
    const list = await (await req("/workspaces")).json()
    expect(list.filter((workspace: any) => workspace.kind === "task")).toHaveLength(0)
  })
  it("setup failure -> 500 SetupScriptError, row stays error; retry -> 200 active", async () => {
    const pid = await addProject()
    fs.mkdirSync(path.join(repoRoot, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, ".coolie", "setup.local.sh"), "#!/bin/bash\nexit 1\n")
    setupFails = true
    const failed = await createWs(pid, { branchSlug: "broken" })
    expect(failed.status).toBe(500)
    expect((await failed.json()).code).toBe("SetupScriptError")
    const list = await (await req("/workspaces")).json()
    const failedWorkspace = list.find((workspace: any) => workspace.kind === "task")
    expect(failedWorkspace.status).toBe("error")
    setupFails = false
    const retried = await req(`/workspaces/${failedWorkspace.id}/retry`, { method: "POST", body: JSON.stringify({}) })
    expect(retried.status).toBe(200)
    expect((await retried.json()).status).toBe("active")
  })
  it("lifecycle events are visible via GET /events", async () => {
    const pid = await addProject()
    await createWs(pid)
    const events = await (await req("/events?after=0")).json()
    const types = events.map((e: any) => e.type)
    expect(types).toContain("workspace.intent.created")
    expect(types).toContain("workspace.created")
  })
  it("POST /workspaces/:id/pin strictly validates and persists pin state", async () => {
    const pid = await addProject()
    const ws = await (await createWs(pid)).json()
    const badBodies = [{}, { pinned: 1 }, { pinned: true, extra: "nope" }]
    for (const body of badBodies) {
      const bad = await req(`/workspaces/${ws.id}/pin`, { method: "POST", body: JSON.stringify(body) })
      expect(bad.status).toBe(400)
      expect((await bad.json()).code).toBe("Validation")
    }
    const pinned = await req(`/workspaces/${ws.id}/pin`, { method: "POST", body: JSON.stringify({ pinned: true }) })
    expect(pinned.status).toBe(200)
    expect((await pinned.json()).pinned).toBe(true)
    const listed = await (await req("/workspaces")).json()
    expect(listed.find((item: any) => item.id === ws.id).pinned).toBe(true)
    const events = await (await req(`/events?workspace=${ws.id}`)).json()
    expect(events.filter((event: any) => event.type === "workspace.pinned")).toHaveLength(1)
  })
  it("POST /workspaces/:id/pin returns 404 for unknown workspace", async () => {
    const response = await req("/workspaces/nope/pin", {
      method: "POST",
      body: JSON.stringify({ pinned: true }),
    })
    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe("NotFound")
  })
  it("POST /workspaces rejects non-string initialPrompt", async () => {
    const r = await req("/workspaces", { method: "POST", body: JSON.stringify({ projectId: "p", initialPrompt: 42 }) })
    expect(r.status).toBe(400)
  })
  it("create/retry 保留 engine、model 与 effort", async () => {
    const pid = await addProject()
    const created = await createWs(pid, {
      name: "engine-options",
      initialPrompt: "ship it",
      engineId: "codex",
      model: "gpt-5",
      effort: "high",
    })
    expect(created.status).toBe(201)
    expect(seenCreateCtx).toEqual([{
      initialPrompt: "ship it",
      engineId: "codex",
      model: "gpt-5",
      effort: "high",
    }])

    fs.mkdirSync(path.join(repoRoot, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, ".coolie", "setup.local.sh"), "#!/bin/bash\nexit 1\n")
    setupFails = true
    const failed = await createWs(pid, {
      name: "engine-options-retry",
      engineId: "codex",
      model: "gpt-5",
      effort: "xhigh",
    })
    expect(failed.status).toBe(500)
    const failedWs = (await (await req("/workspaces")).json()).find((w: any) => w.name === "engine-options-retry")
    seenCreateCtx = []
    setupFails = false
    const retried = await req(`/workspaces/${failedWs.id}/retry`, { method: "POST", body: "{}" })
    expect(retried.status).toBe(200)
    expect(seenCreateCtx).toEqual([{ engineId: "codex", model: "gpt-5", effort: "xhigh" }])
  })
  it("POST /workspaces accepts fanoutGroup and passes it to lifecycle", async () => {
    const pid = await addProject()
    const created = await createWs(pid, {
      name: "fanout-one",
      engineId: "claude",
      fanoutGroup: "fo-abc",
    })
    expect(created.status).toBe(201)
    expect(seenCreateCtx).toEqual([{ engineId: "claude", fanoutGroup: "fo-abc" }])
  })
  it("mutates task metadata, safely renames its branch, and reorders tasks", async () => {
    const pid = await addProject()
    const workspace = await (await createWs(pid, { name: "metadata" })).json()
    const second = await (await createWs(pid, { name: "metadata-second" })).json()
    const renamed = await req(`/workspaces/${workspace.id}/rename`, {
      method: "POST", body: JSON.stringify({ name: "Metadata Task" }),
    })
    expect((await renamed.json()).name).toBe("Metadata Task")
    const status = await req(`/workspaces/${workspace.id}/task-status`, {
      method: "POST", body: JSON.stringify({ status: "in_review" }),
    })
    expect((await status.json()).taskStatus).toBe("in_review")
    const branch = await req(`/workspaces/${workspace.id}/branch`, {
      method: "POST", body: JSON.stringify({ branch: "feature/renamed" }),
    })
    expect((await branch.json()).branch).toBe("feature/renamed")
    expect(fake.state.worktrees.get(workspace.path)).toBe("feature/renamed")
    const all = await (await req(`/workspaces?project=${pid}`)).json()
    const mainId = all.find((item: any) => item.kind === "main").id
    const ids = [second.id, workspace.id]
    const reordered = await req("/workspaces/reorder", {
      method: "POST", body: JSON.stringify({ projectId: pid, workspaceIds: ids }),
    })
    expect(reordered.status).toBe(200)
    const reorderedRows = await reordered.json()
    expect(reorderedRows.filter((item: any) => item.kind === "task" && item.status !== "archived")
      .map((item: any) => item.id)).toEqual(ids)
    expect(reorderedRows.some((item: any) => item.id === mainId)).toBe(true)
    const events = await (await req(`/events?workspace=${workspace.id}`)).json()
    expect(events.map((event: any) => event.type)).toEqual(expect.arrayContaining([
      "workspace.renamed", "workspace.task-status.changed", "workspace.branch.renamed",
    ]))
  })
  it("never archives or deletes the project main task", async () => {
    const pid = await addProject()
    const main = (await (await req(`/workspaces?project=${pid}`)).json())
      .find((workspace: any) => workspace.kind === "main")
    expect((await req(`/workspaces/${main.id}/archive`, { method: "POST", body: "{}" })).status).toBe(409)
    expect((await req(`/workspaces/${main.id}`, { method: "DELETE" })).status).toBe(409)
  })
  it.each(["engineId", "model", "effort", "fanoutGroup"])("POST /workspaces rejects non-string %s", async (field) => {
    const r = await req("/workspaces", {
      method: "POST",
      body: JSON.stringify({ projectId: "p", [field]: 42 }),
    })
    expect(r.status).toBe(400)
  })
})
