import { Context, Effect, Layer, Option } from "effect"
import type Database from "better-sqlite3"
import type { CoolieEvent } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"

/** 只写 events 行、不广播——供各 repo 在自己的 db.transaction 里复用（写库与事件原子）。 */
export const appendEventRow = (
  db: Database.Database,
  e: { workspaceId: string | null; type: string; payload: unknown },
): CoolieEvent => {
  const ts = Date.now()
  const res = db
    .prepare("INSERT INTO events (workspace_id, type, payload, ts) VALUES (?,?,?,?)")
    .run(e.workspaceId, e.type, JSON.stringify(e.payload ?? null), ts)
  return { seq: Number(res.lastInsertRowid), workspaceId: e.workspaceId, type: e.type, payload: e.payload ?? null, ts }
}

export interface EventsRepoShape {
  readonly append: (e: { workspaceId: string | null; type: string; payload: unknown }) => Effect.Effect<number>
  readonly listAfter: (opts: { after: number; limit?: number; workspaceId?: string }) => Effect.Effect<CoolieEvent[]>
}
export class EventsRepo extends Context.Tag("EventsRepo")<EventsRepo, EventsRepoShape>() {}

export const EventsRepoLive = Layer.effect(
  EventsRepo,
  Effect.gen(function* () {
    const db = yield* Db
    // EventsBus 是可选依赖（serviceOption 不产生新的 R 需求）：
    // 组合里提供了就广播 live 事件，没提供（Plan 1 的既有测试）行为不变。
    const bus = yield* Effect.serviceOption(EventsBus)
    return {
      append: (e) => Effect.sync(() => {
        const ev = appendEventRow(db, e)
        if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, ev)
        return ev.seq
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
