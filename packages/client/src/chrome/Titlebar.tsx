import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { useSettings } from "../settings/settings"
import { useT } from "../i18n"
import type { ThemePref } from "../settings/theme"
import { capabilities } from "../platform"
import { GitBranchIcon, PanelLeftIcon, PanelRightIcon } from "./icons"

const nextTheme = (theme: ThemePref): ThemePref =>
  theme === "system" ? "light" : theme === "light" ? "dark" : "system"

/** Two-letter warm monogram for the project chip (Conductor breadcrumb). */
const monogram = (name: string): string =>
  (name.match(/[A-Za-z0-9]/g)?.slice(0, 2).join("") || name.slice(0, 2)).toUpperCase()

export const Titlebar = () => {
  const tr = useT()
  const status = useData((s) => s.status)
  const theme = useSettings((s) => s.theme)
  const lang = useSettings((s) => s.lang)
  const selectedWs = useUi((s) => s.selectedWs)
  const ws = useData((s) => s.workspaces.find((w) => w.id === selectedWs))
  const project = useData((s) => (ws ? s.projects.find((p) => p.id === ws.projectId) : undefined))
  const rightPanel = useUi((s) => s.rightPanel)
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
      <button
        className="icobtn"
        aria-label={tr("titlebar.toggleSidebar")}
        title={tr("titlebar.toggleSidebar")}
        onClick={() => useUi.getState().toggleSidebar()}
      >
        <PanelLeftIcon />
      </button>
      <div className="titlebar-center" {...dragRegion}>
        {ws ? (
          <>
            <span className="crumb">
              {project && <span className="repo-m">{monogram(project.name)}</span>}
              {project && <span className="proj-name">{project.name}</span>}
              {project && <span className="sep">›</span>}
              <span className="cur">{ws.name}</span>
            </span>
            <span className="titlebar-spacer" />
            <span className="branch-pill" title={ws.branch}>
              <GitBranchIcon size={12} />
              {ws.branch.replace(/^coolie\//, "")}
            </span>
            <button
              className={`icobtn${rightPanel !== "collapsed" ? " on" : ""}`}
              aria-label={tr("titlebar.toggleRight")}
              title={tr("titlebar.toggleRight")}
              onClick={() =>
                useUi.getState().setRightPanel(rightPanel === "collapsed" ? "changes" : "collapsed")
              }
            >
              <PanelRightIcon />
            </button>
          </>
        ) : (
          <span className="crumb"><span className="cur">Coolie</span></span>
        )}
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
