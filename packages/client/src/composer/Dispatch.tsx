import { useEffect, useRef, useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { Composer } from "./Composer"
import { makeDrafts, type DraftStorage } from "./drafts"
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
  baseBranch: string
  engineId: string
  prompt: string
  model: string
  effort: string
  namePool?: string
  customNames?: readonly string[]
}

export const buildCreateBody = (i: CreateBodyInput): Record<string, unknown> => ({
  projectId: i.projectId,
  baseBranch: i.baseBranch,
  engineId: i.engineId,
  initialPrompt: i.prompt,
  ...(i.model !== "default" ? { model: i.model } : {}),
  ...(i.effort !== "default" ? { effort: i.effort } : {}),
  ...(i.namePool ? { namePool: i.namePool } : {}),
  ...(i.namePool === "custom" ? { customNames: [...(i.customNames ?? [])] } : {}),
})

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

export const DispatchPanel = () => {
  const tr = useT()
  const projects = useData((s) => s.projects)
  // Default outside the selector: a fresh [] inside the selector makes useSyncExternalStore
  // loop forever (Maximum update depth) — keep the selector returning a stable reference.
  const engines = useData((s) => s.config?.engines) ?? []
  const projectId = useUi((s) => s.dispatchProjectId) ?? projects[0]?.id ?? null
  const project = projects.find((candidate) => candidate.id === projectId)
  const preferences = useSettings((state) => state.preferences)
  const initialDefaults = resolveDispatchDefaults(engines, preferences)
  const initializedDefaults = useRef(engines.length > 0)
  const [engineId, setEngineId] = useState(initialDefaults.engineId)
  const engine = engines.find((candidate) => candidate.id === engineId) ?? engines[0]
  const [model, setModel] = useState(initialDefaults.model)
  const [baseBranch, setBaseBranch] = useState(project?.defaultBaseBranch ?? "")
  const [branches, setBranches] = useState<string[]>(
    project?.defaultBaseBranch ? [project.defaultBaseBranch] : [],
  )
  const [branchLoad, setBranchLoad] = useState<"loading" | "ready" | "error">("loading")
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
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
      return next.engineId
    })
  }, [engines, preferences.defaultEngine, preferences.defaultModel])

  useEffect(() => {
    if (!engine) return
    if (model !== "default" && !engine.models.includes(model)) setModel("default")
  }, [engine, model])

  useEffect(() => {
    const fallback = project?.defaultBaseBranch ?? ""
    setBaseBranch(fallback)
    setBranches(fallback ? [fallback] : [])
    setBranchLoad("loading")
    const api = useData.getState().getApi()
    if (!api || !projectId) {
      setBranchLoad("error")
      return
    }
    let active = true
    void api.req("GET", `/projects/${projectId}/branches`).then((response) => {
      if (!active) return
      const listed = Array.isArray(response?.branches)
        ? response.branches.filter((branch: unknown): branch is string => typeof branch === "string")
        : []
      const next = [...new Set([fallback, ...listed].filter(Boolean))]
      setBranches(next)
      setBaseBranch((current) => next.includes(current) ? current : fallback)
      setBranchLoad("ready")
    }).catch(() => {
      if (active) setBranchLoad("error")
    })
    return () => { active = false }
  }, [projectId, project?.defaultBaseBranch])

  const submit = (prompt: string): void => {
    const api = useData.getState().getApi()
    if (!api || !projectId || !baseBranch || !engine || creating) return
    setCreating(true); setErr(null)
    void (async () => {
      try {
        // Intent creation is cheap; ensure performs the first materialization and prompt delivery.
        const ws = await api.req("POST", "/workspaces", buildCreateBody({
          projectId,
          baseBranch,
          engineId: engine.id,
          prompt,
          model,
          effort: "default",
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
        <label>{tr("dispatch.branch")}</label>
        <input
          className="dispatch-branch"
          list="dispatch-branches"
          value={baseBranch}
          onChange={(event) => setBaseBranch(event.target.value)}
          placeholder={tr("dispatch.branchSearch")}
        />
        <datalist id="dispatch-branches">
          {branches.map((branch) => <option key={branch} value={branch} />)}
        </datalist>
        <span className={branchLoad === "error" ? "dispatch-err" : "dim"}>
          {branchLoad === "loading"
            ? tr("dispatch.branchLoading")
            : branchLoad === "error"
              ? tr("dispatch.branchLoadFailed")
              : tr("dispatch.branchCount").replace("{count}", String(branches.length))}
        </span>
        <label>{tr("dispatch.engine")}</label>
        <select value={engine?.id ?? ""} onChange={(event) => {
          setEngineId(event.target.value)
          setModel("default")
        }}>
          {engines.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>
          ))}
        </select>
        <label>{tr("dispatch.model")}</label>
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="default">{tr("dispatch.default")}</option>
          {engine?.models.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </div>
      {err && <div className="dispatch-err">{tr("dispatch.createFailed").replace("{error}", err)}</div>}
      {creating
        ? <div className="dispatch-busy">◌ {tr("dispatch.creating")}</div>
        : <Composer wsId={`dispatch:${projectId ?? "none"}`} onSubmitOverride={submit}
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
