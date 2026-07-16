/** Migrate legacy Copilot custom-engine rows onto the built-in identity (Task 3.2). */

export const BUILTIN_ENGINE_IDS = ["claude", "codex", "copilot"] as const
export type BuiltinEngineId = (typeof BUILTIN_ENGINE_IDS)[number]

export const isBuiltinEngineId = (id: string): id is BuiltinEngineId =>
  (BUILTIN_ENGINE_IDS as readonly string[]).includes(id)

export type CopilotMigrationShape =
  | "absent"
  | "preset"
  | "custom-conflict"
  | "custom-non-copilot-id"

export type CopilotMigrationResult = {
  readonly shape: CopilotMigrationShape
  readonly removedPreset: boolean
  readonly renamedFrom: string | null
  readonly renamedTo: string | null
  readonly tabsUpdated: number
}

type EngineRow = { id: string; definition: string }

const parseDefinition = (raw: string): { presetId?: unknown } => {
  try { return JSON.parse(raw) as { presetId?: unknown } } catch { return {} }
}

const pickRenameId = (db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }, base: string): string => {
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? `${base}-custom` : `${base}-custom-${i}`
    if (!db.prepare("SELECT 1 FROM custom_engines WHERE id = ?").get(candidate)) return candidate
  }
  return `${base}-custom-${Date.now()}`
}

/**
 * Conflict shapes:
 * 1. absent — no custom row for id=copilot
 * 2. preset — row id=copilot with presetId=copilot → delete (built-in owns id)
 * 3. custom-conflict — row id=copilot without that preset → rename + retarget tabs
 * 4. custom-non-copilot-id — preset-shaped row under another id is left alone (still valid custom install)
 */
export const migrateCopilotCustomRows = (db: {
  prepare: (sql: string) => any
  exec?: (sql: string) => void
}): CopilotMigrationResult => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_engines'").get())
    return { shape: "absent", removedPreset: false, renamedFrom: null, renamedTo: null, tabsUpdated: 0 }

  const row = db.prepare("SELECT id, definition FROM custom_engines WHERE id = ?").get("copilot") as EngineRow | undefined
  if (!row)
    return { shape: "absent", removedPreset: false, renamedFrom: null, renamedTo: null, tabsUpdated: 0 }

  const definition = parseDefinition(row.definition)
  if (definition.presetId === "copilot") {
    db.prepare("DELETE FROM custom_engines WHERE id = ?").run("copilot")
    return { shape: "preset", removedPreset: true, renamedFrom: null, renamedTo: null, tabsUpdated: 0 }
  }

  const renamedTo = pickRenameId(db, "copilot")
  const now = Date.now()
  // Rewrite PK: insert renamed row, delete old, retarget tabs.
  const full = db.prepare("SELECT id, display_name, enabled, definition, created_at, updated_at FROM custom_engines WHERE id = ?").get("copilot") as {
    id: string; display_name: string; enabled: number; definition: string; created_at: number; updated_at: number
  }
  let nextDefinition = full.definition
  try {
    const parsed = JSON.parse(full.definition) as Record<string, unknown>
    parsed.id = renamedTo
    nextDefinition = JSON.stringify(parsed)
  } catch { /* keep raw definition */ }

  db.prepare(`INSERT INTO custom_engines (id, display_name, enabled, definition, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(renamedTo, full.display_name, full.enabled, nextDefinition, full.created_at, now)
  db.prepare("DELETE FROM custom_engines WHERE id = ?").run("copilot")

  let tabsUpdated = 0
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tabs'").get()) {
    const result = db.prepare("UPDATE tabs SET engine_id = ? WHERE engine_id = ?").run(renamedTo, "copilot")
    tabsUpdated = Number(result.changes ?? 0)
  }

  return {
    shape: "custom-conflict",
    removedPreset: false,
    renamedFrom: "copilot",
    renamedTo,
    tabsUpdated,
  }
}

/** Best-effort inverse for tests: restore a deleted preset row or undo a rename. */
export const rollbackCopilotMigration = (
  db: { prepare: (sql: string) => any },
  snapshot: {
    readonly shape: CopilotMigrationShape
    readonly presetRow?: { id: string; display_name: string; enabled: number; definition: string; created_at: number; updated_at: number }
    readonly renamedTo?: string | null
    readonly tabsUpdated?: number
  },
): void => {
  if (snapshot.shape === "preset" && snapshot.presetRow) {
    const r = snapshot.presetRow
    db.prepare(`INSERT OR REPLACE INTO custom_engines (id, display_name, enabled, definition, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(r.id, r.display_name, r.enabled, r.definition, r.created_at, r.updated_at)
    return
  }
  if (snapshot.shape === "custom-conflict" && snapshot.renamedTo) {
    const row = db.prepare("SELECT id, display_name, enabled, definition, created_at, updated_at FROM custom_engines WHERE id = ?")
      .get(snapshot.renamedTo) as {
      id: string; display_name: string; enabled: number; definition: string; created_at: number; updated_at: number
    } | undefined
    if (!row) return
    let definition = row.definition
    try {
      const parsed = JSON.parse(row.definition) as Record<string, unknown>
      parsed.id = "copilot"
      definition = JSON.stringify(parsed)
    } catch { /* keep */ }
    db.prepare(`INSERT INTO custom_engines (id, display_name, enabled, definition, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("copilot", row.display_name, row.enabled, definition, row.created_at, row.updated_at)
    db.prepare("DELETE FROM custom_engines WHERE id = ?").run(snapshot.renamedTo)
    if (snapshot.tabsUpdated && snapshot.tabsUpdated > 0)
      db.prepare("UPDATE tabs SET engine_id = ? WHERE engine_id = ?").run("copilot", snapshot.renamedTo)
  }
}
