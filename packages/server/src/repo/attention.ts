import { Context, Effect, Layer } from "effect"
import { ulid } from "ulid"
import {
  type AttentionFilter,
  type AttentionItem,
  type CompletionSignal,
  decodeAttentionItemStrict,
} from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { ConflictError, NotFoundError } from "./errors.js"

const rowToItem = (r: any): AttentionItem => decodeAttentionItemStrict({
  id: r.id,
  workspaceId: r.workspace_id,
  tabId: r.tab_id,
  kind: r.kind,
  source: r.source,
  sourceEventSeq: r.source_event_seq,
  sessionTurnId: r.session_turn_id ?? null,
  summary: r.summary,
  state: r.state,
  createdAt: r.created_at,
  acknowledgedAt: r.acknowledged_at ?? null,
})

export interface AttentionInboxShape {
  readonly record: (signal: CompletionSignal) => Effect.Effect<AttentionItem>
  readonly get: (id: string) => Effect.Effect<AttentionItem, NotFoundError>
  readonly list: (filter?: AttentionFilter) => Effect.Effect<AttentionItem[]>
  readonly acknowledge: (
    id: string,
    expectedEpisode?: string | null,
    now?: number,
  ) => Effect.Effect<AttentionItem, NotFoundError | ConflictError>
}

export class AttentionInbox extends Context.Tag("AttentionInbox")<
  AttentionInbox,
  AttentionInboxShape
>() {}

export const makeAttentionInbox = (db: import("better-sqlite3").Database): AttentionInboxShape => {
  const findBySourceEventSeq = (sourceEventSeq: number): AttentionItem | null => {
    const row = db.prepare("SELECT * FROM attention_items WHERE source_event_seq = ?").get(sourceEventSeq)
    return row ? rowToItem(row) : null
  }

  return {
    record: (signal) => Effect.sync(() => {
      const existing = findBySourceEventSeq(signal.sourceEventSeq)
      if (existing) return existing
      const id = ulid()
      const createdAt = signal.createdAt ?? Date.now()
      db.prepare(`
        INSERT INTO attention_items
          (id, workspace_id, tab_id, kind, source, source_event_seq, session_turn_id,
           summary, state, created_at, acknowledged_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)
      `).run(
        id,
        signal.workspaceId,
        signal.tabId,
        signal.kind,
        signal.source,
        signal.sourceEventSeq,
        signal.sessionTurnId ?? null,
        signal.summary,
        createdAt,
      )
      return rowToItem(db.prepare("SELECT * FROM attention_items WHERE id = ?").get(id))
    }),

    get: (id) => Effect.sync(() => {
      const row = db.prepare("SELECT * FROM attention_items WHERE id = ?").get(id)
      if (!row) throw new NotFoundError({ message: `attention item 不存在：${id}` })
      return rowToItem(row)
    }),

    list: (filter = {}) => Effect.sync(() => {
      const clauses: string[] = []
      const params: unknown[] = []
      if (filter.workspaceId) { clauses.push("workspace_id = ?"); params.push(filter.workspaceId) }
      if (filter.kind) { clauses.push("kind = ?"); params.push(filter.kind) }
      if (filter.state) { clauses.push("state = ?"); params.push(filter.state) }
      if (filter.cursorCreatedAt !== undefined && filter.cursorId) {
        clauses.push("(created_at > ? OR (created_at = ? AND id > ?))")
        params.push(filter.cursorCreatedAt, filter.cursorCreatedAt, filter.cursorId)
      }
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
      const rows = db.prepare(`
        SELECT * FROM attention_items ${where}
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `).all(...params, limit)
      return rows.map(rowToItem)
    }),

    acknowledge: (id, expectedEpisode, now = Date.now()) => Effect.gen(function* () {
      const row = db.prepare("SELECT * FROM attention_items WHERE id = ?").get(id)
      if (!row) return yield* new NotFoundError({ message: `attention item 不存在：${id}` })
      const item = rowToItem(row)
      if (item.state === "acknowledged") return item
      if (expectedEpisode !== undefined && expectedEpisode !== item.sessionTurnId)
        return yield* new ConflictError({ message: "expectedEpisode does not match current attention episode" })
      db.prepare(`
        UPDATE attention_items
        SET state = 'acknowledged', acknowledged_at = ?
        WHERE id = ?
      `).run(now, id)
      return rowToItem(db.prepare("SELECT * FROM attention_items WHERE id = ?").get(id))
    }),
  }
}

export const AttentionInboxLive = Layer.effect(
  AttentionInbox,
  Effect.gen(function* () {
    const db = yield* Db
    return makeAttentionInbox(db)
  }),
)

/** Test helper: direct repo without Effect layer wiring. */
export { rowToItem as attentionRowToItem }
