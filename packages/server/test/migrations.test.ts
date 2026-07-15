import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../src/db/migrations.js"

const tables = (db: Database.Database) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name)

describe("migrations", () => {
  it("creates core tables and the prompt queue", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const t = tables(db)
    for (const n of ["projects", "workspaces", "tabs", "events", "prompt_queue", "custom_engines", "schema_migrations"]) expect(t).toContain(n)
  })
  it("is idempotent", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
    expect(db.prepare("SELECT COUNT(*) c FROM schema_migrations").get()).toEqual({ c: 7 })
  })

  it("adds queue state to databases that already ran the original m0003", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE prompt_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, tab_id TEXT NOT NULL,
        text TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL);
    `)
    for (const id of ["m0001-core-tables", "m0002-workspace-indexes", "m0003-prompt-queue"])
      db.prepare("INSERT INTO schema_migrations VALUES (?, 1)").run(id)
    runMigrations(db)
    expect((db.prepare("PRAGMA table_info(prompt_queue)").all() as any[]).map((c) => c.name)).toContain("state")
  })

  it("backfills task metadata and one main task per existing project", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    db.prepare("DELETE FROM schema_migrations WHERE id = 'm0005-kobe-task-semantics'").run()
    db.exec(`
      DROP INDEX idx_workspaces_one_main;
      DROP INDEX idx_workspaces_project_sort;
      DELETE FROM workspaces;
      INSERT INTO projects VALUES ('p1', 'demo', '/repo/demo', 'main', 10);
      INSERT INTO workspaces
        (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data,
         task_status, kind, materialized, sort_order)
      VALUES ('w1', 'p1', 'old', '/worktrees/old', 'coolie/old', 'main', 'abc', 'archived', 0, 20, 30, '{}',
              'backlog', 'task', 0, 0);
    `)
    runMigrations(db)
    const rows = db.prepare(
      "SELECT kind, task_status AS taskStatus, materialized, path, base_ref AS baseRef FROM workspaces ORDER BY kind",
    ).all() as any[]
    expect(rows).toEqual([
      { kind: "main", taskStatus: "in_progress", materialized: 1, path: "/repo/demo", baseRef: "HEAD" },
      { kind: "task", taskStatus: "done", materialized: 1, path: "/worktrees/old", baseRef: "abc" },
    ])
  })

  it("repairs legacy main task base refs without shelling out", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    db.prepare("INSERT INTO projects VALUES ('p1', 'demo', '/repo/demo', 'main', 1)").run()
    db.prepare(`INSERT INTO workspaces
      (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at,
       archived_at, data, task_status, kind, materialized, sort_order)
      VALUES ('main-p1', 'p1', 'demo', '/repo/demo', 'main', 'main', '', 'active', 0, 1,
              NULL, '{}', 'in_progress', 'main', 1, -1)`).run()
    db.prepare("DELETE FROM schema_migrations WHERE id = 'm0007-main-base-ref'").run()
    runMigrations(db)
    const refs = db.prepare("SELECT DISTINCT base_ref AS baseRef FROM workspaces WHERE kind = 'main'").all()
    expect(refs).toEqual([{ baseRef: "HEAD" }])
  })
})
