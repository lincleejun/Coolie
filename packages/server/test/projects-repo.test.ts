import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Layer, Exit } from "effect"
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
  })
})
