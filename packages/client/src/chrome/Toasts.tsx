import { useData } from "../stores/data"
import { useT } from "../i18n"

export const showToast = (code: string, error: unknown): void =>
  useData.getState().pushWarning(code, error instanceof Error ? error.message : String(error))

export const WarningToasts = () => {
  const tr = useT()
  const warnings = useData((s) => s.warnings)
  if (warnings.length === 0) return null
  return (
    <div className="toasts" aria-live="assertive" aria-atomic="false">
      {warnings.map((w) => (
        <div className="toast toast-warn" key={w.id} role="alert">
          <span className="toast-code">{w.code}</span>
          <span className="toast-msg">{w.message}</span>
          <button className="toast-x" title={tr("dialog.close")} aria-label={tr("dialog.close")}
            onClick={() => useData.getState().dismissWarning(w.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
