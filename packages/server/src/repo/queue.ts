import type Database from "better-sqlite3"
import type { CoolieEvent } from "@coolie/protocol"
import { Context, Effect, Layer, Option } from "effect"
import { Db } from "../db/sqlite.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { appendEventRow } from "./events.js"

export interface QueuedPrompt {
  readonly id: number
  readonly workspaceId: string
  readonly tabId: string
  readonly text: string
  readonly mode: "send"
  readonly state: "queued" | "inflight"
  readonly createdAt: number
}

const rowToQueued = (row: any): QueuedPrompt => ({
  id: row.id,
  workspaceId: row.workspace_id,
  tabId: row.tab_id,
  text: row.text,
  mode: row.mode,
  state: row.state,
  createdAt: row.created_at,
})

export interface QueueRepoShape {
  readonly enqueue: (entry: { workspaceId: string; tabId: string; text: string }) =>
    Effect.Effect<{ id: number; position: number }>
  readonly peekNext: (workspaceId: string) => Effect.Effect<QueuedPrompt | null>
  readonly claimNext: (workspaceId: string) => Effect.Effect<QueuedPrompt | null>
  readonly listQueued: (workspaceId: string) => Effect.Effect<QueuedPrompt[]>
  readonly withdraw: (id: number, workspaceId: string) =>
    Effect.Effect<{ status: "withdrawn" | "inflight" | "missing"; prompt?: QueuedPrompt }>
  readonly delivered: (id: number) => Effect.Effect<boolean>
  readonly release: (id: number, reason?: string) => Effect.Effect<boolean>
  readonly recoverInflight: () => Effect.Effect<number>
  readonly listWorkspaceIds: () => Effect.Effect<string[]>
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
      position = (db.prepare("SELECT COUNT(*) AS n FROM prompt_queue WHERE workspace_id = ? AND state = 'queued'")
        .get(workspaceId) as { n: number }).n
      event = appendEventRow(db, {
        workspaceId,
        type: "prompt.queued",
        payload: { tabId, queueId: id, position, chars: text.length },
      })
    })()
    broadcast(event)
    return { id, position }
  }),
  peekNext: (workspaceId) => Effect.sync(() => {
    const row = db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? AND state = 'queued' ORDER BY id ASC LIMIT 1").get(workspaceId)
    return row ? rowToQueued(row) : null
  }),
  claimNext: (workspaceId) => Effect.sync(() => {
    let claimed: QueuedPrompt | null = null
    db.transaction(() => {
      const row = db.prepare(
        "SELECT * FROM prompt_queue WHERE workspace_id = ? AND state = 'queued' ORDER BY id ASC LIMIT 1",
      ).get(workspaceId)
      if (!row) return
      const changed = db.prepare("UPDATE prompt_queue SET state = 'inflight' WHERE id = ? AND state = 'queued'")
        .run((row as any).id).changes
      if (changed === 1) claimed = rowToQueued({ ...(row as any), state: "inflight" })
    })()
    return claimed
  }),
  listQueued: (workspaceId) => Effect.sync(() =>
    db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? AND state = 'queued' ORDER BY id ASC").all(workspaceId).map(rowToQueued)),
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
        payload: { tabId: prompt.tabId, queueId: id },
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
        payload: { tabId: prompt.tabId, queueId: id },
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
          payload: { tabId: prompt.tabId, queueId: id, reason },
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
