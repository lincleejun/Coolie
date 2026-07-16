import { useEffect, useRef, useState } from "react"
import {
  clearStoredWebServer,
  ensureServer,
  hasStoredWebServer,
  parseServerSpecifier,
  saveStoredWebServer,
  setSessionWebServer,
} from "./api/discovery"
import { makeApi } from "./api/client"
import { startEventStream } from "./api/sse"
import { useData } from "./stores/data"
import { useUi } from "./stores/ui"
import { useAttention } from "./stores/attention"
import { useGlobalHotkeys } from "./hotkeys/useGlobalHotkeys"
import { requestNotifyPermission } from "./chrome/notify"
import { Titlebar } from "./chrome/Titlebar"
import { TmuxGuide } from "./chrome/TmuxGuide"
import { Cheatsheet } from "./chrome/Cheatsheet"
import { CommandPalette } from "./chrome/CommandPalette"
import { Footer } from "./chrome/Footer"
import { showToast, WarningToasts } from "./chrome/Toasts"
import { Sidebar } from "./sidebar/Sidebar"
import { InboxPanel } from "./attention/Inbox"
import { deleteConfirmation } from "./sidebar/taskCommands"
import { CenterArea } from "./terminal/TabsBar"
import { Composer } from "./composer/Composer"
import { DispatchPanel, ErrorActions } from "./composer/Dispatch"
import { RightPanel } from "./rightpanel/RightPanel"
import { EmptyState } from "./chrome/EmptyState"
import { createSafeDeepLinkRouter, installDeepLinkHandlers } from "./deeplink"
import { createAsyncLifecycle } from "./async-lifecycle"
import { KeybindingSettings } from "./settings/KeybindingSettings"
import { useSettings } from "./settings/settings"
import { applyResolvedTheme, resolveTheme, systemIsDark, watchSystemTheme } from "./settings/theme"
import { syncTerminalTheme } from "./terminal/session"
import { useT } from "./i18n"
import { capabilities } from "./platform"
import { DialogHost, confirmDialog } from "./chrome/dialogs"

const WebServerSetup = ({ onConnect }: { onConnect: () => void }) => {
  const tr = useT()
  const [value, setValue] = useState("")
  const [remember, setRemember] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [storageError, setStorageError] = useState(false)
  const [stored, setStored] = useState(() => hasStoredWebServer())
  const connect = (): void => {
    if (parseServerSpecifier(value) === null) {
      setInvalid(true)
      return
    }
    if (remember) {
      if (!saveStoredWebServer(value)) {
        setStorageError(true)
        return
      }
    } else {
      clearStoredWebServer()
    }
    setSessionWebServer(value)
    setStored(remember)
    onConnect()
  }
  const clear = (): void => {
    clearStoredWebServer()
    setStored(false)
  }
  return (
    <div className="web-server-setup">
      <label htmlFor="web-server">{tr("app.server.label")}</label>
      <input
        id="web-server"
        type="password"
        autoComplete="off"
        value={value}
        placeholder="3210:token"
        onChange={(event) => { setValue(event.target.value); setInvalid(false); setStorageError(false) }}
        onKeyDown={(event) => { if (event.key === "Enter") connect() }}
      />
      {invalid && <span className="ob-err">{tr("app.server.invalid")}</span>}
      {storageError && <span className="ob-err">{tr("app.server.storageError")}</span>}
      <label>
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        {tr("app.server.remember")}
      </label>
      <p className="dim">
        {tr("app.server.security")}
      </p>
      <div>
        <button className="btn" onClick={connect}>{tr("app.server.connect")}</button>
        {stored && <button className="btn-secondary" onClick={clear}>{tr("app.server.clear")}</button>}
      </div>
    </div>
  )
}

