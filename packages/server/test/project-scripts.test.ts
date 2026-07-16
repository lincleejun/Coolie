import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { Effect, Exit, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { StateRepo, StateRepoLive } from "../src/repo/state.js"
import { ProjectScriptsRepo, ProjectScriptsRepoLive } from "../src/repo/project-scripts.js"

const seedProject = (db: Database.Database, id = "p1"): void => {
  db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
    .run(id, "demo", `/tmp/${id}`, "main", 1)
}

const seedWorkspace = (db: Database.Database, id: string, projectId: string): void => {
  db.prepare(`INSERT INTO workspaces
    (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at,
     task_status, kind, materialized, sort_order, data)
    VALUES (?,?,?,?,?,?,?,'active',0,1,'in_progress','task',1,1,?)`).run(
    id, projectId, id, `/tmp/${id}`, `coolie/${id}`, "main", "HEAD", JSON.stringify({ portBase: 40000 }),
  )
}

const scriptsLayer = (db: Database.Database) =>
  ProjectScriptsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))

const stateLayer = (db: Database.Database) =>
  StateRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))

describe("project scripts repository (Task 2B.6)", () => {
  it("creates migration tables for definitions, runs, and log metadata", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((row: any) => row.name)
    expect(tables).toContain("project_scripts")
    expect(tables).toContain("run_instances")
    expect(tables).toContain("run_log_metadata")
  })

  it("enforces unique named run ids per project and validates scope", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    seedProject(db)

    const runRepo = <A, E>(eff: Effect.Effect<A, E, ProjectScriptsRepo>) =>
      Effect.runPromiseExit(Effect.provide(eff, scriptsLayer(db)) as Effect.Effect<A, E, never>)

    const first = await runRepo(Effect.gen(function* () {
      return yield* (yield* ProjectScriptsRepo).upsert("p1", {
        runId: "dev-server",
        scriptType: "run",
        scope: "workspace",
        command: "npm",
        args: ["run", "dev"],
      })
    }))
    expect(Exit.isSuccess(first)).toBe(true)

    const duplicate = await runRepo(Effect.gen(function* () {
      return yield* (yield* ProjectScriptsRepo).upsert("p1", {
        runId: "dev-server",
        scriptType: "run",
        scope: "workspace",
        command: "npm",
        args: ["run", "dev"],
      })
    }))
    expect(Exit.isSuccess(duplicate)).toBe(true)
    if (Exit.isSuccess(duplicate)) expect(duplicate.value.command).toBe("npm")

    const invalid = await runRepo(Effect.gen(function* () {
      return yield* (yield* ProjectScriptsRepo).upsert("p1", {
        runId: "archive",
        scriptType: "archive",
        scope: "workspace",
        command: "./archive.sh",
        args: [],
      })
    }))
    expect(Exit.isFailure(invalid)).toBe(true)
  })

  it("returns active runs through state snapshot reads", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    seedProject(db)
    seedWorkspace(db, "w1", "p1")

    const runScripts = <A, E>(eff: Effect.Effect<A, E, ProjectScriptsRepo>) =>
      Effect.runPromiseExit(Effect.provide(eff, scriptsLayer(db)) as Effect.Effect<A, E, never>)
    const runState = <A, E>(eff: Effect.Effect<A, E, StateRepo>) =>
      Effect.runPromiseExit(Effect.provide(eff, stateLayer(db)) as Effect.Effect<A, E, never>)

    await runScripts(Effect.gen(function* () {
      const repo = yield* ProjectScriptsRepo
      yield* repo.recordRun({
        id: "run-1",
        workspaceId: "w1",
        runId: "dev-server",
        scriptType: "run",
        status: "running",
        startedAt: 100,
        exitedAt: null,
        exitCode: null,
      })
      yield* repo.recordLog({
        id: "log-1",
        runInstanceId: "run-1",
        workspaceId: "w1",
        scriptType: "run",
        bytes: 256,
        truncated: false,
        updatedAt: 101,
      })
    }))

    const snapshot = await runState(Effect.gen(function* () {
      return yield* (yield* StateRepo).read()
    }))
    expect(Exit.isSuccess(snapshot)).toBe(true)
    if (Exit.isSuccess(snapshot)) {
      expect(snapshot.value.activeRuns.map((run) => run.runId)).toEqual(["dev-server"])
    }
  })
})
