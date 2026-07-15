import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Layer, Exit } from "effect"
import Database from "better-sqlite3"
import { EventEmitter } from "node:events"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { EventsBus, EVENT_CHANNEL } from "../src/events/bus.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"

let db: Database.Database
let bus: EventEmitter
let live: Array<{ type: string; payload: any }>

beforeEach(() => {
  db = new Database(":memory:"); runMigrations(db)
  db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)`).run()
  db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
    VALUES ('w1','p1','usa-zion','/tmp/ws1','coolie/a','main','r','active',0,1,NULL,'{}')`).run()
  bus = new EventEmitter()
  live = []
  bus.on(EVENT_CHANNEL, (e: any) => live.push({ type: e.type, payload: e.payload }))
})

const layer = () => TabsRepoLive.pipe(
  Layer.provide(Layer.succeed(Db, db)),
  Layer.provide(Layer.succeed(EventsBus, bus)),
)
const run = <A, E>(eff: Effect.Effect<A, E, TabsRepo>) => Effect.runPromise(Effect.provide(eff, layer()))
const runExit = <A, E>(eff: Effect.Effect<A, E, TabsRepo>) => Effect.runPromiseExit(Effect.provide(eff, layer()))
const eventRows = () => db.prepare("SELECT type, payload FROM events ORDER BY seq").all() as Array<{ type: string; payload: string }>

