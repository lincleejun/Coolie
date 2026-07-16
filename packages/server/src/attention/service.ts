import { Context, Effect, Layer, Option } from "effect"
import { ulid } from "ulid"
import type Database from "better-sqlite3"
import {
  type AttentionItem,
  type AttentionKind,
  type AttentionSource,
  type CompletionSignal,
  type CoolieEvent,
  type Tab,
  type TabStatus,
} from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { appendEventRow } from "../repo/events.js"
import { NotFoundError } from "../repo/errors.js"
import { attentionRowToItem } from "../repo/attention.js"
import type { TabStatusSource } from "../repo/tabs.js"

const rowToTab = (r: any): Tab => {
  let data: any = {}
  try { data = r.data ? JSON.parse(r.data) : {} } catch { /* ignore */ }
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    engineId: r.engine_id ?? null,
    engineSessionId: r.engine_session_id ?? null,
    tmuxWindow: r.tmux_window ?? null,
    title: r.title ?? null,
    status: (r.status ?? "idle") as TabStatus,
    lastHookAt: typeof data.lastHookAt === "number" ? data.lastHookAt : null,
  } as Tab
}

export interface CompletionWriteInput {
  readonly tabId: string
  readonly workspaceId: string
  readonly status: TabStatus
  readonly statusSource: TabStatusSource
  readonly kind: AttentionKind
  readonly attentionSource: AttentionSource
  readonly sessionTurnId?: string | null
  readonly summary: string
  readonly turnFinished?: {
    readonly sessionId: string | null
    readonly source?: string
  }
}

export interface CompletionWriteResult {
  readonly tab: Tab
  readonly attention: AttentionItem | null
  readonly events: readonly CoolieEvent[]
}

const findAttentionBySourceEventSeq = (db: Database.Database, sourceEventSeq: number): AttentionItem | null => {
  const row = db.prepare("SELECT * FROM attention_items WHERE source_event_seq = ?").get(sourceEventSeq)
  return row ? attentionRowToItem(row) : null
}

const recordAttentionInTx = (
  db: Database.Database,
  signal: CompletionSignal,
): AttentionItem => {
  const existing = findAttentionBySourceEventSeq(db, signal.sourceEventSeq)
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
  return attentionRowToItem(db.prepare("SELECT * FROM attention_items WHERE id = ?").get(id))
}

export interface AttentionCompletionShape {
  readonly apply: (input: CompletionWriteInput) => Effect.Effect<CompletionWriteResult, NotFoundError>
}

export class AttentionCompletion extends Context.Tag("AttentionCompletion")<
  AttentionCompletion,
  AttentionCompletionShape
>() {}

export const makeAttentionCompletion = (
  db: Database.Database,
  bus: Option.Option<import("node:events").EventEmitter>,
): AttentionCompletionShape => {
  const broadcast = (ev: CoolieEvent): void => {
    if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, ev)
  }

  return {
    apply: (input) => Effect.sync(() => {
      const row = db.prepare("SELECT * FROM tabs WHERE id = ?").get(input.tabId)
      if (!row) throw new NotFoundError({ message: `tab 不存在：${input.tabId}` })

      // Poller inferred completion: one attention item per awaiting-input cycle.
      if (row.status === input.status && input.statusSource === "poller") {
        return { tab: rowToTab(row), attention: null, events: [] }
      }
      if (row.status === input.status) {
        return { tab: rowToTab(row), attention: null, events: [] }
      }

      const events: CoolieEvent[] = []
      let attention: AttentionItem | null = null

      db.transaction(() => {
        db.prepare("UPDATE tabs SET status = ? WHERE id = ?").run(input.status, input.tabId)
        const statusEv = appendEventRow(db, {
          workspaceId: input.workspaceId,
          type: "tab.status.changed",
          payload: { tabId: input.tabId, status: input.status, source: input.statusSource },
        })
        events.push(statusEv)

        let sourceEventSeq = statusEv.seq
        if (input.turnFinished) {
          const finishedEv = appendEventRow(db, {
            workspaceId: input.workspaceId,
            type: "engine.turn.finished",
            payload: {
              tabId: input.tabId,
              sessionId: input.turnFinished.sessionId,
              ...(input.turnFinished.source ? { source: input.turnFinished.source } : {}),
            },
          })
          events.push(finishedEv)
          sourceEventSeq = finishedEv.seq
        }

        attention = recordAttentionInTx(db, {
          workspaceId: input.workspaceId,
          tabId: input.tabId,
          kind: input.kind,
          source: input.attentionSource,
          sourceEventSeq,
          sessionTurnId: input.sessionTurnId ?? null,
          summary: input.summary,
        })
      })()

      for (const ev of events) broadcast(ev)
      return { tab: rowToTab(db.prepare("SELECT * FROM tabs WHERE id = ?").get(input.tabId)), attention, events }
    }),
  }
}

export const AttentionCompletionLive = Layer.effect(
  AttentionCompletion,
  Effect.gen(function* () {
    const db = yield* Db
    const bus = yield* Effect.serviceOption(EventsBus)
    return makeAttentionCompletion(db, bus)
  }),
)
