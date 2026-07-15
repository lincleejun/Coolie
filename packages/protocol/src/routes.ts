export type RouteVerb = "GET" | "POST" | "DELETE"
export type RouteGroup = "system" | "projects" | "events" | "workspaces" | "engines" | "hooks" | "terminal"
export interface RouteSchema {
  readonly method: RouteVerb
  readonly path: string
  readonly description: string
  readonly group?: RouteGroup
  readonly request?: string
  readonly response?: string
  readonly example?: string
}

export const ROUTES = [
  { method: "GET",    path: "/health",       description: "存活探测（免 token）" },
  { method: "POST",   path: "/shutdown",     description: "优雅退出 daemon" },
  { method: "GET",    path: "/clients",      description: "观察连接与 GUI lease 状态" },
  { method: "GET",    path: "/config",       description: "client 引导配置与 engine 能力" },
  { method: "GET",    path: "/engines/custom", description: "列出 custom engine 定义" },
  { method: "POST",   path: "/engines/custom", description: "创建或更新 custom engine argv 定义" },
  { method: "POST",   path: "/engines/custom/presets/copilot", description: "应用 Copilot custom-engine preset" },
  { method: "POST",   path: "/engines/custom/:id/detect", description: "安全执行 engine account/availability 探测" },
  { method: "DELETE", path: "/engines/custom/:id", description: "删除 custom engine" },
  { method: "GET",    path: "/projects",     description: "列出项目" },
  { method: "POST",   path: "/projects",     description: "注册项目 {repoRoot}" },
  { method: "POST",   path: "/projects/clone", description: "克隆并注册项目 {url,dest?}" },
  { method: "GET",    path: "/projects/:id/worktrees/adoptable", description: "发现可采用的已有 branch worktree" },
  { method: "POST",   path: "/projects/:id/worktrees/adopt", description: "采用精确匹配的已有 worktree {path,name?}" },
  { method: "DELETE", path: "/projects/:id", description: "忘记项目（不删仓库）" },
  { method: "GET",    path: "/events",       description: "读取事件 ?after=&limit=&workspace=" },
  { method: "GET",    path: "/events/stream", description: "SSE replay/live；role=gui 持有连接级 lease" },
  { method: "GET",    path: "/collect",      description: "读取后台 collector 当前聚合快照 ?workspace=" },
  { method: "POST",   path: "/collect",      description: "立即刷新 collector 聚合快照 {workspaceId?}" },
  { method: "GET",    path: "/workspaces",   description: "列出 workspace ?project=" },
  { method: "GET",    path: "/workspaces/:id", description: "读取单个 task/workspace" },
  { method: "POST",   path: "/workspaces",   description: "创建惰性 task intent {name?,namePool?,customNames?}" },
  { method: "POST",   path: "/workspaces/reorder", description: "重排项目 task {projectId,workspaceIds[]}" },
  { method: "POST",   path: "/workspaces/:id/rename", description: "修改 task 显示名 {name}" },
  { method: "POST",   path: "/workspaces/:id/task-status", description: "修改 Kobe task 状态 {status}" },
  { method: "POST",   path: "/workspaces/:id/branch", description: "安全重命名 task branch {branch}" },
  { method: "POST",   path: "/workspaces/:id/archive", description: "归档 worktree，保留 branch {force?}" },
  { method: "POST",   path: "/workspaces/:id/unarchive", description: "从 branch 恢复 workspace" },
  { method: "POST",   path: "/workspaces/:id/retry", description: "重试失败的创建流水线" },
  { method: "POST",   path: "/workspaces/:id/pin", description: "设置置顶 {pinned:boolean}" },
  { method: "POST",   path: "/workspaces/:id/ensure", description: "确保 tmux session 存在并按需恢复" },
  { method: "POST",   path: "/workspaces/:id/engine", description: "原地 respawn 指定 engine tab {tabId?,engineId,model?,effort?}" },
  { method: "POST",   path: "/workspaces/:id/zen", description: "切换持久 zen 布局 {zen?,tabId?}" },
  { method: "POST",   path: "/workspaces/:id/finish", description: "创建 PR 和/或合回主 checkout" },
  { method: "POST",   path: "/workspaces/:id/checkpoints", description: "创建非破坏性 checkpoint {label?}，返回 ref/oid 供人工 diff" },
  { method: "GET",    path: "/workspaces/:id/checkpoints", description: "按新到旧列出 checkpoint（active/archived）" },
  { method: "DELETE", path: "/workspaces/:id/checkpoints/:checkpointId", description: "删除 checkpoint 私有 ref（不碰 branch）" },
  { method: "DELETE", path: "/workspaces/:id", description: "删除 worktree 与记录 ?force=1" },
  { method: "POST",   path: "/attachments", description: "上传新 workspace 首条 prompt 的临时图片 {name,mime,dataBase64}" },
  { method: "POST",   path: "/workspaces/:id/attachments", description: "上传单张图片附件 {name,mime,dataBase64}" },
  { method: "GET",    path: "/workspaces/:id/tabs", description: "列出 tab 与 tmux window 映射" },
  { method: "POST",   path: "/workspaces/:id/tabs", description: "创建 engine/shell tab" },
  { method: "POST",   path: "/workspaces/:id/tabs/:tabId/resume", description: "原地恢复 engine tab" },
  { method: "POST",   path: "/workspaces/:id/tabs/:tabId/rename", description: "重命名 tab {title}" },
  { method: "DELETE", path: "/workspaces/:id/tabs/:tabId", description: "关闭 shell/非末个 engine tab" },
  { method: "POST",   path: "/workspaces/:id/input", description: "投递 composer 输入，忙时可入队" },
  { method: "GET",    path: "/workspaces/:id/queue", description: "列出待投递 prompt 队列" },
  { method: "DELETE", path: "/workspaces/:id/queue/:queueId", description: "撤回待投递 prompt" },
  { method: "GET",    path: "/workspaces/:id/git/diffstat", description: "读取相对 baseRef 的 shortstat" },
  { method: "GET",    path: "/workspaces/:id/git/changes", description: "读取分区变更与 untracked" },
  { method: "GET",    path: "/workspaces/:id/git/diff", description: "读取单文件 diff ?section=&path=" },
  { method: "GET",    path: "/workspaces/:id/files", description: "列出 worktree 文件" },
  { method: "GET",    path: "/workspaces/:id/pr-instructions", description: "读取 repo 覆写的 Create PR composer prompt" },
  { method: "GET",    path: "/workspaces/:id/commands", description: "扫描 slash commands" },
  { method: "POST",   path: "/hooks/:engine", description: "动态 engine hook ?workspace=" },
  { method: "POST",   path: "/notify/:engine", description: "动态 engine 完成通知 ?workspace=" },
  { method: "POST",   path: "/hooks/engine-exit", description: "回报 engine 退出 ?workspace= {exitCode}" },
  { method: "GET",    path: "/ws/terminal", description: "WS 终端 ?workspace=&window=&cols=&rows=&token=" },
] as const satisfies ReadonlyArray<RouteSchema>

