import { useEffect, useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { makeDrafts, type DraftStorage } from "../composer/drafts"
import type { DiffSection, FileChange } from "../stores/types"
import { t, useT } from "../i18n"
import { RunPanel } from "../runs/RunPanel"
import { CaretRightIcon, ChevronDownIcon, FolderIcon, PanelRightIcon } from "../chrome/icons"
import { capabilities, openInEditor } from "../platform"
import { shouldApplyAsyncResult } from "./stale"

// node 测试环境（filetree.test）会 import 本模块取 buildTree；此处不能裸引 localStorage（node 无此全局会 ReferenceError）。
const storage: DraftStorage =
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const drafts = makeDrafts(storage)

export const injectComposerPrompt = (wsId: string, prompt: string): void => {
  const current = drafts.load(wsId)
  drafts.save(wsId, current === "" ? prompt : `${current}\n\n${prompt}`)
  useUi.getState().focusComposer()
}

export interface TreeNode { name: string; path: string; children: TreeNode[] }

export const buildTree = (paths: readonly string[]): TreeNode => {
  const root: TreeNode = { name: "", path: "", children: [] }
  for (const p of paths) {
    let node = root
    const parts = p.split("/")
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/")
      let child = node.children.find((c) => c.name === part)
      if (!child) { child = { name: part, path, children: [] }; node.children.push(child) }
      node = child
    })
  }
  const sort = (n: TreeNode): void => {
    n.children.sort((a, b) =>
      (Number(b.children.length > 0) - Number(a.children.length > 0)) || a.name.localeCompare(b.name))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

// @注入：追加到该 ws 草稿尾部（drafts.ts 无 append，且 composer/ 不在本任务改动域 → 用现有 load/save 就地拼接），
// 再 focusComposer()。注意：Composer 需在 focusNonce effect 里重读草稿注入才会「即时」出现于输入框——
// 该 Composer.tsx 一行改动属 T13 域，见 task-14-report「@注入 wiring」。
const injectAt = (wsId: string, path: string): void => {
  const cur = drafts.load(wsId)
  drafts.save(wsId, cur === "" ? `@${path}` : `${cur} @${path}`)
  useUi.getState().focusComposer()
}

const openEditor = (wsId: string, file: string): void => {
  const workspace = useData.getState().workspaces.find((item) => item.id === wsId)
  if (!workspace || !capabilities.openEditor) {
    useData.getState().pushWarning("editor.unavailable", t("editor.webUnavailable"))
    return
  }
  void openInEditor(workspace.path, file).catch((error: unknown) =>
    useData.getState().pushWarning("editor.open", error instanceof Error ? error.message : String(error)))
}

const Tree = ({ node, wsId, depth }: { node: TreeNode; wsId: string; depth: number }) => {
  const tr = useT()
  const [open, setOpen] = useState(depth < 1)
  const isDir = node.children.length > 0
  return (
    <div>
      {node.name !== "" && (
        <div className="tree-row" style={{ paddingLeft: depth * 14 }}
          onClick={() => (isDir ? setOpen(!open) : injectAt(wsId, node.path))}
          title={isDir ? node.path : tr("right.injectComposer").replace("{path}", node.path)}>
          {isDir
            ? <>{open ? <ChevronDownIcon size={11} className="tree-chev" /> : <CaretRightIcon size={11} className="tree-chev" />}<FolderIcon size={14} className="tree-folder" /></>
            : <span className="tree-dot">·</span>}
          <span className="tree-name">{node.name}</span>
          {!isDir && <button type="button" className="tree-editor" aria-label={tr("right.openEditorAria").replace("{path}", node.path)}
            onClick={(event) => { event.stopPropagation(); openEditor(wsId, node.path) }}>↗</button>}
        </div>
      )}
      {open && node.children.map((c) => <Tree key={c.path} node={c} wsId={wsId} depth={depth + 1} />)}
    </div>
  )
}

const ChangeSection = ({ title, section, list, onOpen, wsId }: {
  title: string
  section: DiffSection
  list: FileChange[]
  wsId: string
  onOpen: (section: DiffSection, path: string) => void
}) => {
  const tr = useT()
  const [open, setOpen] = useState(true)
  return (
    <section className="chg-section">
      <h4 onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {title}（{list.length}）</h4>
      {open && list.map((f) => (
        <div className="chg-row chg-row-pick" key={f.path} title={tr("right.openDiff").replace("{path}", f.path)}
          onClick={() => onOpen(section, f.path)}>
          <span className="chg-path">{f.path}</span>
          <span className="diffcount"><em className="plus">+{f.insertions}</em><em className="minus">−{f.deletions}</em></span>
          <button type="button" className="tree-editor" aria-label={tr("right.openEditorAria").replace("{path}", f.path)}
            onClick={(event) => { event.stopPropagation(); openEditor(wsId, f.path) }}>↗</button>
        </div>
      ))}
    </section>
  )
}

export const RightPanel = ({ wsId, forcePanel }: {
  wsId: string
  /** Deterministic server-render/test seam; production follows the UI store. */
  forcePanel?: "collapsed" | "changes" | "files"
}) => {
  const tr = useT()
  const storedPanel = useUi((s) => s.rightPanel)
  const panel = forcePanel ?? storedPanel
  const changes = useData((s) => s.changesByWs[wsId])
  const stat = useData((s) => s.diffstatByWs[wsId])
  const [files, setFiles] = useState<string[]>([])
  const [loadingPrPrompt, setLoadingPrPrompt] = useState(false)
  const createPrPrompt = (): void => {
    const api = useData.getState().getApi()
    if (!api) return useData.getState().pushWarning("pr.prompt", tr("right.serverUnavailable"))
    setLoadingPrPrompt(true)
    void api.req("GET", `/workspaces/${wsId}/pr-instructions`)
      .then((result: { content: string }) => injectComposerPrompt(wsId, result.content))
      .catch((error: unknown) => useData.getState().pushWarning("pr.prompt", String(error)))
      .finally(() => setLoadingPrPrompt(false))
  }

  useEffect(() => {
    if (panel === "changes") void useData.getState().refreshChanges(wsId).catch(() => {})
    if (panel !== "files") return
    let cancelled = false
    const requestedWs = wsId
    void useData.getState().getApi()?.req("GET", `/workspaces/${wsId}/files`)
      .then((r) => {
        if (!shouldApplyAsyncResult(requestedWs, wsId, cancelled)) return
        setFiles(r.files)
      }).catch(() => {})
    return () => { cancelled = true }
  }, [panel, wsId])

  // 展开时跟随 turn 结束刷新（changes 已由 data store 的 engine.turn.finished → refreshDiffstat 带动；这里补 changes）
  useEffect(() => {
    if (panel !== "changes") return
    const t = setInterval(() => { if (document.hasFocus()) void useData.getState().refreshChanges(wsId).catch(() => {}) }, 8000)
    return () => clearInterval(t)
  }, [panel, wsId])

  if (panel === "collapsed")
    return (
      <div className="right-collapsed">
        <button type="button" className="right-entry" aria-label={tr("right.changes")} aria-expanded="false"
          onClick={() => useUi.getState().setRightPanel("changes")}>
          {tr("right.changes")}{stat && (stat.insertions > 0 || stat.deletions > 0) ? ` +${stat.insertions}−${stat.deletions}` : ""}
        </button>
        <button type="button" className="right-entry" aria-label={tr("right.files")} aria-expanded="false"
          onClick={() => useUi.getState().setRightPanel("files")}>{tr("right.files")}</button>
      </div>
    )

  const panelId = `right-panel-${wsId}`
  return (
    <div className="right-open">
      <div className="right-head" role="tablist">
        <button type="button" role="tab" aria-selected={panel === "changes"} aria-controls={panelId}
          className={panel === "changes" ? "active" : ""} onClick={() => useUi.getState().setRightPanel("changes")}>{tr("right.changes")}</button>
        <button type="button" role="tab" aria-selected={panel === "files"} aria-controls={panelId}
          className={panel === "files" ? "active" : ""} onClick={() => useUi.getState().setRightPanel("files")}>{tr("right.files")}</button>
        <span className="tabsbar-spacer" />
        {panel === "changes" && <button type="button" className="btn-secondary" disabled={loadingPrPrompt}
          onClick={createPrPrompt}>{tr("right.createPrPrompt")}</button>}
        <button type="button" className="icobtn" title={tr("titlebar.toggleRight")} aria-label={tr("titlebar.toggleRight")} onClick={() => useUi.getState().setRightPanel("collapsed")}>
          <PanelRightIcon />
        </button>
      </div>
      <div className="right-body" id={panelId} role="tabpanel">
        <RunPanel wsId={wsId} />
        {panel === "changes" && (
          changes ? (
            <>
              <div className="chg-total">{tr("right.vsBase").replace(
                "{stats}",
                stat
                  ? `+${stat.insertions} −${stat.deletions} (${tr("right.fileCount").replace("{count}", String(stat.filesChanged))})`
                  : "…",
              )}</div>
              <ChangeSection title={tr("right.againstBase")} section="againstBase" list={changes.againstBase} wsId={wsId}
                onOpen={(section, path) => useUi.getState().openCenterDiff({ wsId, section, path })} />
              <ChangeSection title={tr("right.committed")} section="committed" list={changes.committed} wsId={wsId}
                onOpen={(section, path) => useUi.getState().openCenterDiff({ wsId, section, path })} />
              <ChangeSection title={tr("right.staged")} section="staged" list={changes.staged} wsId={wsId}
                onOpen={(section, path) => useUi.getState().openCenterDiff({ wsId, section, path })} />
              <ChangeSection title={tr("right.unstaged")} section="unstaged" list={changes.unstaged} wsId={wsId}
                onOpen={(section, path) => useUi.getState().openCenterDiff({ wsId, section, path })} />
              {changes.untracked.length > 0 && (
                <ChangeSection
                  title={tr("right.untracked")}
                  section="untracked"
                  list={changes.untracked.map((p) => ({ path: p, insertions: 0, deletions: 0 }))}
                  wsId={wsId}
                  onOpen={(section, path) => useUi.getState().openCenterDiff({ wsId, section, path })}
                />
              )}
            </>
          ) : <div className="dim">{tr("right.loading")}</div>
        )}
        {panel === "files" && <Tree node={buildTree(files)} wsId={wsId} depth={0} />}
      </div>
    </div>
  )
}
