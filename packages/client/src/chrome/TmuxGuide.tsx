import { useEffect, useState } from "react"
import { tmuxOnPath } from "../api/discovery"
import { useT } from "../i18n"
import { useUi } from "../stores/ui"

export const TmuxGuide = () => {
  const tr = useT()
  const [missing, setMissing] = useState(false)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    let cancelled = false
    void tmuxOnPath().then((ok) => {
      if (cancelled) return
      if (!ok) useUi.getState().openModal("tmux-guide")
      setMissing(!ok)
    })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (missing) useUi.getState().openModal("tmux-guide")
    else useUi.getState().closeModal("tmux-guide")
    return () => useUi.getState().closeModal("tmux-guide")
  }, [missing])
  if (!missing) return null
  const recheck = async () => {
    setChecking(true)
    const nextMissing = !(await tmuxOnPath())
    if (nextMissing) useUi.getState().openModal("tmux-guide")
    else useUi.getState().closeModal("tmux-guide")
    setMissing(nextMissing)
    setChecking(false)
  }
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={tr("tmux.title")}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Enter") event.stopPropagation()
        }}>
        <h2>{tr("tmux.title")}</h2>
        <p>{tr("tmux.description")}</p>
        <pre>brew install tmux</pre>
        <p className="dim">{tr("tmux.retryHint")}</p>
        <button className="btn" onClick={() => void recheck()} disabled={checking}>
          {checking ? tr("tmux.checking") : tr("tmux.retry")}
        </button>
      </div>
    </div>
  )
}