/** Route metadata is the single discovery source used by both compact and detailed CLI schema output. */
export const routeGroup = (route: RouteSchema): RouteGroup => {
  if (route.path === "/health" || route.path === "/shutdown" || route.path === "/clients" || route.path === "/config")
    return "system"
  if (route.path === "/collect") return "workspaces"
  if (route.path.startsWith("/projects")) return "projects"
  if (route.path.startsWith("/events")) return "events"
  if (route.path.startsWith("/workspaces")) return "workspaces"
  if (route.path.startsWith("/engines")) return "engines"
  if (route.path.startsWith("/hooks") || route.path.startsWith("/notify")) return "hooks"
  return "terminal"
}

export const routeRequestShape = (route: RouteSchema): string => {
  if (route.request) return route.request
  const documentedObject = route.description.match(/\{[^}]+\}/)?.[0]
  if (documentedObject) return documentedObject
  return route.method === "GET" ? "query/path parameters only" : route.method === "DELETE" ? "none" : "{}"
}

export const routeResponseShape = (route: RouteSchema): string =>
  route.response ?? (route.method === "DELETE" ? "204 or JSON result" : "JSON")

export const routeExample = (route: RouteSchema): string => {
  if (route.example) return route.example
  const concrete = route.path
    .replace(":checkpointId", "CHECKPOINT_ID").replace(":queueId", "QUEUE_ID")
    .replace(":tabId", "TAB_ID").replace(":engine", "claude").replace(":id", "ID")
  const request = routeRequestShape(route)
  return `${route.method} ${concrete}${request.startsWith("{") && request !== "{}" ? ` body=${request}` : ""}`
}

export const selectRoutes = (options: { group?: string; verb?: string } = {}): RouteSchema[] =>
  ROUTES.filter((route) =>
    (options.group === undefined || routeGroup(route) === options.group) &&
    (options.verb === undefined || route.method === options.verb.toUpperCase()))
