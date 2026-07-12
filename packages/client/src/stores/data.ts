import { create } from "zustand"
import type { Api } from "../api/client"
import type { CoolieEventLike } from "../api/sse"
import type { Project, Workspace, Tab } from "@coolie/protocol"
import type { DiffStat, ChangesReport, EngineInfo } from "./types"

export interface PendingSend { id: number; wsId: string; text: string; mode: string; abort: AbortController }
/** UI 警告面（prompt.delivery.degraded 等 server 侧降级信号 → toast/badge） */
export interface Warning { id: number; code: string; message: string }

interface DataState {
  status: "connecting" | "online" | "offline"
  config: { tmuxSocket: string; engines: EngineInfo[] } | null
  projects: Project[]
  workspaces: Workspace[]
  tabsByWs: Record<string, Tab[]>
  diffstatByWs: Record<string, DiffStat>
  changesByWs: Record<string, ChangesReport>
  pendingSends: PendingSend[]
  warnings: Warning[]
  setApi(api: Api): void
  getApi(): Api | null
  setStatus(s: DataState["status"]): void
  /** 终端会话回收钩子（依赖注入）：App 侧接 terminal/session 的 disposeWorkspaceSessions；node 测试注入 spy。
   *  用注入而非直接 import：session.ts 顶层 import 了 @xterm + xterm.css，直接引会把 DOM/CSS 依赖拖进纯 node store 测试。 */
  setSessionDisposer(fn: (wsId: string) => void): void
  bootstrap(): Promise<void>
  refreshProjects(): Promise<void>
  refreshWorkspaces(): Promise<void>
  refreshTabs(wsId: string): Promise<void>
  refreshDiffstat(wsId: string): Promise<void>
  refreshChanges(wsId: string): Promise<void>
  applyEvent(e: CoolieEventLike): void
  sendInput(wsId: string, req: { text: string; mode: string; skipStable: boolean }): Promise<void>
  cancelSend(id: number): void
  pushWarning(code: string, message: string): void
  dismissWarning(id: number): void
}

let api: Api | null = null
let sendSeq = 0
let warnSeq = 0
let disposeWsSessions: (wsId: string) => void = () => {} // F2：默认 noop，Terminal 模块加载时注册真实回收器
const swallow = (p: Promise<unknown>): void => { void p.catch(() => {}) } // 刷新失败＝下次事件/轮询再试

export const useData = create<DataState>((set, get) => ({
  status: "connecting",
  config: null,
  projects: [], workspaces: [], tabsByWs: {}, diffstatByWs: {}, changesByWs: {},
  pendingSends: [],
  warnings: [],
  setApi: (a) => { api = a },
  getApi: () => api,
  setStatus: (status) => set({ status }),
  setSessionDisposer: (fn) => { disposeWsSessions = fn },
  bootstrap: async () => {
    if (!api) return
    const [config, projects, workspaces] = await Promise.all([
      api.req("GET", "/config"), api.req("GET", "/projects"), api.req("GET", "/workspaces"),
    ])
    set({ config, projects, workspaces })
    for (const w of workspaces as Workspace[])
      if (w.status === "active") { swallow(get().refreshTabs(w.id)); swallow(get().refreshDiffstat(w.id)) }
  },
  refreshProjects: async () => { if (api) set({ projects: await api.req("GET", "/projects") }) },
  refreshWorkspaces: async () => { if (api) set({ workspaces: await api.req("GET", "/workspaces") }) },
  refreshTabs: async (wsId) => {
    if (!api) return
    const tabs = await api.req("GET", `/workspaces/${wsId}/tabs`)
    set((s) => ({ tabsByWs: { ...s.tabsByWs, [wsId]: tabs } }))
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
  applyEvent: (e) => {
    const { refreshWorkspaces, refreshTabs, refreshProjects, refreshDiffstat, pushWarning } = get()
    if (e.type.startsWith("project.")) swallow(refreshProjects())
    else if (e.type.startsWith("workspace.")) {
      swallow(refreshWorkspaces())
      if (e.type === "workspace.archived" || e.type === "workspace.deleted") {
        // F2：归档/删除 = workspace 从列表移除 → 主动回收该 ws 全部终端会话（N×tabs 的 xterm+WS 否则永久泄漏）。
        // engine 本体归 tmux（archive 侧另行 kill-session），这里只断 GUI 侧的活连接。
        if (e.workspaceId) disposeWsSessions(e.workspaceId)
      } else if (e.workspaceId) swallow(refreshTabs(e.workspaceId))
    } else if (e.workspaceId && (e.type.startsWith("tab.") || e.type.startsWith("engine.") || e.type.startsWith("composer."))) {
      swallow(refreshTabs(e.workspaceId))
      if (e.type === "engine.turn.finished") swallow(refreshDiffstat(e.workspaceId)) // turn 结束大概率有新 diff
    } else if (e.type.startsWith("prompt.")) {
      // F5：prompt.* 家族（landed commit eb2932e）——至少把投递降级信号浮到 UI，别静默丢。
      if (e.type === "prompt.delivery.degraded") {
        const p = (e.payload ?? {}) as { code?: string; reason?: string }
        pushWarning(p.code ?? "prompt.delivery.degraded", p.reason ?? "投递降级：prompt 可能未完整送达 engine")
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
        body: JSON.stringify(req),
      })
      if (!r.ok) {
        const j: any = await r.json().catch(() => ({}))
        throw new Error(j.message ?? `input failed ${r.status}`)
      }
    } finally {
      set((s) => ({ pendingSends: s.pendingSends.filter((p) => p.id !== id) }))
    }
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
