import { create } from "zustand"
import type { Api } from "../api/client"
import type { CoolieEventLike } from "../api/sse"
import type { Project, Workspace, Tab, TaskStatus, CustomEngineDefinition, EngineAvailability } from "@coolie/protocol"
import type { DiffStat, ChangesReport, EngineInfo, NamePoolInfo } from "./types"
import { useUi } from "./ui"
import { useAttention } from "./attention"
import { setBadge } from "../chrome/notify"
import {
  applyDispatchEvent,
  progressAt,
  type DispatchProgress,
} from "../composer/dispatchProgress"

export interface PendingSend { id: number; wsId: string; text: string; mode: string; abort: AbortController }
/** UI 警告面（prompt.delivery.degraded 等 server 侧降级信号 → toast/badge） */
export interface Warning { id: number; code: string; message: string }
export interface QueuedPrompt { id: number; tabId: string; text: string; position: number }
export interface ApplyEventOptions { allowAttention?: boolean }

interface DataState {
  status: "connecting" | "online" | "offline"
  config: { tmuxSocket: string; engines: EngineInfo[]; namePools: NamePoolInfo[] } | null
  projects: Project[]
  workspaces: Workspace[]
  tabsByWs: Record<string, Tab[]>
  diffstatByWs: Record<string, DiffStat>
  changesByWs: Record<string, ChangesReport>
  pendingSends: PendingSend[]
  queuedByWs: Record<string, QueuedPrompt[]>
  warnings: Warning[]
  dispatchProgressByWs: Record<string, DispatchProgress>
  seedDispatchProgress(wsId: string): void
  setApi(api: Api): void
  getApi(): Api | null
  setStatus(s: DataState["status"]): void
  /** 终端会话回收钩子（依赖注入）：App 侧接 terminal/session 的 disposeWorkspaceSessions；node 测试注入 spy。
   *  用注入而非直接 import：session.ts 顶层 import 了 @xterm + xterm.css，直接引会把 DOM/CSS 依赖拖进纯 node store 测试。 */
  setSessionDisposer(fn: (wsId: string) => void): void
  setTabSessionDisposer(fn: (wsId: string, tabId: string) => void): void
  bootstrap(): Promise<void>
  refreshConfig(): Promise<void>
  refreshProjects(): Promise<void>
  refreshWorkspaces(): Promise<void>
  refreshTabs(wsId: string): Promise<void>
  refreshDiffstat(wsId: string): Promise<void>
  refreshChanges(wsId: string): Promise<void>
  refreshQueue(wsId: string): Promise<void>
  withdrawQueued(wsId: string, id: number): Promise<void>
  applyEvent(e: CoolieEventLike, options?: ApplyEventOptions): void
  sendInput(wsId: string, req: { text: string; mode: string; skipStable: boolean }): Promise<void>
  /** 生命周期动作（D2）：包已有 REST 端点。列表由 workspace.* SSE 事件重拉，故这里不手动刷新。
   *  archive 脏树会被 server 409 拒（force=false）；调用方据此弹确认再以 force=true 重试。 */
  archiveWs(wsId: string, force?: boolean): Promise<void>
  unarchiveWs(wsId: string): Promise<void>
  setPinnedWs(wsId: string, pinned: boolean): Promise<void>
  renameWs(wsId: string, name: string): Promise<void>
  setTaskStatusWs(wsId: string, status: TaskStatus): Promise<void>
  renameBranchWs(wsId: string, branch: string): Promise<void>
  reorderWs(projectId: string, workspaceIds: readonly string[]): Promise<void>
  deleteWs(wsId: string, force?: boolean): Promise<void>
  saveCustomEngine(definition: CustomEngineDefinition): Promise<void>
  deleteCustomEngine(id: string): Promise<void>
  applyCopilotPreset(id?: string): Promise<void>
  detectCustomEngine(id: string): Promise<EngineAvailability>
  switchEngine(wsId: string, engineId: string, model?: string, effort?: string): Promise<void>
  toggleZen(wsId: string, tabId?: string): Promise<void>
  cancelSend(id: number): void
  pushWarning(code: string, message: string): void
  dismissWarning(id: number): void
}

