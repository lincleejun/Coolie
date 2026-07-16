import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as http from "node:http"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { EventEmitter } from "node:events"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { createApp, newToken } from "../src/http/app.js"
import { ProjectScriptsRepo, ProjectScriptsRepoLive } from "../src/repo/project-scripts.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { EventsBus } from "../src/events/bus.js"
import { RunManagerLive } from "../src/runs/manager.js"

describe("runs HTTP (Task 2B.8)", () => {
  let server: http.Server
  let base = ""
  let token = ""
  let db: Database.Database
  let wsPath = ""

  const layer = () => Layer.mergeAll(
    ProjectsRepoLive,
    WorkspacesRepoLive,
    ProjectScriptsRepoLive,
    EventsRepoLive,
    RunManagerLive,
  ).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(Db, db),
    Layer.succeed(EventsBus, new EventEmitter()),
  )))

  beforeEach(async () => {
    db = new Database(":memory:")
    runMigrations(db)
    wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-http-runs-"))
    db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)").run()
    db.prepare(`INSERT INTO workspaces
      (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, task_status, kind, materialized, sort_order, data)
      VALUES ('w1','p1','usa-zion',?,'coolie/a','main','r','active',0,1,'in_progress','task',1,1,'{}')`).run(wsPath)
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      yield* (yield* ProjectScriptsRepo).upsert("p1", {
        runId: "dev",
        scriptType: "run",
        scope: "workspace",
        command: process.execPath,
        args: ["-e", "console.log('run-ok')"],
      })
    }), layer()))

    token = newToken()
    server = http.createServer(createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer()) as Effect.Effect<any, any, never>),
      token,
      onShutdown: () => {},
    }))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
    db.close()
    fs.rmSync(wsPath, { recursive: true, force: true })
  })

  const req = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })

  it("lists, starts, reads log, and stops a run", async () => {
    const empty = await req("/workspaces/w1/runs")
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual([])

    const started = await req("/workspaces/w1/runs/dev/start", { method: "POST", body: "{}" })
    expect(started.status).toBe(200)
    const run = await started.json()
    expect(run.runId).toBe("dev")
    expect(run.status).toBe("running")

    const listed = await req("/workspaces/w1/runs")
    expect((await listed.json())[0].runId).toBe("dev")

    const log = await req("/workspaces/w1/runs/dev/log")
    expect(log.status).toBe(200)

    const stopped = await req("/workspaces/w1/runs/dev/stop", { method: "POST", body: "{}" })
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).status).not.toBe("running")
  })
})