export const App = () => {
  const tr = useT()
  const [bootErr, setBootErr] = useState<string | null>(null)
  const bootstrapLifecycle = useRef<ReturnType<typeof createAsyncLifecycle> | null>(null)
  const bootstrapStop = useRef<(() => void) | null>(null)
  if (bootstrapLifecycle.current === null) {
    bootstrapLifecycle.current = createAsyncLifecycle(async (owner) => {
      // SSE starts at seq 0 to rebuild durable state. Only events produced after this GUI
      // session began are eligible to raise "needs you"; older replay still refreshes stores.
      const attentionStartedAt = Date.now()
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
        onEvent: (e) => useData.getState().applyEvent(e, { allowAttention: e.ts >= attentionStartedAt }),
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
    const apply = (theme: "light" | "dark"): void => {
      applyResolvedTheme(theme)
      syncTerminalTheme(theme)
    }
    const applyPreference = (): void => {
      apply(resolveTheme(useSettings.getState().theme, systemIsDark()))
    }
    applyPreference()
    const stopSystem = watchSystemTheme(() => useSettings.getState().theme, apply)
    const stopSettings = useSettings.subscribe((state, previous) => {
      if (state.theme !== previous.theme) applyPreference()
    })
    return () => {
      stopSystem()
      stopSettings()
    }
  }, [])

  useEffect(() => {
    bootstrapStop.current = bootstrapLifecycle.current!.start()
    return () => bootstrapStop.current?.()
  }, [])

  const rightPanel = useUi((s) => s.rightPanel)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const selectedWs = useUi((s) => s.selectedWs)
  const dispatchMode = useUi((s) => s.dispatchMode)
  const attentionCount = useAttention((s) => s.count())
  const status = useData((s) => s.status)
  const selWs = useData((s) => s.workspaces.find((w) => w.id === selectedWs))

  const selectedTab = useUi((s) => selectedWs ? s.selectedTabByWs[selectedWs] : undefined)

  useEffect(() => {
    const api = useData.getState().getApi()
    const tryAck = (): void => {
      if (!api || !selectedWs) return
      void useAttention.getState().tryAckVisible(api, selectedWs, selectedTab)
    }
    tryAck()
    if (typeof window === "undefined") return
    window.addEventListener("focus", tryAck)
    return () => window.removeEventListener("focus", tryAck)
  }, [selectedWs, selectedTab])

  const openInbox = (): void => useUi.getState().setInboxOpen(true)

  if (bootErr)
    return (
      <div className="app-frame">
        <Titlebar />
        <div className="boot-error">
          <h2>{tr("app.connectionFailed")}</h2>
          <pre>{bootErr}</pre>
          {!capabilities.daemonDiscovery && <WebServerSetup onConnect={() => {
            setBootErr(null)
            bootstrapStop.current?.()
            bootstrapStop.current = bootstrapLifecycle.current!.start()
          }} />}
          <button className="btn" onClick={() => location.reload()}>{tr("app.retry")}</button>
        </div>
      </div>
    )
  return (
    <div className="app-frame">
      <Titlebar />
      {attentionCount > 0 && (
        <button className="attention-banner" onClick={openInbox}>
          ⚠ {tr("app.needsYou").replace("{count}", String(attentionCount))}
        </button>
      )}
      <div className="columns">
        {!sidebarCollapsed && <aside className="col-left"><Sidebar /></aside>}
        <main className="col-center">
          {status === "offline" && <div className="offline-banner">{tr("offline.banner")}</div>}
          {dispatchMode ? (
            <DispatchPanel />
          ) : selectedWs && selWs ? (
            selWs.status === "error" ? (
              <ErrorActions wsId={selectedWs} />
            ) : selWs.status === "archived" ? (
              <div className="error-actions">
                <span className="dim">{tr("app.archivedRetained")}</span>
                <button className="btn" onClick={() => void useData.getState().unarchiveWs(selectedWs)
                  .catch((error: unknown) => showToast("task.lifecycle", error))}>{tr("task.restore")}</button>
                <button onClick={() => void confirmDialog(
                  tr("task.deleteTitle"),
                  deleteConfirmation(selWs),
                  true,
                ).then((confirmed) => {
                  if (confirmed) return useData.getState().deleteWs(selectedWs, true)
                }).catch((error: unknown) => showToast("task.lifecycle", error))}>{tr("task.delete")}</button>
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
      <Footer />
      <TmuxGuide />
      <Cheatsheet />
      <CommandPalette />
      <KeybindingSettings />
      <WarningToasts />
      <DialogHost />
      <InboxPanel />
    </div>
  )
}
