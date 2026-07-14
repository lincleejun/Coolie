import { useEffect, useState } from "react"
import type { Workspace, Tab } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { useAttention } from "../stores/attention"
import { ApiError } from "../api/client"
import { orderedActiveWs, pinnedFirst } from "../hotkeys/useGlobalHotkeys"

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
    try { await d.archiveWs(ws.id, false) }
    catch (e) {
      // 脏 worktree：server 以 409 ConflictError 拒绝无 force 归档 → 征得确认后强制
      if (e instanceof ApiError && e.status === 409 && window.confirm(`「${ws.name}」有未提交改动。仍要归档吗？（改动留在 worktree）`))
        await d.archiveWs(ws.id, true)
      else if (!(e instanceof ApiError && e.status === 409)) throw e
    }
  })
  const togglePinned = (): void => run(() => useData.getState().setPinnedWs(ws.id, !ws.pinned))
  const unarchive = (): void => run(() => useData.getState().unarchiveWs(ws.id))
  const del = (): void => {
    if (!window.confirm(`删除 workspace「${ws.name}」？\nworktree 会被删除，branch ⑂${ws.branch} 保留。`)) { onClose(); return }
    run(() => useData.getState().deleteWs(ws.id, true))
  }
  return (
    <div className="ws-menu" role="menu" onClick={(e) => e.stopPropagation()}>
      <button role="menuitem" disabled={busy} onClick={togglePinned}>{ws.pinned ? "取消置顶" : "置顶"}</button>
      {ws.status === "active" && <button role="menuitem" disabled={busy} onClick={archive}>归档</button>}
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
      <span className="ws-branch" title={ws.branch}>⑂{ws.branch.replace(/^coolie\//, "")}</span>
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

  return (
    <div className="sidebar">
      <div className="side-actions">
        <button className="side-new" onClick={() => useUi.getState().setDispatchMode(true, projects[0]?.id ?? null)}>
          ＋ New Workspace <kbd>⌘N</kbd>
        </button>
        <input
          className="side-search" placeholder="🔍 搜索 workspace…"
          value={query} onChange={(e) => useUi.getState().setSearch(e.target.value)}
        />
      </div>
      <div className="side-list">
        {projects.map((p) => {
          const rows = ordered.filter((w) => w.projectId === p.id)
          if (rows.length === 0 && query !== "") return null
          return (
            <section key={p.id}>
              <h3 className="proj-h">▾ {p.name}</h3>
              {rows.map((w) => <WsRow key={w.id} ws={w} />)}
              {rows.length === 0 && <div className="dim empty-hint">⌘N 创建第一个 workspace</div>}
            </section>
          )
        })}
        {archived.length > 0 && (
          <section>
            <h3 className="proj-h">▸ 已归档（{archived.length}）</h3>
            {archived.map((w) => <WsRow key={w.id} ws={w} />)}
          </section>
        )}
        {projects.length === 0 && <div className="dim empty-hint side-onboard-hint">还没有项目 —— 中间面板可打开目录或 clone 仓库。</div>}
      </div>
      <div className="side-footer">
        <button className="dim" onClick={() => useUi.getState().setCheatsheet(true)}>⚙ 设置 / ⌘/ 快捷键</button>
      </div>
    </div>
  )
}
