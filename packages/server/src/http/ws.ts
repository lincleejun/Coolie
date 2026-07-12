import { WebSocketServer, WebSocket } from "ws"
import type { Server } from "node:http"
import type { Duplex } from "node:stream"
import { tokenEquals } from "./token.js"
import { spawnTmuxAttach, createGroupedView, killGroupedView, viewSessionName } from "../pty/attach.js"
import type { ClientRegistry } from "../daemon/clients.js"

export const TERMINAL_WS_PATH = "/ws/terminal"

export interface TerminalWsDeps {
  readonly token: string
  readonly tmuxSocket: string
  /** workspace id → tmux session 名；无效/非 active 返回 null */
  readonly resolveSession: (workspaceId: string) => Promise<string | null>
  readonly log?: (msg: string) => void
  /** 登记进 /clients 视图；WS 终端一律 role=terminal——pane 永不持有 server 生命周期（§2.1） */
  readonly clients?: ClientRegistry
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

  // ── 早绑的连接级状态 + 清理（D1 鲁棒性）──
  // grouped view 的创建与 pty spawn 都是异步的：若客户端在这段窗口里断开，close 事件必须仍能回收
  // 已建的 view（否则 view 泄漏）。故 close/error 处理器在任何 await 之前就挂上，清理读共享可变状态。
  const pendingInput: Array<{ data: Buffer; isBinary: boolean }> = []
  let handleInput: (data: Buffer, isBinary: boolean) => void = (data, isBinary) => {
    pendingInput.push({ data, isBinary }) // pty 就绪前的键击/控制帧先入队，就绪后重放
  }
  let closed = false
  let viewSession: string | null = null
  let ptyProc: import("node-pty").IPty | null = null
  let lease: { readonly id: string } | null = null
  let resizeTimer: NodeJS.Timeout | null = null
  // 无守卫、逐资源置空——可安全多次调用（early-close 时 viewSession 尚未赋值，赋值后再调一次即回收）。
  const teardown = (): void => {
    if (lease) { deps.clients?.release(lease.id); lease = null }
    if (resizeTimer !== null) { clearTimeout(resizeTimer); resizeTimer = null }
    if (ptyProc) { try { ptyProc.kill() } catch { /* 已退出 */ } ptyProc = null }
    // D1：回收本连接的 grouped view（杀 view 绝不触及真 session/windows）——close/error/setup 中断都走这里
    if (viewSession) { void killGroupedView(deps.tmuxSocket, viewSession); viewSession = null }
  }
  ws.on("message", (data: Buffer, isBinary: boolean) => handleInput(data, isBinary))
  ws.on("close", () => { closed = true; teardown() })
  ws.on("error", () => { closed = true; teardown() }) // 异常断连同一清理，且避免 unhandled 'error' 抛出

  const session = await deps.resolveSession(wsId).catch(() => null)
  if (session === null) { ws.close(4404, "workspace/session not found"); return }
  if (closed) return // setup 期间已断开（尚无 view）

  // D1：每连接建一次性 grouped view session（共享 windows、current-window 独立），pty attach 到 view——
  // 两个 tab 各 attach 各自 view，切 window 互不干扰（同 session 多 attach 会共享 current-window，互踢）。
  const vs = viewSessionName(session)
  try {
    await createGroupedView({ socket: deps.tmuxSocket, session, viewSession: vs, window: windowIdx })
  } catch (e) {
    deps.log?.(`grouped view create failed: ${String(e)}`)
    void killGroupedView(deps.tmuxSocket, vs) // 半成品也清
    ws.close(4500, "view session create failed")
    return
  }
  viewSession = vs
  if (closed) { teardown(); return } // view 已建但客户端在 setup 中断开 → 立即回收，不 spawn pty

  let p: import("node-pty").IPty
  try {
    p = spawnTmuxAttach({ socket: deps.tmuxSocket, session: vs, window: windowIdx, cols, rows })
  } catch (e) {
    deps.log?.(`pty spawn failed: ${String(e)}`)
    teardown() // 杀已建的 view
    ws.close(4500, "pty spawn failed")
    return
  }
  ptyProc = p
  if (closed) { teardown(); return }

  lease = deps.clients?.register("terminal") ?? null
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
  const applyResize = (): void => {
    if (pendingResize === null || closed) return
    try { p.resize(pendingResize.cols, pendingResize.rows) } catch { /* pty 可能已死 */ }
    pendingResize = null
  }
  // pty 就绪：切换到真正的输入处理，并重放 open→就绪窗口里缓冲的帧
  handleInput = (data: Buffer, isBinary: boolean): void => {
    if (isBinary) {
      // 终端输入字节：原样 Buffer 透传（这就是真实键击字节；绝不 utf8 往返——
      // 方向键/Alt 组合/中文 IME 分段字节含非 UTF8 序列，toString("utf8") 会 replacement-char 化损坏。C1）
      p.write(data)
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
  }
  for (const { data, isBinary } of pendingInput) handleInput(data, isBinary)
  pendingInput.length = 0
  if (closed) teardown() // 就绪后若已断连（罕见竞态），补一次回收（teardown 可重入）
}
