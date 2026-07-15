import { useEffect, useRef } from "react"
import { hotkeyCategoryKey, hotkeyLabel, prettyChord } from "../hotkeys/registry"
import { useSettings } from "../settings/settings"
import { consumeModalKey, useUi } from "../stores/ui"
import { useT } from "../i18n"

export const Cheatsheet = () => {
  const open = useUi((s) => s.cheatsheetOpen)
  const tr = useT()
  const registry = useSettings((state) => state.effectiveHotkeys)
  const dialog = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) {
      const target = returnFocus.current
      returnFocus.current = null
      if (target) requestAnimationFrame(() => { if (target.isConnected !== false) target.focus() })
      return
    }
    returnFocus.current ??= document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => dialog.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])
  if (!open) return null
  const cats = [...new Set(registry.map((h) => h.category))]
  return (
    <div className="modal-backdrop" onClick={() => useUi.getState().setCheatsheet(false)}>
      <div ref={dialog} className="modal cheatsheet" role="dialog" aria-modal="true"
        aria-label={tr("cheatsheet.dialog")} tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          consumeModalKey(event, "Escape", () => useUi.getState().setCheatsheet(false))
        }}>
        <h2>{tr("cheatsheet.title")}</h2>
        {cats.map((c) => (
          <section key={c}>
            <h3>{tr(hotkeyCategoryKey(c))}</h3>
            {registry.filter((h) => h.category === c).map((h) => (
              <div className="hk-row" key={h.id}><kbd>{prettyChord(h.chord)}</kbd><span>{
                hotkeyLabel(h, tr)
              }</span></div>
            ))}
          </section>
        ))}
        <p className="dim">{tr("cheatsheet.terminal")}</p>
      </div>
    </div>
  )
}
