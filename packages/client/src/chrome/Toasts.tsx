import { useData } from "../stores/data"

export const WarningToasts = () => {
  const warnings = useData((s) => s.warnings)
  if (warnings.length === 0) return null
  return (
    <div className="toasts">
      {warnings.map((w) => (
        <div className="toast toast-warn" key={w.id} role="alert">
          <span className="toast-code">{w.code}</span>
          <span className="toast-msg">{w.message}</span>
          <button className="toast-x" title="关闭" onClick={() => useData.getState().dismissWarning(w.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
