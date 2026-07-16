import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { appendEventRow } from "../src/repo/events.js"
import { makeStateRepo, StateRepo, StateRepoLive } from "../src/repo/state.js"

const ensureOptionalTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attention_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      source_event_seq INTEGER NOT NULL,
      session_turn_id TEXT,
      summary TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS run_instances (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      script_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      exited_at INTEGER,
      exit_code INTEGER
    );
  `)
}

const seedProject = (db: Database.Database, id = "p1"): void => {
  db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
    .run(id, `project-${id}`, `/tmp/${id}`, "main", 1)
}

const seedWorkspace = (
  db: Database.Database,
  id: string,
  projectId: string,
  overrides: Partial<{
    name: string
    path: string
    branch: string
    sortOrder: number
  }> = {},
): void => {
  db.prepare(`INSERT INTO workspaces
    (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at,
     task_status, kind, materialized, sort_order, data)
    VALUES (?,?,?,?,?,?,?,'active',0,1,'in_progress','task',1,?,?)`).run(
    id,
    projectId,
    overrides.name ?? id,
    overrides.path ?? `/tmp/${id}`,
    overrides.branch ?? `coolie/${id}`,
    "main",
    "HEAD",
    overrides.sortOrder ?? 1,
    JSON.stringify({ portBase: 40000, ownership: "managed" }),
  )
}

const seedTab = (db: Database.Database, id: string, workspaceId: string): void => {
  db.prepare(`INSERT INTO tabs
    (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, workspaceId, "engine", "claude", "sess-1", 1, "Claude", "idle", "{}")
}

const layer = (db: Database.Database) => StateRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
const run = <A, E>(db: Database.Database, eff: Effect.Effect<A, E, StateRepo>) =>
  Effect.runPromiseExit(Effect.provide(eff, layer(db)) as Effect.Effect<A, E, never>)

