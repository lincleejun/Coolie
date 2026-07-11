import { WebSocketServer, WebSocket } from "ws"
import type { Server } from "node:http"
import type { Duplex } from "node:stream"
import { tokenEquals } from "./token.js"
import { spawnTmuxAttach } from "../pty/attach.js"

export const TERMINAL_WS_PATH = "/ws/terminal"

export interface TerminalWsDeps {
  readonly token: string
  readonly tmuxSocket: string
  /** workspace id → tmux session 名；无效/非 active 返回 null */
  readonly resolveSession: (workspaceId: string) => Promise<string | null>
  readonly log?: (msg: string) => void
}

const clampInt = (raw: string | null, min: number, max: number, dflt: number): number => {
  if (raw === null) return dflt
  const n = Number(raw)
  if (!Number.isInteger(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

export const attachTerminalWs = (server: Server, deps: TerminalWsDeps): WebSocketServer => {
  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? "/", "http://local")
    if (url.pathname !== TERMINAL_WS_PATH) { socket.destroy(); return }
    // 鉴权先于 upgrade：query token（浏览器主路径）或 Bearer header。日志纪律：不打印 URL。
    const header = (req.headers.authorization ?? "").replace(/^Bearer /, "")
    const qp = url.searchParams.get("token") ?? ""
    const got = header !== "" ? header : qp
    if (got === "" || !tokenEquals(got, deps.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => { void handleConn(ws, url, deps) })
  })
  return wss
}

const handleConn = async (ws: WebSocket, url: URL, deps: TerminalWsDeps): Promise<void> => {
  const wsId = url.searchParams.get("workspace")
  const windowIdx = clampInt(url.searchParams.get("window"), 0, 999, 0)
  const cols = clampInt(url.searchParams.get("cols"), 20, 500, 120)
  const rows = clampInt(url.searchParams.get("rows"), 5, 300, 32)
  if (!wsId) { ws.close(4400, "workspace query param required"); return }
  const session = await deps.resolveSession(wsId).catch(() => null)
  if (session === null) { ws.close(4404, "workspace/session not found"); return }

  let p: import("node-pty").IPty
  try {
    p = spawnTmuxAttach({ socket: deps.tmuxSocket, session, window: windowIdx, cols, rows })
  } catch (e) {
    deps.log?.(`pty spawn failed: ${String(e)}`)
    ws.close(4500, "pty spawn failed")
    return
  }

  let closed = false
  p.onData((d: string | Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return
    // encoding:null → Buffer；类型兜底：万一是 string 用 latin1 保字节
    ws.send(Buffer.isBuffer(d) ? d : Buffer.from(d, "latin1"), { binary: true })
  })
  p.onExit(({ exitCode }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }))
      ws.close(1000, "pty exited")
    }
  })

  // resize 防抖：50ms trailing——GUI 拖窗时高频 resize 直通会让 tmux 布局抖动
  let pendingResize: { cols: number; rows: number } | null = null
  let resizeTimer: NodeJS.Timeout | null = null
  const applyResize = (): void => {
    if (pendingResize === null || closed) return
    try { p.resize(pendingResize.cols, pendingResize.rows) } catch { /* pty 可能已死 */ }
    pendingResize = null
  }
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // 终端输入字节：原样透传（这就是终端本身，不做 prompt 消毒）
      p.write(data.toString("utf8"))
      return
    }
    try {
      const msg = JSON.parse(data.toString("utf8"))
      if (msg?.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        pendingResize = {
          cols: Math.min(500, Math.max(20, msg.cols)),
          rows: Math.min(300, Math.max(5, msg.rows)),
        }
        if (resizeTimer !== null) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(applyResize, 50)
      }
    } catch { /* 坏控制帧：忽略 */ }
  })
  ws.on("close", () => {
    closed = true
    if (resizeTimer !== null) clearTimeout(resizeTimer)
    try { p.kill() } catch { /* 已退出 */ }
  })
}
