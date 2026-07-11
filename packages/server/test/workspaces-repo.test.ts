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
  it("insertCreating + get round-trips incl portBase", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      expect(ws.status).toBe("creating")
      expect(ws.portBase).toBe(40000)
      expect(ws.baseRef).toBe("")
      expect(ws.archivedAt).toBeNull()
      return yield* repo.get(ws.id)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.name).toBe("usa-zion")
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
  it("status machine: creating→active→archived→active; illegal moves rejected", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      const a = yield* repo.setStatus(ws.id, "active")
      expect(a.status).toBe("active")
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
})
