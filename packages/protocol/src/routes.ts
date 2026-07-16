export type RouteVerb = "GET" | "POST" | "DELETE"
export type RouteGroup = "system" | "projects" | "events" | "workspaces" | "engines" | "hooks" | "terminal"
export type RouteAuth = "none" | "bearer"

export interface RouteSchema {
  readonly method: RouteVerb
  readonly path: string
  readonly description: string
  readonly name?: string
  readonly group?: RouteGroup
  readonly request?: string
  readonly response?: string
  readonly example?: string
  readonly errors?: readonly string[]
  readonly idempotency?: string | null
  readonly sideEffects?: string
  readonly auth?: RouteAuth
}

export const ROUTE_GROUPS = [
  "system",
  "projects",
  "events",
  "workspaces",
  "engines",
  "hooks",
  "terminal",
] as const satisfies readonly RouteGroup[]

export const ROUTE_VERBS = ["GET", "POST", "DELETE"] as const satisfies readonly RouteVerb[]

export interface AgentRouteDocument {
  readonly name: string
  readonly method: RouteVerb
  readonly path: string
  readonly group: RouteGroup
  readonly description: string
  readonly auth: RouteAuth
  readonly request: string
  readonly response: string
  readonly errors: readonly string[]
  readonly idempotency: string | null
  readonly sideEffects: string
  readonly example: string
}

export interface AgentApiSchema {
  readonly version: 1
  readonly groups: readonly RouteGroup[]
  readonly verbs: readonly RouteVerb[]
  readonly routes: readonly AgentRouteDocument[]
}

export interface RouteFilterOptions {
  readonly group?: string
  readonly verb?: string
}

export class RouteFilterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RouteFilterError"
  }
}

