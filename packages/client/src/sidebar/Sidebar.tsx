import { useEffect } from "react"
import type { Workspace, Tab } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { orderedActiveWs } from "../hotkeys/useGlobalHotkeys"

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

const WsRow = ({ ws }: { ws: Workspace }) => {
  const selected = useUi((s) => s.selectedWs === ws.id)
  const tabs = useData((s) => s.tabsByWs[ws.id])
  const badge = wsBadge(ws, tabs)
  return (
    <div className={`ws-row ${selected ? "selected" : ""}`} onClick={() => useUi.getState().selectWs(ws.id)}>
      <span className={`badge ${badge.cls}`} title={badge.title}>{badge.glyph}</span>
      <span className="ws-name">{ws.pinned ? "📌 " : ""}{ws.name}</span>
      <span className="ws-branch" title={ws.branch}>⑂{ws.branch.replace(/^coolie\//, "")}</span>
      {ws.status === "active" && <DiffCount wsId={ws.id} />}
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
  const archived = workspaces.filter((w) => w.status === "archived" && match(w))

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
