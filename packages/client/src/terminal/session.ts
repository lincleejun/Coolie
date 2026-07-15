import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { arbitrateTerminalKey } from "./arbitrate"
import { createTerminalSocketController } from "./socket"
import type { Api } from "../api/client"
import { terminalTheme, type ResolvedTheme } from "../settings/theme"

export type TermState = "connecting" | "open" | "exited" | "dead"

export interface TermSession {
  readonly el: HTMLDivElement
  readonly term: Terminal
  state: TermState
  exitCode: number | null
  onStateChange?: (s: TermState) => void
  mount(container: HTMLElement): void
  unmount(): void
  focus(): void
  reconnect(): Promise<void>
  dispose(): void
}

const enc = new TextEncoder()
let activeTheme: ResolvedTheme = "dark"

export const syncTerminalTheme = (theme: ResolvedTheme): void => {
  activeTheme = theme
  for (const session of sessions.values()) session.term.options.theme = terminalTheme(theme)
}

export const createTermSession = (api: Api, workspaceId: string, windowIdx: number): TermSession => {
  const el = document.createElement("div")
  el.className = "term-host"
  const term = new Terminal({
    fontFamily: "Menlo, Monaco, 'SF Mono', monospace",
    fontSize: 13,
    scrollback: 10_000,
    allowProposedApi: true,
    theme: terminalTheme(activeTheme),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  let opened = false
  let disposed = false
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let ro: ResizeObserver | null = null
  let session!: TermSession
  const setState = (state: TermState): void => {
    session.state = state
    session.onStateChange?.(state)
  }
  const socket = createTerminalSocketController(
    () => api.wsTerminalUrl(workspaceId, windowIdx, term.cols, term.rows),
    {
      onOpen: () => { setState("open"); pushResize() },
      onMessage: (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data)
            if (msg?.type === "exit") { session.exitCode = msg.code ?? null; setState("exited") }
          } catch { /* 未知控制帧忽略 */ }
          return
        }
        term.write(new Uint8Array(ev.data as ArrayBuffer))
      },
      onClose: () => {
        if (session.state === "open" || session.state === "connecting") setState("dead")
      },
    },
  )

  session = {
    el, term, state: "connecting", exitCode: null,
    mount(container) {
      container.appendChild(el)
      if (!opened) {
        opened = true
        term.open(el)
        void loadRenderer()
        safeFit()
        socket.connect()
        // heal：字体度量 settle 后 refit（首帧 WebGL atlas 用错度量的经典坑，superset plans/20260425）
        void document.fonts.ready.then(() => { safeFit(); pushResize() })
        ro = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => { safeFit(); pushResize() }, 150)
        })
        ro.observe(el)
      } else {
        safeFit()
        pushResize()
      }
    },
    unmount() { el.parentElement?.removeChild(el) }, // xterm 实例保活：scrollback/连接不丢
    focus() { term.focus() },
    async reconnect() {
      if (disposed) return
      setState("connecting")
      session.exitCode = null
      await socket.reconnect()
    },
    dispose() {
      disposed = true
      ro?.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      socket.dispose()
      term.dispose()
      el.remove()
    },
  }

  const safeFit = (): void => {
    // 容器无尺寸（display:none/未布局）时 fit 会抛：吞掉，等下一次
    try { if (el.clientWidth > 4 && el.clientHeight > 4) fit.fit() } catch { /* skip */ }
  }

  const pushResize = (): void => {
    socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
  }

  const loadRenderer = async (): Promise<void> => {
    // WebGL → DOM fallback（xterm #5816 macOS beta WebGL 损坏 + context loss；claude-terminal try/catch 模式）
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl")
      const gl = new WebglAddon()
      gl.onContextLoss(() => gl.dispose()) // dispose 后 xterm 自动回落 DOM 渲染
      term.loadAddon(gl)
    } catch { /* DOM 渲染兜底 */ }
  }

  // 输入：xterm onData（含粘贴/IME 提交）→ 二进制帧
  term.onData((d) => { socket.send(enc.encode(d)) })

  // 三层键位仲裁（Task 7 纯函数）：bubble → xterm bail 且事件冒泡给 document；write → 直写 PTY
  term.attachCustomKeyEventHandler((e) => {
    const decision = arbitrateTerminalKey(e as unknown as Parameters<typeof arbitrateTerminalKey>[0])
    if (decision.action === "pty") return true
    if (decision.action === "write") {
      e.preventDefault()
      socket.send(enc.encode(decision.bytes))
      return false
    }
    return false // bubble：xterm 不处理，事件自然冒泡到全局 dispatcher
  })

  return session
}

/* ---- 会话注册表：tab 切换/组件卸载不销毁（终端保活归 GUI 生命周期，engine 保活归 tmux） ----
 * 生命周期上界（F2/F3）：会话只在 (a) workspace 归档/删除 → disposeWorkspaceSessions（data store applyEvent 调用），
 *   或 (b) 手动关 tab → disposeTabSession 时回收；从不在 tab 切换/卸载时断连。
 * 惰性挂载（F3）：只有被看过的 tab 才进注册表——CenterArea 只给 active/已看过的 tab 渲染 TerminalView，
 *   未看过的后台 tab 是占位符、零 WS。因此活会话数 ≤ 用户实际看过的 tab 数（人手频度，天然有界）。
 * LRU 上界（可选，cheap）：若某 workspace tab 极多，可在 getOrCreateSession 里对同 wsId 前缀的会话按最近 mount 时间
 *   淘汰到 N（如 8）个——M1 不实装（Map 迭代顺序即插入序，加一个 lastTouch 时间戳与阈值即可），记为已知延展点。 */
const sessions = new Map<string, TermSession>()

// Both identities matter: tmux may reuse an index for a replacement tab, while
// heal may move the same tab to another index.
export const sessionKey = (wsId: string, tabId: string, windowIdx: number): string =>
  `${wsId}:${tabId}:${windowIdx}`
export const getOrCreateSession = (key: string, make: () => TermSession): TermSession => {
  // dead/exited 会话刻意保留复用（Reconnect 走 session.reconnect()，xterm 画面不清空）
  let s = sessions.get(key)
  if (!s) { s = make(); sessions.set(key, s) }
  return s
}
export const disposeSession = (key: string): void => { sessions.get(key)?.dispose(); sessions.delete(key) }
export const disposeTabSession = (wsId: string, tabId: string): void => {
  const prefix = `${wsId}:${tabId}:`
  for (const [key, session] of sessions) {
    if (!key.startsWith(prefix)) continue
    session.dispose()
    sessions.delete(key)
  }
}
export const disposeWorkspaceSessions = (wsId: string): void => {
  for (const [k, s] of sessions) if (k.startsWith(`${wsId}:`)) { s.dispose(); sessions.delete(k) }
}
