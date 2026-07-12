import { useEffect, useState } from "react"
import { pushHotkeyLayer } from "../hotkeys/dispatch"
import "./picker.css"

export const Picker = ({ items, onPick, onClose }: {
  items: string[]; onPick: (item: string) => void; onClose: () => void
}) => {
  const [idx, setIdx] = useState(0)
  useEffect(() => setIdx(0), [items.join("\n")])
  // 打开期间吞掉全局键（LIFO 层）
  useEffect(() => pushHotkeyLayer({ "workspace.new": () => {}, "tab.newShell": () => {}, "tab.close": () => {} }), [])
  if (items.length === 0) return null
  return (
    <div className="picker">
      {items.map((it, i) => (
        <div key={it} className={`picker-row ${i === idx ? "active" : ""}`}
          onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); onPick(it) }}>
          {it}
        </div>
      ))}
      <PickerKeys count={items.length} idx={idx} setIdx={setIdx} pick={() => items[idx] && onPick(items[idx]!)} close={onClose} />
    </div>
  )
}

/** 键盘处理挂 document capture：textarea 焦点不動，↑↓/Enter/Tab/Esc 被 picker 截获 */
const PickerKeys = ({ count, idx, setIdx, pick, close }: {
  count: number; idx: number; setIdx: (i: number) => void; pick: () => void; close: () => void
}) => {
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setIdx((idx + 1) % count) }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setIdx((idx - 1 + count) % count) }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); pick() }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close() }
    }
    document.addEventListener("keydown", h, true)
    return () => document.removeEventListener("keydown", h, true)
  }, [count, idx, pick, close])
  return null
}
