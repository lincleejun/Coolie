import { useEffect, useRef, useState } from "react"
import { ensureServer } from "./api/discovery"
import { makeApi } from "./api/client"
import { startEventStream } from "./api/sse"
import { startGuiLease } from "./api/lease"
import { useData } from "./stores/data"
import { useUi } from "./stores/ui"
import { useGlobalHotkeys } from "./hotkeys/useGlobalHotkeys"
import { Titlebar } from "./chrome/Titlebar"
import { TmuxGuide } from "./chrome/TmuxGuide"
import { Cheatsheet } from "./chrome/Cheatsheet"
import { WarningToasts } from "./chrome/Toasts"
import { Sidebar } from "./sidebar/Sidebar"
import { CenterArea } from "./terminal/TabsBar"
import { Composer } from "./composer/Composer"
import { DispatchPanel, ErrorActions } from "./composer/Dispatch"
import { RightPanel } from "./rightpanel/RightPanel"
import { EmptyState } from "./chrome/EmptyState"

export const App = () => {
  const [bootErr, setBootErr] = useState<string | null>(null)
  const started = useRef(false)
  useGlobalHotkeys()

  useEffect(() => {
    if (started.current) return // StrictMode 双跑防抖
    started.current = true
    let stopSse: (() => void) | null = null
    let stopLease: (() => void) | null = null
    void (async () => {
      try {
        const info = await ensureServer()
        const api = makeApi(info)
        useData.getState().setApi(api)
        await useData.getState().bootstrap()
        useData.getState().setStatus("online")
        stopLease = startGuiLease(api) // [Plan 4 contract — verify at execution]
        stopSse = startEventStream({
          after: 0, // 首连从 0 replay 没意义且量大：用 bootstrap 后的最新态即可 → 实际用当前最大 seq；M1 简化为 0 + 幂等刷新，事件量小可接受
          role: "gui", // Plan-4 server lease：SSE 连接即持有 GUI refcount（连接断＝自动释放）
          getInfo: async () => {
            const fresh = await ensureServer() // server 崩溃：重发现/重拉起（spec §十）
            const freshApi = makeApi(fresh)
            useData.getState().setApi(freshApi)
            void useData.getState().bootstrap()
            return fresh
          },
          onEvent: (e) => useData.getState().applyEvent(e),
          onStatus: (s) => useData.getState().setStatus(s),
        })
      } catch (e: any) {
        setBootErr(e?.message ?? String(e))
      }
    })()
    return () => { stopSse?.(); stopLease?.() }
  }, [])

  const rightPanel = useUi((s) => s.rightPanel)
  const selectedWs = useUi((s) => s.selectedWs)
  const dispatchMode = useUi((s) => s.dispatchMode)
  const status = useData((s) => s.status)
  const selWs = useData((s) => s.workspaces.find((w) => w.id === selectedWs))
  if (bootErr)
    return (
      <div className="app-frame">
        <Titlebar />
        <div className="boot-error">
          <h2>无法连接 coolie-server</h2>
          <pre>{bootErr}</pre>
          <button className="btn" onClick={() => location.reload()}>重试</button>
        </div>
      </div>
    )
  return (
    <div className="app-frame">
      <Titlebar />
      <div className="columns">
        <aside className="col-left"><Sidebar /></aside>
        <main className="col-center">
          {status === "offline" && <div className="offline-banner">server 重连中…（终端画面由 tmux 保管，不会丢）</div>}
          {dispatchMode ? (
            <DispatchPanel />
          ) : selectedWs && selWs ? (
            selWs.status === "error" ? (
              <ErrorActions wsId={selectedWs} />
            ) : selWs.status === "archived" ? (
              <div className="error-actions">
                <span className="dim">已归档（branch 保留）</span>
                <button className="btn" onClick={() => void useData.getState().unarchiveWs(selectedWs)}>恢复</button>
                <button onClick={() => {
                  if (window.confirm(`删除 workspace「${selWs.name}」？\nworktree 会被删除，branch ⑂${selWs.branch} 保留。`))
                    void useData.getState().deleteWs(selectedWs, true)
                }}>删除…</button>
              </div>
            ) : (
              <>
                <CenterArea wsId={selectedWs} />
                <Composer wsId={selectedWs} />
              </>
            )
          ) : (
            <EmptyState />
          )}
        </main>
        <aside className={`col-right ${rightPanel === "collapsed" ? "collapsed" : ""}`}>
          {selectedWs && !dispatchMode && <RightPanel wsId={selectedWs} />}
        </aside>
      </div>
      <TmuxGuide />
      <Cheatsheet />
      <WarningToasts />
    </div>
  )
}
