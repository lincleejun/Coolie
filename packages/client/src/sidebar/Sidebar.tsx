import { useEffect, useState } from "react"
import type { Workspace, Tab } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { useAttention } from "../stores/attention"
import { ApiError } from "../api/client"
import { orderedActiveWs, pinnedFirst } from "../hotkeys/useGlobalHotkeys"
import { CaretRightIcon, ChevronDownIcon, FolderPlusIcon, GitBranchIcon, HelpIcon, PlusIcon, SearchIcon, SettingsIcon } from "../chrome/icons"
import { ProjectOnboarding } from "../chrome/EmptyState"
import { openWorkspaceWindow } from "../chrome/workspaceWindow"

/** 状态徽标（spec §六）：workspace 状态优先，active 时取 engine tab 状态 */
export const wsBadge = (ws: Workspace, tabs: Tab[] | undefined): { glyph: string; cls: string; title: string } => {
  if (ws.status === "creating") return { glyph: "◌", cls: "b-creating", title: "创建中" }
  if (ws.status === "error") return { glyph: "!", cls: "b-error", title: "创建失败（可重试）" }
  if (ws.status === "archived") return { glyph: "▪", cls: "b-archived", title: "已归档" }
  const engine = tabs?.find((t) => t.kind === "engine")
  switch (engine?.status) {
    case "working": return { glyph: "●", cls: "b-working", title: "工作中" }
    case "awaiting-input": return { glyph: "✓", cls: "b-await", title: "等输入" }
    case "error": return { glyph: "!", cls: "b-error", title: "错误" }
    default: return { glyph: "○", cls: "b-idle", title: "空闲" }
  }
}

/** Two-letter warm monogram for the project group header (Conductor sidebar). */
const monogram = (name: string): string =>
  (name.match(/[A-Za-z0-9]/g)?.slice(0, 2).join("") || name.slice(0, 2)).toUpperCase()

export const archiveForceConfirmation = (ws: Workspace): string =>
  ws.ownership === "adopted"
    ? `归档「${ws.name}」只取消 Coolie 管理并停止运行时，保留外部 worktree 及其改动。`
    : `「${ws.name}」有未提交改动。强制归档会永久丢弃未提交改动，确定继续？`

export const deleteConfirmation = (ws: Workspace): string =>
  ws.ownership === "adopted"
    ? `删除 workspace「${ws.name}」只取消 Coolie 管理，保留外部 worktree、分支及未提交改动。`
    : `删除 workspace「${ws.name}」？\n这会永久丢弃未提交改动并删除 worktree；branch ⑂${ws.branch} 保留。`

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
    void fn().catch((e: unknown) => alert(e instanceof Error ? e.message : String(e))).finally(() => { setBusy(false); onClose() })
  }
  const archive = (): void => run(async () => {
    const d = useData.getState()
    if (ws.ownership === "adopted" && !window.confirm(archiveForceConfirmation(ws))) return
    try { await d.archiveWs(ws.id, false) }
    catch (e) {
      // 脏 worktree：server 以 409 ConflictError 拒绝无 force 归档 → 征得确认后强制
      if (e instanceof ApiError && e.status === 409 && window.confirm(archiveForceConfirmation(ws)))
        await d.archiveWs(ws.id, true)
      else if (!(e instanceof ApiError && e.status === 409)) throw e
    }
  })
  const togglePinned = (): void => run(() => useData.getState().setPinnedWs(ws.id, !ws.pinned))
  const unarchive = (): void => run(() => useData.getState().unarchiveWs(ws.id))
  const del = (): void => {
    if (!window.confirm(deleteConfirmation(ws))) { onClose(); return }
    run(() => useData.getState().deleteWs(ws.id, true))
  }
  const finishPr = (): void => run(async () => {
    const api = useData.getState().getApi()
    if (!api) throw new Error("api 未就绪")
    const title = window.prompt("PR 标题（留空使用 branch 名）") ?? undefined
    const out = await api.req("POST", `/workspaces/${ws.id}/finish`, { createPr: true, title })
    if (out.prUrl) window.alert(`PR 已创建：${out.prUrl}`)
    for (const warning of out.warnings ?? []) useData.getState().pushWarning("workspace.finish", warning)
  })
  const mergeBack = (): void => {
    if (!window.confirm(`确认把「${ws.branch}」以 --no-ff 合回主 checkout 的 ${ws.baseBranch}？\n两边都必须 clean；冲突会原样保留。`)) {
      onClose()
      return
    }
    run(async () => {
      const api = useData.getState().getApi()
      if (!api) throw new Error("api 未就绪")
      await api.req("POST", `/workspaces/${ws.id}/finish`, { mergeBack: true })
    })
  }
  return (
    <div className="ws-menu" role="menu" onClick={(e) => e.stopPropagation()}>
      <button role="menuitem" disabled={busy} onClick={togglePinned}>{ws.pinned ? "取消置顶" : "置顶"}</button>
      {ws.status === "active" && <button role="menuitem" disabled={busy} onClick={archive}>归档</button>}
      {ws.status === "active" && <button role="menuitem" disabled={busy} onClick={finishPr}>创建 PR…</button>}
      {ws.status === "active" && <button role="menuitem" disabled={busy} onClick={mergeBack}>合回主 checkout…</button>}
      {ws.status === "archived" && <button role="menuitem" disabled={busy} onClick={unarchive}>恢复</button>}
      <button role="menuitem" className="danger" disabled={busy} onClick={del}>删除…</button>
    </div>
  )
}