describe("TabsRepo", () => {
  it("insert writes the row AND the tab.created event in one transaction, then broadcasts", async () => {
    const tab = await run(Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "s-1", tmuxWindow: 0 })
    }))
    expect(tab.status).toBe("idle")
    expect(tab.engineSessionId).toBe("s-1")
    const evs = eventRows()
    expect(evs.map((e) => e.type)).toContain("tab.created")
    expect(JSON.parse(evs.find((e) => e.type === "tab.created")!.payload).tabId).toBe(tab.id)
    expect(live.map((e) => e.type)).toContain("tab.created")
  })

  it("setStatus emits tab.status.changed once; same value is a no-op", async () => {
    const tab = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      const t = yield* repo.insert({ workspaceId: "w1", kind: "engine", engineId: "claude" })
      yield* repo.setStatus(t.id, "working", "hook")
      yield* repo.setStatus(t.id, "working", "hook") // no-op
      return yield* repo.get(t.id)
    }))
    expect(tab.status).toBe("working")
    expect(eventRows().filter((e) => e.type === "tab.status.changed")).toHaveLength(1)
    const p = JSON.parse(eventRows().find((e) => e.type === "tab.status.changed")!.payload)
    expect(p).toMatchObject({ status: "working", source: "hook" })
  })

  it("setTitle + touchHookAt round-trip", async () => {
    const tab = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      const t = yield* repo.insert({ workspaceId: "w1", kind: "engine" })
      yield* repo.setTitle(t.id, "Fix the login bug")
      yield* repo.touchHookAt(t.id, 1234)
      return yield* repo.get(t.id)
    }))
    expect(tab.title).toBe("Fix the login bug")
    expect(tab.lastHookAt).toBe(1234)
    expect(eventRows().map((e) => e.type)).toContain("tab.title.changed")
  })

  it("setEngineSessionId：更新 + 同事务 tab.session.changed；同值 no-op 不发事件", async () => {
    const tab = await run(Effect.gen(function* () {
      const tabs = yield* TabsRepo
      const t = yield* tabs.insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "old-id", tmuxWindow: 0 })
      yield* tabs.setEngineSessionId(t.id, "new-id")
      yield* tabs.setEngineSessionId(t.id, "new-id") // 同值：不写库不发事件
      return yield* tabs.get(t.id)
    }))
    expect(tab.engineSessionId).toBe("new-id")
    const evs = (db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type)
    expect(evs.filter((t) => t === "tab.session.changed")).toHaveLength(1)
  })
  it("setEngineSessionId：不存在的 tab → NotFoundError", async () => {
    const exit = await runExit(Effect.gen(function* () {
      yield* (yield* TabsRepo).setEngineSessionId("ghost", "x")
    }))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("switchEngine atomically updates the engine tab and preserves sibling tabs", async () => {
    const result = await run(Effect.gen(function* () {
      const tabs = yield* TabsRepo
      const engine = yield* tabs.insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "old", tmuxWindow: 0 })
      const shell = yield* tabs.insert({ workspaceId: "w1", kind: "shell", tmuxWindow: 2 })
      const switched = yield* tabs.switchEngine(engine.id, "copilot", "new")
      return { switched, shell, all: yield* tabs.listByWorkspace("w1") }
    }))
    expect(result.switched).toMatchObject({ engineId: "copilot", engineSessionId: "new", status: "idle" })
    expect(result.all.some((tab) => tab.id === result.shell.id && tab.tmuxWindow === 2)).toBe(true)
    const event = eventRows().find((row) => row.type === "engine.switched")
    expect(JSON.parse(event!.payload)).toMatchObject({ fromEngineId: "claude", engineId: "copilot" })
  })

  it("findEngineTab returns the engine tab, null when absent", async () => {
    const found = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      yield* repo.insert({ workspaceId: "w1", kind: "shell" })
      const none = yield* repo.findEngineTab("w1")
      yield* repo.insert({ workspaceId: "w1", kind: "engine", engineId: "claude" })
      const some = yield* repo.findEngineTab("w1")
      return { none, some }
    }))
    expect(found.none).toBeNull()
    expect(found.some?.kind).toBe("engine")
  })

  it("lists and resolves multiple engine tabs by exact session/window while primary is deterministic", async () => {
    const found = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      const later = yield* repo.insert({
        workspaceId: "w1", kind: "engine", engineId: "codex", engineSessionId: "session-b", tmuxWindow: 4,
      })
      const primary = yield* repo.insert({
        workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "session-a", tmuxWindow: 1,
      })
      return {
        list: yield* repo.listEngineTabsByWorkspace("w1"),
        session: yield* repo.findEngineTabBySession("w1", "session-b"),
        window: yield* repo.findTabByWindow("w1", 1),
        primary: yield* repo.findEngineTab("w1"),
        later,
        expectedPrimary: primary,
      }
    }))
    expect(found.list.map((tab) => tab.id)).toEqual([found.expectedPrimary.id, found.later.id])
    expect(found.session?.id).toBe(found.later.id)
    expect(found.window?.id).toBe(found.expectedPrimary.id)
    expect(found.primary?.id).toBe(found.expectedPrimary.id)
  })

  it("listEngineTabs joins active workspaces only", async () => {
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w2','p1','usa-arches','/tmp/ws2','coolie/b','main','r','archived',0,1,NULL,'{}')`).run()
    const rows = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      yield* repo.insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "s-a" })
      yield* repo.insert({ workspaceId: "w2", kind: "engine", engineId: "claude", engineSessionId: "s-b" })
      return yield* repo.listEngineTabs()
    }))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.workspacePath).toBe("/tmp/ws1")
  })

  it("remove：删单个 shell tab 行 + tab.closed 事件；后续 listByWorkspace 不含它", async () => {
    const out = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      const t = yield* repo.insert({ workspaceId: "w1", kind: "shell", tmuxWindow: 3 })
      yield* repo.remove(t.id)
      return { id: t.id, list: yield* repo.listByWorkspace("w1") }
    }))
    expect(out.list.some((t) => t.id === out.id)).toBe(false)
    const closed = eventRows().find((e) => e.type === "tab.closed")
    expect(closed).toBeDefined()
    expect(JSON.parse(closed!.payload)).toMatchObject({ tabId: out.id, kind: "shell" })
    expect(live.map((e) => e.type)).toContain("tab.closed")
  })
  it("remove：不存在的 tab → NotFoundError", async () => {
    const exit = await runExit(Effect.gen(function* () { yield* (yield* TabsRepo).remove("ghost") }))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("removeByWorkspace deletes all tabs; get then fails NotFound", async () => {
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      const repo = yield* TabsRepo
      const t = yield* repo.insert({ workspaceId: "w1", kind: "engine" })
      yield* repo.removeByWorkspace("w1")
      return yield* repo.get(t.id)
    }), layer()))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
