import { Context, Effect, Layer, Option } from "effect"
import { ulid } from "ulid"
import {
  Workspace,
  type CoolieEvent,
  type TaskStatus,
  type WorkspaceStatus,
} from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { ConflictError, NotFoundError } from "./errors.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { appendEventRow } from "./events.js"
import type { WorkspaceLayoutState } from "../tmux/layout.js"

/** 持久 workspace 状态机。archiving 冻结输入，并允许成功提交或失败补偿回 active。 */
const ALLOWED_TRANSITIONS: Record<WorkspaceStatus, ReadonlyArray<WorkspaceStatus>> = {
  creating: ["active", "error"],
  active: ["archiving", "error"],
  archiving: ["active", "archived"],
  archived: ["active"],
  error: ["creating"],
}

const rowToWorkspace = (r: any): Workspace => {
  let data: any = {}
  try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 坏 JSON 视为无 data */ }
  return new Workspace({
    id: r.id, projectId: r.project_id, name: r.name, path: r.path, branch: r.branch,
    baseBranch: r.base_branch, baseRef: r.base_ref, status: r.status,
    taskStatus: r.task_status, kind: r.kind, materialized: !!r.materialized,
    sortOrder: r.sort_order,
    ownership: data.ownership === "adopted" ? "adopted" : "managed",
    zenMode: data.layout?.zen === true,
    pinned: !!r.pinned, createdAt: r.created_at, archivedAt: r.archived_at ?? null,
    portBase: typeof data.portBase === "number" ? data.portBase : 0,
  })
}

export interface ArchiveOperation {
  readonly force: boolean
  readonly startedAt: number
  readonly lastError: { readonly tag: string; readonly stage: string; readonly message: string; readonly at: number } | null
}

const rowData = (r: any): any => {
  try { return r.data ? JSON.parse(r.data) : {} } catch { return {} }
}

const archiveOperationFromRow = (r: any): ArchiveOperation => {
  const raw = rowData(r).archiveOperation ?? {}
  return {
    force: raw.force === true,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : r.created_at,
    lastError: raw.lastError && typeof raw.lastError === "object"
      ? {
          tag: typeof raw.lastError.tag === "string" ? raw.lastError.tag : "ArchiveError",
          stage: typeof raw.lastError.stage === "string" ? raw.lastError.stage : "unknown",
          message: typeof raw.lastError.message === "string" ? raw.lastError.message : "archive failed",
          at: typeof raw.lastError.at === "number" ? raw.lastError.at : r.created_at,
        }
      : null,
  }
}

