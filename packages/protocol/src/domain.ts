import { Schema } from "effect"

export const WorkspaceStatus = Schema.Literal("creating", "active", "archived", "error")
export type WorkspaceStatus = typeof WorkspaceStatus.Type

export class Workspace extends Schema.Class<Workspace>("Workspace")({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  baseRef: Schema.String,
  status: WorkspaceStatus,
  pinned: Schema.Boolean,
  createdAt: Schema.Number,
  archivedAt: Schema.NullOr(Schema.Number),
  portBase: Schema.Number,
}) {}
export const decodeWorkspace = Schema.decodeUnknownSync(Workspace)

export const TabKind = Schema.Literal("engine", "setup", "run", "shell")
export type TabKind = typeof TabKind.Type

/** 状态徽标（设计文档 §六）：working=●工作中 / awaiting-input=✓等输入 / error=!错误 / idle=○空闲 */
export const TabStatus = Schema.Literal("working", "awaiting-input", "error", "idle")
export type TabStatus = typeof TabStatus.Type

export class Tab extends Schema.Class<Tab>("Tab")({
  id: Schema.String,
  workspaceId: Schema.String,
  kind: TabKind,
  engineId: Schema.NullOr(Schema.String),
  engineSessionId: Schema.NullOr(Schema.String),
  tmuxWindow: Schema.NullOr(Schema.Number),
  title: Schema.NullOr(Schema.String),
  status: TabStatus,
  /** hooks 最近一次上报时间（turn detector 的 hook 优先仲裁用），无 hook 信号为 null */
  lastHookAt: Schema.NullOr(Schema.Number),
}) {}
export const decodeTab = Schema.decodeUnknownSync(Tab)

/** tmux session 命名唯一真源（设计文档 §五）：server bootstrap、CLI enter/open、WS resolveSession 共用。 */
export const tmuxSessionName = (wsId: string): string => `coolie-${wsId}`

export class Project extends Schema.Class<Project>("Project")({
  id: Schema.String,
  name: Schema.String,
  repoRoot: Schema.String,
  defaultBaseBranch: Schema.String,
  createdAt: Schema.Number,
}) {}
export const decodeProject = Schema.decodeUnknownSync(Project)

export const ApiErrorCode = Schema.Literal(
  "GitError", "TmuxError", "EngineError", "SetupScriptError",
  "NotFound", "Conflict", "Validation", "Internal",
)
export const ApiErrorBody = Schema.Struct({ code: ApiErrorCode, message: Schema.String })
export type ApiErrorBody = typeof ApiErrorBody.Type

export const CoolieEvent = Schema.Struct({
  seq: Schema.Number,
  workspaceId: Schema.NullOr(Schema.String),
  type: Schema.String,
  payload: Schema.Unknown,
  ts: Schema.Number,
})
export type CoolieEvent = typeof CoolieEvent.Type
export const decodeCoolieEvent = Schema.decodeUnknownSync(CoolieEvent)
