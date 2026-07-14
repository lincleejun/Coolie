import { useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { Composer } from "./Composer"
import { makeDrafts, type DraftStorage } from "./drafts"
import { MAX_FANOUT } from "@coolie/protocol"
import type { EngineInfo } from "../stores/types"
import { useT } from "../i18n"
import { useSettings } from "../settings/settings"

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
  namePool?: string
  customNames?: readonly string[]
}

export const buildCreateBody = (i: CreateBodyInput): Record<string, unknown> => ({
  projectId: i.projectId,
  engineId: i.engineId,
  initialPrompt: i.prompt,
  ...(i.model !== "default" ? { model: i.model } : {}),
  ...(i.effort !== "default" ? { effort: i.effort } : {}),
  ...(i.namePool ? { namePool: i.namePool } : {}),
  ...(i.namePool === "custom" ? { customNames: [...(i.customNames ?? [])] } : {}),
})

export const fanoutTotal = (counts: Readonly<Record<string, number>>): number =>
  Object.values(counts).reduce((total, count) =>
    total + (Number.isFinite(count) && count > 0 ? Math.floor(count) : 0), 0)

export const buildFanoutRequests = (
  base: CreateBodyInput,
  counts: Readonly<Record<string, number>>,
  engines: readonly EngineInfo[],
  groupId: string,
): Array<Record<string, unknown>> => {
  const requests: Array<Record<string, unknown>> = []
  for (const engine of engines) {
    const count = Math.max(0, Math.floor(counts[engine.id] ?? 0))
    const selected = engine.id === base.engineId
    for (let index = 0; index < count; index++) {
      requests.push({
        ...buildCreateBody({
          projectId: base.projectId,
          engineId: engine.id,
          prompt: base.prompt,
          // 当前 UI 只有一组 model/effort 选择器。只把选择值发给它所属的引擎；
          // 其他引擎明确使用默认值，避免把 codex-only effort 发给 claude。
          model: selected && engine.models.includes(base.model) ? base.model : "default",
          effort: selected && engine.capabilities.effort && engine.efforts?.includes(base.effort)
            ? base.effort
            : "default",
          ...(base.namePool !== undefined ? { namePool: base.namePool } : {}),
          ...(base.customNames !== undefined ? { customNames: base.customNames } : {}),
        }),
        fanoutGroup: groupId,
      })
    }
  }
  return requests
}

export type FanoutCreateResult =
  | { readonly engineId: string; readonly ok: true; readonly workspaceId: string }
  | { readonly engineId: string; readonly ok: false; readonly error: string }

export const submitFanoutRequests = async (
  requests: readonly Record<string, unknown>[],
  create: (body: Record<string, unknown>) => Promise<{ id: string }>,
): Promise<FanoutCreateResult[]> => {
  const results: FanoutCreateResult[] = []
  for (const body of requests) {
    const engineId = typeof body.engineId === "string" ? body.engineId : "unknown"
    try {
      const workspace = await create(body)
      results.push({ engineId, ok: true, workspaceId: workspace.id })
    } catch (error) {
      results.push({
        engineId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export const DispatchPanel = () => {
  const tr = useT()
  const projects = useData((s) => s.projects)
  const engines = useData((s) => s.config?.engines ?? [])
  const projectId = useUi((s) => s.dispatchProjectId) ?? projects[0]?.id ?? null
  const [engineId, setEngineId] = useState(engines[0]?.id ?? "claude")
  const engine = engines.find((candidate) => candidate.id === engineId) ?? engines[0]
  const [model, setModel] = useState("default")
  const [effort, setEffort] = useState("default")
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const total = fanoutTotal(counts)
  const overCap = total > MAX_FANOUT
  const namePool = useSettings((state) => state.namePool)
  const customNames = useSettings((state) => state.customNames)

  const submit = (prompt: string): void => {
    const api = useData.getState().getApi()
    if (!api || !projectId || !engine || creating) return
    if (overCap) {
      setErr(`fan-out 实例数 ${total} 超上限 ${MAX_FANOUT}`)
      return
    }
    setCreating(true); setErr(null)
    void (async () => {
      try {
        if (total > 0) {
          const groupId = `fo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const requests = buildFanoutRequests({
            projectId,
            engineId: engine.id,
            prompt,
            model,
            effort,
            namePool,
            customNames,
          }, counts, engines, groupId)
          const results = await submitFanoutRequests(
            requests,
            (body) => api.req("POST", "/workspaces", body),
          )
          const first = results.find((result) => result.ok)
          if (first?.ok) useUi.getState().selectWs(first.workspaceId)
          const failures = results.filter((result): result is Extract<FanoutCreateResult, { ok: false }> => !result.ok)
          if (failures.length > 0)
            setErr(`部分失败（${failures.length}/${results.length}）：${failures.map((result) =>
              `${result.engineId}: ${result.error}`).join("；")}；成功项已保留`)
          return
        }
        // 同步流水线：fetch 会等到 active/error 才返回（server 行为，可长达数十秒）
        const ws = await api.req("POST", "/workspaces", buildCreateBody({
          projectId,
          engineId: engine.id,
          prompt,
          model,
          effort,
          namePool,
          customNames,
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
        <h2>{tr("dispatch.title")}</h2>
        <button className="dim" onClick={() => useUi.getState().setDispatchMode(false)}>{tr("dispatch.cancel")}</button>
      </div>
      <div className="dispatch-row">
        <label>{tr("dispatch.project")}</label>
        <select value={projectId ?? ""} onChange={(e) => {
          // Composer 把草稿键在 dispatch:<projectId> 上；切项目会换 wsId，先把已打的字搬过去再切，别丢
          drafts.carry(`dispatch:${projectId ?? "none"}`, `dispatch:${e.target.value}`)
          useUi.getState().setDispatchMode(true, e.target.value)
        }}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label>{tr("dispatch.engine")}</label>
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
            <label>{tr("dispatch.model")}</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="default">{tr("dispatch.default")}</option>
              {engine.models.map((m) => <option key={m} value={m}>{engine.displayName}·{m}</option>)}
            </select>
          </>
        )}
        {engine?.capabilities.effort && engine.efforts && engine.efforts.length > 0 && (
          <>
            <label>{tr("dispatch.effort")}</label>
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="default">{tr("dispatch.default")}</option>
              {engine.efforts.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </>
        )}
      </div>
      <div className="dispatch-fanout">
        <label>Fan-out（每引擎实例数）</label>
        {engines.map((candidate) => (
          <span key={candidate.id} className="fanout-engine">
            {candidate.displayName}
            <input
              aria-label={`${candidate.displayName} 实例数`}
              type="number"
              min={0}
              max={MAX_FANOUT}
              step={1}
              value={counts[candidate.id] ?? 0}
              onChange={(event) => setCounts((current) => ({
                ...current,
                [candidate.id]: Math.max(0, Math.floor(Number(event.target.value) || 0)),
              }))}
            />
          </span>
        ))}
        {total > 0 && (
          <span className={overCap ? "dispatch-err" : "dim"}>
            将创建 {total} 个（上限 {MAX_FANOUT}）{overCap ? "，请减少实例数" : ""}
          </span>
        )}
      </div>
      {err && <div className="dispatch-err">创建失败：{err}（左栏 error 项可 Retry）</div>}
      {creating
        ? <div className="dispatch-busy">◌ 创建中…（fetch worktree → setup → tmux → engine → 投递首条 prompt）</div>
        : <Composer wsId={`dispatch:${projectId ?? "none"}`} onSubmitOverride={submit}
            disabled={overCap}
            placeholder={tr("dispatch.placeholder")} />}
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