export interface WorkspacesRepoShape {
  readonly insertCreating: (w: {
    projectId: string; name: string; path: string; branch: string; baseBranch: string; portBase: number
  }) => Effect.Effect<Workspace, ConflictError>
  /** Adopt 专用：active 行与 workspace.adopted 事件同一事务写入。 */
  readonly insertAdopted: (w: {
    projectId: string; name: string; path: string; branch: string; baseBranch: string; baseRef: string; portBase: number
  }) => Effect.Effect<Workspace, ConflictError>
  readonly get: (id: string) => Effect.Effect<Workspace, NotFoundError>
  readonly list: (filter?: { projectId?: string }) => Effect.Effect<Workspace[]>
  readonly setStatus: (id: string, next: WorkspaceStatus) => Effect.Effect<Workspace, NotFoundError | ConflictError>
  /** active→archiving 与 force intent 同事务；archiving retry 只允许升级 force，绝不降级。 */
  readonly beginArchive: (id: string, force: boolean) => Effect.Effect<{
    workspace: Workspace; operation: ArchiveOperation
  }, NotFoundError | ConflictError>
  readonly getArchiveOperation: (id: string) => Effect.Effect<ArchiveOperation, NotFoundError | ConflictError>
  readonly setArchiveError: (id: string, error: {
    tag: string; stage: string; message: string
  }) => Effect.Effect<void, NotFoundError | ConflictError>
  /** runtime 已验证恢复后才可 archiving→active，并原子清理 operation。 */
  readonly cancelArchive: (id: string) => Effect.Effect<Workspace, NotFoundError | ConflictError>
  /** worktree/runtime teardown 完成后原子提交 archived + done，并清理 operation。 */
  readonly completeArchive: (id: string) => Effect.Effect<Workspace, NotFoundError | ConflictError>
  readonly setPinned: (id: string, pinned: boolean) => Effect.Effect<Workspace, NotFoundError>
  readonly rename: (id: string, name: string) => Effect.Effect<Workspace, NotFoundError | ConflictError>
  readonly setTaskStatus: (id: string, status: TaskStatus) => Effect.Effect<Workspace, NotFoundError>
  readonly setBranch: (id: string, branch: string) => Effect.Effect<Workspace, NotFoundError | ConflictError>
  readonly setMaterialized: (id: string, materialized: boolean) => Effect.Effect<Workspace, NotFoundError>
  readonly reorder: (projectId: string, workspaceIds: readonly string[]) => Effect.Effect<Workspace[], NotFoundError | ConflictError>
  readonly setBaseRef: (id: string, baseRef: string) => Effect.Effect<void, NotFoundError>
  readonly setLastError: (id: string, err: { tag: string; message: string }) => Effect.Effect<void, NotFoundError>
  /** create 存下首条 prompt+引擎（C2）：error 后 retry 从 data.createCtx 回填 PostCreateContext 补投 */
  readonly setCreateCtx: (id: string, ctx: {
    initialPrompt?: string; engineId?: string; model?: string; effort?: string; fanoutGroup?: string
  }) => Effect.Effect<void, NotFoundError>
  readonly getCreateCtx: (id: string) => Effect.Effect<{
    initialPrompt?: string; engineId?: string; model?: string; effort?: string; fanoutGroup?: string
  }, NotFoundError>
  readonly getLayoutState: (id: string) => Effect.Effect<WorkspaceLayoutState, NotFoundError>
  readonly setLayoutState: (id: string, state: WorkspaceLayoutState) => Effect.Effect<void, NotFoundError>
  readonly usedPortBases: () => Effect.Effect<number[]>
  readonly remove: (id: string) => Effect.Effect<void, NotFoundError | ConflictError>
}
export class WorkspacesRepo extends Context.Tag("WorkspacesRepo")<WorkspacesRepo, WorkspacesRepoShape>() {}