const WsRow = ({ ws }: { ws: Workspace }) => {
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
      className={`ws-row ${selected ? "selected" : ""}`}
      onClick={() => useUi.getState().selectWs(ws.id)}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
    >
      <span className={`badge ${badge.cls}`} title={badge.title}>{badge.glyph}</span>
      {raised && <span className="attn-dot" title="需要你" aria-label="需要你">!</span>}
      <span className="ws-name">{ws.pinned ? "📌 " : ""}{ws.name}</span>
      <span className="ws-branch" title={ws.branch}><GitBranchIcon size={11} className="ws-branch-icon" />{ws.branch.replace(/^coolie\//, "")}</span>
      {ws.status === "active" && <DiffCount wsId={ws.id} />}
      <button
        className="ws-more" title="更多动作" aria-label="更多动作"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
      >⋯</button>
      {menuOpen && <WsRowMenu ws={ws} onClose={() => setMenuOpen(false)} />}
    </div>
  )
}

export const Sidebar = () => {
  const projects = useData((s) => s.projects)
  const workspaces = useData((s) => s.workspaces)
  const query = useUi((s) => s.searchQuery)
  const collapsedProjects = useUi((s) => s.collapsedProjects)
  const dispatchMode = useUi((s) => s.dispatchMode)
  const dispatchProjectId = useUi((s) => s.dispatchProjectId)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)

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
  const startWorkspace = (projectId: string): void => {
    void openWorkspaceWindow(projectId)
      .catch((error: unknown) => window.alert(error instanceof Error ? error.message : String(error)))
  }
  const adopt = async (projectId: string): Promise<void> => {
    const data = useData.getState()
    const api = data.getApi()
    if (!api) return
    try {
      const candidates: Array<{ path: string; branch: string; head: string }> =
        await api.req("GET", `/projects/${projectId}/worktrees/adoptable`)
      if (candidates.length === 0) return window.alert("没有可采用的 branch worktree")
      const answer = window.prompt(
        `输入要采用的编号：\n${candidates.map((item, index) => `${index + 1}. ${item.branch}\n   ${item.path}`).join("\n")}`,
        "1",
      )
      if (answer === null) return
      const chosen = candidates[Number(answer) - 1]
      if (!chosen) throw new Error("编号无效")
      const name = window.prompt("Workspace 名称（留空自动分配）") || undefined
      await api.req("POST", `/projects/${projectId}/worktrees/adopt`, { path: chosen.path, ...(name ? { name } : {}) })
      await data.refreshWorkspaces()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="sidebar">
      <div className="side-actions">
        <button className="side-new" onClick={() => setProjectPickerOpen(true)}>
          <PlusIcon size={15} /> Open Project
        </button>
        <div className="side-search-wrap">
          <SearchIcon size={13} />
          <input
            className="side-search" placeholder="搜索 workspace…"
            value={query} onChange={(e) => useUi.getState().setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="side-list">
        {projects.map((p) => {
          const rows = ordered.filter((w) => w.projectId === p.id)
          const creatingHere = dispatchMode && dispatchProjectId === p.id
          const showNewAgent = creatingHere && !rows.some((workspace) => workspace.status === "creating")
          if (rows.length === 0 && query !== "" && !creatingHere) return null
          const collapsed = collapsedProjects[p.id] === true
          return (
            <section key={p.id}>
              <div className="proj-h">
                <button
                  className="proj-chev" aria-label={collapsed ? "展开" : "折叠"}
                  onClick={() => useUi.getState().toggleProjectCollapsed(p.id)}
                >
                  {collapsed ? <CaretRightIcon size={12} /> : <ChevronDownIcon size={12} />}
                </button>
                <span className="repo-m">{monogram(p.name)}</span>
                <span className="proj-name">{p.name}</span>
                <button className="proj-add" title="采用已有 worktree…" aria-label="采用 worktree" onClick={() => void adopt(p.id)}>
                  <FolderPlusIcon size={13} />
                </button>
                <button className="proj-add" title="在新窗口新建 workspace" aria-label="新建 workspace" onClick={() => startWorkspace(p.id)}>
                  <PlusIcon size={13} />
                </button>
              </div>
              {!collapsed && rows.map((w) => <WsRow key={w.id} ws={w} />)}
              {!collapsed && showNewAgent && (
                <button className="ws-row new-agent-row selected" onClick={() => useUi.getState().setDispatchMode(true, p.id)}>
                  <span className="badge b-creating">◌</span>
                  <span className="ws-name">&lt;new agent&gt;</span>
                </button>
              )}
              {!collapsed && rows.length === 0 && !creatingHere && <div className="dim empty-hint">⌘N 创建第一个 workspace</div>}
            </section>
          )
        })}
        {archived.length > 0 && (
          <section>
            <div className="proj-h">
              <button
                className="proj-chev" aria-label={collapsedProjects.__archived ? "展开" : "折叠"}
                onClick={() => useUi.getState().toggleProjectCollapsed("__archived")}
              >
                {collapsedProjects.__archived ? <CaretRightIcon size={12} /> : <ChevronDownIcon size={12} />}
              </button>
              <span className="proj-name">已归档（{archived.length}）</span>
            </div>
            {!collapsedProjects.__archived && archived.map((w) => <WsRow key={w.id} ws={w} />)}
          </section>
        )}
        {projects.length === 0 && <div className="dim empty-hint side-onboard-hint">还没有项目 —— 中间面板可打开目录或 clone 仓库。</div>}
      </div>
      <div className="side-footer">
        <span className="side-foot-sp" />
        <button className="icobtn" title={`帮助 · 快捷键 ⌘/`} aria-label="帮助" onClick={() => useUi.getState().setCheatsheet(true)}>
          <HelpIcon size={16} />
        </button>
        <button className="icobtn" title="设置（⌘,）" aria-label="设置" onClick={() => useUi.getState().setSettings(true)}>
          <SettingsIcon size={16} />
        </button>
      </div>
      {projectPickerOpen && (
        <div className="modal-backdrop" onClick={() => setProjectPickerOpen(false)}>
          <div className="modal project-picker" role="dialog" aria-label="Open Project" onClick={(event) => event.stopPropagation()}>
            <button className="project-picker-close" onClick={() => setProjectPickerOpen(false)} aria-label="关闭">×</button>
            <ProjectOnboarding onProjectReady={(project) => {
              setProjectPickerOpen(false)
              startWorkspace(project.id)
            }} />
          </div>
        </div>
      )}
    </div>
  )
}