export const ROUTES = [
  {
    method: "GET",
    path: "/health",
    name: "get.health",
    description: "存活探测（免 token）",
    auth: "none",
    request: "none",
    response: "{ok:true}",
    sideEffects: "read-only",
  },
  {
    method: "POST",
    path: "/shutdown",
    name: "post.shutdown",
    description: "优雅退出 daemon",
    request: "none",
    response: "{ok:true}",
    sideEffects: "daemon shutdown",
    errors: ["401 Validation"],
  },
  {
    method: "GET",
    path: "/clients",
    name: "get.clients",
    description: "观察连接与 GUI lease 状态",
    response: "{clients,guiHolders,lingerMs,idleExitArmed}",
    sideEffects: "read-only",
  },
  {
    method: "GET",
    path: "/config",
    name: "get.config",
    description: "client 引导配置与 engine 能力",
    response: "{tmuxSocket,engines[],namePools[]}",
    sideEffects: "read-only",
  },
  {
    method: "GET",
    path: "/state",
    name: "get.state",
    description: "读取 canonical current-state snapshot；可选 workspace scope；消费流程：GET /state → asOfSeq=N，再 GET /events/stream?after=N 订阅 live 增量",
    request: "query: workspace?",
    response: "CoolieStateSnapshot {asOfSeq,generatedAt,scope,projects,workspaces,tabs,openAttention,queuedPrompts,activeRuns}",
    example: "GET /state?workspace=WORKSPACE_ID",
    sideEffects: "read-only",
  },
  {
    method: "GET",
    path: "/attention",
    name: "get.attention",
    description: "列出 durable attention inbox items；支持 workspace/kind/state/cursor 过滤",
    request: "query: workspace?,kind?,state?,cursorCreatedAt?,cursorId?,limit?",
    response: "AttentionItem[]",
    sideEffects: "read-only",
    errors: ["400 Validation", "401 Validation"],
  },
  {
    method: "GET",
    path: "/attention/:id",
    name: "get.attention.item",
    description: "读取单个 attention item",
    request: "path: id",
    response: "AttentionItem",
    sideEffects: "read-only",
    errors: ["404 NotFound"],
  },
  {
    method: "POST",
    path: "/attention/:id/ack",
    name: "post.attention.ack",
    description: "acknowledge attention item；幂等；写入 attention.acknowledged 事件",
    request: "{expectedEpisode?}",
    response: "AttentionItem",
    sideEffects: "updates attention item; may append attention.acknowledged event",
    idempotency: "same id returns acknowledged item; duplicate ack is no-op",
    errors: ["404 NotFound", "409 Conflict"],
  },
  {
    method: "GET",
    path: "/engines/custom",
    name: "get.engines.custom",
    description: "列出 custom engine 定义",
    response: "CustomEngineDefinition[]",
    sideEffects: "read-only",
  },
  {
    method: "POST",
    path: "/engines/custom",
    name: "post.engines.custom",
    description: "创建或更新 custom engine argv 定义",
    request: "CustomEngineDefinition",
    response: "CustomEngineDefinition",
    sideEffects: "writes custom engine store",
  },
  {
    method: "POST",
    path: "/engines/custom/presets/copilot",
    name: "post.engines.custom.presets.copilot",
    description: "Deprecated: Copilot is built-in. Returns deprecation notice; optional non-reserved id still installs a custom preset copy",
    request: "{id?}",
    response: "{deprecated,message,engineId} | CustomEngineDefinition&{deprecated}",
    sideEffects: "may write custom engine store for non-reserved ids",
  },
  {
    method: "POST",
    path: "/engines/custom/:id/detect",
    name: "post.engines.custom.detect",
    description: "安全执行 engine account/availability 探测",
    request: "path: id",
    response: "{available,accountHint?,error?}",
    sideEffects: "read-only probe",
  },
  {
    method: "DELETE",
    path: "/engines/custom/:id",
    name: "delete.engines.custom",
    description: "删除 custom engine",
    request: "path: id",
    response: "204",
    sideEffects: "deletes custom engine",
  },
  {
    method: "GET",
    path: "/projects",
    name: "get.projects",
    description: "列出项目",
    response: "Project[]",
    sideEffects: "read-only",
  },
  {
    method: "POST",
    path: "/projects",
    name: "post.projects",
    description: "注册项目",
    request: "{repoRoot}",
    response: "Project",
    sideEffects: "creates project row",
  },
  {
    method: "POST",
    path: "/projects/clone",
    name: "post.projects.clone",
    description: "克隆并注册项目",
    request: "{url,dest?}",
    response: "Project",
    sideEffects: "git clone + creates project row",
    errors: ["400 Validation", "409 Conflict"],
  },
  {
    method: "GET",
    path: "/projects/:id/branches",
    name: "get.projects.branches",
    description: "列出项目可用 base branch（local + remote）",
    request: "path: id",
    response: "{branches:string[]}",
    sideEffects: "read-only git probe",
    errors: ["404 NotFound", "500 GitError", "501 Internal"],
  },
  {
    method: "GET",
    path: "/projects/:id/environment/preview",
    name: "get.projects.environment.preview",
    description: "预览 files-to-copy 计划（路径/字节统计，不含内容）",
    request: "path: id",
    response: "CopyPlan",
    sideEffects: "read-only",
    errors: ["404 NotFound", "400 CopyError"],
  },
  {
    method: "GET",
    path: "/projects/:id/worktrees/adoptable",
    name: "get.projects.worktrees.adoptable",
    description: "发现可采用的已有 branch worktree",
    request: "path: id",
    response: "AdoptableWorktree[]",
    sideEffects: "read-only",
  },
  {
    method: "POST",
    path: "/projects/:id/worktrees/adopt",
    name: "post.projects.worktrees.adopt",
    description: "采用精确匹配的已有 worktree",
    request: "{path,name?}",
    response: "Workspace",
    sideEffects: "creates adopted workspace",
  },
  {
    method: "DELETE",
    path: "/projects/:id",
    name: "delete.projects",
    description: "忘记项目（不删仓库）",
    request: "path: id",
    response: "204",
    sideEffects: "deletes project row",
  },
  {
    method: "GET",
    path: "/events",
    name: "get.events",
    description: "读取事件",
    request: "query: after?,limit?,workspace?",
    response: "CoolieEvent[]",
    sideEffects: "read-only",
  },
  {
    method: "GET",
    path: "/events/stream",
    name: "get.events.stream",
    description: "SSE replay/live；role=gui 持有连接级 lease",
    request: "query: after,role?,workspace?,label?",
    response: "SSE CoolieEvent stream",
    sideEffects: "registers GUI lease when role=gui",
    errors: ["400 Validation"],
  },
  {
    method: "GET",
    path: "/collect",
    name: "get.collect",
    description: "读取后台 collector 当前聚合快照",
    request: "query: workspace?",
    response: "CollectorSnapshot[]",
    sideEffects: "read-only",
    errors: ["501 Internal"],
  },
  {
    method: "POST",
    path: "/collect",
    name: "post.collect",
    description: "立即刷新 collector 聚合快照",
    request: "{workspaceId?}",
    response: "CollectorSnapshot[]",
    sideEffects: "runs collector refresh",
    errors: ["400 Validation", "501 Internal"],
  },
  {
    method: "GET",
    path: "/workspaces",
    name: "get.workspaces",
    description: "列出 workspace",
    request: "query: project?",
    response: "Workspace[]",
    sideEffects: "read-only",
  },
  {
    method: "GET",
    path: "/workspaces/:id",
    name: "get.workspaces.item",
    description: "读取单个 task/workspace",
    request: "path: id",
    response: "Workspace",
    sideEffects: "read-only",
  },
  {
    method: "POST",
    path: "/workspaces",
    name: "post.workspaces",
    description: "创建惰性 task intent",
    request: "{projectId,name?,namePool?,customNames?,branchSlug?,baseBranch?,initialPrompt?,engineId?,model?,effort?,attachments?}",
    response: "Workspace",
    sideEffects: "creates workspace intent + async provisioning",
  },
  {
    method: "POST",
    path: "/workspaces/reorder",
    name: "post.workspaces.reorder",
    description: "重排项目 task",
    request: "{projectId,workspaceIds[]}",
    response: "{ok:true}",
    sideEffects: "updates workspace order",
  },
  {
    method: "POST",
    path: "/workspaces/:id/rename",
    name: "post.workspaces.rename",
    description: "修改 task 显示名",
    request: "{name}",
    response: "Workspace",
    sideEffects: "updates workspace metadata",
  },
  {
    method: "POST",
    path: "/workspaces/:id/task-status",
    name: "post.workspaces.task-status",
    description: "修改 Kobe task 状态",
    request: "{status}",
    response: "Workspace",
    sideEffects: "updates workspace metadata",
  },
  {
    method: "POST",
    path: "/workspaces/:id/branch",
    name: "post.workspaces.branch",
    description: "安全重命名 task branch",
    request: "{branch}",
    response: "Workspace",
    sideEffects: "renames git branch",
  },
  {
    method: "POST",
    path: "/workspaces/:id/archive",
    name: "post.workspaces.archive",
    description: "归档 worktree，保留 branch",
    request: "{force?}",
    response: "Workspace",
    sideEffects: "archives workspace + tmux teardown",
  },
  {
    method: "POST",
    path: "/workspaces/:id/unarchive",
    name: "post.workspaces.unarchive",
    description: "从 branch 恢复 workspace",
    request: "path: id",
    response: "Workspace",
    sideEffects: "restores archived workspace",
  },
  {
    method: "POST",
    path: "/workspaces/:id/retry",
    name: "post.workspaces.retry",
    description: "重试失败的创建流水线",
    request: "path: id",
    response: "Workspace",
    sideEffects: "retries provisioning",
  },
  {
    method: "POST",
    path: "/workspaces/:id/pin",
    name: "post.workspaces.pin",
    description: "设置置顶",
    request: "{pinned:boolean}",
    response: "Workspace",
    sideEffects: "updates workspace metadata",
  },
  {
    method: "POST",
    path: "/workspaces/:id/ensure",
    name: "post.workspaces.ensure",
    description: "确保 tmux session 存在并按需恢复",
    request: "path: id",
    response: "HealOutcome",
    sideEffects: "may recreate tmux session",
  },
  {
    method: "POST",
    path: "/workspaces/:id/environment/recopy",
    name: "post.workspaces.environment.recopy",
    description: "显式重复制 files-to-copy；默认不覆盖已有文件，force 需明确确认",
    request: "{force?}",
    response: "CopyResult",
    sideEffects: "copies gitignored files + writes manifest/event",
    errors: ["404 NotFound", "400 CopyError"],
  },
  {
    method: "GET",
    path: "/workspaces/:id/runs",
    name: "get.workspaces.runs",
    description: "列出 workspace 命名 run script 实例状态",
    request: "path: id",
    response: "RunInstanceRecord[]",
    sideEffects: "read-only; may reconcile stale running rows",
  },
  {
    method: "POST",
    path: "/workspaces/:id/runs/:runId/start",
    name: "post.workspaces.runs.start",
    description: "启动命名 run script；同 workspace/runId 幂等",
    request: "path: id,runId",
    response: "RunInstanceRecord",
    sideEffects: "spawns detached process group + run.started event",
    errors: ["404 NotFound", "409 RunError"],
  },
  {
    method: "POST",
    path: "/workspaces/:id/runs/:runId/stop",
    name: "post.workspaces.runs.stop",
    description: "停止命名 run script（SIGHUP→200ms→SIGTERM process group）",
    request: "path: id,runId",
    response: "RunInstanceRecord",
    sideEffects: "stops process group + run.stopped event",
    errors: ["404 NotFound"],
  },
  {
    method: "GET",
    path: "/workspaces/:id/runs/:runId/log",
    name: "get.workspaces.runs.log",
    description: "读取 bounded/redacted run log tail",
    request: "path: id,runId",
    response: "RunLogBuffer",
    sideEffects: "read-only",
    errors: ["404 NotFound"],
  },
  {
    method: "POST",
    path: "/workspaces/:id/engine",
    name: "post.workspaces.engine",
    description: "原地 respawn 指定 engine tab",
    request: "{tabId?,engineId,model?,effort?}",
    response: "Tab",
    sideEffects: "respawns engine tab",
    errors: ["404 NotFound", "409 Conflict"],
  },
  {
    method: "POST",
    path: "/workspaces/:id/zen",
    name: "post.workspaces.zen",
    description: "切换持久 zen 布局",
    request: "{zen?,tabId?}",
    response: "Workspace",
    sideEffects: "updates layout state",
  },
  {
    method: "POST",
    path: "/workspaces/:id/finish",
    name: "post.workspaces.finish",
    description: "创建 PR 和/或合回主 checkout",
    request: "path: id + finish options",
    response: "FinishResult",
    sideEffects: "git/PR operations",
  },
  {
    method: "POST",
    path: "/workspaces/:id/checkpoints",
    name: "post.workspaces.checkpoints",
    description: "创建非破坏性 checkpoint {label?}，返回 ref/oid 供人工 diff",
    request: "{label?}",
    response: "Checkpoint",
    sideEffects: "creates git checkpoint ref",
  },
  {
    method: "GET",
    path: "/workspaces/:id/checkpoints",
    name: "get.workspaces.checkpoints",
    description: "按新到旧列出 checkpoint（active/archived）",
    request: "path: id",
    response: "Checkpoint[]",
    sideEffects: "read-only",
  },
  {
    method: "DELETE",
    path: "/workspaces/:id/checkpoints/:checkpointId",
    name: "delete.workspaces.checkpoints",
    description: "删除 checkpoint 私有 ref（不碰 branch）",
    request: "path: id,checkpointId",
    response: "204",
    sideEffects: "deletes checkpoint ref",
  },
  {
    method: "DELETE",
    path: "/workspaces/:id",
    name: "delete.workspaces",
    description: "删除 worktree 与记录",
    request: "query: force=1?",
    response: "204",
    sideEffects: "deletes workspace + worktree",
  },
  {
    method: "POST",
    path: "/attachments",
    name: "post.attachments",
    description: "上传新 workspace 首条 prompt 的临时图片",
    request: "{name,mime,dataBase64}",
    response: "{attachmentId,url}",
    sideEffects: "writes staging attachment",
  },
  {
    method: "POST",
    path: "/workspaces/:id/attachments",
    name: "post.workspaces.attachments",
    description: "上传单张图片附件",
    request: "{name,mime,dataBase64}",
    response: "{attachmentId,url}",
    sideEffects: "writes workspace attachment",
  },
  {
    method: "GET",
    path: "/workspaces/:id/tabs",
    name: "get.workspaces.tabs",
    description: "列出 tab 与 tmux window 映射",
    request: "path: id",
    response: "Tab[]",
    sideEffects: "read-only",
  },
  {
    method: "GET",
    path: "/workspaces/:id/tabs/:tabId/transcript",
    name: "get.workspaces.tabs.transcript",
    description: "增量读取 engine tab 结构化 transcript；shell/setup 返回 capability unavailable",
    request: "path: id,tabId; query: cursor?,maxEntries?,maxBytes?",
    response: "TranscriptPage",
    sideEffects: "read-only",
    errors: ["404 NotFound"],
  },
  {
    method: "POST",
    path: "/workspaces/:id/tabs",
    name: "post.workspaces.tabs",
    description: "创建 engine/shell tab",
    request: "{kind:'engine'|'shell',engineId?,model?,effort?,title?}",
    response: "Tab",
    sideEffects: "creates tmux window + tab row",
  },
  {
    method: "POST",
    path: "/workspaces/:id/tabs/:tabId/resume",
    name: "post.workspaces.tabs.resume",
    description: "原地恢复 engine tab",
    request: "path: id,tabId",
    response: "Tab",
    sideEffects: "respawns engine tab",
  },
  {
    method: "POST",
    path: "/workspaces/:id/tabs/:tabId/rename",
    name: "post.workspaces.tabs.rename",
    description: "重命名 tab",
    request: "{title}",
    response: "Tab",
    sideEffects: "updates tab metadata",
  },
  {
    method: "DELETE",
    path: "/workspaces/:id/tabs/:tabId",
    name: "delete.workspaces.tabs",
    description: "关闭 shell/非末个 engine tab",
    request: "path: id,tabId",
    response: "204",
    sideEffects: "closes tmux window + tab row",
  },
  {
    method: "POST",
    path: "/workspaces/:id/input",
    name: "post.workspaces.input",
    description: "投递 composer 输入；SQLite queue 为 at-least-once，receipt 前 crash 可重投同一 messageId",
    request: "{text,mode,tabId?,skipStable?,idempotencyKey?} | header: Idempotency-Key?",
    response: "{ok:true} | QueueAcceptedResponse",
    example: "POST /workspaces/WORKSPACE_ID/input body={text,mode:'send'}",
    idempotency: "optional Idempotency-Key header or body.idempotencyKey; same workspace+key+body replays first response; conflicting body → 409",
    sideEffects: "delivers input or enqueues prompt",
    errors: ["400 Validation", "404 NotFound", "409 Conflict", "409 workspace not active"],
  },
  {
    method: "GET",
    path: "/workspaces/:id/queue",
    name: "get.workspaces.queue",
    description: "列出 at-least-once 待投递队列；id/queueId/messageId 标识同一消息",
    request: "query: tabId?",
    response: "QueueListResponse {deliveryGuarantee:'at-least-once',queue:QueuedPromptDto[]}",
    sideEffects: "read-only",
  },
  {
    method: "DELETE",
    path: "/workspaces/:id/queue/:queueId",
    name: "delete.workspaces.queue",
    description: "按 queueId 撤回尚未投递的 at-least-once 消息",
    request: "path: id,queueId",
    response: "{withdrawn:true}",
    sideEffects: "withdraws queued prompt",
  },
  {
    method: "GET",
    path: "/workspaces/:id/git/diffstat",
    name: "get.workspaces.git.diffstat",
    description: "读取相对 baseRef 的 shortstat",
    request: "path: id",
    response: "Diffstat",
    sideEffects: "read-only git inspect",
  },
  {
    method: "GET",
    path: "/workspaces/:id/git/changes",
    name: "get.workspaces.git.changes",
    description: "读取分区变更与 untracked",
    request: "path: id",
    response: "GitChanges",
    sideEffects: "read-only git inspect",
  },
  {
    method: "GET",
    path: "/workspaces/:id/git/diff",
    name: "get.workspaces.git.diff",
    description: "读取单文件 diff",
    request: "query: section?,path",
    response: "GitDiff",
    sideEffects: "read-only git inspect",
    errors: ["400 Validation"],
  },
  {
    method: "GET",
    path: "/workspaces/:id/files",
    name: "get.workspaces.files",
    description: "列出 worktree 文件",
    request: "path: id",
    response: "{files:string[]}",
    sideEffects: "read-only git inspect",
  },
  {
    method: "GET",
    path: "/workspaces/:id/pr-instructions",
    name: "get.workspaces.pr-instructions",
    description: "读取 repo 覆写的 Create PR composer prompt",
    request: "path: id",
    response: "{instructions:string}",
    sideEffects: "read-only",
  },
  {
    method: "GET",
    path: "/workspaces/:id/commands",
    name: "get.workspaces.commands",
    description: "扫描 slash commands",
    request: "path: id",
    response: "{commands:string[]}",
    sideEffects: "read-only",
  },
  {
    method: "POST",
    path: "/hooks/:engine",
    name: "post.hooks.engine",
    description: "动态 engine hook",
    request: "query: workspace,tabId?,sessionId?,window? + hook JSON body",
    response: "{ok:true}",
    sideEffects: "updates tab/engine state from hook",
  },
  {
    method: "POST",
    path: "/notify/:engine",
    name: "post.notify.engine",
    description: "动态 engine 完成通知",
    request: "query: workspace,tabId?,sessionId?,window? + notify JSON body",
    response: "{ok:true}",
    sideEffects: "updates tab/engine state from notify",
  },
  {
    method: "POST",
    path: "/hooks/engine-exit",
    name: "post.hooks.engine-exit",
    description: "回报 engine 退出",
    request: "query: workspace,tabId?,sessionId?,window? + {exitCode,tabId?}",
    response: "{ok:true}",
    sideEffects: "records engine exit",
    errors: ["400 Validation"],
  },
  {
    method: "GET",
    path: "/ws/terminal",
    name: "get.ws.terminal",
    description: "WS 终端",
    request: "query: workspace,window?,cols?,rows?,token",
    response: "WebSocket PTY stream",
    sideEffects: "opens tmux attach websocket",
    auth: "bearer",
  },
] as const satisfies ReadonlyArray<RouteSchema>

