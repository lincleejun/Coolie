import { useEffect, useState } from "react"
import type { CheckItem, WorkspaceChecksSnapshot } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { makeDrafts, type DraftStorage } from "../composer/drafts"
import { useT } from "../i18n"
import { shouldApplyAsyncResult } from "./stale"

const storage: DraftStorage =
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const drafts = makeDrafts(storage)

const injectComposerPrompt = (wsId: string, prompt: string): void => {
  const current = drafts.load(wsId)
  drafts.save(wsId, current === "" ? prompt : `${current}\n\n${prompt}`)
  useUi.getState().focusComposer()
}

const statusClass = (status: CheckItem["status"]): string => {
  switch (status) {
    case "pass": return "check-pass"
    case "fail": return "check-fail"
    case "warn": return "check-warn"
    case "pending": return "check-pending"
    case "skipped": return "check-skipped"
    default: return "check-unavailable"
  }
}

const formatTime = (ts: number): string => {
  try { return new Date(ts).toLocaleTimeString() } catch { return String(ts) }
}

export const ChecksPanel = ({ wsId }: { wsId: string }) => {
  const tr = useT()
  const api = useData((s) => s.getApi())
  const [snapshot, setSnapshot] = useState<WorkspaceChecksSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    if (!api) return
    const requestedWs = wsId
    try {
      const next = await api.req(
        "GET",
        `/workspaces/${encodeURIComponent(wsId)}/checks`,
      ) as WorkspaceChecksSnapshot
      const currentWs = useUi.getState().selectedWs
      if (!shouldApplyAsyncResult(requestedWs, currentWs, false)) return
      setSnapshot(next)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (document.hasFocus()) void refresh()
    }, 5000)
    return () => clearInterval(timer)
  }, [api, wsId])

  const runAction = (item: CheckItem): void => {
    const action = item.action
    if (!action || action.kind === "none") return
    if (action.kind === "view-diff") {
      useUi.getState().setRightPanel("changes")
      return
    }
    if (action.kind === "fix-with-agent") {
      injectComposerPrompt(wsId, `Please fix: ${item.label}${item.detail ? ` (${item.detail})` : ""}`)
      return
    }
    if (action.kind === "run-script" && action.runId && api) {
      void api.req("POST", `/workspaces/${encodeURIComponent(wsId)}/runs/${encodeURIComponent(action.runId)}/start`, {})
        .then(() => refresh())
        .catch((e: unknown) => useData.getState().pushWarning("checks.run", String(e)))
      return
    }
    if (action.kind === "open-pr") {
      injectComposerPrompt(wsId, tr("right.createPrPrompt"))
    }
  }

  if (error) return <div className="dim" role="status">{tr("checks.loadFailed").replace("{error}", error)}</div>
  if (!snapshot) return <div className="dim">{tr("checks.loading")}</div>

  return (
    <section className="checks-panel" aria-label={tr("checks.panel")}>
      <div className="checks-meta dim">
        {tr("checks.updated").replace("{time}", formatTime(snapshot.collectedAt))}
        {snapshot.degraded ? ` · ${tr("checks.degraded")}` : ""}
      </div>
      <ul className="checks-list">
        {snapshot.items.map((item) => (
          <li key={item.id} className={`checks-row ${statusClass(item.status)}`}>
            <div className="checks-main">
              <span className={`badge b-check-${item.status}`} data-status={item.status}>{item.status}</span>
              <strong>{item.label}</strong>
              <span className="dim checks-time">{formatTime(item.updatedAt)}</span>
            </div>
            {item.detail && <div className="checks-detail dim">{item.detail}</div>}
            {item.action && item.action.kind !== "none" && (
              <button type="button" className="btn-secondary checks-action" onClick={() => runAction(item)}>
                {item.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
