import { useEffect, useRef, useState } from "react"
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

export const resolveDispatchDefaults = (
  engines: readonly EngineInfo[],
  preferences: { defaultEngine: string; defaultModel: string },
): { engineId: string; model: string } => {
  const usable = (candidate: EngineInfo): boolean =>
    candidate.enabled !== false && candidate.availability?.available !== false
  const engine = engines.find((candidate) => candidate.id === preferences.defaultEngine && usable(candidate))
    ?? engines.find(usable)
    ?? engines[0]
  return {
    engineId: engine?.id ?? preferences.defaultEngine ?? "",
    model: engine && preferences.defaultModel && engine.models.includes(preferences.defaultModel)
      ? preferences.defaultModel
      : "default",
  }
}

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
  // Default outside the selector: a fresh [] inside the selector makes useSyncExternalStore
  // loop forever (Maximum update depth) — keep the selector returning a stable reference.
  const engines = useData((s) => s.config?.engines) ?? []
  const projectId = useUi((s) => s.dispatchProjectId) ?? projects[0]?.id ?? null
  const preferences = useSettings((state) => state.preferences)
  const initialDefaults = resolveDispatchDefaults(engines, preferences)
  const initializedDefaults = useRef(engines.length > 0)
  const [engineId, setEngineId] = useState(initialDefaults.engineId)
  const engine = engines.find((candidate) => candidate.id === engineId) ?? engines[0]
  const [model, setModel] = useState(initialDefaults.model)
  const [effort, setEffort] = useState("default")
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const total = fanoutTotal(counts)
  const overCap = total > MAX_FANOUT
  const effortOptions = model === "default"
    ? engine?.efforts
    : engine?.modelEfforts?.[model] ?? engine?.efforts
  const namePool = useSettings((state) => state.namePool)
  const customNames = useSettings((state) => state.customNames)

  useEffect(() => {
    setEngineId((current) => {
      const currentEngine = engines.find((candidate) => candidate.id === current)
      const currentUsable = currentEngine &&
        currentEngine.enabled !== false && currentEngine.availability?.available !== false
      if (initializedDefaults.current && currentUsable) return current
      const next = resolveDispatchDefaults(engines, preferences)
      initializedDefaults.current = engines.length > 0
      setModel(next.model)
      setEffort("default")
      return next.engineId
    })
  }, [engines, preferences.defaultEngine, preferences.defaultModel])

  useEffect(() => {
    if (!engine) return
    if (model !== "default" && !engine.models.includes(model)) setModel("default")
    if (!engine.capabilities.effort) setEffort("default")
  }, [engine, model])

  const submit = (prompt: string): void => {
    const api = useData.getState().getApi()
    if (!api || !projectId || !engine || creating) return
    if (overCap) {
      setErr(tr("dispatch.overCap").replace("{total}", String(total)).replace("{max}", String(MAX_FANOUT)))
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
            async (body) => {
              const workspace = await api.req("POST", "/workspaces", body)
              await api.req("POST", `/workspaces/${workspace.id}/ensure`, {})
              return workspace
            },
          )
          const first = results.find((result) => result.ok)
          if (first?.ok) useUi.getState().selectWs(first.workspaceId)
          const failures = results.filter((result): result is Extract<FanoutCreateResult, { ok: false }> => !result.ok)
          if (failures.length > 0)
            setErr(tr("dispatch.partialFailure")
              .replace("{failed}", String(failures.length))
              .replace("{total}", String(results.length))
              .replace("{errors}", failures.map((result) => `${result.engineId}: ${result.error}`).join("; ")))
          return
        }
        // Intent creation is cheap; ensure performs the first materialization and prompt delivery.
        const ws = await api.req("POST", "/workspaces", buildCreateBody({
          projectId,
          engineId: engine.id,
          prompt,
          model,
          effort,
          namePool,
          customNames,
        }))
        await api.req("POST", `/workspaces/${ws.id}/ensure`, {})
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
            <select value={model} onChange={(e) => { setModel(e.target.value); setEffort("default") }}>
              <option value="default">{tr("dispatch.default")}</option>
              {engine.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </>
        )}
        {engine?.capabilities.effort && effortOptions && effortOptions.length > 0 && (
          <>
            <label>{tr("dispatch.effort")}</label>
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="default">{tr("dispatch.default")}</option>
              {effortOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </>
        )}
      </div>
      <div className="dispatch-fanout">
        <label>{tr("dispatch.fanout")}</label>
        {engines.map((candidate) => (
          <span key={candidate.id} className="fanout-engine">
            {candidate.displayName}
            <input
              aria-label={tr("dispatch.instanceCount").replace("{engine}", candidate.displayName)}
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
            {tr("dispatch.total").replace("{total}", String(total)).replace("{max}", String(MAX_FANOUT))}
            {overCap ? tr("dispatch.reduce") : ""}
          </span>
        )}
      </div>
      {err && <div className="dispatch-err">{tr("dispatch.createFailed").replace("{error}", err)}</div>}
      {creating
        ? <div className="dispatch-busy">◌ {tr("dispatch.creating")}</div>
        : <Composer wsId={`dispatch:${projectId ?? "none"}`} onSubmitOverride={submit}
            disabled={overCap}
            placeholder={tr("dispatch.placeholder")} />}
    </div>
  )
}

/** error workspace 的动作条（spec §四：error 可重试；半成品已自动回滚） */
export const ErrorActions = ({ wsId }: { wsId: string }) => {
  const tr = useT()
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<unknown>): void => {
    setBusy(true)
    void fn().catch((e: any) => useData.getState().pushWarning("workspace.lifecycle", e?.message ?? String(e)))
      .finally(() => setBusy(false))
  }
  const api = () => useData.getState().getApi()!
  return (
    <div className="error-actions">
      <span className="b-error">! {tr("dispatch.errorRolledBack")}</span>
      <button className="btn" disabled={busy} onClick={() => act(() => api().req("POST", `/workspaces/${wsId}/retry`, {}))}>{tr("dispatch.retry")}</button>
      <button disabled={busy} onClick={() => act(() => api().req("DELETE", `/workspaces/${wsId}?force=1`))}>{tr("dispatch.deleteRecord")}</button>
    </div>
  )
}
