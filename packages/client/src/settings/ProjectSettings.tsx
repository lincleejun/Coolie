import { useCallback, useEffect, useMemo, useState } from "react"
import type { Api } from "../api/client"
import { useSettings } from "./settings"
import { useData } from "../stores/data"
import { useT } from "../i18n"
import { showToast } from "../chrome/Toasts"

export interface CopyPlanPreview {
  readonly source: "worktreeinclude" | "project" | "default"
  readonly entries: ReadonlyArray<{ readonly relativePath: string; readonly size: number }>
  readonly totalBytes: number
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const ProjectSettings = ({ projectId }: { projectId: string }) => {
  const tr = useT()
  const api = useData((state) => state.getApi())
  // Filter outside the selector — .filter() returns a new array every snapshot.
  const allWorkspaces = useData((state) => state.workspaces)
  const workspaces = useMemo(
    () => allWorkspaces.filter((workspace) => workspace.projectId === projectId && workspace.kind === "task"),
    [allWorkspaces, projectId],
  )
  const patterns = useSettings((state) => state.filesToCopyPatterns(projectId))
  const [draft, setDraft] = useState(patterns.join("\n"))
  const [preview, setPreview] = useState<CopyPlanPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [recopyWsId, setRecopyWsId] = useState(workspaces[0]?.id ?? "")

  useEffect(() => {
    setDraft(patterns.join("\n"))
  }, [patterns, projectId])

  useEffect(() => {
    if (!recopyWsId && workspaces[0]?.id) setRecopyWsId(workspaces[0].id)
  }, [recopyWsId, workspaces])

  const runPreview = useCallback(async (client: Api): Promise<void> => {
    setLoading(true)
    setPreviewError(null)
    try {
      const lines = draft.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
      const query = lines.length > 0 ? `?patterns=${encodeURIComponent(JSON.stringify(lines))}` : ""
      const plan = await client.req("GET", `/projects/${encodeURIComponent(projectId)}/environment/preview${query}`) as CopyPlanPreview
      setPreview(plan)
      if (plan.source === "worktreeinclude") setDraft(lines.join("\n"))
    } catch (error: unknown) {
      setPreview(null)
      setPreviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [draft, projectId])

  useEffect(() => {
    if (!api) return
    void runPreview(api)
  }, [api, projectId, runPreview])

  const savePatterns = (): void => {
    const lines = draft.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
    useSettings.getState().setFilesToCopyPatterns(projectId, lines)
    if (api) void runPreview(api)
  }

  const recopy = async (): Promise<void> => {
    if (!api || !recopyWsId) return
    try {
      await api.req("POST", `/workspaces/${encodeURIComponent(recopyWsId)}/environment/recopy`, {})
      showToast("projectSettings.recopyDone", tr("projectSettings.recopyDone"))
    } catch (error: unknown) {
      showToast("projectSettings.recopyFailed", error)
    }
  }

  const readOnly = preview?.source === "worktreeinclude"

  return (
    <section className="project-settings" aria-label={tr("projectSettings.title")}>
      <h3>{tr("projectSettings.title")}</h3>
      <p className="hint">{tr("projectSettings.precedence")}</p>
      {preview && (
        <p className="project-settings-source">
          {tr("projectSettings.source")}: <strong>{tr(`projectSettings.source.${preview.source}`)}</strong>
        </p>
      )}
      <label>
        <span>{tr("projectSettings.patterns")}</span>
        <textarea
          aria-label={tr("projectSettings.patterns")}
          value={draft}
          readOnly={readOnly}
          placeholder={tr("projectSettings.patternsPlaceholder")}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      {readOnly && <p className="hint">{tr("projectSettings.worktreeincludeReadonly")}</p>}
      {!readOnly && (
        <button type="button" onClick={savePatterns}>{tr("projectSettings.savePatterns")}</button>
      )}
      <div className="project-settings-actions">
        <button type="button" disabled={!api || loading} onClick={() => api && void runPreview(api)}>
          {loading ? tr("projectSettings.previewLoading") : tr("projectSettings.preview")}
        </button>
        {workspaces.length > 0 && (
          <>
            <label>
              <span>{tr("projectSettings.recopyTarget")}</span>
              <select value={recopyWsId} onChange={(event) => setRecopyWsId(event.target.value)}>
                {workspaces.map((workspace) =>
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
              </select>
            </label>
            <button type="button" disabled={!api || !recopyWsId} onClick={() => void recopy()}>
              {tr("projectSettings.recopy")}
            </button>
          </>
        )}
      </div>
      {previewError && <p role="alert" className="error">{previewError}</p>}
      {preview && (
        <div className="project-settings-preview" aria-live="polite">
          <p>{tr("projectSettings.previewSummary")
            .replace("{count}", String(preview.entries.length))
            .replace("{bytes}", formatBytes(preview.totalBytes))}</p>
          <ul>
            {preview.entries.map((entry) =>
              <li key={entry.relativePath}>{entry.relativePath} ({formatBytes(entry.size)})</li>)}
          </ul>
        </div>
      )}
    </section>
  )
}
