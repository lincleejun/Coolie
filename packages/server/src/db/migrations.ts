import type Database from "better-sqlite3"

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
