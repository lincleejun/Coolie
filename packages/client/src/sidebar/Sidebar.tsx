import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import type { Workspace, Tab } from "@coolie/protocol"
import { useData } from "../stores/data"
import { consumeModalKey, useUi } from "../stores/ui"
import { useAttention } from "../stores/attention"
import { ApiError } from "../api/client"
import { orderedActiveWs, pinnedFirst } from "../hotkeys/useGlobalHotkeys"
import { CaretRightIcon, ChevronDownIcon, FolderPlusIcon, GitBranchIcon, HelpIcon, PlusIcon, SearchIcon, SettingsIcon } from "../chrome/icons"
import { ProjectOnboarding } from "../chrome/EmptyState"
import { openWorkspaceWindow } from "../chrome/workspaceWindow"
import { archiveForceConfirmation, buildTaskCommands, deleteConfirmation } from "./taskCommands"
import { confirmDialog, promptDialog, trapTabKey, useAppDialogOpen } from "../chrome/dialogs"
import { showToast } from "../chrome/Toasts"
import { useT, t } from "../i18n"

export { archiveForceConfirmation, deleteConfirmation } from "./taskCommands"

/** 状态徽标（spec §六）：workspace 状态优先，active 时取 engine tab 状态 */
export const wsBadge = (ws: Workspace, tabs: Tab[] | undefined): { glyph: string; cls: string; title: string } => {
  if (ws.status === "creating") return { glyph: "◌", cls: "b-creating", title: t("sidebar.status.creating") }
  if (ws.status === "error") return { glyph: "!", cls: "b-error", title: t("sidebar.status.createError") }
  if (ws.status === "archived") return { glyph: "▪", cls: "b-archived", title: t("sidebar.status.archived") }
  const statuses = tabs?.filter((tab) => tab.kind === "engine").map((tab) => tab.status) ?? []
  const status = statuses.includes("error") ? "error"
    : statuses.includes("awaiting-input") ? "awaiting-input"
    : statuses.includes("working") ? "working"
    : "idle"
  switch (status) {
    case "working": return { glyph: "●", cls: "b-working", title: t("sidebar.status.working") }
    case "awaiting-input": return { glyph: "✓", cls: "b-await", title: t("sidebar.status.awaiting") }
    case "error": return { glyph: "!", cls: "b-error", title: t("sidebar.status.error") }
    default: return { glyph: "○", cls: "b-idle", title: t("sidebar.status.idle") }
  }
}

/** Two-letter warm monogram for the project group header (Conductor sidebar). */
const monogram = (name: string): string =>
  (name.match(/[A-Za-z0-9]/g)?.slice(0, 2).join("") || name.slice(0, 2)).toUpperCase()

export const reorderWorkspaceIds = (ids: readonly string[], sourceId: string, targetId: string): string[] => {
  const next = [...ids]
  const from = next.indexOf(sourceId)
  const to = next.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return next
  next.splice(from, 1)
  next.splice(to, 0, sourceId)
  return next
}

export const canFinishWorkspace = (workspace: Pick<Workspace, "kind" | "status">): boolean =>
  workspace.status === "active" && workspace.kind !== "main"

const DiffCount = ({ wsId }: { wsId: string }) => {
  const d = useData((s) => s.diffstatByWs[wsId])
  if (!d || (d.insertions === 0 && d.deletions === 0)) return null
  return <span className="diffcount"><em className="plus">+{d.insertions}</em><em className="minus">−{d.deletions}</em></span>
}

/** 行内上下文动作（D2）：hover 露出 ⋯，右键同菜单。归档/恢复/删除都走 data store 的生命周期动作。
 *  archive 脏树被 server 409 拒 → 弹确认后带 force 重试；delete 一律先确认（branch 保留）。 */
