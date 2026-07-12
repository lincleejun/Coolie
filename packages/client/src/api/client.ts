/** 纯 fetch API 封装：无 Tauri 依赖（node 集成测试直接用）。unix sock 是 CLI 的事，浏览器只有 TCP。 */
export interface ServerInfo { port: number; token: string; pid: number; sock?: string }

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = "ApiError"
  }
}

export interface Api {
  readonly info: ServerInfo
  req(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<any>
  wsTerminalUrl(workspaceId: string, window: number, cols: number, rows: number): string
}

export const probeHealth = async (info: ServerInfo): Promise<boolean> => {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(800) })
    return r.ok
  } catch { return false }
}

export const makeApi = (info: ServerInfo): Api => ({
  info,
  req: async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${info.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (r.status === 204) return undefined
    let json: any = {}
    try { json = await r.json() } catch { /* 非 JSON 保持 {} */ }
    if (!r.ok) throw new ApiError(json.code ?? String(r.status), json.message ?? "request failed", r.status)
    return json
  },
  wsTerminalUrl: (workspaceId, window, cols, rows) =>
    `ws://127.0.0.1:${info.port}/ws/terminal?workspace=${encodeURIComponent(workspaceId)}` +
    `&window=${window}&cols=${cols}&rows=${rows}&token=${encodeURIComponent(info.token)}`,
})
