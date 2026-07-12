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

/** role 化 client 注册（设计文档 §2.1）：gui 持有 server 生命周期 lease，terminal pane / cli 一次性命令不持有。 */
export const ClientRole = Schema.Literal("gui", "terminal", "cli")
export type ClientRole = typeof ClientRole.Type

export class ClientInfo extends Schema.Class<ClientInfo>("ClientInfo")({
  id: Schema.String,
  role: ClientRole,
  label: Schema.NullOr(Schema.String),
  connectedAt: Schema.Number,
}) {}

export const ClientsStatus = Schema.Struct({
  clients: Schema.Array(ClientInfo),
  guiHolders: Schema.Number,
  lingerMs: Schema.Number,
  idleExitArmed: Schema.Boolean,
})
export type ClientsStatus = typeof ClientsStatus.Type
export const decodeClientsStatus = Schema.decodeUnknownSync(ClientsStatus)

/** ensure-or-heal / resume 的统一结果（设计文档 §十）。 */
export const HealAction = Schema.Literal("none", "recreated", "respawned")
export type HealAction = typeof HealAction.Type
export const HealOutcome = Schema.Struct({
  action: HealAction,
  resumed: Schema.Boolean,
  sessionName: Schema.String,
  tabId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
})
export type HealOutcome = typeof HealOutcome.Type
export const decodeHealOutcome = Schema.decodeUnknownSync(HealOutcome)