const WsRowMenu = ({ ws, onClose }: { ws: Workspace; onClose: () => void }) => {
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true)
    void fn().catch((error: unknown) => showToast("task.lifecycle", error))
      .finally(() => { setBusy(false); onClose() })
  }
  const archive = (): void => run(async () => {
    const d = useData.getState()
    if (ws.ownership === "adopted" && !await confirmDialog(t("task.archiveTitle"), archiveForceConfirmation(ws), true)) return
    try { await d.archiveWs(ws.id, false) }
    catch (e) {
      // 脏 worktree：server 以 409 ConflictError 拒绝无 force 归档 → 征得确认后强制
      if (e instanceof ApiError && e.status === 409 && await confirmDialog(t("task.archiveTitle"), archiveForceConfirmation(ws), true))
        await d.archiveWs(ws.id, true)
      else if (!(e instanceof ApiError && e.status === 409)) throw e
    }
  })
  const togglePinned = (): void => run(() => useData.getState().setPinnedWs(ws.id, !ws.pinned))
  const unarchive = (): void => run(() => useData.getState().unarchiveWs(ws.id))
  const del = (): void => run(async () => {
    if (await confirmDialog(t("task.deleteTitle"), deleteConfirmation(ws), true))
      await useData.getState().deleteWs(ws.id, true)
  })
  const finishPr = (): void => run(async () => {
    if (ws.kind === "main") return
    const api = useData.getState().getApi()
    if (!api) throw new Error(t("sidebar.apiUnavailable"))
    const title = await promptDialog(t("dialog.createPr"), t("dialog.prTitle"), ws.branch) ?? undefined
    const out = await api.req("POST", `/workspaces/${ws.id}/finish`, { createPr: true, title })
    if (out.prUrl) showToast("workspace.pr.created", out.prUrl)
    for (const warning of out.warnings ?? []) showToast("workspace.finish", warning)
  })
  const mergeBack = (): void => {
    run(async () => {
      if (ws.kind === "main") return
      if (!await confirmDialog(t("dialog.mergeTitle"), t("dialog.mergeMessage")
        .replace("{branch}", ws.branch).replace("{base}", ws.baseBranch), true)) return
      const api = useData.getState().getApi()
      if (!api) throw new Error(t("sidebar.apiUnavailable"))
      await api.req("POST", `/workspaces/${ws.id}/finish`, { mergeBack: true })
    })
  }
  return (
    <div className="ws-menu" role="menu" onClick={(e) => e.stopPropagation()}>
      <button role="menuitem" disabled={busy} onClick={togglePinned}>{t(ws.pinned ? "task.unpin" : "task.pin")}</button>
      {ws.status === "active" && <button role="menuitem" disabled={busy} onClick={archive}>{t("task.archive")}</button>}
      {canFinishWorkspace(ws) &&
        <button role="menuitem" disabled={busy} onClick={finishPr}>{t("task.createPr")}</button>}
      {canFinishWorkspace(ws) &&
        <button role="menuitem" disabled={busy} onClick={mergeBack}>{t("task.mergeBack")}</button>}
      {ws.status === "archived" && <button role="menuitem" disabled={busy} onClick={unarchive}>{t("task.restore")}</button>}
      <button role="menuitem" className="danger" disabled={busy} onClick={del}>{t("task.delete")}</button>
    </div>
  )
}

