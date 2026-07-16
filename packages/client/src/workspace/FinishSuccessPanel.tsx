import { useState } from "react"
import type { Workspace } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { useT } from "../i18n"
import { ApiError } from "../api/client"
import { confirmDialog } from "../chrome/dialogs"
import { archiveForceConfirmation } from "../sidebar/taskCommands"
import { openExternalUrl } from "../platform"

export const FinishSuccessPanel = ({ ws }: { ws: Workspace }) => {
  const tr = useT()
  const result = ws.finishResult
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!result) return null

  const run = (fn: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    void fn()
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setBusy(false))
  }

  const openPr = (): void => {
    if (!result.prUrl) return
    void openExternalUrl(result.prUrl).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  const archive = (): void => run(async () => {
    const d = useData.getState()
    try {
      await d.archiveWs(ws.id, false)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (await confirmDialog(tr("task.archiveTitle"), archiveForceConfirmation(ws), true))
          await d.archiveWs(ws.id, true)
        else return
      } else {
        throw e
      }
    }
    await d.refreshWorkspaces()
  })

  const keepWorking = (): void => run(async () => {
    const api = useData.getState().getApi()
    if (!api) throw new Error(tr("sidebar.apiUnavailable"))
    await api.req("DELETE", `/workspaces/${encodeURIComponent(ws.id)}/finish-result`)
    await useData.getState().refreshWorkspaces()
  })

  return (
    <div className="error-actions finish-success" data-testid="finish-success" role="status">
      <div className="finish-success-body">
        <strong>{tr("finish.successTitle")}</strong>
        <p className="dim">
          {result.prUrl
            ? tr("finish.successPr").replace("{url}", result.prUrl)
            : result.mergedBack
              ? tr("finish.successMerged")
              : tr("finish.successGeneric")}
        </p>
        {result.warnings.length > 0 && (
          <ul className="finish-warnings">
            {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        )}
        {error && <div className="dispatch-err" role="alert">{error}</div>}
      </div>
      <div className="finish-success-actions">
        {result.prUrl && (
          <button
            type="button"
            className="btn"
            data-testid="finish-open-pr"
            disabled={busy}
            onClick={openPr}
          >{tr("finish.openPr")}</button>
        )}
        <button
          type="button"
          className="btn"
          data-testid="finish-archive"
          disabled={busy}
          onClick={archive}
        >{tr("finish.archive")}</button>
        <button
          type="button"
          className="btn-secondary"
          data-testid="finish-keep-working"
          disabled={busy}
          onClick={keepWorking}
        >{tr("finish.keepWorking")}</button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => useUi.getState().setRightPanel("checks")}
        >{tr("finish.viewChecks")}</button>
      </div>
    </div>
  )
}
