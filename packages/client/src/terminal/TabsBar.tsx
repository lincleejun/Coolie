import { useEffect, useState } from "react"
import type { Tab } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { useTerminal } from "../stores/terminal"
import { pushHotkeyLayer } from "../hotkeys/dispatch"
import { TerminalView } from "./Terminal"
import { buildAttachCommand, type TerminalId } from "./terminals"
import { capabilities } from "../platform"
import { CloseIcon, PlusIcon } from "../chrome/icons"
import { Dropdown } from "../chrome/Dropdown"
import { CenterDiff } from "../rightpanel/CenterDiff"
import { promptDialog } from "../chrome/dialogs"
import { t as translate, useT } from "../i18n"

export const openInTerminal = async (
  tmuxSocket: string,
  wsId: string,
  id: TerminalId,
): Promise<void> => {
  if (!capabilities.externalTerminal) throw new Error(translate("terminal.webExternalUnavailable"))
  const attachCommand = buildAttachCommand(tmuxSocket, wsId)
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("open_external_terminal", {
    terminal: id,
    attachCommand,
  })
}

// engineLabel 由调用方按 tab.engineId 从 /config 解析（绝不硬编码 vendor 名——否则 codex 会误显示为 claude）。
const tabLabel = (t: Tab, engineLabel: string): string =>
  t.kind === "engine" ? (t.title ?? engineLabel) : t.kind

export const cycleTabId = (tabs: readonly Tab[], selectedId: string | undefined, delta: -1 | 1): string | null => {
  if (tabs.length === 0) return null
  const current = Math.max(0, tabs.findIndex((tab) => tab.id === selectedId))
  return tabs[(current + delta + tabs.length) % tabs.length]!.id
}

