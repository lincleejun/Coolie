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
})
