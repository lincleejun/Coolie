import type Database from "better-sqlite3"
import type { CoolieEvent } from "@coolie/protocol"
import { QUEUE_DELIVERY_GUARANTEE, queueMessageId } from "@coolie/protocol"
import { Context, Effect, Layer, Option } from "effect"
import { Db } from "../db/sqlite.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { appendEventRow } from "./events.js"

export interface QueuedPrompt {
  readonly id: number
  readonly queueId: number
  readonly messageId: string
  readonly workspaceId: string
  readonly tabId: string
  readonly text: string
  readonly mode: "send"
  readonly state: "queued" | "inflight"
  readonly createdAt: number
}

const rowToQueued = (row: any): QueuedPrompt => ({
  id: row.id,
  queueId: row.id,
  messageId: queueMessageId(row.id),
  workspaceId: row.workspace_id,
  tabId: row.tab_id,
  text: row.text,
  mode: row.mode,
  state: row.state,
  createdAt: row.created_at,
})

export interface QueueRepoShape {
  readonly enqueue: (entry: { workspaceId: string; tabId: string; text: string }) =>
    Effect.Effect<{
      id: number
      queueId: number
      messageId: string
      position: number
      deliveryGuarantee: typeof QUEUE_DELIVERY_GUARANTEE
    }>
  readonly peekNext: (workspaceId: string, tabId?: string) => Effect.Effect<QueuedPrompt | null>
  readonly claimNext: (workspaceId: string, tabId?: string) => Effect.Effect<QueuedPrompt | null>
  readonly listQueued: (workspaceId: string, tabId?: string) => Effect.Effect<QueuedPrompt[]>
  readonly withdraw: (id: number, workspaceId: string) =>
    Effect.Effect<{ status: "withdrawn" | "inflight" | "missing"; prompt?: QueuedPrompt }>
  readonly delivered: (id: number) => Effect.Effect<boolean>
  readonly release: (id: number, reason?: string) => Effect.Effect<boolean>
  readonly recoverInflight: () => Effect.Effect<number>
  readonly listWorkspaceIds: () => Effect.Effect<string[]>
  readonly listTargets: () => Effect.Effect<Array<{ workspaceId: string; tabId: string }>>
  readonly clearWorkspace: (workspaceId: string) => Effect.Effect<number>
}

export class QueueRepo extends Context.Tag("QueueRepo")<QueueRepo, QueueRepoShape>() {}

