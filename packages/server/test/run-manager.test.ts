import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Exit, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { EventsBus } from "../src/events/bus.js"
import { EventEmitter } from "node:events"
import { ProjectScriptsRepo, ProjectScriptsRepoLive } from "../src/repo/project-scripts.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { RunManager, RunManagerLive } from "../src/runs/manager.js"
import { appendRunLog, redactRunLog } from "../src/runs/log.js"
import { isProcessAlive } from "../src/runs/process.js"

const seed = (db: Database.Database): string => {
  const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-run-mgr-"))
  db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','demo','/tmp/p1','main',1)").run()
  db.prepare(`INSERT INTO workspaces
    (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, task_status, kind, materialized, sort_order, data)
    VALUES ('w1','p1','w1',?,'coolie/w1','main','HEAD','active',0,1,'in_progress','task',1,1,'{}')`).run(wsPath)
  return wsPath
}

const layer = (db: Database.Database) =>
  Layer.mergeAll(
    ProjectsRepoLive,
    WorkspacesRepoLive,
    ProjectScriptsRepoLive,
    EventsRepoLive,
    RunManagerLive,
  ).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(Db, db),
    Layer.succeed(EventsBus, new EventEmitter()),
  )))

const run = <A, E>(db: Database.Database, eff: Effect.Effect<A, E, RunManager | ProjectScriptsRepo | WorkspacesRepo | ProjectsRepo | EventsRepo>) =>
  Effect.runPromiseExit(Effect.provide(eff, layer(db)) as Effect.Effect<A, E, never>)

describe("run manager (Task 2B.7)", () => {
  it("redacts bearer tokens from run logs", () => {
    const redacted = redactRunLog("Authorization: Bearer secret-token\nCOOLIE_PORT=1234")
    expect(redacted).not.toContain("secret-token")
    expect(redacted).toContain("[redacted]")
  })

  it("truncates bounded logs", () => {
    const big = "x".repeat(100_000)
    const log = appendRunLog("", big)
    expect(log.truncated).toBe(true)
    expect(log.bytes).toBeLessThanOrEqual(64_000)
  })

  it("starts and stops a run idempotently", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const wsPath = seed(db)
    await run(db, Effect.gen(function* () {
      yield* (yield* ProjectScriptsRepo).upsert("p1", {
        runId: "dev",
        scriptType: "run",
        scope: "workspace",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      })
    }))
    const first = await run(db, Effect.gen(function* () {
      return yield* (yield* RunManager).start("w1", "dev")
    }))
    expect(Exit.isSuccess(first)).toBe(true)
    if (!Exit.isSuccess(first)) return
    expect(first.value.status).toBe("running")

    const second = await run(db, Effect.gen(function* () {
      return yield* (yield* RunManager).start("w1", "dev")
    }))
    expect(Exit.isSuccess(second)).toBe(true)
    if (Exit.isSuccess(second)) expect(second.value.id).toBe(first.value.id)

    const stopped = await run(db, Effect.gen(function* () {
      return yield* (yield* RunManager).stop("w1", "dev")
    }))
    expect(Exit.isSuccess(stopped)).toBe(true)
    if (Exit.isSuccess(stopped)) {
      expect(stopped.value.status).not.toBe("running")
      expect(stopped.value.exitedAt).not.toBeNull()
    }
    fs.rmSync(wsPath, { recursive: true, force: true })
  })

  it("reconciles stale running rows after process exit", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    seed(db)
    const pid = process.pid
    expect(isProcessAlive(pid)).toBe(true)
    await run(db, Effect.gen(function* () {
      yield* (yield* ProjectScriptsRepo).recordRun({
        id: "run-w1-dev",
        workspaceId: "w1",
        runId: "dev",
        scriptType: "run",
        status: "running",
        startedAt: Date.now(),
        exitedAt: null,
        exitCode: null,
      })
    }))
    const reconciled = await run(db, Effect.gen(function* () {
      return yield* (yield* RunManager).reconcile("w1")
    }))
    expect(Exit.isSuccess(reconciled)).toBe(true)
    if (Exit.isSuccess(reconciled))
      expect(reconciled.value.every((run) => run.status !== "running" || run.id !== "run-w1-dev")).toBe(true)
  })
})