const DEFAULT_READ_ERRORS = ["401 Validation"] as const
const DEFAULT_MUTATION_ERRORS = ["400 Validation", "401 Validation", "404 NotFound", "409 Conflict", "500 Internal"] as const

export const routeGroup = (route: RouteSchema): RouteGroup => {
  if (route.group) return route.group
  if (route.path === "/health" || route.path === "/shutdown" || route.path === "/clients" || route.path === "/config" || route.path === "/state")
    return "system"
  if (route.path.startsWith("/attention")) return "workspaces"
  if (route.path === "/collect") return "workspaces"
  if (route.path.startsWith("/projects")) return "projects"
  if (route.path.startsWith("/events")) return "events"
  if (route.path.startsWith("/workspaces")) return "workspaces"
  if (route.path.startsWith("/engines")) return "engines"
  if (route.path.startsWith("/hooks") || route.path.startsWith("/notify")) return "hooks"
  return "terminal"
}

export const routeAuth = (route: RouteSchema): RouteAuth =>
  route.auth ?? (route.path === "/health" ? "none" : "bearer")

export const routeName = (route: RouteSchema): string => {
  if (route.name) return route.name
  const slug = route.path.replace(/^\//, "").replace(/[:/]/g, ".")
  return `${route.method.toLowerCase()}.${slug}`
}

export const routeRequestShape = (route: RouteSchema): string => {
  if (route.request) return route.request
  return route.method === "GET" ? "query/path parameters only" : route.method === "DELETE" ? "none" : "{}"
}

export const routeResponseShape = (route: RouteSchema): string =>
  route.response ?? (route.method === "DELETE" ? "204 or JSON result" : "JSON")

export const routeErrors = (route: RouteSchema): readonly string[] => {
  if (route.errors) return route.errors
  if (routeAuth(route) === "none") return []
  return route.method === "GET" ? DEFAULT_READ_ERRORS : DEFAULT_MUTATION_ERRORS
}

export const routeIdempotency = (route: RouteSchema): string | null =>
  route.idempotency ?? null

export const routeSideEffects = (route: RouteSchema): string =>
  route.sideEffects ?? (route.method === "GET" ? "read-only" : "mutation")

export const routeExample = (route: RouteSchema): string => {
  if (route.example) return route.example
  const concrete = route.path
    .replace(":checkpointId", "CHECKPOINT_ID").replace(":queueId", "QUEUE_ID")
    .replace(":tabId", "TAB_ID").replace(":engine", "claude").replace(":id", "ID")
  const request = routeRequestShape(route)
  return `${route.method} ${concrete}${request.startsWith("{") && request !== "{}" ? ` body=${request}` : ""}`
}

export const toAgentRouteDocument = (route: RouteSchema): AgentRouteDocument => ({
  name: routeName(route),
  method: route.method,
  path: route.path,
  group: routeGroup(route),
  description: route.description,
  auth: routeAuth(route),
  request: routeRequestShape(route),
  response: routeResponseShape(route),
  errors: routeErrors(route),
  idempotency: routeIdempotency(route),
  sideEffects: routeSideEffects(route),
  example: routeExample(route),
})

export const validateRouteFilter = (options: RouteFilterOptions = {}): void => {
  if (options.group !== undefined && !(ROUTE_GROUPS as readonly string[]).includes(options.group))
    throw new RouteFilterError(`unknown schema group: ${options.group}`)
  if (options.verb !== undefined && !(ROUTE_VERBS as readonly string[]).includes(options.verb.toUpperCase() as RouteVerb))
    throw new RouteFilterError(`unknown schema verb: ${options.verb}`)
}

export const selectRoutes = (options: RouteFilterOptions = {}): RouteSchema[] => {
  validateRouteFilter(options)
  return ROUTES.filter((route) =>
    (options.group === undefined || routeGroup(route) === options.group) &&
    (options.verb === undefined || route.method === options.verb.toUpperCase()))
}

export const buildAgentApiSchema = (options: RouteFilterOptions = {}): AgentApiSchema => ({
  version: 1,
  groups: ROUTE_GROUPS,
  verbs: ROUTE_VERBS,
  routes: selectRoutes(options).map(toAgentRouteDocument),
})

export const routeKeys = (): string[] =>
  ROUTES.map((route) => `${route.method} ${route.path}`)
