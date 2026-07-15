import { describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../src/db/migrations.js"
import { cleanupRemovedRunTabs } from "../src/db/cleanup.js"

describe("removed run tab cleanup", () => {
  it("kills legacy windows and removes their tab and queue rows", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    db.prepare("INSERT INTO projects VALUES ('p1', 'demo', '/repo', 'main', 1)").run()
    db.prepare(`INSERT INTO workspaces
      (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at,
       archived_at, data, task_status, kind, materialized, sort_order)
      VALUES ('w1', 'p1', 'task', '/worktree', 'coolie/task', 'main', 'base', 'active', 0, 1,
              NULL, '{}', 'in_progress', 'task', 1, 1)`).run()
    db.prepare(`INSERT INTO tabs
      (id, workspace_id, kind, tmux_window, status, data)
      VALUES ('run-1', 'w1', 'run', 2, 'idle', '{}'),
             ('shell-1', 'w1', 'shell', 3, 'idle', '{}')`).run()
    db.prepare(`INSERT INTO prompt_queue
      (workspace_id, tab_id, text, mode, state, created_at)
      VALUES ('w1', 'run-1', 'legacy', 'send', 'queued', 1),
             ('w1', 'shell-1', 'keep', 'send', 'queued', 2)`).run()
    const killWindow = vi.fn(async () => {})

    await expect(cleanupRemovedRunTabs(db, killWindow)).resolves.toBe(1)

    expect(killWindow).toHaveBeenCalledWith("coolie-w1", 2)
    expect(db.prepare("SELECT id FROM tabs ORDER BY id").all()).toEqual([{ id: "shell-1" }])
    expect(db.prepare("SELECT text FROM prompt_queue ORDER BY id").all()).toEqual([{ text: "keep" }])
    db.close()
  })
})
