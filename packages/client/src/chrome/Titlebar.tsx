import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { useSettings } from "../settings/settings"
import { useT } from "../i18n"
import type { ThemePref } from "../settings/theme"
import { capabilities } from "../platform"

const nextTheme = (theme: ThemePref): ThemePref =>
  theme === "system" ? "light" : theme === "light" ? "dark" : "system"

export const Titlebar = () => {
  const tr = useT()
  const status = useData((s) => s.status)
  const theme = useSettings((s) => s.theme)
  const lang = useSettings((s) => s.lang)
  const selectedWs = useUi((s) => s.selectedWs)
  const ws = useData((s) => s.workspaces.find((w) => w.id === selectedWs))
  const windowAction = async (action: "close" | "minimize" | "toggleMaximize"): Promise<void> => {
    if (!capabilities.windowControls) return
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow()[action]()
  }
  const dragRegion = capabilities.windowControls ? { "data-tauri-drag-region": true } : {}
  return (
    <div className="titlebar" {...dragRegion}>
      {capabilities.windowControls && (
        <div className="traffic" {...dragRegion}>
          <button className="tl close" aria-label={tr("titlebar.close")} title={tr("titlebar.close")} onClick={() => void windowAction("close")} />
          <button className="tl min" aria-label={tr("titlebar.minimize")} title={tr("titlebar.minimize")} onClick={() => void windowAction("minimize")} />
          <button className="tl max" aria-label={tr("titlebar.maximize")} title={tr("titlebar.maximize")} onClick={() => void windowAction("toggleMaximize")} />
        </div>
      )}
      <div className="titlebar-center" {...dragRegion}>
        {ws ? <><strong>{ws.name}</strong><span className="branch">⑂ {ws.branch}</span></> : <strong>Coolie</strong>}
      </div>
      <div className="titlebar-controls">
        <button
          className="tl-pref"
          aria-label={`${tr("titlebar.theme")}：${tr(`theme.${theme}`)}`}
          title={`${tr("titlebar.theme")}：${tr(`theme.${theme}`)}`}
          onClick={() => useSettings.getState().setTheme(nextTheme(theme))}
        >
          {theme === "dark" ? "🌙" : theme === "light" ? "☀" : "◐"}
        </button>
        <button
          className="tl-pref tl-lang"
          aria-label={`${tr("titlebar.language")}：${tr(`language.${lang}`)}`}
          title={`${tr("titlebar.language")}：${tr(`language.${lang}`)}`}
          onClick={() => useSettings.getState().setLang(lang === "zh" ? "en" : "zh")}
        >
          {lang === "zh" ? "中" : "EN"}
        </button>
        <div className={`conn conn-${status}`} title={`server: ${status}`}>
          {status === "online"
            ? `● ${tr("titlebar.status.online")}`
            : status === "offline"
              ? `○ ${tr("titlebar.status.offline")}`
              : `○ ${tr("titlebar.status.connecting")}`}
        </div>
      </div>
    </div>
  )
}
