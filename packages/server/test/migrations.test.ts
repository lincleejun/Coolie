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
    for (const n of ["projects", "workspaces", "tabs", "events", "prompt_queue", "schema_migrations"]) expect(t).toContain(n)
  })
  it("is idempotent", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
    expect(db.prepare("SELECT COUNT(*) c FROM schema_migrations").get()).toEqual({ c: 4 })
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
})
