import { useEffect } from "react"
import type { TranscriptEntry as TranscriptEntryDto } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useTranscript } from "../stores/transcript"
import { renderTranscriptBlock } from "./TranscriptEntry"
import { useT } from "../i18n"

export const TranscriptView = ({
  wsId,
  tabId,
  active,
}: {
  wsId: string
  tabId: string
  active: boolean
}) => {
  const tr = useT()
  const api = useData((state) => state.getApi())
  const cache = useTranscript((state) => state.cacheByTab[tabId])
  const refresh = useTranscript((state) => state.refreshVisible)

  useEffect(() => {
    if (!active || !api) return
    void refresh(api, wsId, tabId).catch(() => {})
    const timer = setInterval(() => {
      void refresh(api, wsId, tabId).catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [active, api, wsId, tabId, refresh])

  if (!cache || cache.capability === "unavailable") {
    return <div className="transcript-empty dim">{tr("transcript.unavailable")}</div>
  }

  return (
    <div className="transcript-view" role="log" aria-label={tr("transcript.panel")}>
      {cache.entries.map((entry: TranscriptEntryDto) => (
        <article key={entry.id} className={`transcript-entry role-${entry.role}`}>
          <header className="transcript-entry-head">
            <span>{entry.role}</span>
            {entry.timestamp !== undefined && (
              <time dateTime={new Date(entry.timestamp).toISOString()}>
                {new Date(entry.timestamp).toLocaleTimeString()}
              </time>
            )}
          </header>
          <div
            className="transcript-entry-body"
            dangerouslySetInnerHTML={{ __html: entry.blocks.map(renderTranscriptBlock).join("") }}
          />
        </article>
      ))}
      {cache.entries.length === 0 && <div className="dim">{tr("transcript.empty")}</div>}
    </div>
  )
}
