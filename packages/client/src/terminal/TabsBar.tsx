import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { Tab } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { pushHotkeyLayer } from "../hotkeys/dispatch"
import { TerminalView } from "./Terminal"

/** Open in iTerm2（spec §五）：osascript 起新窗口 attach 同一 tmux session——里外同一画面 */
const SHELL_SAFE = /^[A-Za-z0-9._-]+$/ // F6：socket 名/wsId 拼进 AppleScript 前的白名单——挡引号/分号/换行注入
export const openInIterm = async (tmuxSocket: string, wsId: string): Promise<void> => {
  if (!SHELL_SAFE.test(tmuxSocket) || !SHELL_SAFE.test(wsId))
    throw new Error(`拒绝打开：非法 socket/wsId（仅允许字母数字 . _ -）：${tmuxSocket} / ${wsId}`)
  const cmd = `tmux -L ${tmuxSocket} attach -t coolie-${wsId}`
  const script = [
    'tell application "iTerm2"',
    "  activate",
    "  set w to (create window with default profile)",
    `  tell current session of w to write text "${cmd}"`,
    "end tell",
  ].join("\n")
  await invoke("spawn_detached", { program: "/usr/bin/osascript", args: ["-e", script] })
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
        <button className="tab tab-new" title="新 shell tab（⌘T）" onClick={() => void newShell()}>＋</button>
        <div className="tabsbar-spacer" />
        <button
          className="iterm-btn"
          title="在 iTerm2 中打开（同一 tmux 会话）"
          onClick={() => config && void openInIterm(config.tmuxSocket, wsId)}
        >↗ Open in iTerm2</button>
      </div>
      <div className="term-stack">
        {tabs.filter((t) => t.tmuxWindow !== null).map((t) =>
          // 惰性挂载（F3）：active 或已看过 → 活 TerminalView（active 条件保证首帧不闪占位）；否则零 WS 占位符。
          viewed.has(t.id) || t.id === selected?.id ? (
            <TerminalView key={t.id} wsId={wsId} windowIdx={t.tmuxWindow!} active={t.id === selected?.id} />
          ) : (
            <div key={t.id} className="term-wrap term-placeholder" style={{ visibility: "hidden" }} aria-hidden />
          ),
        )}
        {tabs.length === 0 && <div className="dim center-empty">无终端 tab（workspace 可能已归档）</div>}
      </div>
    </div>
  )
}
