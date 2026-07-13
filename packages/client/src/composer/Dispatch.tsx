import { useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { Composer } from "./Composer"
import { makeDrafts, type DraftStorage } from "./drafts"

const draftStorage: DraftStorage =
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const drafts = makeDrafts(draftStorage)

export interface CreateBodyInput {
  projectId: string
  engineId: string
  prompt: string
  model: string
  effort: string
}

export const buildCreateBody = (i: CreateBodyInput): Record<string, string> => ({
  projectId: i.projectId,
  engineId: i.engineId,
  initialPrompt: i.prompt,
  ...(i.model !== "default" ? { model: i.model } : {}),
  ...(i.effort !== "default" ? { effort: i.effort } : {}),
})

export const DispatchPanel = () => {
  const projects = useData((s) => s.projects)
  const engines = useData((s) => s.config?.engines ?? [])
  const projectId = useUi((s) => s.dispatchProjectId) ?? projects[0]?.id ?? null
  const [engineId, setEngineId] = useState(engines[0]?.id ?? "claude")
  const engine = engines.find((candidate) => candidate.id === engineId) ?? engines[0]
  const [model, setModel] = useState("default")
  const [effort, setEffort] = useState("default")
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = (prompt: string): void => {
    const api = useData.getState().getApi()
    if (!api || !projectId || !engine || creating) return
    setCreating(true); setErr(null)
    void (async () => {
      try {
        // 同步流水线：fetch 会等到 active/error 才返回（server 行为，可长达数十秒）
        const ws = await api.req("POST", "/workspaces", buildCreateBody({
          projectId,
          engineId: engine.id,
          prompt,
          model,
          effort,
        }))
        useUi.getState().selectWs(ws.id)
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
        <label>引擎</label>
        <select value={engine?.id ?? ""} onChange={(e) => {
          setEngineId(e.target.value)
          setModel("default")
          setEffort("default")
        }}>
          {engines.map((candidate) =>
            <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
        </select>
        {engine && engine.models.length > 0 && (
          <>
            <label>模型</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="default">默认</option>
              {engine.models.map((m) => <option key={m} value={m}>{engine.displayName}·{m}</option>)}
            </select>
          </>
        )}
        {engine?.capabilities.effort && engine.efforts && engine.efforts.length > 0 && (
          <>
            <label>effort</label>
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="default">默认</option>
              {engine.efforts.map((value) => <option key={value} value={value}>{value}</option>)}
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
