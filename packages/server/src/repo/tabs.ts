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

export type TabStatusSource = "hook" | "notify" | "interrupt" | "poller" | "wrapper" | "heal" | "composer" | "queue"

export interface TabsRepoShape {
  readonly insert: (t: {
    workspaceId: string; kind: TabKind
    engineId?: string; engineSessionId?: string | null; tmuxWindow?: number; title?: string
  }) => Effect.Effect<Tab>
  readonly get: (id: string) => Effect.Effect<Tab, NotFoundError>
  readonly listByWorkspace: (workspaceId: string) => Effect.Effect<Tab[]>
  readonly listEngineTabsByWorkspace: (workspaceId: string) => Effect.Effect<Tab[]>
  readonly findEngineTabBySession: (workspaceId: string, sessionId: string) => Effect.Effect<Tab | null>
  readonly findTabByWindow: (workspaceId: string, tmuxWindow: number) => Effect.Effect<Tab | null>
  /** Compatibility only: deterministic primary engine tab (lowest tmux window, then oldest id). */
  readonly findEngineTab: (workspaceId: string) => Effect.Effect<Tab | null>
  readonly setStatus: (id: string, status: TabStatus, source: TabStatusSource) => Effect.Effect<Tab, NotFoundError>
  /** C3：engine 退出的状态与 engine.exited 事件同事务提交/回滚（避免 setStatus 已落库、事件写失败的半写） */
  readonly recordEngineExit: (tabId: string, workspaceId: string, exitCode: number) => Effect.Effect<Tab, NotFoundError>
  readonly setTitle: (id: string, title: string) => Effect.Effect<void, NotFoundError>
  readonly setEngineSessionId: (id: string, sessionId: string) => Effect.Effect<void, NotFoundError>
  readonly setTmuxWindow: (id: string, tmuxWindow: number) => Effect.Effect<void, NotFoundError>
  readonly switchEngine: (id: string, engineId: string, sessionId: string | null) => Effect.Effect<Tab, NotFoundError>
  readonly touchHookAt: (id: string, ts: number) => Effect.Effect<void, NotFoundError>
  readonly listEngineTabs: () => Effect.Effect<Array<{ tab: Tab; workspacePath: string }>>
  /** 删单个 tab 行 + tab.closed 事件（shell tab 关闭用） */
  readonly remove: (id: string) => Effect.Effect<void, NotFoundError>
  /** archive：engine resume 钥匙保留，其余 runtime tab 立即删除。 */
  readonly removeNonEngineByWorkspace: (workspaceId: string) => Effect.Effect<void>
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
      listEngineTabsByWorkspace: (wsId) => Effect.sync(() =>
        db.prepare(`SELECT * FROM tabs WHERE workspace_id = ? AND kind = 'engine'
          ORDER BY CASE WHEN tmux_window IS NULL THEN 1 ELSE 0 END, tmux_window, id`).all(wsId).map(rowToTab)),
      findEngineTabBySession: (wsId, sessionId) => Effect.sync(() => {
        const r = db.prepare(`SELECT * FROM tabs
          WHERE workspace_id = ? AND kind = 'engine' AND engine_session_id = ?
          ORDER BY CASE WHEN tmux_window IS NULL THEN 1 ELSE 0 END, tmux_window, id LIMIT 1`).get(wsId, sessionId)
        return r ? rowToTab(r) : null
      }),
      findTabByWindow: (wsId, tmuxWindow) => Effect.sync(() => {
        const r = db.prepare("SELECT * FROM tabs WHERE workspace_id = ? AND tmux_window = ? ORDER BY id LIMIT 1")
          .get(wsId, tmuxWindow)
        return r ? rowToTab(r) : null
      }),
      findEngineTab: (wsId) => Effect.sync(() => {
        const r = db.prepare(`SELECT * FROM tabs WHERE workspace_id = ? AND kind = 'engine'
          ORDER BY CASE WHEN tmux_window IS NULL THEN 1 ELSE 0 END, tmux_window, id LIMIT 1`).get(wsId)
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
      recordEngineExit: (tabId, workspaceId, exitCode) => Effect.gen(function* () {
        const r = yield* mustGetRow(tabId)
        const status: TabStatus = exitCode === 0 ? "idle" : "error"
        const sessionId = r.engine_session_id ?? null
        const evs: CoolieEvent[] = []
        // 单事务：状态迁移（+ tab.status.changed）与 engine.exited 事件同提交/同回滚
        db.transaction(() => {
          if (r.status !== status) { // 同值 no-op：与 setStatus 一致，不写库不发 status 事件
            db.prepare("UPDATE tabs SET status = ? WHERE id = ?").run(status, tabId)
            evs.push(appendEventRow(db, {
              workspaceId: r.workspace_id, type: "tab.status.changed",
              payload: { tabId, status, source: "wrapper" },
            }))
          }
          evs.push(appendEventRow(db, {
            workspaceId, type: "engine.exited", payload: { tabId, sessionId, exitCode },
          }))
        })()
        for (const ev of evs) broadcast(ev)
        return rowToTab(getRow(tabId))
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
      setTmuxWindow: (id, tmuxWindow) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.tmux_window === tmuxWindow) return
        db.prepare("UPDATE tabs SET tmux_window = ? WHERE id = ?").run(tmuxWindow, id)
      }),
      switchEngine: (id, engineId, sessionId) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE tabs SET engine_id = ?, engine_session_id = ?, status = 'idle' WHERE id = ?")
            .run(engineId, sessionId, id)
          ev = appendEventRow(db, {
            workspaceId: r.workspace_id, type: "engine.switched",
            payload: { tabId: id, fromEngineId: r.engine_id ?? null, engineId, sessionId },
          })
        })()
        broadcast(ev)
        return rowToTab(getRow(id))
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
      remove: (id) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("DELETE FROM prompt_queue WHERE tab_id = ?").run(id)
          db.prepare("DELETE FROM tabs WHERE id = ?").run(id)
          ev = appendEventRow(db, { workspaceId: r.workspace_id, type: "tab.closed", payload: { tabId: id, kind: r.kind } })
        })()
        broadcast(ev)
      }),
      removeNonEngineByWorkspace: (wsId) => Effect.sync(() => {
        const rows = db.prepare("SELECT id, kind FROM tabs WHERE workspace_id = ? AND kind <> 'engine'").all(wsId) as any[]
        const evs: CoolieEvent[] = []
        db.transaction(() => {
          db.prepare("DELETE FROM tabs WHERE workspace_id = ? AND kind <> 'engine'").run(wsId)
          for (const row of rows)
            evs.push(appendEventRow(db, { workspaceId: wsId, type: "tab.closed", payload: { tabId: row.id, kind: row.kind } }))
        })()
        for (const ev of evs) broadcast(ev)
      }),
      removeByWorkspace: (wsId) => Effect.sync(() => {
        db.prepare("DELETE FROM tabs WHERE workspace_id = ?").run(wsId)
      }),
    }
  }),
)
