import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { Tab } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { useTerminal } from "../stores/terminal"
import { pushHotkeyLayer } from "../hotkeys/dispatch"
import { TerminalView } from "./Terminal"
import { buildAttachCommand, buildTerminalLaunch, type TerminalId } from "./terminals"
import { openRunTab } from "./run"

export const openInTerminal = async (
  tmuxSocket: string,
  wsId: string,
  id: TerminalId,
  customTemplate?: string,
): Promise<void> => {
  const { program, args } = buildTerminalLaunch(id, tmuxSocket, wsId, customTemplate)
  await invoke("spawn_detached", { program, args })
}

const tabLabel = (t: Tab): string => {
  if (t.kind === "engine") return t.title ?? "claude" // displayName 来自 server config；title 由 historyReader 派生
  return t.kind
}

export const CenterArea = ({ wsId }: { wsId: string }) => {
  const tabs = useData((s) => s.tabsByWs[wsId]) ?? []
  const config = useData((s) => s.config)
  const engines = config?.engines ?? []
  const selectedId = useUi((s) => s.selectedTabByWs[wsId]) ?? tabs[0]?.id
  const selected = tabs.find((t) => t.id === selectedId) ?? tabs[0]
  const terminalApp = useTerminal((s) => s.terminalApp)
  const customTemplate = useTerminal((s) => s.customTemplate)
  const external = useTerminal((s) => s.externalByWs[wsId] === true)
  const terminalLabel = terminalApp === "iterm2" ? "iTerm2" : terminalApp === "terminal" ? "Terminal.app" : "自定义终端"
  const openExternal = (): void => {
    if (!config) return
    void openInTerminal(config.tmuxSocket, wsId, terminalApp, customTemplate)
      .catch((error: unknown) => alert(error instanceof Error ? error.message : String(error)))
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
  const run = async (): Promise<void> => {
    const api = useData.getState().getApi()
    if (!api) return
    await openRunTab(api, wsId, (workspaceId, tabId) => useUi.getState().selectTab(workspaceId, tabId))
  }
  const closeTab = async (t: Tab): Promise<void> => {
    if (t.kind !== "shell") return // engine/setup/run 不可关（tmux window 归 lifecycle 管）
    const api = useData.getState().getApi()
    if (!api) return
    await api.req("DELETE", `/workspaces/${wsId}/tabs/${t.id}`)
  }

  // tab.* 全局键：随 CenterArea 挂载压层（LIFO：晚于 App base layer，优先命中）
  useEffect(() => {
    return pushHotkeyLayer({
      "tab.newShell": () => void newShell().catch((e) => alert(e.message)),
      "tab.close": () => { if (selected) void closeTab(selected).catch((e) => alert(e.message)) },
    })
  }, [wsId, selected?.id])

  const engineName = (id: string | null) => engines.find((e) => e.id === id)?.displayName ?? id ?? "engine"

  return (
    <div className="center-area">
      <div className="tabsbar">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${t.id === selected?.id ? "active" : ""}`}
            title={t.kind === "engine" ? engineName(t.engineId) : t.kind}
            onClick={() => useUi.getState().selectTab(wsId, t.id)}
          >
            {t.kind === "engine" && <span className={`badge b-${t.status}`}>●</span>}
            <span>{tabLabel(t)}</span>
            {t.kind === "shell" && (
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(t) }}>×</span>
            )}
          </button>
        ))}
        <button className="tab tab-run" title="运行 .coolie/run.sh" onClick={() => void run().catch((e) => alert(e.message))}>Run</button>
        <button className="tab tab-new" title="新 shell tab（⌘T）" onClick={() => void newShell()}>＋</button>
        <div className="tabsbar-spacer" />
        <select
          className="term-picker"
          value={terminalApp}
          onChange={(event) => useTerminal.getState().setTerminalApp(event.target.value as TerminalId)}
          title="选择外部终端"
        >
          <option value="iterm2">iTerm2</option>
          <option value="terminal">Terminal.app</option>
          <option value="custom">自定义 argv</option>
        </select>
        <button
          className="iterm-btn"
          title={`在 ${terminalLabel} 中打开同一 tmux 会话`}
          onClick={openExternal}
        >↗ {terminalLabel}</button>
        <button
          className="term-mode-toggle"
          title="切换外部终端模式"
          onClick={() => useTerminal.getState().toggleExternal(wsId)}
        >{external ? "回内嵌" : "外部模式"}</button>
      </div>
      {terminalApp === "custom" && (
        <label className="term-custom-editor">
          <span>自定义 JSON argv 模板</span>
          <input
            value={customTemplate}
            placeholder={'["/usr/bin/open","-na","WezTerm","--args","sh","-lc","{cmd}"]'}
            onChange={(event) => useTerminal.getState().setCustomTemplate(event.target.value)}
            spellCheck={false}
          />
        </label>
      )}
      {external ? (
        <div className="term-external">
          <p className="dim">外部终端模式已开启。GUI 终端会话与 WebSocket 已释放。</p>
          {config && <code className="attach-cmd">{buildAttachCommand(config.tmuxSocket, wsId)}</code>}
          <div className="term-external-actions">
            <button className="btn" onClick={openExternal}>在 {terminalLabel} 中打开</button>
            <button className="btn-secondary" onClick={() => useTerminal.getState().setExternal(wsId, false)}>回内嵌终端</button>
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
          {tabs.length === 0 && <div className="dim center-empty">无终端 tab（workspace 可能已归档）</div>}
        </div>
      )}
    </div>
  )
}
