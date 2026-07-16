import { useEffect, useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import type { DiffSection, FileDiff } from "../stores/types"
import { parseUnifiedDiff, type DiffLine } from "./diff"
import { shouldApplyAsyncResult } from "./stale"
import { t, useT } from "../i18n"

export interface LineSelection {
  path: string
  section: DiffSection
  startIdx: number
  endIdx: number
  lines: DiffLine[]
}

export const DiffView = ({ wsId, section, path, onComment }: {
  wsId: string
  section: DiffSection
  path: string
  onComment: (selection: LineSelection) => void
}) => {
  const tr = useT()
  const [lines, setLines] = useState<DiffLine[] | null>(null)
  const [binary, setBinary] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [head, setHead] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const requestedWs = wsId
    setLines(null)
    setBinary(false)
    setError(null)
    setAnchor(null)
    setHead(null)
    const api = useData.getState().getApi()
    if (!api) {
      setError(t("diff.apiUnavailable"))
      return () => { cancelled = true }
    }
    void api.req("GET", `/workspaces/${wsId}/git/diff?section=${section}&path=${encodeURIComponent(path)}`)
      .then((result: FileDiff) => {
        const currentWs = useUi.getState().selectedWs
        if (!shouldApplyAsyncResult(requestedWs, currentWs, cancelled)) return
        setBinary(result.binary)
        setLines(parseUnifiedDiff(result.unified))
      })
      .catch((reason: unknown) => {
        const currentWs = useUi.getState().selectedWs
        if (!shouldApplyAsyncResult(requestedWs, currentWs, cancelled)) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { cancelled = true }
  }, [wsId, section, path])

  if (error) return <div className="diff-err">{tr("diff.loadFailed").replace("{error}", error)}</div>
  if (binary) return <div className="dim">{tr("diff.binary")}</div>
  if (lines === null) return <div className="dim">{tr("diff.loading")}</div>

  const selectable = (index: number): boolean =>
    lines[index]?.kind === "add" || lines[index]?.kind === "del" || lines[index]?.kind === "ctx"
  const selected = (index: number): boolean =>
    anchor !== null && head !== null && index >= Math.min(anchor, head) && index <= Math.max(anchor, head)
  const selectLine = (index: number, extend: boolean): void => {
    if (!selectable(index)) return
    if (extend && anchor !== null) setHead(index)
    else {
      setAnchor(index)
      setHead(index)
    }
  }
  const comment = (): void => {
    if (anchor === null || head === null) return
    const startIdx = Math.min(anchor, head)
    const endIdx = Math.max(anchor, head)
    onComment({ path, section, startIdx, endIdx, lines: lines.slice(startIdx, endIdx + 1) })
    setAnchor(null)
    setHead(null)
  }

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span className="diff-file">{path}</span>
        <button className="btn-sm" disabled={anchor === null} onClick={comment}>{tr("diff.commentSelected")}</button>
      </div>
      <div className="diff-body">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`dl dl-${line.kind}${selected(index) ? " dl-sel" : ""}${selectable(index) ? " dl-pick" : ""}`}
            onClick={(event) => selectLine(index, event.shiftKey)}
          >
            <span className="dl-old">{line.oldNo ?? ""}</span>
            <span className="dl-new">{line.newNo ?? ""}</span>
            <span className="dl-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "ctx" ? " " : ""}</span>
            <span className="dl-text">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
