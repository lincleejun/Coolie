import { Context, Effect, Layer } from "effect"
import { ulid } from "ulid"
import { Workspace, type WorkspaceStatus } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { ConflictError, NotFoundError } from "./errors.js"

/** 设计文档 §四 状态机：creating→active→archived→active；creating 失败→error；error 可重试回 creating */
const ALLOWED_TRANSITIONS: Record<WorkspaceStatus, ReadonlyArray<WorkspaceStatus>> = {
  creating: ["active", "error"],
  active: ["archived"],
  archived: ["active"],
  error: ["creating"],
}

const rowToWorkspace = (r: any): Workspace => {
  let data: any = {}
  try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 坏 JSON 视为无 data */ }
  return new Workspace({
    id: r.id, projectId: r.project_id, name: r.name, path: r.path, branch: r.branch,
    baseBranch: r.base_branch, baseRef: r.base_ref, status: r.status,
    pinned: !!r.pinned, createdAt: r.created_at, archivedAt: r.archived_at ?? null,
    portBase: typeof data.portBase === "number" ? data.portBase : 0,
  })
}

export interface WorkspacesRepoShape {
  readonly insertCreating: (w: {
    projectId: string; name: string; path: string; branch: string; baseBranch: string; portBase: number
  }) => Effect.Effect<Workspace, ConflictError>
  readonly get: (id: string) => Effect.Effect<Workspace, NotFoundError>
  readonly list: (filter?: { projectId?: string }) => Effect.Effect<Workspace[]>
  readonly setStatus: (id: string, next: WorkspaceStatus) => Effect.Effect<Workspace, NotFoundError | ConflictError>
  readonly setBaseRef: (id: string, baseRef: string) => Effect.Effect<void, NotFoundError>
  readonly setLastError: (id: string, err: { tag: string; message: string }) => Effect.Effect<void, NotFoundError>
  /** create 存下首条 prompt+引擎（C2）：error 后 retry 从 data.createCtx 回填 PostCreateContext 补投 */
  readonly setCreateCtx: (id: string, ctx: {
    initialPrompt?: string; engineId?: string; model?: string; effort?: string
  }) => Effect.Effect<void, NotFoundError>
  readonly getCreateCtx: (id: string) => Effect.Effect<{
    initialPrompt?: string; engineId?: string; model?: string; effort?: string
  }, NotFoundError>
  readonly usedPortBases: () => Effect.Effect<number[]>
  readonly remove: (id: string) => Effect.Effect<void, NotFoundError>
}
export class WorkspacesRepo extends Context.Tag("WorkspacesRepo")<WorkspacesRepo, WorkspacesRepoShape>() {}

export const WorkspacesRepoLive = Layer.effect(
  WorkspacesRepo,
  Effect.gen(function* () {
    const db = yield* Db
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
            (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
            VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?)`)
            .run(id, w.projectId, w.name, w.path, w.branch, w.baseBranch, "", "creating",
              Date.now(), JSON.stringify({ portBase: w.portBase }))
        } catch (e: any) {
          if (String(e?.code ?? "").startsWith("SQLITE_CONSTRAINT"))
            return yield* new ConflictError({ message: `workspace 名称/分支/路径已被占用（name=${w.name} branch=${w.branch}）` })
          throw e // 非约束错误 → defect
        }
        return rowToWorkspace(getRow(id))
      }),
      get: (id) => mustGetRow(id).pipe(Effect.map(rowToWorkspace)),
      list: (filter) => Effect.sync(() => {
        const rows = filter?.projectId
          ? db.prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at").all(filter.projectId)
          : db.prepare("SELECT * FROM workspaces ORDER BY created_at").all()
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
        }
        db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
      }),
      getCreateCtx: (id) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let data: any = {}
        try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 坏 JSON 视为无 ctx */ }
        const c = (data.createCtx ?? {}) as {
          initialPrompt?: unknown; engineId?: unknown; model?: unknown; effort?: unknown
        }
        return {
          ...(typeof c.initialPrompt === "string" ? { initialPrompt: c.initialPrompt } : {}),
          ...(typeof c.engineId === "string" ? { engineId: c.engineId } : {}),
          ...(typeof c.model === "string" ? { model: c.model } : {}),
          ...(typeof c.effort === "string" ? { effort: c.effort } : {}),
        }
      }),
      usedPortBases: () => Effect.sync(() =>
        (db.prepare("SELECT data FROM workspaces").all() as any[])
          .map((r) => { try { return JSON.parse(r.data ?? "{}").portBase } catch { return undefined } })
          .filter((n): n is number => typeof n === "number")),
      remove: (id) => Effect.gen(function* () {
        const res = db.prepare("DELETE FROM workspaces WHERE id = ?").run(id)
        if (res.changes === 0) return yield* new NotFoundError({ message: `workspace 不存在：${id}` })
      }),
    }
  }),
)
