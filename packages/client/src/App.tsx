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
import { requestNotifyPermission, setBadge } from "./chrome/notify"
import { Titlebar } from "./chrome/Titlebar"
import { TmuxGuide } from "./chrome/TmuxGuide"
import { Cheatsheet } from "./chrome/Cheatsheet"
import { CommandPalette } from "./chrome/CommandPalette"
import { Footer } from "./chrome/Footer"
import { WarningToasts } from "./chrome/Toasts"
import { Sidebar } from "./sidebar/Sidebar"
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

const WebServerSetup = ({ onConnect }: { onConnect: () => void }) => {
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
      <label htmlFor="web-server">现有 server（端口:token）</label>
      <input
        id="web-server"
        type="password"
        autoComplete="off"
        value={value}
        placeholder="3210:token"
        onChange={(event) => { setValue(event.target.value); setInvalid(false); setStorageError(false) }}
        onKeyDown={(event) => { if (event.key === "Enter") connect() }}
      />
      {invalid && <span className="ob-err">格式无效；端口须为 1–65535，token 不能为空。</span>}
      {storageError && <span className="ob-err">浏览器禁止使用 localStorage；请取消保存后连接。</span>}
      <label>
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        保存到 localStorage
      </label>
      <p className="dim">
        保存后 token 可被同源脚本读取，且会一直保留到清除；不保存时 token 只留在本页模块内存，不写入 URL。
      </p>
      <div>
        <button className="btn" onClick={connect}>连接</button>
        {stored && <button className="btn-secondary" onClick={clear}>清除已保存的 token</button>}
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
          {!capabilities.daemonDiscovery && <WebServerSetup onConnect={() => {
            setBootErr(null)
            bootstrapStop.current?.()
            bootstrapStop.current = bootstrapLifecycle.current!.start()
          }} />}
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
      <Footer />
      <TmuxGuide />
      <Cheatsheet />
      <CommandPalette />
      <KeybindingSettings />
      <WarningToasts />
    </div>
  )
}
