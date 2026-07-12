import { useEffect, useRef, useState } from "react"
import { useData } from "../stores/data"
import { createTermSession, getOrCreateSession, sessionKey, disposeWorkspaceSessions, type TermState } from "./session"
import "./terminal.css"

// F2：Terminal 模块一加载就把真实的会话回收器注入 data store。
// store 里默认是 noop（保持 store 纯 node 可测）；一旦终端进场，workspace.archived/deleted 即触发按 ws 断连。
useData.getState().setSessionDisposer(disposeWorkspaceSessions)

/**
 * 退出横幅的 Resume：[Plan 4 contract — verify at execution]
 * Plan 4 提供 engine keep-alive + resume API 后接真按钮（POST resume → session 复活）。
 * 未合并时降级提示走 Open in iTerm2 手动 `claude --resume`。
 */
export const TerminalView = ({ wsId, windowIdx, active }: { wsId: string; windowIdx: number; active: boolean }) => {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<TermState>("connecting")
  const api = useData((s) => s.getApi())

  useEffect(() => {
    if (!api || !host.current) return
    const key = sessionKey(wsId, windowIdx)
    const s = getOrCreateSession(key, () => createTermSession(api, wsId, windowIdx))
    s.onStateChange = setState
    setState(s.state)
    s.mount(host.current)
    if (active) s.focus()
    return () => { s.unmount() } // 保活：只摘 DOM
  }, [api, wsId, windowIdx])

  useEffect(() => {
    if (!active || !api) return
    getOrCreateSession(sessionKey(wsId, windowIdx), () => createTermSession(api, wsId, windowIdx)).focus()
  }, [active, api, wsId, windowIdx])

  const reconnect = (): void => {
    if (!api) return
    getOrCreateSession(sessionKey(wsId, windowIdx), () => createTermSession(api, wsId, windowIdx)).reconnect()
  }

  return (
    <div className="term-wrap" style={{ visibility: active ? "visible" : "hidden", zIndex: active ? 1 : 0 }}>
      <div className="term-container" ref={host} />
      {(state === "exited" || state === "dead") && (
        <div className="term-banner">
          <span>{state === "exited" ? "进程已退出" : "连接已断开（server 重启/会话丢失）"}</span>
          <button className="btn" onClick={reconnect}>重新连接</button>
        </div>
      )}
    </div>
  )
}