const WsRow = ({ ws, focused, onFocus, onDrop }: {
  ws: Workspace
  focused: boolean
  onFocus(): void
  onDrop(sourceId: string, targetId: string): void
}) => {
  const selected = useUi((s) => s.selectedWs === ws.id)
  const raised = useAttention((s) => s.isRaised(ws.id))
  const tabs = useData((s) => s.tabsByWs[ws.id])
  const badge = wsBadge(ws, tabs)
  const [menuOpen, setMenuOpen] = useState(false)
  // 点击行外任意处关菜单
  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => setMenuOpen(false)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [menuOpen])
  return (
    <div
      className={`ws-row ${selected ? "selected" : ""} ${focused ? "keyboard-focused" : ""}`}
      role="option"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      draggable
      data-workspace-id={ws.id}
      onClick={() => useUi.getState().selectWs(ws.id)}
      onFocus={onFocus}
      onDragStart={(event) => event.dataTransfer.setData("text/coolie-workspace", ws.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const sourceId = event.dataTransfer.getData("text/coolie-workspace")
        if (sourceId) onDrop(sourceId, ws.id)
      }}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
    >
      <span className={`badge ${badge.cls}`} title={badge.title}>{badge.glyph}</span>
      {raised && <span className="attn-dot" title={t("sidebar.needsYou")} aria-label={t("sidebar.needsYou")}>!</span>}
      <span className="ws-name">{ws.pinned ? "📌 " : ""}{ws.name}</span>
      <span className="ws-branch" title={ws.branch}><GitBranchIcon size={11} className="ws-branch-icon" />{ws.branch.replace(/^coolie\//, "")}</span>
      {ws.status === "active" && <DiffCount wsId={ws.id} />}
      <button
        className="ws-more" title={t("sidebar.more")} aria-label={t("sidebar.more")}
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
      >⋯</button>
      {menuOpen && <WsRowMenu ws={ws} onClose={() => setMenuOpen(false)} />}
    </div>
  )
}

export const Sidebar = () => {
  const tr = useT()
  const projects = useData((s) => s.projects)
  const workspaces = useData((s) => s.workspaces)
  const query = useUi((s) => s.searchQuery)
  const collapsedProjects = useUi((s) => s.collapsedProjects)
  const dispatchMode = useUi((s) => s.dispatchMode)
  const dispatchProjectId = useUi((s) => s.dispatchProjectId)
  const settingsOpen = useUi((s) => s.settingsOpen)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [projectFilter, setProjectFilter] = useState("")
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const projectPicker = useRef<HTMLDivElement>(null)
  const projectPickerTrigger = useRef<HTMLButtonElement>(null)
  const projectPickerClose = useRef<HTMLButtonElement>(null)
  const appDialogOpen = useAppDialogOpen()

  useEffect(() => {
    if (projectPickerOpen) useUi.getState().openModal("project-picker")
    else useUi.getState().closeModal("project-picker")
    return () => useUi.getState().closeModal("project-picker")
  }, [projectPickerOpen])

  useEffect(() => {
    if (!projectPickerOpen || appDialogOpen) return
    const frame = requestAnimationFrame(() => projectPickerClose.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [appDialogOpen, projectPickerOpen])

  useEffect(() => {
    if (settingsOpen) {
      setProjectPickerOpen(false)
      useUi.getState().closeModal("project-picker")
    }
  }, [settingsOpen])

  const openProjectPicker = (): void => {
    useUi.getState().openModal("project-picker")
    setProjectPickerOpen(true)
  }
  const closeProjectPicker = (): void => {
    useUi.getState().closeModal("project-picker")
    setProjectPickerOpen(false)
    requestAnimationFrame(() => projectPickerTrigger.current?.focus())
  }

  // diff 计数轮询（spec §7.1：git diff --shortstat 轮询）：5s、窗口聚焦时才打
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hasFocus()) return
      for (const w of useData.getState().workspaces)
        if (w.status === "active") void useData.getState().refreshDiffstat(w.id)
    }, 5000)
    return () => clearInterval(t)
  }, [])

  const match = (w: Workspace) =>
    query === "" || w.name.includes(query) || w.branch.includes(query)
  const ordered = orderedActiveWs().filter(match)
  const archived = pinnedFirst(workspaces.filter((w) => w.status === "archived" && match(w)))
  const visible = useMemo(() => ordered.filter((workspace) =>
    projectFilter === "" || workspace.projectId === projectFilter), [ordered, projectFilter])
  const moveWorkspace = (sourceId: string, targetId: string): void => {
    const source = workspaces.find((workspace) => workspace.id === sourceId)
    const target = workspaces.find((workspace) => workspace.id === targetId)
    if (!source || !target || source.projectId !== target.projectId || sourceId === targetId) return
    const ids = reorderWorkspaceIds(
      ordered.filter((workspace) => workspace.projectId === source.projectId).map((workspace) => workspace.id),
      sourceId,
      targetId,
    )
    void useData.getState().reorderWs(source.projectId, ids)
      .catch((error: unknown) => showToast("workspace.reorder", error))
  }
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return
    const index = visible.findIndex((workspace) => workspace.id === focusedId)
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const delta = event.key === "ArrowDown" ? 1 : -1
      const next = visible[(Math.max(index, 0) + delta + visible.length) % visible.length]
      if (event.shiftKey && focusedId && next) moveWorkspace(focusedId, next.id)
      else if (next) {
        setFocusedId(next.id)
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-workspace-id="${next.id}"]`)?.focus())
      }
      return
    }
    if (event.key.toLowerCase() === "n") {
      event.preventDefault()
      const projectId = projectFilter || visible.find((workspace) => workspace.id === focusedId)?.projectId || projects[0]?.id
      if (projectId) startWorkspace(projectId)
      return
    }
    const ws = visible.find((workspace) => workspace.id === focusedId)
    if (!ws) return
    const command = buildTaskCommands(ws).find((item) =>
      item.key.toLowerCase() === event.key.toLowerCase())
    if (command) {
      event.preventDefault()
      void command.run()
    }
  }
  const startWorkspace = (projectId: string): void => {
    void openWorkspaceWindow(projectId)
      .catch((error: unknown) => showToast("workspace.open", error))
  }
  const adopt = async (projectId: string): Promise<void> => {
    const data = useData.getState()
    const api = data.getApi()
    if (!api) return
    try {
      const candidates: Array<{ path: string; branch: string; head: string }> =
        await api.req("GET", `/projects/${projectId}/worktrees/adoptable`)
      if (candidates.length === 0) {
        showToast("workspace.adopt", tr("sidebar.noAdoptable"))
        return
      }
      const answer = await promptDialog(t("dialog.adoptTitle"),
        `${t("sidebar.adoptNumber")}:\n${candidates.map((item, index) => `${index + 1}. ${item.branch}\n   ${item.path}`).join("\n")}`,
        "1",
      )
      if (answer === null) return
      const chosen = candidates[Number(answer) - 1]
      if (!chosen) throw new Error(tr("sidebar.invalidAdoptNumber"))
      const name = await promptDialog(t("task.namePrompt"), t("task.namePrompt")) || undefined
      await api.req("POST", `/projects/${projectId}/worktrees/adopt`, { path: chosen.path, ...(name ? { name } : {}) })
      await data.refreshWorkspaces()
    } catch (error) {
      showToast("workspace.adopt", error)
    }
  }

  return (
    <div className="sidebar">
      <div className="side-actions">
        <button ref={projectPickerTrigger} className="side-new" onClick={openProjectPicker}>
          <PlusIcon size={15} /> {tr("sidebar.openProject")}
        </button>
        <div className="side-search-wrap">
          <SearchIcon size={13} />
          <input
            className="side-search" placeholder={tr("sidebar.search")}
            value={query} onChange={(e) => useUi.getState().setSearch(e.target.value)}
          />
        </div>
        <select
          className="side-project-filter"
          aria-label={tr("sidebar.filter")}
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
        >
          <option value="">{tr("sidebar.allProjects")}</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>
      <div className="side-list" ref={listRef} role="listbox" aria-label={tr("sidebar.tasks")} onKeyDown={onListKeyDown}>
        {projects.filter((project) => projectFilter === "" || project.id === projectFilter).map((p) => {
          const rows = visible.filter((w) => w.projectId === p.id)
          const creatingHere = dispatchMode && dispatchProjectId === p.id
          const showNewAgent = creatingHere && !rows.some((workspace) => workspace.status === "creating")
          if (rows.length === 0 && query !== "" && !creatingHere) return null
          const collapsed = collapsedProjects[p.id] === true
          return (
            <section key={p.id}>
              <div className="proj-h">
                <button
                  className="proj-chev" aria-label={collapsed ? tr("sidebar.expand") : tr("sidebar.collapse")}
                  onClick={() => useUi.getState().toggleProjectCollapsed(p.id)}
                >
                  {collapsed ? <CaretRightIcon size={12} /> : <ChevronDownIcon size={12} />}
                </button>
                <span className="repo-m">{monogram(p.name)}</span>
                <span className="proj-name">{p.name}</span>
                <button className="proj-add" title={tr("sidebar.adopt")} aria-label={tr("sidebar.adopt")} onClick={() => void adopt(p.id)}>
                  <FolderPlusIcon size={13} />
                </button>
                <button className="proj-add" title={tr("sidebar.new")} aria-label={tr("sidebar.new")} onClick={() => startWorkspace(p.id)}>
                  <PlusIcon size={13} />
                </button>
              </div>
              {!collapsed && rows.map((w) => <WsRow key={w.id} ws={w}
                focused={focusedId === w.id || (focusedId === null && w.id === visible[0]?.id)}
                onFocus={() => setFocusedId(w.id)}
                onDrop={moveWorkspace} />)}
              {!collapsed && showNewAgent && (
                <button className="ws-row new-agent-row selected" onClick={() => useUi.getState().setDispatchMode(true, p.id)}>
                  <span className="badge b-creating">◌</span>
                  <span className="ws-name">&lt;new agent&gt;</span>
                </button>
              )}
              {!collapsed && rows.length === 0 && !creatingHere && <div className="dim empty-hint">{tr("sidebar.empty")}</div>}
            </section>
          )
        })}
        {archived.length > 0 && (
          <section>
            <div className="proj-h">
              <button
                className="proj-chev" aria-label={collapsedProjects.__archived ? tr("sidebar.expand") : tr("sidebar.collapse")}
                onClick={() => useUi.getState().toggleProjectCollapsed("__archived")}
              >
                {collapsedProjects.__archived ? <CaretRightIcon size={12} /> : <ChevronDownIcon size={12} />}
              </button>
              <span className="proj-name">{tr("sidebar.archived")}（{archived.length}）</span>
            </div>
            {!collapsedProjects.__archived && archived.map((w) => <WsRow key={w.id} ws={w}
              focused={focusedId === w.id} onFocus={() => setFocusedId(w.id)} onDrop={moveWorkspace} />)}
          </section>
        )}
        {projects.length === 0 && <div className="dim empty-hint side-onboard-hint">{tr("sidebar.noProjects")}</div>}
      </div>
      <div className="side-footer">
        <span className="side-foot-sp" />
        <button className="icobtn" title={`${tr("sidebar.help")} · ⌘/`} aria-label={tr("sidebar.help")} onClick={() => useUi.getState().setCheatsheet(true)}>
          <HelpIcon size={16} />
        </button>
        <button className="icobtn" title={`${tr("sidebar.settings")}（⌘,）`} aria-label={tr("sidebar.settings")} onClick={() => useUi.getState().setSettings(true)}>
          <SettingsIcon size={16} />
        </button>
      </div>
      {projectPickerOpen && !appDialogOpen && !settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeProjectPicker() }}>
          <div ref={projectPicker} className="modal project-picker" role="dialog" aria-modal="true"
            aria-label={tr("sidebar.openProject")} onKeyDown={(event) => {
              if (trapTabKey(event.nativeEvent, projectPicker.current)) return
              consumeModalKey(event, "Escape", closeProjectPicker)
            }}>
            <button ref={projectPickerClose} className="project-picker-close" onClick={closeProjectPicker}
              aria-label={tr("dialog.close")}>×</button>
            <ProjectOnboarding onProjectReady={(project) => {
              closeProjectPicker()
              startWorkspace(project.id)
            }} />
          </div>
        </div>
      )}
    </div>
  )
}
