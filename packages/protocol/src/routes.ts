export const ROUTES = [
  { method: "GET",    path: "/health",       description: "存活探测（免 token）" },
  { method: "POST",   path: "/shutdown",     description: "优雅退出 daemon" },
  { method: "GET",    path: "/projects",     description: "列出已保存项目" },
  { method: "POST",   path: "/projects",     description: "保存项目 {repoRoot}" },
  { method: "DELETE", path: "/projects/:id", description: "忘记项目（只删记录）" },
  { method: "GET",    path: "/events",       description: "事件流游标读取 ?after=&limit=&workspace=" },
] as const satisfies ReadonlyArray<{ method: "GET" | "POST" | "DELETE"; path: string; description: string }>