export const WorkspacesRepoLive = Layer.effect(
  WorkspacesRepo,
  Effect.gen(function* () {
    const db = yield* Db
    const bus = yield* Effect.serviceOption(EventsBus)
    const broadcast = (ev: CoolieEvent): void => { if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, ev) }
    const getRow = (id: string): any => db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id)
    const mustGetRow = (id: string) => Effect.gen(function* () {
      const r = getRow(id)
      if (!r) return yield* new NotFoundError({ message: `workspace 不存在：${id}` })
      return r
    })
    return {
      insertCreating: (w) => Effect.gen(function* () {
        const id = ulid()
        try {
          db.prepare(`INSERT INTO workspaces
            (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data,
             task_status, kind, materialized, sort_order)
            VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?,'backlog','task',0,?)`)
            .run(id, w.projectId, w.name, w.path, w.branch, w.baseBranch, "", "creating",
              Date.now(), JSON.stringify({ portBase: w.portBase, ownership: "managed" }), Date.now())
        } catch (e: any) {
          if (String(e?.code ?? "").startsWith("SQLITE_CONSTRAINT"))
            return yield* new ConflictError({ message: `workspace 名称/分支/路径已被占用（name=${w.name} branch=${w.branch}）` })
          throw e // 非约束错误 → defect
        }
        return rowToWorkspace(getRow(id))
      }),
      insertAdopted: (w) => Effect.gen(function* () {
        const id = ulid()
        let ev!: CoolieEvent
        try {
          db.transaction(() => {
            db.prepare(`INSERT INTO workspaces
              (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data,
               task_status, kind, materialized, sort_order)
              VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?,'in_progress','task',1,?)`)
              .run(id, w.projectId, w.name, w.path, w.branch, w.baseBranch, w.baseRef, "active",
                Date.now(), JSON.stringify({ portBase: w.portBase, ownership: "adopted" }), Date.now())
            ev = appendEventRow(db, {
              workspaceId: id, type: "workspace.adopted",
              payload: { id, projectId: w.projectId, path: w.path, branch: w.branch, head: w.baseRef },
            })
          })()
        } catch (e: any) {
          if (String(e?.code ?? "").startsWith("SQLITE_CONSTRAINT"))
            return yield* new ConflictError({ message: `worktree 已登记或名称/分支冲突（path=${w.path} branch=${w.branch}）` })
          throw e
        }
        broadcast(ev)
        return rowToWorkspace(getRow(id))
      }),
      get: (id) => mustGetRow(id).pipe(Effect.map(rowToWorkspace)),
      list: (filter) => Effect.sync(() => {
        const rows = filter?.projectId
          ? db.prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY sort_order, created_at").all(filter.projectId)
          : db.prepare("SELECT * FROM workspaces ORDER BY project_id, sort_order, created_at").all()
        return rows.map(rowToWorkspace)
      }),
      setStatus: (id, next) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        const cur = r.status as WorkspaceStatus
        if (!ALLOWED_TRANSITIONS[cur].includes(next))
          return yield* new ConflictError({ message: `非法状态迁移：${cur} → ${next}` })
        const archivedAt = next === "archived" ? Date.now() : null
        db.prepare("UPDATE workspaces SET status = ?, archived_at = ? WHERE id = ?").run(next, archivedAt, id)
        return rowToWorkspace(getRow(id))
      }),
      beginArchive: (id, force) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.status !== "active" && r.status !== "archiving")
          return yield* new ConflictError({ message: `只能开始 active/archiving workspace 的归档（当前 ${r.status}）` })
        const data = rowData(r)
        const existing = r.status === "archiving" ? archiveOperationFromRow(r) : null
        const operation: ArchiveOperation = {
          force: force || existing?.force === true,
          startedAt: existing?.startedAt ?? Date.now(),
          lastError: null,
        }
        data.archiveOperation = operation
        db.transaction(() => {
          db.prepare("UPDATE workspaces SET status = 'archiving', archived_at = NULL, data = ? WHERE id = ?")
            .run(JSON.stringify(data), id)
        })()
        return { workspace: rowToWorkspace(getRow(id)), operation }
      }),
      getArchiveOperation: (id) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.status !== "archiving")
          return yield* new ConflictError({ message: `workspace 非 archiving（当前 ${r.status}）` })
        // Compatibility: rows created by the first archiving implementation have no operation payload.
        return archiveOperationFromRow(r)
      }),
      setArchiveError: (id, error) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.status !== "archiving")
          return yield* new ConflictError({ message: `workspace 非 archiving（当前 ${r.status}）` })
        const data = rowData(r)
        const operation = archiveOperationFromRow(r)
        data.archiveOperation = {
          ...operation,
          lastError: { ...error, at: Date.now() },
        }
        db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
      }),
      cancelArchive: (id) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.status !== "archiving")
          return yield* new ConflictError({ message: `workspace 非 archiving（当前 ${r.status}）` })
        const data = rowData(r)
        delete data.archiveOperation
        db.prepare("UPDATE workspaces SET status = 'active', archived_at = NULL, data = ? WHERE id = ?")
          .run(JSON.stringify(data), id)
        return rowToWorkspace(getRow(id))
      }),
      completeArchive: (id) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.status !== "archiving")
          return yield* new ConflictError({ message: `workspace 非 archiving（当前 ${r.status}）` })
        const data = rowData(r)
        delete data.archiveOperation
        db.prepare(`UPDATE workspaces
          SET status = 'archived', task_status = 'done', archived_at = ?, data = ? WHERE id = ?`)
          .run(Date.now(), JSON.stringify(data), id)
        return rowToWorkspace(getRow(id))
      }),
      setPinned: (id, pinned) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (!!r.pinned === pinned) return rowToWorkspace(r)
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE workspaces SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id)
          ev = appendEventRow(db, {
            workspaceId: id,
            type: "workspace.pinned",
            payload: { pinned },
          })
        })()
        broadcast(ev)
        return rowToWorkspace(getRow(id))
      }),
      rename: (id, name) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.name === name) return rowToWorkspace(r)
        let ev!: CoolieEvent
        try {
          db.transaction(() => {
            db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name, id)
            ev = appendEventRow(db, {
              workspaceId: id, type: "workspace.renamed", payload: { from: r.name, name },
            })
          })()
        } catch (e: any) {
          if (String(e?.code ?? "").startsWith("SQLITE_CONSTRAINT"))
            return yield* new ConflictError({ message: `workspace 名称已被占用：${name}` })
          throw e
        }
        broadcast(ev)
        return rowToWorkspace(getRow(id))
      }),
      setTaskStatus: (id, status) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.task_status === status) return rowToWorkspace(r)
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE workspaces SET task_status = ? WHERE id = ?").run(status, id)
          ev = appendEventRow(db, {
            workspaceId: id, type: "workspace.task-status.changed",
            payload: { from: r.task_status, status },
          })
        })()
        broadcast(ev)
        return rowToWorkspace(getRow(id))
      }),
      setBranch: (id, branch) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.branch === branch) return rowToWorkspace(r)
        let ev!: CoolieEvent
        try {
          db.transaction(() => {
            db.prepare("UPDATE workspaces SET branch = ? WHERE id = ?").run(branch, id)
            ev = appendEventRow(db, {
              workspaceId: id, type: "workspace.branch.renamed",
              payload: { from: r.branch, branch },
            })
          })()
        } catch (e: any) {
          if (String(e?.code ?? "").startsWith("SQLITE_CONSTRAINT"))
            return yield* new ConflictError({ message: `branch 已被占用：${branch}` })
          throw e
        }
        broadcast(ev)
        return rowToWorkspace(getRow(id))
      }),
      setMaterialized: (id, materialized) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (!!r.materialized === materialized) return rowToWorkspace(r)
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE workspaces SET materialized = ? WHERE id = ?").run(materialized ? 1 : 0, id)
          ev = appendEventRow(db, {
            workspaceId: id,
            type: materialized ? "workspace.materialized" : "workspace.dematerialized",
            payload: { materialized },
          })
        })()
        broadcast(ev)
        return rowToWorkspace(getRow(id))
      }),
      reorder: (projectId, workspaceIds) => Effect.gen(function* () {
        const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)
        if (!project)
          return yield* new NotFoundError({ message: `项目不存在或没有 task：${projectId}` })
        // The sidebar reorders only regular, non-archived tasks. Main and archived rows are
        // deliberately outside this contract, so their relative order remains untouched.
        const rows = db.prepare(
          "SELECT id FROM workspaces WHERE project_id = ? AND kind = 'task' AND status <> 'archived'",
        ).all(projectId) as Array<{ id: string }>
        const existing = new Set(rows.map((row) => row.id))
        if (workspaceIds.length !== existing.size || new Set(workspaceIds).size !== workspaceIds.length ||
          workspaceIds.some((id) => !existing.has(id)))
          return yield* new ConflictError({ message: "reorder 必须包含项目内每个未归档普通 task，且不能重复" })
        let ev!: CoolieEvent
        db.transaction(() => {
          const update = db.prepare("UPDATE workspaces SET sort_order = ? WHERE id = ?")
          workspaceIds.forEach((id, index) => update.run(index, id))
          ev = appendEventRow(db, {
            workspaceId: null, type: "workspace.reordered", payload: { projectId, workspaceIds },
          })
        })()
        broadcast(ev)
        return (db.prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY sort_order, created_at")
          .all(projectId) as any[]).map(rowToWorkspace)
      }),
      setBaseRef: (id, baseRef) => Effect.gen(function* () {
        yield* mustGetRow(id)
        db.prepare("UPDATE workspaces SET base_ref = ? WHERE id = ?").run(baseRef, id)
      }),
      setLastError: (id, err) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let data: any = {}
        try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 重建 */ }
        data.lastError = { tag: err.tag, message: err.message, at: Date.now() }
        db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
      }),
      setCreateCtx: (id, ctx) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let data: any = {}
        try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 重建 */ }
        data.createCtx = {
          ...(ctx.initialPrompt !== undefined ? { initialPrompt: ctx.initialPrompt } : {}),
          ...(ctx.engineId !== undefined ? { engineId: ctx.engineId } : {}),
          ...(ctx.model !== undefined ? { model: ctx.model } : {}),
          ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
          ...(ctx.fanoutGroup !== undefined ? { fanoutGroup: ctx.fanoutGroup } : {}),
        }
        db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
      }),
      getCreateCtx: (id) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let data: any = {}
        try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 坏 JSON 视为无 ctx */ }
        const c = (data.createCtx ?? {}) as {
          initialPrompt?: unknown; engineId?: unknown; model?: unknown; effort?: unknown; fanoutGroup?: unknown
        }
        return {
          ...(typeof c.initialPrompt === "string" ? { initialPrompt: c.initialPrompt } : {}),
          ...(typeof c.engineId === "string" ? { engineId: c.engineId } : {}),
          ...(typeof c.model === "string" ? { model: c.model } : {}),
          ...(typeof c.effort === "string" ? { effort: c.effort } : {}),
          ...(typeof c.fanoutGroup === "string" ? { fanoutGroup: c.fanoutGroup } : {}),
        }
      }),
      getLayoutState: (id) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let raw: any = {}
        try { raw = JSON.parse(r.data ?? "{}").layout ?? {} } catch { /* migration-compatible default */ }
        const geometry = Array.isArray(raw.geometry)
          ? raw.geometry.filter((item: any) =>
              Number.isInteger(item?.window) && typeof item?.layout === "string" &&
              Number.isInteger(item?.cols) && Number.isInteger(item?.rows))
            .map((item: any) => ({
              window: item.window, layout: item.layout,
              cols: Math.max(20, Math.min(500, item.cols)),
              rows: Math.max(5, Math.min(300, item.rows)),
            }))
          : []
        return {
          version: 1,
          zen: raw.zen === true,
          focusedTabId: typeof raw.focusedTabId === "string" ? raw.focusedTabId : null,
          restoreTabId: typeof raw.restoreTabId === "string" ? raw.restoreTabId : null,
          geometry,
        }
      }),
      setLayoutState: (id, state) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let data: any = {}
        try { data = r.data ? JSON.parse(r.data) : {} } catch { /* rebuild malformed JSON */ }
        data.layout = state
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
          ev = appendEventRow(db, {
            workspaceId: id, type: "workspace.layout.changed",
            payload: { zen: state.zen, focusedTabId: state.focusedTabId },
          })
        })()
        broadcast(ev)
      }),
      usedPortBases: () => Effect.sync(() =>
        (db.prepare("SELECT data FROM workspaces").all() as any[])
          .map((r) => { try { return JSON.parse(r.data ?? "{}").portBase } catch { return undefined } })
          .filter((n): n is number => typeof n === "number")),
      remove: (id) => Effect.gen(function* () {
        const row = yield* mustGetRow(id)
        if (row.kind === "main")
          return yield* new ConflictError({ message: "main task 不可删除" })
        const res = db.prepare("DELETE FROM workspaces WHERE id = ?").run(id)
        if (res.changes === 0) return yield* new NotFoundError({ message: `workspace 不存在：${id}` })
      }),
    }
  }),
)
