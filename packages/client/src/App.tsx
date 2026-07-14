import { useEffect, useRef, useState } from "react"
import { ensureServer } from "./api/discovery"
import { makeApi } from "./api/client"
import { startEventStream } from "./api/sse"
import { useData } from "./stores/data"
import { useUi } from "./stores/ui"
import { useAttention } from "./stores/attention"
import { useGlobalHotkeys } from "./hotkeys/useGlobalHotkeys"
import { requestNotifyPermission, setBadge } from "./chrome/notify"
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
import { createSafeDeepLinkRouter, installDeepLinkHandlers } from "./deeplink"
import { createAsyncLifecycle } from "./async-lifecycle"

export const App = () => {
  const [bootErr, setBootErr] = useState<string | null>(null)
  const bootstrapLifecycle = useRef<ReturnType<typeof createAsyncLifecycle> | null>(null)
  if (bootstrapLifecycle.current === null) {
    bootstrapLifecycle.current = createAsyncLifecycle(async (owner) => {
      const info = await ensureServer()
      if (!owner.isCurrent()) return
      const api = makeApi(info)
      useData.getState().setApi(api)
      await useData.getState().bootstrap()
      if (!owner.isCurrent()) return
      useData.getState().setStatus("online")
      owner.own(startEventStream({
        after: 0,
        role: "gui",
        getInfo: async () => {
          const fresh = await ensureServer()
          const freshApi = makeApi(fresh)
          useData.getState().setApi(freshApi)
          void useData.getState().bootstrap()
          return fresh
        },
        onEvent: (e) => useData.getState().applyEvent(e),
        onStatus: (s) => useData.getState().setStatus(s),
      }))
      const router = createSafeDeepLinkRouter({
        hasWorkspace: (id) => useData.getState().workspaces.some((workspace) => workspace.id === id),
        hasTab: (workspaceId, tabId) => {
          const tabs = useData.getState().tabsByWs[workspaceId]
          return tabs === undefined || tabs.some((tab) => tab.id === tabId)
        },
        hasProject: (id) => useData.getState().projects.some((project) => project.id === id),
      }, {
        selectWs: (id) => useUi.getState().selectWs(id),
        selectTab: (workspaceId, tabId) => useUi.getState().selectTab(workspaceId, tabId),
        openProjectDispatch: (projectId) => useUi.getState().setDispatchMode(true, projectId),
      })
      owner.own(await installDeepLinkHandlers(router))
    }, (error) => setBootErr(error instanceof Error ? error.message : String(error)))
  }
  useGlobalHotkeys()

  useEffect(() => {
    requestNotifyPermission()
  }, [])

  useEffect(() => {
    return bootstrapLifecycle.current!.start()
  }, [])

  const rightPanel = useUi((s) => s.rightPanel)
  const selectedWs = useUi((s) => s.selectedWs)
  const dispatchMode = useUi((s) => s.dispatchMode)
  const needsYou = useAttention((s) => s.needsYou)
  const status = useData((s) => s.status)
  const selWs = useData((s) => s.workspaces.find((w) => w.id === selectedWs))

  useEffect(() => {
    const clearSelectedAttention = (): void => {
      if (!selectedWs) return
      useAttention.getState().clear(selectedWs)
      setBadge(useAttention.getState().count())
    }
    clearSelectedAttention()
    if (typeof window === "undefined") return
    window.addEventListener("focus", clearSelectedAttention)
    return () => window.removeEventListener("focus", clearSelectedAttention)
  }, [selectedWs])

  const selectAttentionWorkspace = (): void => {
    const wsId = needsYou.values().next().value
    if (typeof wsId !== "string") return
    useUi.getState().selectWs(wsId)
    useAttention.getState().clear(wsId)
    setBadge(useAttention.getState().count())
  }

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
      {needsYou.size > 0 && (
        <button className="attention-banner" onClick={selectAttentionWorkspace}>
          ⚠ {needsYou.size} 个 workspace 需要你
        </button>
      )}
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
