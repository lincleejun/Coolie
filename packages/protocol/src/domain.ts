import { Schema } from "effect"

export const WorkspaceStatus = Schema.Literal("creating", "active", "archiving", "archived", "error")
export type WorkspaceStatus = typeof WorkspaceStatus.Type
export const WorkspaceOwnership = Schema.Literal("managed", "adopted")
export type WorkspaceOwnership = typeof WorkspaceOwnership.Type
export const TaskStatus = Schema.Literal("backlog", "in_progress", "in_review", "done", "canceled", "error")
export type TaskStatus = typeof TaskStatus.Type
export const WorkspaceKind = Schema.Literal("main", "task")
export type WorkspaceKind = typeof WorkspaceKind.Type

export const WorkspaceLastError = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  at: Schema.Number,
  stage: Schema.optional(Schema.String),
})
export type WorkspaceLastError = typeof WorkspaceLastError.Type

/** Durable finish outcome for Finish→Archive daily loop (Task 3.8). */
export const FinishResult = Schema.Struct({
  prUrl: Schema.optional(Schema.String),
  mergedBack: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
  finishedAt: Schema.Number,
  createPr: Schema.Boolean,
  mergeBack: Schema.Boolean,
})
export type FinishResult = typeof FinishResult.Type

export class Workspace extends Schema.Class<Workspace>("Workspace")({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  baseRef: Schema.String,
  status: WorkspaceStatus,
  taskStatus: Schema.optionalWith(TaskStatus, { default: () => "in_progress" as const }),
  kind: Schema.optionalWith(WorkspaceKind, { default: () => "task" as const }),
  materialized: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  sortOrder: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  ownership: Schema.optionalWith(WorkspaceOwnership, { default: () => "managed" as const }),
  zenMode: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  pinned: Schema.Boolean,
  createdAt: Schema.Number,
  archivedAt: Schema.NullOr(Schema.Number),
  portBase: Schema.Number,
  lastError: Schema.optionalWith(Schema.NullOr(WorkspaceLastError), { default: () => null }),
  finishResult: Schema.optionalWith(Schema.NullOr(FinishResult), { default: () => null }),
}) {}
export const decodeWorkspace = Schema.decodeUnknownSync(Workspace)

export const TabKind = Schema.Literal("engine", "setup", "shell")
export type TabKind = typeof TabKind.Type

/** 状态徽标（设计文档 §六）：working=●工作中 / awaiting-input=✓等输入 / error=!错误 / idle=○空闲 */
export const TabStatus = Schema.Literal("working", "awaiting-input", "error", "idle")
export type TabStatus = typeof TabStatus.Type

export const EngineCapabilitiesSchema = Schema.Struct({
  nativeQueue: Schema.Boolean,
  midSessionModelSwitch: Schema.Boolean,
  resume: Schema.Boolean,
  hooks: Schema.Boolean,
  effort: Schema.Boolean,
})
export type EngineCapabilitiesDto = typeof EngineCapabilitiesSchema.Type

export const CustomEngineDefinition = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  enabled: Schema.Boolean,
  command: Schema.Array(Schema.String),
  models: Schema.optional(Schema.Array(Schema.String)),
  efforts: Schema.optional(Schema.Array(Schema.String)),
  capabilities: EngineCapabilitiesSchema,
  transcriptStrategy: Schema.Literal("none", "jsonl-path"),
  transcriptPathTemplate: Schema.optional(Schema.String),
  historyStrategy: Schema.Literal("none", "resume-args"),
  resumeArgs: Schema.optional(Schema.Array(Schema.String)),
  turnDetection: Schema.Literal("none", "hooks", "terminal-title"),
  accountDetectionCommand: Schema.optional(Schema.Array(Schema.String)),
  accountDetectionPath: Schema.optional(Schema.String),
  presetId: Schema.optional(Schema.String),
})
export type CustomEngineDefinition = typeof CustomEngineDefinition.Type
export const decodeCustomEngineDefinition = Schema.decodeUnknownSync(CustomEngineDefinition)

export const EngineAvailability = Schema.Struct({
  available: Schema.Boolean,
  accountHint: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})
export type EngineAvailability = typeof EngineAvailability.Type

export const EngineInfo = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  capabilities: EngineCapabilitiesSchema,
  models: Schema.Array(Schema.String),
  efforts: Schema.optional(Schema.Array(Schema.String)),
  custom: Schema.Boolean,
  enabled: Schema.Boolean,
  presetId: Schema.NullOr(Schema.String),
  availability: EngineAvailability,
  definition: Schema.optional(CustomEngineDefinition),
})
export type EngineInfo = typeof EngineInfo.Type

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

/** SQLite prompt queues acknowledge delivery after PTY input, so a crash can redeliver the same message. */
export const QueueDeliveryGuarantee = Schema.Literal("at-least-once")
export type QueueDeliveryGuarantee = typeof QueueDeliveryGuarantee.Type
export const QUEUE_DELIVERY_GUARANTEE: QueueDeliveryGuarantee = "at-least-once"

/** Stable identity shared by queue DTOs and every lifecycle event for one queued message. */
export const queueMessageId = (queueId: number): string => `queue:${queueId}`

export const QueuedPromptDto = Schema.Struct({
  /** Backward-compatible alias for queueId. */
  id: Schema.Number,
  queueId: Schema.Number,
  messageId: Schema.String,
  tabId: Schema.String,
  text: Schema.String,
  mode: Schema.Literal("send"),
  createdAt: Schema.Number,
  position: Schema.Number,
  deliveryGuarantee: QueueDeliveryGuarantee,
})
export type QueuedPromptDto = typeof QueuedPromptDto.Type

export const QueueListResponse = Schema.Struct({
  deliveryGuarantee: QueueDeliveryGuarantee,
  queue: Schema.Array(QueuedPromptDto),
})
export type QueueListResponse = typeof QueueListResponse.Type

export const QueueAcceptedResponse = Schema.Struct({
  queued: Schema.Literal(true),
  /** Backward-compatible alias for queueId. */
  id: Schema.Number,
  queueId: Schema.Number,
  messageId: Schema.String,
  position: Schema.Number,
  deliveryGuarantee: QueueDeliveryGuarantee,
})
export type QueueAcceptedResponse = typeof QueueAcceptedResponse.Type

/** tmux session 命名唯一真源（设计文档 §五）：server bootstrap、CLI enter/open、WS resolveSession 共用。 */
export const tmuxSessionName = (wsId: string): string => `coolie-${wsId}`

/** CLI 与 GUI 共用的单次 fan-out 实例上限。 */
export const MAX_FANOUT = 16

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
