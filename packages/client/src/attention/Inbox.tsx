import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import type { AttentionItem } from "@coolie/protocol"
import { useAttention } from "../stores/attention"
import { useData } from "../stores/data"
import { useUi, consumeModalKey } from "../stores/ui"
import { useT } from "../i18n"
import {
  defaultInboxFilter,
  filterAttentionItems,
  inboxItemStatusLabel,
  jumpToAttentionItem,
  moveInboxSelection,
  pickNextAttentionItem,
  sortAttentionItems,
  type InboxFilter,
} from "./inbox-logic"

export const InboxPanel = () => {
  const tr = useT()
  const open = useUi((state) => state.inboxOpen)
  const close = (): void => useUi.getState().setInboxOpen(false)
  const items = useAttention((state) => Object.values(state.items))
  const workspaces = useData((state) => state.workspaces)
  const projects = useData((state) => state.projects)
  const tabsByWs = useData((state) => state.tabsByWs)
  const api = useData((state) => state.getApi())
  const [filter, setFilter] = useState<InboxFilter>(defaultInboxFilter())
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  )
  const filtered = useMemo(
    () => sortAttentionItems(filterAttentionItems(items, filter, workspaceById)),
    [items, filter, workspaceById],
  )

  useEffect(() => {
    if (!open) return
    useUi.getState().openModal("inbox")
    return () => useUi.getState().closeModal("inbox")
  }, [open])

  useEffect(() => {
    if (!open) return
    setSelectedIndex((current) => (filtered.length === 0 ? 0 : Math.min(current, filtered.length - 1)))
  }, [filtered.length, open])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(".inbox-row.selected")?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, selectedIndex, filtered.length])

  const ackItem = async (item: AttentionItem): Promise<void> => {
    if (!api) return
    try {
      await api.req("POST", `/attention/${encodeURIComponent(item.id)}/ack`, {})
      useAttention.getState().remove(item.id)
    } catch {
      // keep durable item for retry
    }
  }

  const activateItem = (item: AttentionItem): void => {
    jumpToAttentionItem(item, useUi.getState().selectWs, useUi.getState().selectTab)
    close()
  }

  const onNextAttention = (): void => {
    const next = pickNextAttentionItem(items, filter, workspaceById)
    if (!next) return
    activateItem(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (consumeModalKey(event, "Escape", close)) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex((current) => moveInboxSelection(current, event.key === "ArrowDown" ? 1 : -1, filtered.length))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const item = filtered[selectedIndex]
      if (item) activateItem(item)
      return
    }
    if (event.key.toLowerCase() === "a") {
      event.preventDefault()
      const item = filtered[selectedIndex]
      if (item) void ackItem(item)
    }
  }

  if (!open) return null

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div
        ref={listRef}
        className="modal inbox-panel"
        role="dialog"
        aria-modal="true"
        aria-label={tr("inbox.title")}
        onKeyDown={onKeyDown}
      >
        <header className="inbox-header">
          <h2>{tr("inbox.title")}</h2>
          <span className="inbox-count" aria-label={tr("inbox.count")}>{filtered.length}</span>
          <button className="btn-secondary inbox-next" onClick={onNextAttention} disabled={filtered.length === 0}>
            {tr("inbox.next")}
          </button>
        </header>
        <div className="inbox-filters">
          <label>
            {tr("inbox.filterProject")}
            <select
              aria-label={tr("inbox.filterProject")}
              value={filter.projectId}
              onChange={(event) => setFilter((current) => ({ ...current, projectId: event.target.value, workspaceId: "" }))}
            >
              <option value="">{tr("sidebar.allProjects")}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label>
            {tr("inbox.filterWorkspace")}
            <select
              aria-label={tr("inbox.filterWorkspace")}
              value={filter.workspaceId}
              onChange={(event) => setFilter((current) => ({ ...current, workspaceId: event.target.value }))}
            >
              <option value="">{tr("inbox.allWorkspaces")}</option>
              {workspaces
                .filter((workspace) => filter.projectId === "" || workspace.projectId === filter.projectId)
                .map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
          <label>
            {tr("inbox.filterKind")}
            <select
              aria-label={tr("inbox.filterKind")}
              value={filter.kind}
              onChange={(event) => setFilter((current) => ({ ...current, kind: event.target.value as InboxFilter["kind"] }))}
            >
              <option value="">{tr("inbox.allKinds")}</option>
              <option value="turn-finished">{tr("inbox.kind.turnFinished")}</option>
              <option value="permission">{tr("inbox.kind.permission")}</option>
              <option value="elicitation">{tr("inbox.kind.elicitation")}</option>
              <option value="rate-limit">{tr("inbox.kind.rateLimit")}</option>
              <option value="error">{tr("inbox.kind.error")}</option>
              <option value="inferred">{tr("inbox.kind.inferred")}</option>
            </select>
          </label>
        </div>
        <div className="inbox-list" role="listbox" aria-label={tr("inbox.items")}>
          {filtered.length === 0 && <p className="dim inbox-empty">{tr("inbox.empty")}</p>}
          {filtered.map((item, index) => {
            const workspace = workspaceById.get(item.workspaceId)
            const tab = tabsByWs[item.workspaceId]?.find((entry) => entry.id === item.tabId)
            const status = inboxItemStatusLabel(workspace, item.kind)
            return (
              <button
                key={item.id}
                type="button"
                className={`inbox-row ${index === selectedIndex ? "selected" : ""}`}
                role="option"
                aria-selected={index === selectedIndex}
                tabIndex={index === selectedIndex ? 0 : -1}
                onClick={() => activateItem(item)}
                onFocus={() => setSelectedIndex(index)}
              >
                <span className={`inbox-status inbox-status-${status}`}>{tr(`inbox.status.${status}`)}</span>
                <span className="inbox-summary">{item.summary}</span>
                <span className="inbox-meta">
                  {workspace?.name ?? item.workspaceId}
                  {tab?.title ? ` · ${tab.title}` : ""}
                </span>
              </button>
            )
          })}
        </div>
        <footer className="inbox-footer dim">
          {tr("inbox.help")}
        </footer>
      </div>
    </div>
  )
}
