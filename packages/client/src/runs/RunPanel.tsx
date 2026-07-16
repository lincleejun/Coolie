import { useEffect, useState } from "react"
import type { RunInstanceRecord } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useT } from "../i18n"

export const RunPanel = ({ wsId }: { wsId: string }) => {
  const tr = useT()
  const api = useData((state) => state.getApi())
  const [runs, setRuns] = useState<RunInstanceRecord[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    if (!api) return
    try {
      const next = await api.req("GET", `/workspaces/${encodeURIComponent(wsId)}/runs`)
      if (Array.isArray(next)) setRuns(next)
    } catch {
      // keep previous list for retry
    }
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => clearInterval(timer)
  }, [api, wsId])

  const start = async (runId: string): Promise<void> => {
    if (!api) return
    setBusy(runId)
    try {
      await api.req("POST", `/workspaces/${encodeURIComponent(wsId)}/runs/${encodeURIComponent(runId)}/start`, {})
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const stop = async (runId: string): Promise<void> => {
    if (!api) return
    setBusy(runId)
    try {
      await api.req("POST", `/workspaces/${encodeURIComponent(wsId)}/runs/${encodeURIComponent(runId)}/stop`, {})
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  if (runs.length === 0) return null

  return (
    <section className="run-panel" aria-label={tr("runs.panel")}>
      <h4>{tr("runs.title")}</h4>
      {runs.map((run) => (
        <div key={run.id} className="run-row">
          <div>
            <strong>{run.runId}</strong>
            <span className={`badge b-${run.status}`}>{run.status}</span>
          </div>
          <div className="run-actions">
            {run.status === "running"
              ? <button className="btn-secondary" disabled={busy === run.runId} onClick={() => void stop(run.runId)}>{tr("runs.stop")}</button>
              : <button className="btn" disabled={busy === run.runId} onClick={() => void start(run.runId)}>{tr("runs.start")}</button>}
          </div>
        </div>
      ))}
    </section>
  )
}
