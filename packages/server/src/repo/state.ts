import type Database from "better-sqlite3"
import { Context, Effect, Layer } from "effect"
import {
  Project,
  Tab,
  Workspace,
  type AttentionSnapshotItem,
  type CoolieStateSnapshot,
  type QueuedPromptDto,
  type RunSnapshotItem,
  decodeCoolieStateSnapshot,
  queueMessageId,
  QUEUE_DELIVERY_GUARANTEE,
} from "@coolie/protocol"
import { readSnapshotTransaction, sqliteTableExists, Db } from "../db/sqlite.js"
import { NotFoundError } from "./errors.js"

export interface StateSnapshotReadScope {
  readonly workspaceId?: string
}

export interface StateRepoShape {
  readonly read: (scope?: StateSnapshotReadScope) => Effect.Effect<CoolieStateSnapshot, NotFoundError>
}

export class StateRepo extends Context.Tag("StateRepo")<StateRepo, StateRepoShape>() {}

const rowToProject = (r: any): Project =>
  new Project({
    id: r.id,
    name: r.name,
    repoRoot: r.repo_root,
    defaultBaseBranch: r.default_base_branch,
    createdAt: r.created_at,
  })

const rowToWorkspace = (r: any): Workspace => {
  let data: any = {}
  try { data = r.data ? JSON.parse(r.data) : {} } catch { /* bad JSON */ }
  return new Workspace({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    path: r.path,
    branch: r.branch,
    baseBranch: r.base_branch,
    baseRef: r.base_ref,
    status: r.status,
    taskStatus: r.task_status,
    kind: r.kind,
    materialized: !!r.materialized,
    sortOrder: r.sort_order,
    ownership: data.ownership === "adopted" ? "adopted" : "managed",
    zenMode: data.layout?.zen === true,
    pinned: !!r.pinned,
    createdAt: r.created_at,
    archivedAt: r.archived_at ?? null,
    portBase: typeof data.portBase === "number" ? data.portBase : 0,
  })
}

const rowToTab = (r: any): Tab => {
  let data: any = {}
  try { data = r.data ? JSON.parse(r.data) : {} } catch { /* bad JSON */ }
  return new Tab({
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    engineId: r.engine_id ?? null,
    engineSessionId: r.engine_session_id ?? null,
    tmuxWindow: r.tmux_window ?? null,
    title: r.title ?? null,
    status: r.status ?? "idle",
    lastHookAt: typeof data.lastHookAt === "number" ? data.lastHookAt : null,
  })
}

const rowToAttention = (r: any): AttentionSnapshotItem => ({
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

const rowToRun = (r: any): RunSnapshotItem => ({
  id: r.id,
  workspaceId: r.workspace_id,
  runId: r.run_id,
  scriptType: r.script_type,
  status: r.status,
  startedAt: r.started_at,
  exitedAt: r.exited_at ?? null,
  exitCode: r.exit_code ?? null,
})

const loadQueuedPrompts = (db: Database.Database, workspaceId?: string): QueuedPromptDto[] => {
  const rows = workspaceId === undefined
    ? db.prepare("SELECT * FROM prompt_queue WHERE state = 'queued' ORDER BY id ASC").all()
    : db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? AND state = 'queued' ORDER BY id ASC").all(workspaceId)
  const positionByTab = new Map<string, number>()
  return rows.map((row: any) => {
    const key = `${row.workspace_id}:${row.tab_id}`
    const position = (positionByTab.get(key) ?? 0) + 1
    positionByTab.set(key, position)
    const queueId = row.id
    return {
      id: queueId,
      queueId,
      messageId: queueMessageId(queueId),
      tabId: row.tab_id,
      text: row.text,
      mode: "send" as const,
      createdAt: row.created_at,
      position,
      deliveryGuarantee: QUEUE_DELIVERY_GUARANTEE,
    }
  })
}

const loadOpenAttention = (db: Database.Database, workspaceId?: string): AttentionSnapshotItem[] => {
  if (!sqliteTableExists(db, "attention_items")) return []
  const rows = workspaceId === undefined
    ? db.prepare("SELECT * FROM attention_items WHERE state = 'open' ORDER BY created_at ASC, id ASC").all()
    : db.prepare("SELECT * FROM attention_items WHERE workspace_id = ? AND state = 'open' ORDER BY created_at ASC, id ASC").all(workspaceId)
  return rows.map(rowToAttention)
}

const loadActiveRuns = (db: Database.Database, workspaceId?: string): RunSnapshotItem[] => {
  if (!sqliteTableExists(db, "run_instances")) return []
  const rows = workspaceId === undefined
    ? db.prepare("SELECT * FROM run_instances WHERE status IN ('running', 'error') ORDER BY started_at ASC, id ASC").all()
    : db.prepare("SELECT * FROM run_instances WHERE workspace_id = ? AND status IN ('running', 'error') ORDER BY started_at ASC, id ASC").all(workspaceId)
  return rows.map(rowToRun)
}

const readSnapshotRows = (
  db: Database.Database,
  scope?: StateSnapshotReadScope,
): CoolieStateSnapshot => {
  const generatedAt = Date.now()
  const workspaceId = scope?.workspaceId

  return readSnapshotTransaction(db, () => {
    const asOfSeq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events").get() as { n: number }).n

    if (workspaceId !== undefined) {
      const workspaceRow = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId)
      if (!workspaceRow) throw new NotFoundError({ message: `workspace 不存在：${workspaceId}` })
      const projectRow = db.prepare("SELECT * FROM projects WHERE id = ?").get((workspaceRow as any).project_id)
      const projects = projectRow ? [rowToProject(projectRow)] : []
      const workspaces = [rowToWorkspace(workspaceRow)]
      const tabs = db.prepare("SELECT * FROM tabs WHERE workspace_id = ? ORDER BY id ASC").all(workspaceId).map(rowToTab)
      return decodeCoolieStateSnapshot({
        asOfSeq,
        generatedAt,
        scope: { workspaceId },
        projects,
        workspaces,
        tabs,
        openAttention: loadOpenAttention(db, workspaceId),
        queuedPrompts: loadQueuedPrompts(db, workspaceId),
        activeRuns: loadActiveRuns(db, workspaceId),
      })
    }

    return decodeCoolieStateSnapshot({
      asOfSeq,
      generatedAt,
      scope: null,
      projects: db.prepare("SELECT * FROM projects ORDER BY created_at ASC, id ASC").all().map(rowToProject),
      workspaces: db.prepare("SELECT * FROM workspaces ORDER BY sort_order ASC, created_at ASC, id ASC").all().map(rowToWorkspace),
      tabs: db.prepare("SELECT * FROM tabs ORDER BY workspace_id ASC, id ASC").all().map(rowToTab),
      openAttention: loadOpenAttention(db),
      queuedPrompts: loadQueuedPrompts(db),
      activeRuns: loadActiveRuns(db),
    })
  })
}

export const makeStateRepo = (db: Database.Database): StateRepoShape => ({
  read: (scope) => Effect.try({
    try: () => readSnapshotRows(db, scope),
    catch: (cause) => cause instanceof NotFoundError
      ? cause
      : new NotFoundError({ message: cause instanceof Error ? cause.message : String(cause) }),
  }),
})

export const StateRepoLive = Layer.effect(
  StateRepo,
  Effect.gen(function* () {
    const db = yield* Db
    return makeStateRepo(db)
  }),
)
