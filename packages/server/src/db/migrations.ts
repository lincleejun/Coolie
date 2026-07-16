import type Database from "better-sqlite3"
import { migrateCopilotCustomRows } from "../engine/copilot-migration.js"

interface Migration { id: string; up: (db: Database.Database) => void }

const MIGRATIONS: Migration[] = [
  {
    id: "m0001-core-tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_root TEXT NOT NULL UNIQUE,
          default_base_branch TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
          name TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL,
          base_branch TEXT NOT NULL, base_ref TEXT NOT NULL, status TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          archived_at INTEGER, data TEXT);
        CREATE TABLE tabs (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          kind TEXT NOT NULL, engine_id TEXT, engine_session_id TEXT,
          tmux_window INTEGER, title TEXT, status TEXT, data TEXT);
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT,
          type TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL);
      `)
    },
  },
  {
    id: "m0002-workspace-indexes",
    up: (db) => {
      db.exec(`
        CREATE UNIQUE INDEX idx_workspaces_project_name   ON workspaces(project_id, name);
        CREATE UNIQUE INDEX idx_workspaces_project_branch ON workspaces(project_id, branch);
        CREATE UNIQUE INDEX idx_workspaces_path           ON workspaces(path);
        CREATE INDEX idx_events_workspace_seq             ON events(workspace_id, seq);
      `)
    },
  },
  {
    id: "m0003-prompt-queue",
    up: (db) => {
      db.exec(`
        CREATE TABLE prompt_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          tab_id TEXT NOT NULL,
          text TEXT NOT NULL,
          mode TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'inflight')),
          created_at INTEGER NOT NULL);
        CREATE INDEX idx_queue_ws_id ON prompt_queue(workspace_id, id);
      `)
    },
  },
  {
    id: "m0004-prompt-queue-state",
    up: (db) => {
      const columns = db.prepare("PRAGMA table_info(prompt_queue)").all() as Array<{ name: string }>
      if (!columns.some((column) => column.name === "state"))
        db.exec("ALTER TABLE prompt_queue ADD COLUMN state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'inflight'))")
    },
  },
  {
    id: "m0005-kobe-task-semantics",
    up: (db) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get())
        return
      const columns = new Set(
        (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map((column) => column.name),
      )
      if (!columns.has("task_status"))
        db.exec("ALTER TABLE workspaces ADD COLUMN task_status TEXT NOT NULL DEFAULT 'backlog'")
      if (!columns.has("kind"))
        db.exec("ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'")
      if (!columns.has("materialized"))
        db.exec("ALTER TABLE workspaces ADD COLUMN materialized INTEGER NOT NULL DEFAULT 1")
      if (!columns.has("sort_order"))
        db.exec("ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")

      db.exec(`
        UPDATE workspaces
        SET task_status = CASE status
          WHEN 'archived' THEN 'done'
          WHEN 'error' THEN 'error'
          ELSE 'in_progress'
        END,
        kind = 'task',
        materialized = 1,
        sort_order = created_at;

        UPDATE workspaces
        SET kind = 'main', task_status = 'in_progress', materialized = 1, sort_order = -1
        WHERE id IN (
          SELECT w.id FROM workspaces w
          JOIN projects p ON p.id = w.project_id
          WHERE w.path = p.repo_root
        );

        DROP INDEX IF EXISTS idx_workspaces_project_branch;
        CREATE UNIQUE INDEX idx_workspaces_project_branch
          ON workspaces(project_id, branch) WHERE kind = 'task';

        INSERT OR IGNORE INTO workspaces
          (id, project_id, name, path, branch, base_branch, base_ref, status, pinned,
           created_at, archived_at, data, task_status, kind, materialized, sort_order)
        SELECT
          'main-' || p.id, p.id, p.name || ' (main)', p.repo_root,
          p.default_base_branch, p.default_base_branch, 'HEAD', 'active', 0,
          p.created_at, NULL, '{"portBase":0,"ownership":"managed"}',
          'in_progress', 'main', 1, -1
        FROM projects p
        WHERE NOT EXISTS (
          SELECT 1 FROM workspaces w WHERE w.project_id = p.id AND w.kind = 'main'
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_one_main
          ON workspaces(project_id) WHERE kind = 'main';
        CREATE INDEX IF NOT EXISTS idx_workspaces_project_sort
          ON workspaces(project_id, sort_order, created_at);
      `)
    },
  },
  {
    id: "m0006-custom-engines",
    up: (db) => {
      db.exec(`
        CREATE TABLE custom_engines (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          definition TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
    },
  },
  {
    id: "m0007-main-base-ref",
    up: (db) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get())
        return
      const columns = new Set(
        (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map((column) => column.name),
      )
      if (!columns.has("kind")) return
      db.prepare("UPDATE workspaces SET base_ref = 'HEAD' WHERE kind = 'main' AND base_ref <> 'HEAD'").run()
    },
  },
  {
    id: "m0008-input-receipts",
    up: (db) => {
      db.exec(`
        CREATE TABLE input_receipts (
          workspace_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          body_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, idempotency_key)
        );
        CREATE INDEX idx_input_receipts_expires_at ON input_receipts(expires_at);
      `)
    },
  },
  {
    id: "m0009-attention-items",
    up: (db) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get())
        return
      db.exec(`
        CREATE TABLE attention_items (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          source_event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
          session_turn_id TEXT,
          summary TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('open', 'acknowledged')),
          created_at INTEGER NOT NULL,
          acknowledged_at INTEGER
        );
        CREATE INDEX idx_attention_items_workspace_state
          ON attention_items(workspace_id, state, created_at, id);
        CREATE INDEX idx_attention_items_tab
          ON attention_items(tab_id, state);
      `)

      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tabs'").get())
        return

      const awaiting = db.prepare(`
        SELECT t.id AS tabId, t.workspace_id AS workspaceId, t.engine_session_id AS sessionTurnId,
               COALESCE(t.title, 'Awaiting input') AS summary
        FROM tabs t
        WHERE t.kind = 'engine' AND t.status = 'awaiting-input'
      `).all() as Array<{
        tabId: string
        workspaceId: string
        sessionTurnId: string | null
        summary: string
      }>

      const insertEvent = db.prepare(`
        INSERT INTO events (workspace_id, type, payload, ts)
        VALUES (?, 'attention.migrated', ?, ?)
      `)
      const insertItem = db.prepare(`
        INSERT INTO attention_items
          (id, workspace_id, tab_id, kind, source, source_event_seq, session_turn_id,
           summary, state, created_at, acknowledged_at)
        VALUES (?, ?, ?, 'turn-finished', 'hook', ?, ?, ?, 'open', ?, NULL)
      `)

      const now = Date.now()
      for (const row of awaiting) {
        const payload = JSON.stringify({
          tabId: row.tabId,
          reason: "awaiting-input-backfill",
        })
        const event = insertEvent.run(row.workspaceId, payload, now)
        const sourceEventSeq = Number(event.lastInsertRowid)
        insertItem.run(
          `attn-mig-${row.tabId}`,
          row.workspaceId,
          row.tabId,
          sourceEventSeq,
          row.sessionTurnId,
          row.summary,
          now,
        )
      }
    },
  },
  {
    id: "m0010-project-scripts-runs",
    up: (db) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get())
        return
      db.exec(`
        CREATE TABLE project_scripts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          script_type TEXT NOT NULL CHECK (script_type IN ('setup', 'run', 'archive')),
          scope TEXT NOT NULL CHECK (scope IN ('project', 'workspace')),
          command TEXT NOT NULL,
          args_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (project_id, run_id)
        );
        CREATE INDEX idx_project_scripts_project_type
          ON project_scripts(project_id, script_type, run_id);

        CREATE TABLE run_instances (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          script_type TEXT NOT NULL CHECK (script_type IN ('setup', 'run', 'archive')),
          status TEXT NOT NULL CHECK (status IN ('running', 'exited', 'error')),
          started_at INTEGER NOT NULL,
          exited_at INTEGER,
          exit_code INTEGER,
          UNIQUE (workspace_id, run_id)
        );
        CREATE INDEX idx_run_instances_workspace_status
          ON run_instances(workspace_id, status, started_at, id);

        CREATE TABLE run_log_metadata (
          id TEXT PRIMARY KEY,
          run_instance_id TEXT NOT NULL REFERENCES run_instances(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          script_type TEXT NOT NULL CHECK (script_type IN ('setup', 'run', 'archive')),
          bytes INTEGER NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_run_log_metadata_workspace
          ON run_log_metadata(workspace_id, updated_at DESC, id);
      `)
    },
  },
  {
    id: "m0011-copilot-builtin-migration",
    up: (db) => {
      migrateCopilotCustomRows(db)
    },
  },
]

export const runMigrations = (db: Database.Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((r: any) => r.id))
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    const tx = db.transaction(() => {
      m.up(db)
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, Date.now())
    })
    tx()
  }
}