export const CenterArea = ({ wsId }: { wsId: string }) => {
  const tr = useT()
  const report = (error: unknown): void =>
    useData.getState().pushWarning("terminal.action", error instanceof Error ? error.message : String(error))
  const tabs = useData((s) => s.tabsByWs[wsId]) ?? []
  const config = useData((s) => s.config)
  const workspace = useData((s) => s.workspaces.find((item) => item.id === wsId))
  const engines = config?.engines ?? []
  const selectedId = useUi((s) => s.selectedTabByWs[wsId]) ?? tabs[0]?.id
  const selected = tabs.find((t) => t.id === selectedId) ?? tabs[0]
  const centerDiff = useUi((s) => s.centerDiff)
  const activeDiff = centerDiff?.wsId === wsId ? centerDiff : null
  const terminalApp = useTerminal((s) => s.terminalApp)
  const external = useTerminal((s) => capabilities.externalTerminal && s.externalByWs[wsId] === true)
  const terminalLabel = terminalApp === "iterm2"
    ? "iTerm2"
    : terminalApp === "terminal" ? "Terminal.app" : "WezTerm"
  const openExternal = (): void => {
    if (!config) return
    void openInTerminal(config.tmuxSocket, wsId, terminalApp)
      .catch(report)
  }

  // F3 惰性挂载（spec §五："PTY per 在看的 tab"）：只有被看过的 tab 才挂活 TerminalView/WS；
  // 未看过的后台 tab 是零连接占位符。看过一次即进 viewed，之后切走仍保活（会话注册表语义 + F2 归档回收）。
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (!selected) return
    setViewed((v) => v.has(selected.id) ? v : new Set(v).add(selected.id))
  }, [selected?.id])

  const newShell = async (): Promise<void> => {
    const api = useData.getState().getApi()
    if (!api) return
    const tab = await api.req("POST", `/workspaces/${wsId}/tabs`, { kind: "shell" })
    useUi.getState().selectTab(wsId, tab.id)
  }
  const newEngine = async (): Promise<void> => {
    const api = useData.getState().getApi()
    const engineId = selected?.kind === "engine" ? selected.engineId : engines[0]?.id
    if (!api || !engineId) return
    const tab = await api.req("POST", `/workspaces/${wsId}/tabs`, { kind: "engine", engineId })
    useUi.getState().selectTab(wsId, tab.id)
  }
  const closeTab = async (t: Tab): Promise<void> => {
    if (t.kind !== "shell" && t.kind !== "engine") return
    const api = useData.getState().getApi()
    if (!api) return
    await api.req("DELETE", `/workspaces/${wsId}/tabs/${t.id}`)
    const next = tabs.find((candidate) => candidate.id !== t.id && candidate.kind === "engine")
      ?? tabs.find((candidate) => candidate.id !== t.id)
    if (next) useUi.getState().selectTab(wsId, next.id)
  }
  const renameTab = async (t: Tab): Promise<void> => {
    const api = useData.getState().getApi()
    if (!api) return
    const title = (await promptDialog(
      translate("dialog.renameTab"), translate("dialog.tabTitle"), t.title ?? tabLabel(t, engineName(t.engineId)),
    ))?.trim()
    if (!title) return
    await api.req("POST", `/workspaces/${wsId}/tabs/${t.id}/rename`, { title })
  }
  const cycle = (delta: -1 | 1): void => {
    const id = cycleTabId(tabs, selected?.id, delta)
    if (id) useUi.getState().selectTab(wsId, id)
  }
  const toggleZen = async (): Promise<void> => {
    const engineTab = selected?.kind === "engine" ? selected : tabs.find((tab) => tab.kind === "engine")
    if (engineTab && engineTab.id !== selected?.id) useUi.getState().selectTab(wsId, engineTab.id)
    await useData.getState().toggleZen(wsId, engineTab?.id)
  }

  // tab.* 全局键：随 CenterArea 挂载压层（LIFO：晚于 App base layer，优先命中）
  useEffect(() => {
    return pushHotkeyLayer({
      "tab.newShell": () => void newShell().catch(report),
      "tab.newEngine": () => void newEngine().catch(report),
      "tab.prev": () => cycle(-1),
      "tab.next": () => cycle(1),
      "tab.rename": () => { if (selected) void renameTab(selected).catch(report) },
      "tab.close": () => {
        if (activeDiff) useUi.getState().closeCenterDiff()
        else if (selected) void closeTab(selected).catch(report)
      },
      "workspace.zen": () => void toggleZen().catch(report),
    })
  }, [wsId, selected?.id, tabs, activeDiff?.path, activeDiff?.section, workspace?.zenMode])

  const engineName = (id: string | null) => engines.find((e) => e.id === id)?.displayName ?? id ?? "engine"

  return (
    <div className={`center-area ${workspace?.zenMode ? "zen-mode" : ""}`}>
      <div className="tabsbar">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${!activeDiff && t.id === selected?.id ? "active" : ""}`}
            title={t.kind === "engine" ? engineName(t.engineId) : t.kind}
            onClick={() => useUi.getState().selectTab(wsId, t.id)}
            onDoubleClick={() => void renameTab(t)}
          >
            {t.kind === "engine" && <span className={`badge b-${t.status}`}>●</span>}
            <span>{tabLabel(t, engineName(t.engineId))}</span>
            {t.kind === "engine" && <span className="dim">{engineName(t.engineId)} · {t.status}</span>}
            {(t.kind === "shell" || (t.kind === "engine" && tabs.filter((tab) => tab.kind === "engine").length > 1)) && (
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(t) }}><CloseIcon size={12} /></span>
            )}
          </button>
        ))}
        {activeDiff && (
          <button className="tab tab-diff active" title={activeDiff.path}>
            <span>{activeDiff.path.split("/").at(-1)}</span>
            <span
              className="tab-close"
              onClick={(event) => { event.stopPropagation(); useUi.getState().closeCenterDiff() }}
            >
              <CloseIcon size={12} />
            </span>
          </button>
        )}
        <button className="tab tab-new" title={tr("terminal.newEngine")} aria-label={tr("hotkey.tab.newEngine")} onClick={() => void newEngine()}>＋AI</button>
        <button className="tab tab-new" title={tr("terminal.newShell")} aria-label={tr("hotkey.tab.newShell")} onClick={() => void newShell()}><PlusIcon size={14} /></button>
        <div className="tabsbar-spacer" />
        <button
          className={`term-mode-toggle ${workspace?.zenMode ? "active" : ""}`}
          title={tr("terminal.toggleZen")}
          onClick={() => void toggleZen().catch(report)}
        >{workspace?.zenMode ? tr("terminal.exitZen") : "Zen"}</button>
        {capabilities.externalTerminal && (
          <>
            <Dropdown
              className="term-picker-chip"
              title={tr("terminal.selectExternal")}
              value={terminalApp}
              onChange={(v) => useTerminal.getState().setTerminalApp(v as TerminalId)}
              options={[
                { value: "iterm2", label: "iTerm2" },
                { value: "terminal", label: "Terminal.app" },
                { value: "wezterm", label: "WezTerm" },
              ]}
            />
            <button
              className="iterm-btn"
              title={tr("terminal.openExternal").replace("{terminal}", terminalLabel)}
              onClick={openExternal}
            >↗ {terminalLabel}</button>
            <button
              className="term-mode-toggle"
              title={tr("terminal.toggleExternal")}
              onClick={() => useTerminal.getState().toggleExternal(wsId)}
            >{external ? tr("terminal.embedded") : tr("terminal.externalMode")}</button>
          </>
        )}
      </div>
      {activeDiff ? (
        <CenterDiff wsId={wsId} section={activeDiff.section} path={activeDiff.path} />
      ) : (
        <>
          {external ? (
            <div className="term-external">
              <p className="dim">{tr("terminal.externalActive")}</p>
              {config && <code className="attach-cmd">{buildAttachCommand(config.tmuxSocket, wsId)}</code>}
              <div className="term-external-actions">
                <button className="btn" onClick={openExternal}>{tr("terminal.openIn").replace("{terminal}", terminalLabel)}</button>
                <button className="btn-secondary" onClick={() => useTerminal.getState().setExternal(wsId, false)}>{tr("terminal.backEmbedded")}</button>
              </div>
            </div>
          ) : (
            <div className="term-stack">
              {tabs.filter((t) => t.tmuxWindow !== null).map((t) =>
                // 惰性挂载（F3）：active 或已看过 → 活 TerminalView（active 条件保证首帧不闪占位）；否则零 WS 占位符。
                viewed.has(t.id) || t.id === selected?.id ? (
                  <TerminalView
                    key={t.id}
                    wsId={wsId}
                    tabId={t.id}
                    kind={t.kind}
                    tabStatus={t.status}
                    windowIdx={t.tmuxWindow!}
                    active={t.id === selected?.id}
                  />
                ) : (
                  <div key={t.id} className="term-wrap term-placeholder" style={{ visibility: "hidden" }} aria-hidden />
                ),
              )}
              {tabs.length === 0 && <div className="dim center-empty">{tr("terminal.empty")}</div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
