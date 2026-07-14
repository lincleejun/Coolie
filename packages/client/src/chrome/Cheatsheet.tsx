import { prettyChord } from "../hotkeys/registry"
import { useSettings } from "../settings/settings"
import { useUi } from "../stores/ui"

export const Cheatsheet = () => {
  const open = useUi((s) => s.cheatsheetOpen)
  const registry = useSettings((state) => state.effectiveHotkeys)
  if (!open) return null
  const cats = [...new Set(registry.map((h) => h.category))]
  return (
    <div className="modal-backdrop" onClick={() => useUi.getState().setCheatsheet(false)}>
      <div className="modal cheatsheet" onClick={(e) => e.stopPropagation()}>
        <h2>快捷键</h2>
        {cats.map((c) => (
          <section key={c}>
            <h3>{c}</h3>
            {registry.filter((h) => h.category === c).map((h) => (
              <div className="hk-row" key={h.id}><kbd>{prettyChord(h.chord)}</kbd><span>{h.label}</span></div>
            ))}
          </section>
        ))}
        <p className="dim">终端内：Cmd+←/→ 行首尾、Cmd+⌫ 清行、Option+←/→ 词间跳、Shift+Enter 换行；其余按键直达 engine。</p>
      </div>
    </div>
  )
}
