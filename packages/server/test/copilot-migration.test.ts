import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../src/db/migrations.js"
import {
  migrateCopilotCustomRows,
  rollbackCopilotMigration,
} from "../src/engine/copilot-migration.js"
import { copilotPreset } from "../src/engine/custom-store.js"

const seedCore = (db: Database.Database) => {
  runMigrations(db)
  // Re-run migration logic against fixture rows by clearing the migration marker.
  db.prepare("DELETE FROM schema_migrations WHERE id = 'm0011-copilot-builtin-migration'").run()
}

describe("copilot custom-engine migration (Task 3.2)", () => {
  it("removes a legacy preset row so built-in copilot owns the id", () => {
    const db = new Database(":memory:")
    seedCore(db)
    const preset = copilotPreset("copilot")
    const now = Date.now()
    db.prepare(`INSERT INTO custom_engines (id, display_name, enabled, definition, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)`).run(preset.id, preset.displayName, JSON.stringify(preset), now, now)

    const snapshot = {
      shape: "preset" as const,
      presetRow: {
        id: preset.id,
        display_name: preset.displayName,
        enabled: 1,
        definition: JSON.stringify(preset),
        created_at: now,
        updated_at: now,
      },
    }
    const result = migrateCopilotCustomRows(db)
    expect(result).toMatchObject({ shape: "preset", removedPreset: true })
    expect(db.prepare("SELECT COUNT(*) c FROM custom_engines WHERE id = 'copilot'").get()).toEqual({ c: 0 })

    rollbackCopilotMigration(db, snapshot)
    expect(db.prepare("SELECT id FROM custom_engines WHERE id = 'copilot'").get()).toEqual({ id: "copilot" })
    db.close()
  })

  it("renames a user custom conflict and retargets tabs", () => {
    const db = new Database(":memory:")
    seedCore(db)
    db.prepare("INSERT INTO projects VALUES ('p1', 'demo', '/repo/demo', 'main', 1)").run()
    db.prepare(`INSERT INTO workspaces
      (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at,
       archived_at, data, task_status, kind, materialized, sort_order)
      VALUES ('w1', 'p1', 'task-a', '/tmp/a', 'coolie/a', 'main', 'abc', 'active', 0, 1,
              NULL, '{}', 'in_progress', 'task', 1, 0)`).run()
    const custom = {
      id: "copilot",
      displayName: "My Copilot Fork",
      enabled: true,
      command: ["my-copilot"],
      capabilities: { nativeQueue: false, midSessionModelSwitch: false, resume: false, hooks: false, effort: false },
      transcriptStrategy: "none",
      historyStrategy: "none",
      turnDetection: "none",
    }
    const now = Date.now()
    db.prepare(`INSERT INTO custom_engines (id, display_name, enabled, definition, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)`).run("copilot", custom.displayName, JSON.stringify(custom), now, now)
    db.prepare(`INSERT INTO tabs
      (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
      VALUES ('t1', 'w1', 'engine', 'copilot', 'sess', 1, 'Copilot', 'idle', '{}')`).run()

    const result = migrateCopilotCustomRows(db)
    expect(result.shape).toBe("custom-conflict")
    expect(result.renamedFrom).toBe("copilot")
    expect(result.renamedTo).toBe("copilot-custom")
    expect(result.tabsUpdated).toBe(1)
    expect(db.prepare("SELECT id FROM custom_engines").all()).toEqual([{ id: "copilot-custom" }])
    expect(db.prepare("SELECT engine_id AS engineId FROM tabs WHERE id = 't1'").get()).toEqual({ engineId: "copilot-custom" })
    const def = JSON.parse(
      (db.prepare("SELECT definition FROM custom_engines WHERE id = 'copilot-custom'").get() as { definition: string }).definition,
    )
    expect(def.id).toBe("copilot-custom")

    rollbackCopilotMigration(db, {
      shape: "custom-conflict",
      renamedTo: result.renamedTo,
      tabsUpdated: result.tabsUpdated,
    })
    expect(db.prepare("SELECT id FROM custom_engines").all()).toEqual([{ id: "copilot" }])
    expect(db.prepare("SELECT engine_id AS engineId FROM tabs WHERE id = 't1'").get()).toEqual({ engineId: "copilot" })
    db.close()
  })

  it("is a no-op when no copilot custom row exists", () => {
    const db = new Database(":memory:")
    seedCore(db)
    expect(migrateCopilotCustomRows(db).shape).toBe("absent")
    db.close()
  })

  it("runs as schema migration m0011", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const preset = copilotPreset("copilot")
    const now = Date.now()
    db.prepare("DELETE FROM schema_migrations WHERE id = 'm0011-copilot-builtin-migration'").run()
    db.prepare(`INSERT INTO custom_engines (id, display_name, enabled, definition, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)`).run(preset.id, preset.displayName, JSON.stringify(preset), now, now)
    runMigrations(db)
    expect(db.prepare("SELECT COUNT(*) c FROM custom_engines WHERE id = 'copilot'").get()).toEqual({ c: 0 })
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'm0011-copilot-builtin-migration'").get()).toBeTruthy()
    db.close()
  })
})
