import { useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { Composer } from "./Composer"
import { deliverModelSwitch } from "./Composer"
import { makeDrafts } from "./drafts"

const drafts = makeDrafts(localStorage)

export const DispatchPanel = () => {
  const projects = useData((s) => s.projects)
  const engines = useData((s) => s.config?.engines ?? [])
  const claude = engines[0]
  const projectId = useUi((s) => s.dispatchProjectId) ?? projects[0]?.id ?? null
  const [model, setModel] = useState("default")
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = (prompt: string): void => {
    const api = useData.getState().getApi()
    if (!api || !projectId || creating) return
    setCreating(true); setErr(null)
    void (async () => {
      try {
        // 同步流水线：fetch 会等到 active/error 才返回（server 行为，可长达数十秒）
        const ws = await api.req("POST", "/workspaces", { projectId, initialPrompt: prompt })
        useUi.getState().selectWs(ws.id)
        if (model !== "default" && claude?.capabilities.midSessionModelSwitch)
          void deliverModelSwitch(ws.id, model, true).catch(() => {})
      } catch (e: any) {
        setErr(e?.message ?? String(e)) // status=error 的半成品会出现在左栏（! 徽标）供 Retry
      } finally {
        setCreating(false)
      }
    })()
  }

  return (
    <div className="dispatch">
      <div className="dispatch-head">
        <h2>新 Workspace</h2>
        <button className="dim" onClick={() => useUi.getState().setDispatchMode(false)}>Esc 取消</button>
      </div>
      <div className="dispatch-row">
        <label>项目</label>
        <select value={projectId ?? ""} onChange={(e) => {
          // Composer 把草稿键在 dispatch:<projectId> 上；切项目会换 wsId，先把已打的字搬过去再切，别丢
          drafts.carry(`dispatch:${projectId ?? "none"}`, `dispatch:${e.target.value}`)
          useUi.getState().setDispatchMode(true, e.target.value)
        }}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {claude && (
          <>
            <label>模型</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {claude.models.map((m) => <option key={m} value={m}>{claude.displayName}·{m}</option>)}
            </select>
          </>
        )}
      </div>
      {err && <div className="dispatch-err">创建失败：{err}（左栏 error 项可 Retry）</div>}
      {creating
        ? <div className="dispatch-busy">◌ 创建中…（fetch worktree → setup → tmux → engine → 投递首条 prompt）</div>
        : <Composer wsId={`dispatch:${projectId ?? "none"}`} onSubmitOverride={submit}
            placeholder="描述任务… Enter 创建 workspace 并作为首条 prompt 投递" />}
    </div>
  )
}

/** error workspace 的动作条（spec §四：error 可重试；半成品已自动回滚） */
export const ErrorActions = ({ wsId }: { wsId: string }) => {
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<unknown>): void => {
    setBusy(true)
    void fn().catch((e: any) => alert(e?.message ?? e)).finally(() => setBusy(false))
  }
  const api = () => useData.getState().getApi()!
  return (
    <div className="error-actions">
      <span className="b-error">! 创建失败（半成品已回滚）</span>
      <button className="btn" disabled={busy} onClick={() => act(() => api().req("POST", `/workspaces/${wsId}/retry`, {}))}>重试</button>
      <button disabled={busy} onClick={() => act(() => api().req("DELETE", `/workspaces/${wsId}?force=1`))}>删除记录</button>
    </div>
  )
}
