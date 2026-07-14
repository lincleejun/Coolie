import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronDownIcon } from "./icons"

export interface DropdownOption {
  value: string
  label: string
}

export interface DropdownProps {
  value: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
  /** Optional leading glyph/icon rendered inside the chip (e.g. a sparkle). */
  leading?: ReactNode
  className?: string
  title?: string
  /** Shown when no option matches `value`. */
  placeholder?: string
}

/** Conductor-style chip dropdown (`.cchip` + popover menu) — a dependency-free
 *  replacement for native <select>, matching the mockup's model/effort chips. */
export const Dropdown = ({ value, options, onChange, leading, className, title, placeholder }: DropdownProps) => {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false) }
    window.addEventListener("mousedown", onDoc)
    window.addEventListener("keydown", onKey)
    return () => { window.removeEventListener("mousedown", onDoc); window.removeEventListener("keydown", onKey) }
  }, [open])

  return (
    <div className="dd-wrap" ref={wrap}>
      <button
        type="button"
        className={`cchip${className ? ` ${className}` : ""}`}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {leading}
        <span className="cchip-label">{current?.label ?? placeholder ?? value}</span>
        <ChevronDownIcon size={11} className="chev" />
      </button>
      {open && (
        <div className="dd-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dd-item${o.value === value ? " sel" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false) }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
