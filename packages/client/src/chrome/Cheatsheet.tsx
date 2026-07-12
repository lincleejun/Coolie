import { HOTKEYS_REGISTRY } from "../hotkeys/registry"
import { useUi } from "../stores/ui"

export const Cheatsheet = () => {
  const open = useUi((s) => s.cheatsheetOpen)
  if (!open) return null
  const cats = [...new Set(HOTKEYS_REGISTRY.map((h) => h.category))]
  const pretty = (chord: string) => chord.replace("meta+", "⌘").replace("alt+", "⌥").replace("shift+", "⇧").toUpperCase()
  return (
    <div className="modal-backdrop" onClick={() => useUi.getState().setCheatsheet(false)}>
      <div className="modal cheatsheet" onClick={(e) => e.stopPropagation()}>
        <h2>快捷键</h2>
        {cats.map((c) => (
          <section key={c}>
            <h3>{c}</h3>
            {HOTKEYS_REGISTRY.filter((h) => h.category === c).map((h) => (
              <div className="hk-row" key={h.id}><kbd>{pretty(h.chord)}</kbd><span>{h.label}</span></div>
            ))}
          </section>
        ))}
        <p className="dim">终端内：Cmd+←/→ 行首尾、Cmd+⌫ 清行、Option+←/→ 词间跳、Shift+Enter 换行；其余按键直达 engine。</p>
      </div>
    </div>
  )
}
