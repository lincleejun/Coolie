import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { TabKind, TabStatus } from "@coolie/protocol"
import { useData } from "../stores/data"
import { setExternalModeDisposer } from "../stores/terminal"
import {
  createTermSession,
  getOrCreateSession,
  sessionKey,
  disposeSession,
  disposeTabSession,
  disposeWorkspaceSessions,
  type TermState,
} from "./session"
import { createTerminalRecovery, planTerminalRecoveryUi, readableRecoveryError } from "./resume"
import { useT } from "../i18n"
import "./terminal.css"

// F2：Terminal 模块一加载就把真实的会话回收器注入 data store。
// store 里默认是 noop（保持 store 纯 node 可测）；一旦终端进场，workspace.archived/deleted 即触发按 ws 断连。
useData.getState().setSessionDisposer(disposeWorkspaceSessions)
useData.getState().setTabSessionDisposer(disposeTabSession)
setExternalModeDisposer(disposeWorkspaceSessions)

interface TerminalViewProps {
  readonly wsId: string
  readonly tabId: string
  readonly kind: TabKind
  readonly tabStatus: TabStatus
  readonly windowIdx: number
  readonly active: boolean
}

export const TerminalView = ({ wsId, tabId, kind, tabStatus, windowIdx, active }: TerminalViewProps) => {
  const tr = useT()
  const host = useRef<HTMLDivElement>(null)
  const mountedSessionKey = useRef<string | null>(null)
  const [state, setState] = useState<TermState>("connecting")
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const api = useData((s) => s.getApi())
  const refreshTabs = useData((s) => s.refreshTabs)

  useEffect(() => {
    if (!api || !host.current) return
    const key = sessionKey(wsId, tabId, windowIdx)
    if (mountedSessionKey.current !== null && mountedSessionKey.current !== key)
      disposeSession(mountedSessionKey.current)
    mountedSessionKey.current = key
    const s = getOrCreateSession(key, () => createTermSession(api, wsId, windowIdx))
    s.onStateChange = setState
    setState(s.state)
    s.mount(host.current)
    if (active) s.focus()
    return () => { s.unmount() } // 保活：只摘 DOM
  }, [api, wsId, tabId, windowIdx])

  useEffect(() => {
    if (!active || !api) return
    getOrCreateSession(sessionKey(wsId, tabId, windowIdx), () => createTermSession(api, wsId, windowIdx)).focus()
  }, [active, api, wsId, tabId, windowIdx])

  const reconnect = useCallback(async (): Promise<void> => {
    if (!api) return
    await getOrCreateSession(
      sessionKey(wsId, tabId, windowIdx),
      () => createTermSession(api, wsId, windowIdx),
    ).reconnect()
  }, [api, wsId, tabId, windowIdx])

  const recovery = useMemo(() => createTerminalRecovery({
    resume: async () => {
      if (!api) throw new Error("API 尚未就绪")
      return api.req("POST", `/workspaces/${encodeURIComponent(wsId)}/tabs/${encodeURIComponent(tabId)}/resume`)
    },
    refreshTabs: () => refreshTabs(wsId),
    reconnect,
  }), [api, reconnect, refreshTabs, tabId, wsId])

  const resumeEngine = async (): Promise<void> => {
    if (kind !== "engine" || recovery.pending()) return
    setResuming(true)
    setResumeError(null)
    try {
      await recovery.run()
    } catch (error) {
      setResumeError(readableRecoveryError(error))
    } finally {
      setResuming(false)
    }
  }

  const recoveryUi = planTerminalRecoveryUi(kind, state, tabStatus)
  const interruptedLabel = state === "exited"
    ? tr("terminal.exited")
    : state === "dead"
      ? tr("terminal.disconnected")
      : tr("terminal.engineError")

  return (
    <div className="term-wrap" style={{ visibility: active ? "visible" : "hidden", zIndex: active ? 1 : 0 }}>
      <div className="term-container" ref={host} />
      {recoveryUi.interrupted && (
        <div className="term-banner">
          <span>{resumeError ?? interruptedLabel}</span>
          {recoveryUi.showResume && (
            <button className="btn" disabled={resuming} onClick={() => void resumeEngine()}>
              {resuming ? tr("terminal.resuming") : tr("terminal.resume")}
            </button>
          )}
          <button className="btn" onClick={() => void reconnect()}>{tr("terminal.reconnect")}</button>
        </div>
      )}
    </div>
  )
}
