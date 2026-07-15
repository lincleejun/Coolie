import { useState } from "react"
import { hotkeyLabel, prettyChord, type HotkeyDef, type HotkeyId } from "../hotkeys/registry"
import { useSettings } from "../settings/settings"
import { useUi } from "../stores/ui"
import { useT } from "../i18n"

const FOOTER_IDS: readonly HotkeyId[] = [
  "workspace.new",
  "composer.focus",
  "engine.interrupt",
  "app.commandPalette",
  "app.cheatsheet",
]

export interface FooterHint {
  readonly id: HotkeyId
  readonly chord: string
  readonly label: string
}

export const footerHints = (
  registry: readonly HotkeyDef[],
  translate: Parameters<typeof hotkeyLabel>[1],
): FooterHint[] =>
  FOOTER_IDS.flatMap((id) => {
    const hotkey = registry.find((candidate) => candidate.id === id)
    return hotkey
      ? [{ id: hotkey.id, chord: prettyChord(hotkey.chord), label: hotkeyLabel(hotkey, translate) }]
      : []
  })

export const Footer = () => {
  const tr = useT()
  const registry = useSettings((state) => state.effectiveHotkeys)
  const [collapsed, setCollapsed] = useState(false)
  const hints = footerHints(registry, tr)

  return (
    <footer className={`app-footer${collapsed ? " collapsed" : ""}`}>
      <button
        className="footer-toggle"
        aria-label={collapsed ? tr("footer.expand") : tr("footer.collapse")}
        onClick={() => setCollapsed((value) => !value)}
      >{collapsed ? "⌃" : "⌄"}</button>
      {!collapsed && (
        <div className="footer-hints">
          {hints.map((hint) => (
            <span className="footer-hint" key={hint.id}>
              <kbd>{hint.chord}</kbd><span>{hint.label}</span>
            </span>
          ))}
        </div>
      )}
      <span className="footer-spacer" />
      <button className="footer-more" onClick={() => useUi.getState().setCheatsheet(true)}>
        {tr("footer.all")}
      </button>
    </footer>
  )
}
