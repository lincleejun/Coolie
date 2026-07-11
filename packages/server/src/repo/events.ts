import { Context, Effect, Layer } from "effect"
import type { CoolieEvent } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"

export interface EventsRepoShape {
  readonly append: (e: { workspaceId: string | null; type: string; payload: unknown }) => Effect.Effect<number>
  readonly listAfter: (opts: { after: number; limit?: number; workspaceId?: string }) => Effect.Effect<CoolieEvent[]>
}
export class EventsRepo extends Context.Tag("EventsRepo")<EventsRepo, EventsRepoShape>() {}

export const EventsRepoLive = Layer.effect(
  EventsRepo,
  Effect.gen(function* () {
    const db = yield* Db
    return {
      append: (e) => Effect.sync(() => {
        const res = db
          .prepare("INSERT INTO events (workspace_id, type, payload, ts) VALUES (?,?,?,?)")
          .run(e.workspaceId, e.type, JSON.stringify(e.payload ?? null), Date.now())
        return Number(res.lastInsertRowid)
      }),
      listAfter: ({ after, limit = 200, workspaceId }) => Effect.sync(() => {
        const rows = workspaceId
          ? db.prepare("SELECT * FROM events WHERE seq > ? AND workspace_id = ? ORDER BY seq LIMIT ?").all(after, workspaceId, limit)
          : db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit)
        return rows.map((r: any) => ({
          seq: r.seq, workspaceId: r.workspace_id, type: r.type,
          payload: JSON.parse(r.payload), ts: r.ts,
        }))
      }),
    }
  }),
)
