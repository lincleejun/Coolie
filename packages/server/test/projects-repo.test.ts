import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Layer, Exit, Cause, Option } from "effect"
import Database from "better-sqlite3"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"

let repoRoot: string
beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-proj-"))
  execSync("git init -b main", { cwd: repoRoot })
})

const memDb = () => { const db = new Database(":memory:"); runMigrations(db); return db }
const layer = () => ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, memDb())))
const run = <A, E>(eff: Effect.Effect<A, E, ProjectsRepo>) =>
  Effect.runPromiseExit(eff.pipe(Effect.provide(layer())))

const failureTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const failure = Cause.failureOption(exit.cause)
  return Option.isSome(failure) ? (failure.value as { _tag?: string })._tag : undefined
}

describe("ProjectsRepo", () => {
  it("adds and lists a project", async () => {
    const exit = await run(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      const p = yield* repo.add(repoRoot)
      expect(p.name).toBe(path.basename(repoRoot))
      expect(p.defaultBaseBranch).toBe("main")
      return yield* repo.list()
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toHaveLength(1)
  })
  it("atomically creates an undeletable materialized main task", async () => {
    const db = memDb()
    const repoLayer = ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
    const project = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* ProjectsRepo).add(repoRoot)
    }), repoLayer) as Effect.Effect<any, never, never>)
    const main = db.prepare("SELECT * FROM workspaces WHERE project_id = ? AND kind = 'main'").get(project.id) as any
    expect(main).toMatchObject({
      path: path.resolve(repoRoot),
      branch: "main",
      status: "active",
      task_status: "in_progress",
      materialized: 1,
      base_ref: "HEAD",
    })
  })
  it("rejects a non-git dir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-nogit-"))
    const exit = await run(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      return yield* repo.add(dir)
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureTag(exit)).toBe("ValidationError")
  })
  it("rejects adding the same repoRoot twice with ConflictError", async () => {
    const exit = await run(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      yield* repo.add(repoRoot)
      return yield* repo.add(repoRoot)
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureTag(exit)).toBe("ConflictError")
  })
  it("removes a project", async () => {
    const exit = await run(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      const p = yield* repo.add(repoRoot)
      yield* repo.remove(p.id)
      return yield* repo.list()
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toHaveLength(0)
  })
  it("fails to remove a nonexistent project with NotFoundError", async () => {
    const exit = await run(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      return yield* repo.remove("nonexistent")
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureTag(exit)).toBe("NotFoundError")
  })
  it("refuses project removal while a non-main task exists", async () => {
    const db = memDb()
    const repoLayer = ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const project = yield* projects.add(repoRoot)
      db.prepare(`INSERT INTO workspaces
        (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at,
         archived_at, data, task_status, kind, materialized, sort_order)
        VALUES ('task-1', ?, 'task', ?, 'coolie/task', 'main', '', 'creating', 0, 2, NULL, '{}',
                'backlog', 'task', 0, 1)`).run(project.id, path.join(repoRoot, "..", "task"))
      return yield* projects.remove(project.id)
    }), repoLayer) as Effect.Effect<void, any, never>)
    expect(failureTag(exit)).toBe("ConflictError")
    expect((db.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n).toBe(1)
  })
  it("get returns added project by id", async () => {
    const exit = await run(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      const p = yield* repo.add(repoRoot)
      return yield* repo.get(p.id)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.name).toBe(path.basename(repoRoot))
  })
  it("get nonexistent project fails with NotFoundError", async () => {
    const exit = await run(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      return yield* repo.get("nonexistent")
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureTag(exit)).toBe("NotFoundError")
  })
  it("add/remove write project.* events in the same transaction", async () => {
    const db = new Database(":memory:"); runMigrations(db)
    const layer = ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
    const p = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      const proj = yield* repo.add(repoRoot)
      yield* repo.remove(proj.id)
      return proj
    }), layer) as Effect.Effect<any, never, never>)
    const evs = (db.prepare("SELECT type, payload FROM events ORDER BY seq").all() as any[])
    expect(evs.map((e) => e.type)).toEqual(["project.added", "workspace.main.created", "project.removed"])
    expect(JSON.parse(evs[0].payload).id).toBe(p.id)
  })
})