export const makeQueueRepo = (
  db: Database.Database,
  broadcast: (event: CoolieEvent) => void,
): QueueRepoShape => ({
  enqueue: ({ workspaceId, tabId, text }) => Effect.sync(() => {
    let id = 0
    let position = 0
    let event!: CoolieEvent
    db.transaction(() => {
      const result = db.prepare(
        "INSERT INTO prompt_queue (workspace_id, tab_id, text, mode, created_at) VALUES (?, ?, ?, 'send', ?)",
      ).run(workspaceId, tabId, text, Date.now())
      id = Number(result.lastInsertRowid)
      position = (db.prepare(
        "SELECT COUNT(*) AS n FROM prompt_queue WHERE workspace_id = ? AND tab_id = ? AND state = 'queued'",
      ).get(workspaceId, tabId) as { n: number }).n
      event = appendEventRow(db, {
        workspaceId,
        type: "prompt.queued",
        payload: { tabId, queueId: id, messageId: queueMessageId(id), position, chars: text.length },
      })
    })()
    broadcast(event)
    return {
      id,
      queueId: id,
      messageId: queueMessageId(id),
      position,
      deliveryGuarantee: QUEUE_DELIVERY_GUARANTEE,
    }
  }),
  peekNext: (workspaceId, tabId) => Effect.sync(() => {
    const row = tabId === undefined
      ? db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? AND state = 'queued' ORDER BY id ASC LIMIT 1").get(workspaceId)
      : db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? AND tab_id = ? AND state = 'queued' ORDER BY id ASC LIMIT 1").get(workspaceId, tabId)
    return row ? rowToQueued(row) : null
  }),
  claimNext: (workspaceId, tabId) => Effect.sync(() => {
    let claimed: QueuedPrompt | null = null
    db.transaction(() => {
      const row = tabId === undefined
        ? db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? AND state = 'queued' ORDER BY id ASC LIMIT 1").get(workspaceId)
        : db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? AND tab_id = ? AND state = 'queued' ORDER BY id ASC LIMIT 1").get(workspaceId, tabId)
      if (!row) return
      const changed = db.prepare("UPDATE prompt_queue SET state = 'inflight' WHERE id = ? AND state = 'queued'")
        .run((row as any).id).changes
      if (changed === 1) claimed = rowToQueued({ ...(row as any), state: "inflight" })
    })()
    return claimed
  }),
  listQueued: (workspaceId, tabId) => Effect.sync(() =>
    (tabId === undefined
      ? db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? AND state = 'queued' ORDER BY id ASC").all(workspaceId)
      : db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? AND tab_id = ? AND state = 'queued' ORDER BY id ASC").all(workspaceId, tabId))
      .map(rowToQueued)),
  withdraw: (id, workspaceId) => Effect.sync(() => {
    let result: { status: "withdrawn" | "inflight" | "missing"; prompt?: QueuedPrompt } = { status: "missing" }
    let event: CoolieEvent | null = null
    db.transaction(() => {
      const row = db.prepare("SELECT * FROM prompt_queue WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
      if (!row) return
      const prompt = rowToQueued(row)
      if (prompt.state === "inflight") { result = { status: "inflight" }; return }
      const changed = db.prepare("DELETE FROM prompt_queue WHERE id = ? AND state = 'queued'").run(id).changes
      if (changed !== 1) { result = { status: "inflight" }; return }
      result = { status: "withdrawn", prompt }
      event = appendEventRow(db, {
        workspaceId: prompt.workspaceId,
        type: "prompt.withdrawn",
        payload: { tabId: prompt.tabId, queueId: id, messageId: prompt.messageId },
      })
    })()
    if (event) broadcast(event)
    return result
  }),
  delivered: (id) => Effect.sync(() => {
    let event: CoolieEvent | null = null
    const removed = db.transaction(() => {
      const row = db.prepare("SELECT * FROM prompt_queue WHERE id = ? AND state = 'inflight'").get(id)
      if (!row) return false
      const prompt = rowToQueued(row)
      if (db.prepare("DELETE FROM prompt_queue WHERE id = ? AND state = 'inflight'").run(id).changes !== 1) return false
      event = appendEventRow(db, {
        workspaceId: prompt.workspaceId, type: "prompt.delivered",
        payload: { tabId: prompt.tabId, queueId: id, messageId: prompt.messageId },
      })
      return true
    })()
    if (event) broadcast(event)
    return removed
  }),
  release: (id, reason) => Effect.sync(() => {
    let event: CoolieEvent | null = null
    const released = db.transaction(() => {
      const row = db.prepare("SELECT * FROM prompt_queue WHERE id = ? AND state = 'inflight'").get(id)
      if (!row) return false
      if (db.prepare("UPDATE prompt_queue SET state = 'queued' WHERE id = ? AND state = 'inflight'").run(id).changes !== 1)
        return false
      if (reason !== undefined) {
        const prompt = rowToQueued(row)
        event = appendEventRow(db, {
          workspaceId: prompt.workspaceId, type: "prompt.delivery.failed",
          payload: { tabId: prompt.tabId, queueId: id, messageId: prompt.messageId, reason },
        })
      }
      return true
    })()
    if (event) broadcast(event)
    return released
  }),
  recoverInflight: () => Effect.sync(() =>
    db.prepare("UPDATE prompt_queue SET state = 'queued' WHERE state = 'inflight'").run().changes),
  listWorkspaceIds: () => Effect.sync(() =>
    (db.prepare("SELECT DISTINCT workspace_id FROM prompt_queue ORDER BY workspace_id").all() as Array<{ workspace_id: string }>)
      .map((row) => row.workspace_id)),
  listTargets: () => Effect.sync(() =>
    (db.prepare("SELECT DISTINCT workspace_id, tab_id FROM prompt_queue ORDER BY workspace_id, tab_id")
      .all() as Array<{ workspace_id: string; tab_id: string }>)
      .map((row) => ({ workspaceId: row.workspace_id, tabId: row.tab_id }))),
  clearWorkspace: (workspaceId) => Effect.sync(() =>
    db.prepare("DELETE FROM prompt_queue WHERE workspace_id = ?").run(workspaceId).changes),
})

export const QueueRepoLive = Layer.effect(
  QueueRepo,
  Effect.gen(function* () {
    const db = yield* Db
    const bus = yield* Effect.serviceOption(EventsBus)
    return makeQueueRepo(db, (event) => {
      if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, event)
    })
  }),
)
