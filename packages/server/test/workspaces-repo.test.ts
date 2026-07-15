import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import { Effect, Layer, Exit, Cause, Option } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "../src/repo/workspaces.js"

const make = () => {
  const db = new Database(":memory:"); runMigrations(db)
  db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
    .run("p1", "demo", "/tmp/demo", "main", 1)
  const layer = WorkspacesRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
  const run = <A, E>(eff: Effect.Effect<A, E, WorkspacesRepo>) =>
    Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<A, E, never>)
  return { db, run }
}
const w1 = { projectId: "p1", name: "usa-zion", path: "/tmp/ws/usa-zion", branch: "coolie/fix-a", baseBranch: "main", portBase: 40000 }
const failTag = (exit: Exit.Exit<any, any>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const f = Cause.failureOption(exit.cause)
  return Option.isSome(f) ? (f.value as any)._tag : undefined
}

describe("WorkspacesRepo", () => {
  it("persists migration-compatible layout and zen state in workspace data", async () => {
    const { db, run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      expect((yield* repo.getLayoutState(ws.id)).zen).toBe(false)
      yield* repo.setLayoutState(ws.id, {
        version: 1, zen: true, focusedTabId: "tab-2", restoreTabId: "tab-1",
        geometry: [{ window: 0, layout: "layout", cols: 120, rows: 32 }],
      })
      return { state: yield* repo.getLayoutState(ws.id), ws: yield* repo.get(ws.id) }
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.state).toMatchObject({ zen: true, focusedTabId: "tab-2" })
      expect(exit.value.ws.zenMode).toBe(true)
      expect(JSON.parse((db.prepare("SELECT data FROM workspaces WHERE id = ?").get(exit.value.ws.id) as any).data).layout)
        .toMatchObject({ zen: true, restoreTabId: "tab-1" })
    }
  })

  it("insertCreating + get round-trips incl portBase", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      expect(ws.status).toBe("creating")
      expect(ws.ownership).toBe("managed")
      expect(ws.portBase).toBe(40000)
      expect(ws.baseRef).toBe("")
      expect(ws.archivedAt).toBeNull()
      return yield* repo.get(ws.id)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.name).toBe("usa-zion")
  })
  it("persists adopted ownership as durable row data", async () => {
    const { db, run } = make()
    const exit = await run(Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).insertAdopted({
        ...w1,
        branch: "feature/existing",
        baseRef: "abc123",
      })
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.ownership).toBe("adopted")
      expect(JSON.parse((db.prepare("SELECT data FROM workspaces WHERE id = ?").get(exit.value.id) as any).data))
        .toMatchObject({ ownership: "adopted" })
    }
  })
  it("duplicate name in same project -> ConflictError (m0002 unique index)", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      yield* repo.insertCreating(w1)
      return yield* repo.insertCreating({ ...w1, path: "/tmp/ws/other", branch: "coolie/fix-b" })
    }))
    expect(failTag(exit)).toBe("ConflictError")
  })
  it("status machine: creating→active→archiving→archived→active; illegal moves rejected", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      const a = yield* repo.setStatus(ws.id, "active")
      expect(a.status).toBe("active")
      const freezing = yield* repo.setStatus(ws.id, "archiving")
      expect(freezing.status).toBe("archiving")
      const ar = yield* repo.setStatus(ws.id, "archived")
      expect(ar.status).toBe("archived")
      expect(ar.archivedAt).toBeTypeOf("number")
      const back = yield* repo.setStatus(ws.id, "active")
      expect(back.archivedAt).toBeNull()
      return ws.id
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    const { run: run2 } = make()
    const illegal = await run2(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      return yield* repo.setStatus(ws.id, "archived") // creating→archived 非法
    }))
    expect(failTag(illegal)).toBe("ConflictError")
  })
  it("error→creating is the retry transition", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      yield* repo.setStatus(ws.id, "error")
      yield* repo.setLastError(ws.id, { tag: "GitError", message: "boom" })
      const again = yield* repo.setStatus(ws.id, "creating")
      return again.status
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toBe("creating")
  })
  it("persists archive force/error intent and commits terminal states atomically", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      yield* repo.setStatus(ws.id, "active")
      const begun = yield* repo.beginArchive(ws.id, false)
      expect(begun.workspace.status).toBe("archiving")
      expect(begun.operation.force).toBe(false)
      const upgraded = yield* repo.beginArchive(ws.id, true)
      expect(upgraded.operation.force).toBe(true)
      yield* repo.setArchiveError(ws.id, { tag: "GitError", stage: "worktree-remove", message: "boom" })
      expect(yield* repo.getArchiveOperation(ws.id)).toMatchObject({
        force: true, lastError: { tag: "GitError", stage: "worktree-remove", message: "boom" },
      })
      expect((yield* repo.beginArchive(ws.id, false)).operation).toMatchObject({
        force: true, lastError: { tag: "GitError", stage: "worktree-remove", message: "boom" },
      })
      const active = yield* repo.cancelArchive(ws.id)
      expect(active.status).toBe("active")
      yield* repo.beginArchive(ws.id, true)
      return yield* repo.completeArchive(ws.id)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.status).toBe("archived")
      expect(exit.value.taskStatus).toBe("done")
    }
  })
  it("list filters by project; usedPortBases spans all rows; remove deletes", async () => {
    const { db, run } = make()
    db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
      .run("p2", "demo2", "/tmp/demo2", "main", 2)
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const a = yield* repo.insertCreating(w1)
      yield* repo.insertCreating({ projectId: "p2", name: "usa-zion", path: "/tmp/ws2/usa-zion", branch: "coolie/x", baseBranch: "main", portBase: 40010 })
      const onlyP1 = yield* repo.list({ projectId: "p1" })
      const all = yield* repo.list()
      const ports = yield* repo.usedPortBases()
      yield* repo.remove(a.id)
      const gone = yield* repo.list({ projectId: "p1" })
      return { onlyP1, all, ports, gone }
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.onlyP1).toHaveLength(1)
      expect(exit.value.all).toHaveLength(2)
      expect(exit.value.ports.sort()).toEqual([40000, 40010])
      expect(exit.value.gone).toHaveLength(0)
    }
  })
  it("get/remove unknown id -> NotFoundError", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      yield* repo.get("nope")
    }))
    expect(failTag(exit)).toBe("NotFoundError")
    const { run: run2 } = make()
    const removeExit = await run2(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      return yield* repo.remove("nope")
    }))
    expect(failTag(removeExit)).toBe("NotFoundError")
  })
  it("setBaseRef updates baseRef and can be read back", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      yield* repo.setBaseRef(ws.id, "abc123")
      return yield* repo.get(ws.id)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.baseRef).toBe("abc123")
  })
  it("setPinned persists for any status, is idempotent, and records one event per change", async () => {
    const { db, run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      const pinned = yield* repo.setPinned(ws.id, true)
      const same = yield* repo.setPinned(ws.id, true)
      yield* repo.setStatus(ws.id, "active")
      yield* repo.setStatus(ws.id, "archiving")
      yield* repo.setStatus(ws.id, "archived")
      const unpinned = yield* repo.setPinned(ws.id, false)
      return { pinned, same, unpinned, persisted: yield* repo.get(ws.id) }
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.pinned.pinned).toBe(true)
      expect(exit.value.same.pinned).toBe(true)
      expect(exit.value.unpinned.pinned).toBe(false)
      expect(exit.value.persisted.pinned).toBe(false)
      const events = db.prepare("SELECT type, payload FROM events WHERE workspace_id = ? ORDER BY seq")
        .all(exit.value.persisted.id) as Array<{ type: string; payload: string }>
      expect(events.map((event) => event.type)).toEqual(["workspace.pinned", "workspace.pinned"])
      expect(events.map((event) => JSON.parse(event.payload))).toEqual([{ pinned: true }, { pinned: false }])
    }
  })
  it("setPinned unknown id -> NotFoundError without event", async () => {
    const { db, run } = make()
    const exit = await run(Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).setPinned("nope", true)
    }))
    expect(failTag(exit)).toBe("NotFoundError")
    expect((db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(0)
  })
  it("reorders only regular non-archived tasks and preserves archived/main order", async () => {
    const { db, run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const first = yield* repo.insertCreating(w1)
      const archived = yield* repo.insertCreating({
        ...w1, name: "usa-yosemite", path: "/tmp/ws/usa-yosemite", branch: "coolie/archived",
      })
      const last = yield* repo.insertCreating({
        ...w1, name: "usa-acadia", path: "/tmp/ws/usa-acadia", branch: "coolie/last",
      })
      yield* repo.setStatus(archived.id, "active")
      yield* repo.setStatus(archived.id, "archiving")
      yield* repo.setStatus(archived.id, "archived")
      db.prepare(`INSERT INTO workspaces
        (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data,
         task_status, kind, materialized, sort_order)
        VALUES ('main-row','p1','main','/tmp/demo','main','main','','active',0,1,NULL,'{}',
          'in_progress','main',1,7)`).run()
      const archivedBefore = (db.prepare("SELECT sort_order FROM workspaces WHERE id = ?")
        .get(archived.id) as { sort_order: number }).sort_order
      const reordered = yield* repo.reorder("p1", [last.id, first.id])
      return { first, archived, last, reordered, archivedBefore }
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const activeTasks = db.prepare(
        "SELECT id FROM workspaces WHERE project_id = 'p1' AND kind = 'task' AND status <> 'archived' ORDER BY sort_order",
      ).all() as Array<{ id: string }>
      expect(activeTasks.map(({ id }) => id)).toEqual([exit.value.last.id, exit.value.first.id])
      expect((db.prepare("SELECT sort_order FROM workspaces WHERE id = ?").get(exit.value.archived.id) as any).sort_order)
        .toBe(exit.value.archivedBefore)
      expect((db.prepare("SELECT sort_order FROM workspaces WHERE id = 'main-row'").get() as any).sort_order).toBe(7)
      expect(exit.value.reordered).toHaveLength(4)
    }
  })
  it("setLastError stores shape with tag, message, and numeric at", async () => {
    const { db, run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      yield* repo.setLastError(ws.id, { tag: "GitError", message: "boom" })
      return ws.id
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const wsId = exit.value
      const row = db.prepare("SELECT data FROM workspaces WHERE id = ?").get(wsId) as any
      const data = JSON.parse(row.data)
      expect(data.lastError).toBeDefined()
      expect(data.lastError.tag).toBe("GitError")
      expect(data.lastError.message).toBe("boom")
      expect(typeof data.lastError.at).toBe("number")
      expect(data.portBase).toBe(40000) // ensure portBase still present (merge, not overwrite)
    }
  })
  it("setCreateCtx/getCreateCtx round-trips fanoutGroup without exposing it on Workspace", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      yield* repo.setCreateCtx(ws.id, {
        initialPrompt: "ship it",
        engineId: "codex",
        fanoutGroup: "fo-abc",
      })
      return {
        workspace: yield* repo.get(ws.id),
        createCtx: yield* repo.getCreateCtx(ws.id),
      }
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.createCtx).toEqual({
        initialPrompt: "ship it",
        engineId: "codex",
        fanoutGroup: "fo-abc",
      })
      expect("fanoutGroup" in exit.value.workspace).toBe(false)
    }
  })
})
