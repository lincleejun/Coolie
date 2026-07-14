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
import { GitService } from "../src/git/service.js"
import { SetupRunner, SetupScriptError, type SetupRunnerShape } from "../src/workspace/setup.js"
import { WorkspaceLifecycleLive, PostCreateHooks } from "../src/workspace/lifecycle.js"
import { createApp, newToken } from "../src/http/app.js"
import { makeFakeGit } from "./helpers/fake-git.js"

let server: http.Server, base: string, token: string
let fake: ReturnType<typeof makeFakeGit>
let setupFails = false
let repoRoot: string
let seenCreateCtx: Array<{
  initialPrompt?: string; engineId?: string; model?: string; effort?: string; fanoutGroup?: string
}>

beforeEach(async () => {
  const db = new Database(":memory:"); runMigrations(db)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hw-home-"))
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hw-ws-"))
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hw-repo-"))
  fs.mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true })
  const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: wsRoot }
  fake = makeFakeGit()
  setupFails = false
  seenCreateCtx = []
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
        (_ws, ctx) => Effect.sync(() => { seenCreateCtx.push({ ...ctx }) }),
      ]),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
  )
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
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
const createWs = async (projectId: string, extra: Record<string, unknown> = {}) =>
  req("/workspaces", { method: "POST", body: JSON.stringify({ projectId, ...extra }) })

describe("workspace HTTP API", () => {
  it("POST /workspaces -> 201 active; GET /workspaces lists and filters", async () => {
    const pid = await addProject()
    const created = await createWs(pid, { branchSlug: "fix-x" })
    expect(created.status).toBe(201)
    const ws = await created.json()
    expect(ws.status).toBe("active")
    expect(ws.branch).toBe("coolie/fix-x")
    const list = await (await req("/workspaces")).json()
    expect(list.map((w: any) => w.id)).toContain(ws.id)
    const filtered = await (await req(`/workspaces?project=${pid}`)).json()
    expect(filtered).toHaveLength(1)
    const empty = await (await req("/workspaces?project=nope")).json()
    expect(empty).toHaveLength(0)
  })
  it("validation: missing projectId -> 400; unknown project -> 404", async () => {
    const bad = await req("/workspaces", { method: "POST", body: JSON.stringify({}) })
    expect(bad.status).toBe(400)
    const missing = await createWs("nope")
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe("NotFound")
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
    expect(list).toHaveLength(0)
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
    expect(list[0].status).toBe("error")
    setupFails = false
    const retried = await req(`/workspaces/${list[0].id}/retry`, { method: "POST", body: JSON.stringify({}) })
    expect(retried.status).toBe(200)
    expect((await retried.json()).status).toBe("active")
  })
  it("lifecycle events are visible via GET /events", async () => {
    const pid = await addProject()
    await createWs(pid)
    const events = await (await req("/events?after=0")).json()
    const types = events.map((e: any) => e.type)
    expect(types).toContain("workspace.creating")
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
  it.each(["engineId", "model", "effort", "fanoutGroup"])("POST /workspaces rejects non-string %s", async (field) => {
    const r = await req("/workspaces", {
      method: "POST",
      body: JSON.stringify({ projectId: "p", [field]: 42 }),
    })
    expect(r.status).toBe(400)
  })
})