let api: Api | null = null
let sendSeq = 0
let warnSeq = 0
let disposeWsSessions: (wsId: string) => void = () => {} // F2：默认 noop，Terminal 模块加载时注册真实回收器
let disposeTabTermSession: (wsId: string, tabId: string) => void = () => {}
const swallow = (p: Promise<unknown>): void => { void p.catch(() => {}) } // 刷新失败＝下次事件/轮询再试

/** A selected non-engine tab still leaves the workspace composer targeting its primary engine chat. */
export const resolveSelectedEngineTabId = (
  tabs: readonly Tab[] | undefined,
  selectedId: string | undefined,
): string | undefined => {
  const selected = tabs?.find((tab) => tab.id === selectedId)
  if (selected?.kind === "engine") return selected.id
  return tabs?.find((tab) => tab.kind === "engine")?.id ?? (tabs === undefined ? selectedId : undefined)
}

export const useData = create<DataState>((set, get) => ({
  status: "connecting",
  config: null,
  projects: [], workspaces: [], tabsByWs: {}, diffstatByWs: {}, changesByWs: {},
  pendingSends: [],
  queuedByWs: {},
  warnings: [],
  dispatchProgressByWs: {},
  seedDispatchProgress: (wsId) => set((state) => ({
    dispatchProgressByWs: {
      ...state.dispatchProgressByWs,
      [wsId]: progressAt(wsId, "environment"),
    },
  })),
  setApi: (a) => { api = a },
  getApi: () => api,
  setStatus: (status) => set({ status }),
  setSessionDisposer: (fn) => { disposeWsSessions = fn },
  setTabSessionDisposer: (fn) => { disposeTabTermSession = fn },
  bootstrap: async () => {
    if (!api) return
    const [snapshot, config, projects, workspaces] = await Promise.all([
      api.req("GET", "/state"),
      api.req("GET", "/config"),
      api.req("GET", "/projects"),
      api.req("GET", "/workspaces"),
    ])
    useAttention.getState().loadSnapshot(snapshot.openAttention ?? [])
    set({ config, projects, workspaces })
    for (const w of workspaces as Workspace[])
      if (w.status === "active") { swallow(get().refreshTabs(w.id)); swallow(get().refreshDiffstat(w.id)) }
  },
  refreshConfig: async () => { if (api) set({ config: await api.req("GET", "/config") }) },
  refreshProjects: async () => { if (api) set({ projects: await api.req("GET", "/projects") }) },
  refreshWorkspaces: async () => { if (api) set({ workspaces: await api.req("GET", "/workspaces") }) },
  refreshTabs: async (wsId) => {
    if (!api) return
    const tabs = await api.req("GET", `/workspaces/${wsId}/tabs`) as Tab[]
    set((s) => ({ tabsByWs: { ...s.tabsByWs, [wsId]: tabs } }))
    const selected = useUi.getState().selectedTabByWs[wsId]
    if (!tabs.some((tab) => tab.id === selected)) {
      const fallback = tabs.find((tab) => tab.kind === "engine") ?? tabs[0]
      if (fallback) useUi.getState().selectTab(wsId, fallback.id)
    }
  },
  refreshDiffstat: async (wsId) => {
    if (!api) return
    try {
      const d = await api.req("GET", `/workspaces/${wsId}/git/diffstat`)
      set((s) => ({ diffstatByWs: { ...s.diffstatByWs, [wsId]: d } }))
    } catch { /* 非 active（刚归档）等：保留旧值 */ }
  },
  refreshChanges: async (wsId) => {
    if (!api) return
    const c = await api.req("GET", `/workspaces/${wsId}/git/changes`)
    set((s) => ({ changesByWs: { ...s.changesByWs, [wsId]: c } }))
  },
  refreshQueue: async (wsId) => {
    if (!api) return
    try {
      const selectedTab = resolveSelectedEngineTabId(get().tabsByWs[wsId], useUi.getState().selectedTabByWs[wsId])
      const response = await api.req("GET", `/workspaces/${wsId}/queue${selectedTab ? `?tabId=${encodeURIComponent(selectedTab)}` : ""}`)
      set((state) => ({ queuedByWs: { ...state.queuedByWs, [wsId]: response.queue } }))
    } catch { /* transient/non-active workspace: retain last known queue until the next event */ }
  },
  withdrawQueued: async (wsId, id) => {
    if (!api) return
    try { await api.req("DELETE", `/workspaces/${wsId}/queue/${id}`) } catch { /* drain may have won the race */ }
    await get().refreshQueue(wsId)
  },
  applyEvent: (e, options = {}) => {
    const { refreshWorkspaces, refreshTabs, refreshProjects, refreshDiffstat, refreshQueue, pushWarning } = get()
    const mapped = applyDispatchEvent(null, e)
    if (mapped && e.workspaceId) {
      set((state) => {
        const prev = state.dispatchProgressByWs[e.workspaceId!] ?? null
        const next = applyDispatchEvent(prev, e)
        if (!next) return state
        const dispatchProgressByWs = { ...state.dispatchProgressByWs, [e.workspaceId!]: next }
        if (next.current === "active" && !next.failure) {
          const { [e.workspaceId!]: _done, ...rest } = dispatchProgressByWs
          return { dispatchProgressByWs: rest }
        }
        return { dispatchProgressByWs }
      })
    }
    if (e.type.startsWith("project.")) swallow(refreshProjects())
    else if (e.type.startsWith("workspace.")) {
      swallow(refreshWorkspaces())
      if (e.type === "workspace.archived" || e.type === "workspace.deleted") {
        // F2：归档/删除 = workspace 从列表移除 → 主动回收该 ws 全部终端会话（N×tabs 的 xterm+WS 否则永久泄漏）。
        // engine 本体归 tmux（archive 侧另行 kill-session），这里只断 GUI 侧的活连接。
        if (e.workspaceId) {
          disposeWsSessions(e.workspaceId)
          useAttention.getState().purgeWorkspace(e.workspaceId)
          setBadge(useAttention.getState().count())
          set((state) => {
            const { [e.workspaceId!]: _removed, ...dispatchProgressByWs } = state.dispatchProgressByWs
            return { dispatchProgressByWs }
          })
        }
        // 删除时若删的正是当前选中 ws，清掉悬空选中态（归档仍留在列表可选，故只对 deleted 清）
        if (e.type === "workspace.deleted" && e.workspaceId) useUi.getState().clearWsIfSelected(e.workspaceId)
      } else if (e.workspaceId) swallow(refreshTabs(e.workspaceId))
    } else if (e.workspaceId && (e.type.startsWith("tab.") || e.type.startsWith("engine.") || e.type.startsWith("composer."))) {
      if (e.type === "tab.closed") {
        const tabId = (e.payload as { tabId?: unknown } | null)?.tabId
        if (typeof tabId === "string") disposeTabTermSession(e.workspaceId, tabId)
      }
      swallow(refreshTabs(e.workspaceId))
      if (e.type === "engine.turn.finished") swallow(refreshDiffstat(e.workspaceId)) // turn 结束大概率有新 diff
      if (options.allowAttention !== false &&
          e.type === "tab.status.changed" &&
          (e.payload as { status?: unknown } | null)?.status === "awaiting-input" &&
          e.workspaceId && api) {
        void useAttention.getState().syncWorkspace(api, e.workspaceId, { notify: true })
      }
    } else if (e.type === "attention.acknowledged") {
      const id = (e.payload as { id?: unknown } | null)?.id
      if (typeof id === "string") {
        useAttention.getState().remove(id)
        setBadge(useAttention.getState().count())
      }
    } else if (e.type.startsWith("prompt.")) {
      // F5：prompt.* 家族（landed commit eb2932e）——至少把投递降级信号浮到 UI，别静默丢。
      if (e.type === "prompt.delivery.degraded") {
        const p = (e.payload ?? {}) as { code?: string; reason?: string }
        pushWarning(p.code ?? "prompt.delivery.degraded", p.reason ?? "投递降级：prompt 可能未完整送达 engine")
      } else if (e.workspaceId && ["prompt.queued", "prompt.delivered", "prompt.withdrawn"].includes(e.type)) {
        swallow(refreshQueue(e.workspaceId))
      }
    }
  },
  sendInput: async (wsId, req) => {
    if (!api) throw new Error("api 未就绪")
    const id = ++sendSeq
    const abort = new AbortController()
    set((s) => ({ pendingSends: [...s.pendingSends, { id, wsId, text: req.text, mode: req.mode, abort }] }))
    try {
      // 不走 api.req：要挂 AbortSignal 支持排队撤回（POST /input 在稳定检测期间可长达数秒）
      const r = await fetch(`http://127.0.0.1:${api.info.port}/workspaces/${wsId}/input`, {
        method: "POST", signal: abort.signal,
        headers: { Authorization: `Bearer ${api.info.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...req,
          tabId: resolveSelectedEngineTabId(get().tabsByWs[wsId], useUi.getState().selectedTabByWs[wsId]),
        }),
      })
      if (!r.ok) {
        const j: any = await r.json().catch(() => ({}))
        throw new Error(j.message ?? `input failed ${r.status}`)
      }
      // 202 is a successful durable enqueue. prompt.queued SSE is the sole queue-state refresh path.
    } finally {
      set((s) => ({ pendingSends: s.pendingSends.filter((p) => p.id !== id) }))
    }
  },
  archiveWs: async (wsId, force = false) => { if (api) await api.req("POST", `/workspaces/${wsId}/archive`, { force }) },
  unarchiveWs: async (wsId) => { if (api) await api.req("POST", `/workspaces/${wsId}/unarchive`, {}) },
  setPinnedWs: async (wsId, pinned) => {
    if (!api) throw new Error("api 未就绪")
    await api.req("POST", `/workspaces/${wsId}/pin`, { pinned })
  },
  renameWs: async (wsId, name) => {
    if (!api) throw new Error("api 未就绪")
    await api.req("POST", `/workspaces/${wsId}/rename`, { name })
  },
  setTaskStatusWs: async (wsId, status) => {
    if (!api) throw new Error("api 未就绪")
    await api.req("POST", `/workspaces/${wsId}/task-status`, { status })
  },
  renameBranchWs: async (wsId, branch) => {
    if (!api) throw new Error("api 未就绪")
    await api.req("POST", `/workspaces/${wsId}/branch`, { branch })
  },
  reorderWs: async (projectId, workspaceIds) => {
    if (!api) throw new Error("api 未就绪")
    await api.req("POST", "/workspaces/reorder", { projectId, workspaceIds: [...workspaceIds] })
  },
  deleteWs: async (wsId, force = true) => { if (api) await api.req("DELETE", `/workspaces/${wsId}${force ? "?force=1" : ""}`) },
  saveCustomEngine: async (definition) => {
    if (!api) throw new Error("api 未就绪")
    await api.req("POST", "/engines/custom", definition)
    await get().refreshConfig()
  },
  deleteCustomEngine: async (id) => {
    if (!api) throw new Error("api 未就绪")
    await api.req("DELETE", `/engines/custom/${encodeURIComponent(id)}`)
    await get().refreshConfig()
  },
  applyCopilotPreset: async (id = "copilot") => {
    if (!api) throw new Error("api 未就绪")
    await api.req("POST", "/engines/custom/presets/copilot", { id })
    await get().refreshConfig()
  },
  detectCustomEngine: async (id) => {
    if (!api) throw new Error("api 未就绪")
    return api.req("POST", `/engines/custom/${encodeURIComponent(id)}/detect`, {})
  },
  switchEngine: async (wsId, engineId, model, effort) => {
    if (!api) throw new Error("api 未就绪")
    await api.req("POST", `/workspaces/${wsId}/engine`, {
      engineId,
      tabId: resolveSelectedEngineTabId(get().tabsByWs[wsId], useUi.getState().selectedTabByWs[wsId]),
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    })
    await get().refreshTabs(wsId)
  },
  toggleZen: async (wsId, tabId) => {
    if (!api) throw new Error("api 未就绪")
    const workspace = get().workspaces.find((item) => item.id === wsId)
    await api.req("POST", `/workspaces/${wsId}/zen`, {
      zen: !(workspace?.zenMode ?? false),
      ...(tabId ? { tabId } : {}),
    })
    await get().refreshWorkspaces()
  },
  cancelSend: (id) => {
    const p = get().pendingSends.find((x) => x.id === id)
    p?.abort.abort()
    set((s) => ({ pendingSends: s.pendingSends.filter((x) => x.id !== id) }))
  },
  pushWarning: (code, message) => {
    const id = ++warnSeq
    set((s) => ({ warnings: [...s.warnings, { id, code, message }] }))
    setTimeout(() => get().dismissWarning(id), 8000) // 自动淡出；用户也可手动 ×
  },
  dismissWarning: (id) => set((s) => ({ warnings: s.warnings.filter((w) => w.id !== id) })),
}))
