import { Context, Effect, Layer, Option } from "effect"
import { ulid } from "ulid"
import { Tab, type TabKind, type TabStatus, type CoolieEvent } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { NotFoundError } from "./errors.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { appendEventRow } from "./events.js"

const rowToTab = (r: any): Tab => {
  let data: any = {}
  try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 坏 JSON 视为无 data */ }
  return new Tab({
    id: r.id, workspaceId: r.workspace_id, kind: r.kind as TabKind,
    engineId: r.engine_id ?? null, engineSessionId: r.engine_session_id ?? null,
    tmuxWindow: r.tmux_window ?? null, title: r.title ?? null,
    status: (r.status ?? "idle") as TabStatus,
    lastHookAt: typeof data.lastHookAt === "number" ? data.lastHookAt : null,
  })
}

export type TabStatusSource = "hook" | "poller" | "wrapper" | "heal"

export interface TabsRepoShape {
  readonly insert: (t: {
    workspaceId: string; kind: TabKind
    engineId?: string; engineSessionId?: string; tmuxWindow?: number; title?: string
  }) => Effect.Effect<Tab>
  readonly get: (id: string) => Effect.Effect<Tab, NotFoundError>
  readonly listByWorkspace: (workspaceId: string) => Effect.Effect<Tab[]>
  readonly findEngineTab: (workspaceId: string) => Effect.Effect<Tab | null>
  readonly setStatus: (id: string, status: TabStatus, source: TabStatusSource) => Effect.Effect<Tab, NotFoundError>
  readonly setTitle: (id: string, title: string) => Effect.Effect<void, NotFoundError>
  readonly setEngineSessionId: (id: string, sessionId: string) => Effect.Effect<void, NotFoundError>
  readonly touchHookAt: (id: string, ts: number) => Effect.Effect<void, NotFoundError>
  readonly listEngineTabs: () => Effect.Effect<Array<{ tab: Tab; workspacePath: string }>>
  readonly removeByWorkspace: (workspaceId: string) => Effect.Effect<void>
}
export class TabsRepo extends Context.Tag("TabsRepo")<TabsRepo, TabsRepoShape>() {}

export const TabsRepoLive = Layer.effect(
  TabsRepo,
  Effect.gen(function* () {
    const db = yield* Db
    const bus = yield* Effect.serviceOption(EventsBus)
    const broadcast = (ev: CoolieEvent): void => { if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, ev) }
    const getRow = (id: string): any => db.prepare("SELECT * FROM tabs WHERE id = ?").get(id)
    const mustGetRow = (id: string) => Effect.gen(function* () {
      const r = getRow(id)
      if (!r) return yield* new NotFoundError({ message: `tab 不存在：${id}` })
      return r
    })

    return {
      insert: (t) => Effect.sync(() => {
        const id = ulid()
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare(`INSERT INTO tabs (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
            VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(id, t.workspaceId, t.kind, t.engineId ?? null, t.engineSessionId ?? null,
              t.tmuxWindow ?? null, t.title ?? null, "idle", "{}")
          ev = appendEventRow(db, {
            workspaceId: t.workspaceId, type: "tab.created",
            payload: { tabId: id, kind: t.kind, engineId: t.engineId ?? null, tmuxWindow: t.tmuxWindow ?? null },
          })
        })()
        broadcast(ev)
        return rowToTab(getRow(id))
      }),
      get: (id) => mustGetRow(id).pipe(Effect.map(rowToTab)),
      listByWorkspace: (wsId) => Effect.sync(() =>
        db.prepare("SELECT * FROM tabs WHERE workspace_id = ? ORDER BY tmux_window, id").all(wsId).map(rowToTab)),
      findEngineTab: (wsId) => Effect.sync(() => {
        const r = db.prepare("SELECT * FROM tabs WHERE workspace_id = ? AND kind = 'engine' ORDER BY id LIMIT 1").get(wsId)
        return r ? rowToTab(r) : null
      }),
      setStatus: (id, status, source) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.status === status) return rowToTab(r) // 同值 no-op：不写库不发事件
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE tabs SET status = ? WHERE id = ?").run(status, id)
          ev = appendEventRow(db, {
            workspaceId: r.workspace_id, type: "tab.status.changed", payload: { tabId: id, status, source },
          })
        })()
        broadcast(ev)
        return rowToTab(getRow(id))
      }),
      setTitle: (id, title) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE tabs SET title = ? WHERE id = ?").run(title, id)
          ev = appendEventRow(db, { workspaceId: r.workspace_id, type: "tab.title.changed", payload: { tabId: id, title } })
        })()
        broadcast(ev)
      }),
      setEngineSessionId: (id, sessionId) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.engine_session_id === sessionId) return // 同值 no-op
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE tabs SET engine_session_id = ? WHERE id = ?").run(sessionId, id)
          ev = appendEventRow(db, { workspaceId: r.workspace_id, type: "tab.session.changed", payload: { tabId: id, sessionId } })
        })()
        broadcast(ev)
      }),
      touchHookAt: (id, ts) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let data: any = {}
        try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 重建 */ }
        data.lastHookAt = ts
        db.prepare("UPDATE tabs SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
      }),
      listEngineTabs: () => Effect.sync(() =>
        (db.prepare(`SELECT t.*, w.path AS ws_path FROM tabs t
          JOIN workspaces w ON w.id = t.workspace_id
          WHERE t.kind = 'engine' AND w.status = 'active'`).all() as any[])
          .map((r) => ({ tab: rowToTab(r), workspacePath: r.ws_path as string }))),
      removeByWorkspace: (wsId) => Effect.sync(() => {
        db.prepare("DELETE FROM tabs WHERE workspace_id = ?").run(wsId)
      }),
    }
  }),
)
