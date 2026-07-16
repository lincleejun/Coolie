import type Database from "better-sqlite3"

export interface CopyManifestEntry {
  readonly workspaceId: string
  readonly relativePath: string
  readonly size: number
  readonly mtimeMs: number
  readonly mode: number
  readonly ruleSource: string
  readonly copiedAt: number
}

export const ensureCopyManifestTable = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copy_manifest_entries (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      mode INTEGER NOT NULL,
      rule_source TEXT NOT NULL,
      copied_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_copy_manifest_workspace
      ON copy_manifest_entries(workspace_id, copied_at DESC);
  `)
}

export const replaceCopyManifest = (
  db: Database.Database,
  workspaceId: string,
  entries: readonly CopyManifestEntry[],
): void => {
  ensureCopyManifestTable(db)
  db.transaction(() => {
    db.prepare("DELETE FROM copy_manifest_entries WHERE workspace_id = ?").run(workspaceId)
    const insert = db.prepare(`
      INSERT INTO copy_manifest_entries
        (workspace_id, relative_path, size, mtime_ms, mode, rule_source, copied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const entry of entries)
      insert.run(
        entry.workspaceId,
        entry.relativePath,
        entry.size,
        entry.mtimeMs,
        entry.mode,
        entry.ruleSource,
        entry.copiedAt,
      )
  })()
}

export const listCopyManifest = (
  db: Database.Database,
  workspaceId: string,
): CopyManifestEntry[] => {
  ensureCopyManifestTable(db)
  return (db.prepare(`
    SELECT workspace_id AS workspaceId, relative_path AS relativePath, size, mtime_ms AS mtimeMs,
           mode, rule_source AS ruleSource, copied_at AS copiedAt
    FROM copy_manifest_entries
    WHERE workspace_id = ?
    ORDER BY relative_path ASC
  `).all(workspaceId) as CopyManifestEntry[])
}
