import type Database from "better-sqlite3"
import { tmuxSessionName } from "@coolie/protocol"

interface LegacyRunRow {
  readonly id: string
  readonly workspaceId: string
  readonly tmuxWindow: number | null
}

/** Removes persisted run tabs from versions that still supported .coolie/run.sh. */
export const cleanupRemovedRunTabs = async (
  db: Database.Database,
  killWindow: (session: string, window: number) => Promise<void>,
  onError: (error: unknown) => void = () => {},
): Promise<number> => {
  const rows = db.prepare(`
    SELECT id, workspace_id AS workspaceId, tmux_window AS tmuxWindow
    FROM tabs WHERE kind = 'run'
  `).all() as LegacyRunRow[]

  for (const row of rows) {
    if (row.tmuxWindow === null) continue
    try {
      await killWindow(tmuxSessionName(row.workspaceId), row.tmuxWindow)
    } catch (error) {
      onError(error)
    }
  }

  db.transaction(() => {
    db.prepare("DELETE FROM prompt_queue WHERE tab_id IN (SELECT id FROM tabs WHERE kind = 'run')").run()
    db.prepare("DELETE FROM tabs WHERE kind = 'run'").run()
  })()
  return rows.length
}
