import { useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { useT } from "../i18n"

export interface ReviewStartResult {
  tabId: string
  title: string
  queued: boolean
  promptSource: string | null
  engineId: string | null
}

/** Trigger Agent Review against a dedicated Review tab (never busy implementation). */
export const ReviewAction = ({ wsId }: { wsId: string }) => {
  const tr = useT()
  const [busy, setBusy] = useState(false)

  const startReview = (): void => {
    const api = useData.getState().getApi()
    if (!api) {
      useData.getState().pushWarning("review.start", tr("right.serverUnavailable"))
      return
    }
    const focus = useUi.getState().centerDiff
    const body: Record<string, unknown> = {}
    if (focus && focus.wsId === wsId) {
      body.focus = { section: focus.section, path: focus.path }
    }
    setBusy(true)
    void api.req("POST", `/workspaces/${encodeURIComponent(wsId)}/review`, body)
      .then((result: ReviewStartResult) => {
        useUi.getState().selectTab(wsId, result.tabId)
        if (result.queued) {
          useData.getState().pushWarning("review.queued", tr("right.reviewQueued"))
        }
      })
      .catch((error: unknown) => {
        useData.getState().pushWarning(
          "review.start",
          error instanceof Error ? error.message : String(error),
        )
      })
      .finally(() => setBusy(false))
  }

  return (
    <button
      type="button"
      className="btn-secondary"
      disabled={busy}
      aria-label={tr("right.agentReview")}
      data-testid="agent-review"
      onClick={startReview}
    >
      {busy ? tr("right.reviewStarting") : tr("right.agentReview")}
    </button>
  )
}