describe("StateRepo", () => {
  it("returns a valid empty snapshot for a greenfield database", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const exit = await run(db, Effect.gen(function* () {
      return yield* (yield* StateRepo).read()
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.asOfSeq).toBe(0)
      expect(exit.value.scope).toBeNull()
      expect(exit.value.projects).toEqual([])
      expect(exit.value.workspaces).toEqual([])
      expect(exit.value.tabs).toEqual([])
      expect(exit.value.openAttention).toEqual([])
      expect(exit.value.queuedPrompts).toEqual([])
      expect(exit.value.activeRuns).toEqual([])
    }
  })

  it("reads asOfSeq and canonical resources from one readonly transaction", async () => {
    const dbPath = path.join(os.tmpdir(), `coolie-state-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    const writer = new Database(dbPath)
    runMigrations(writer)
    seedProject(writer, "p1")
    seedWorkspace(writer, "w1", "p1")
    seedTab(writer, "t1", "w1")
    appendEventRow(writer, { workspaceId: "w1", type: "workspace.created", payload: { id: "w1" } })

    const reader = new Database(dbPath, { readonly: true })
    const repo = makeStateRepo(reader)

    writer.exec("BEGIN IMMEDIATE")
    appendEventRow(writer, { workspaceId: "w1", type: "prompt.queued", payload: { tabId: "t1" } })
    writer.prepare("INSERT INTO prompt_queue (workspace_id, tab_id, text, mode, state, created_at) VALUES (?,?,?,?,?,?)")
      .run("w1", "t1", "pending", "send", "queued", Date.now())

    const duringWrite = await Effect.runPromise(repo.read())
    expect(duringWrite.asOfSeq).toBe(1)
    expect(duringWrite.queuedPrompts).toEqual([])

    writer.exec("COMMIT")

    const afterWrite = await Effect.runPromise(repo.read())
    expect(afterWrite.asOfSeq).toBe(2)
    expect(afterWrite.queuedPrompts).toHaveLength(1)
    expect(afterWrite.queuedPrompts[0]).toMatchObject({
      tabId: "t1",
      text: "pending",
      position: 1,
      deliveryGuarantee: "at-least-once",
    })

    writer.close()
    reader.close()
    fs.unlinkSync(dbPath)
  })

  it("scopes queue and attention to the requested workspace", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    ensureOptionalTables(db)
    seedProject(db, "p1")
    seedWorkspace(db, "w1", "p1", { name: "alpha", sortOrder: 1 })
    seedWorkspace(db, "w2", "p1", { name: "beta", sortOrder: 2 })
    seedTab(db, "t1", "w1")
    seedTab(db, "t2", "w2")
    db.prepare("INSERT INTO prompt_queue (workspace_id, tab_id, text, mode, state, created_at) VALUES (?,?,?,?,?,?)")
      .run("w1", "t1", "only-w1", "send", "queued", 1)
    db.prepare("INSERT INTO prompt_queue (workspace_id, tab_id, text, mode, state, created_at) VALUES (?,?,?,?,?,?)")
      .run("w2", "t2", "only-w2", "send", "queued", 2)
    db.prepare(`INSERT INTO attention_items
      (id, workspace_id, tab_id, kind, source, source_event_seq, summary, state, created_at, acknowledged_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      "a1", "w1", "t1", "turn-finished", "hook", 1, "w1 attention", "open", 10, null,
    )
    db.prepare(`INSERT INTO attention_items
      (id, workspace_id, tab_id, kind, source, source_event_seq, summary, state, created_at, acknowledged_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      "a2", "w2", "t2", "error", "notify", 2, "w2 attention", "open", 20, null,
    )
    appendEventRow(db, { workspaceId: "w1", type: "seed", payload: {} })

    const exit = await run(db, Effect.gen(function* () {
      return yield* (yield* StateRepo).read({ workspaceId: "w1" })
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.scope).toEqual({ workspaceId: "w1" })
      expect(exit.value.projects).toHaveLength(1)
      expect(exit.value.workspaces.map((w) => w.id)).toEqual(["w1"])
      expect(exit.value.tabs.map((t) => t.id)).toEqual(["t1"])
      expect(exit.value.queuedPrompts.map((q) => q.text)).toEqual(["only-w1"])
      expect(exit.value.openAttention.map((a) => a.id)).toEqual(["a1"])
    }
  })

  it("uses a bounded number of SQL statements for large fixtures", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    ensureOptionalTables(db)
    seedProject(db, "p1")
    for (let i = 0; i < 50; i++) {
      const id = `w${i}`
      seedWorkspace(db, id, "p1", { sortOrder: i })
      seedTab(db, `t${i}`, id)
      db.prepare("INSERT INTO prompt_queue (workspace_id, tab_id, text, mode, state, created_at) VALUES (?,?,?,?,?,?)")
        .run(id, `t${i}`, `prompt-${i}`, "send", "queued", i)
      db.prepare(`INSERT INTO attention_items
        (id, workspace_id, tab_id, kind, source, source_event_seq, summary, state, created_at, acknowledged_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        `a${i}`, id, `t${i}`, "turn-finished", "hook", i, `summary-${i}`, "open", i, null,
      )
      db.prepare(`INSERT INTO run_instances
        (id, workspace_id, run_id, script_type, status, started_at, exited_at, exit_code)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        `r${i}`, id, `run-${i}`, "run", "running", i, null, null,
      )
      appendEventRow(db, { workspaceId: id, type: "seed", payload: { i } })
    }

    let statements = 0
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      statements++
      return prepare(sql)
    }) as typeof db.prepare

    const exit = await run(db, Effect.gen(function* () {
      return yield* (yield* StateRepo).read()
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.workspaces).toHaveLength(50)
      expect(exit.value.queuedPrompts).toHaveLength(50)
      expect(exit.value.openAttention).toHaveLength(50)
      expect(exit.value.activeRuns).toHaveLength(50)
    }
    expect(statements).toBeLessThanOrEqual(10)
    expect(statements).toBeGreaterThan(0)
  })

  it("rejects unknown workspace scope", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const exit = await run(db, Effect.gen(function* () {
      return yield* (yield* StateRepo).read({ workspaceId: "missing" })
    }))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
