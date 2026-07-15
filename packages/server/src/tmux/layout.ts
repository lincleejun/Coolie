import { Effect } from "effect"
import { tmuxSessionName, type Tab, type TabKind } from "@coolie/protocol"
import type { TabsRepoShape } from "../repo/tabs.js"
import type { WorkspacesRepoShape } from "../repo/workspaces.js"
import type { TmuxPaneInfo, TmuxServiceShape, TmuxWindowInfo } from "./service.js"
import type { TmuxError } from "./service.js"
import type { NotFoundError } from "../repo/errors.js"

export const TMUX_ROLES = ["tasks", "engine", "ops", "shell"] as const
export type TmuxRole = typeof TMUX_ROLES[number]
/** Conservative default: one-pane ChatTab windows remain unchanged; split windows tile predictably. */
export const DEFAULT_TMUX_LAYOUT = "tiled"

export interface PersistedGeometry {
  readonly window: number
  readonly layout: string
  readonly cols: number
  readonly rows: number
}

export interface WorkspaceLayoutState {
  readonly version: 1
  readonly zen: boolean
  readonly focusedTabId: string | null
  readonly restoreTabId: string | null
  readonly geometry: readonly PersistedGeometry[]
}

export const DEFAULT_LAYOUT_STATE: WorkspaceLayoutState = {
  version: 1,
  zen: false,
  focusedTabId: null,
  restoreTabId: null,
  geometry: [],
}

export interface LayoutObservation {
  readonly workspaceId: string
  readonly session: string
  readonly windows: readonly TmuxWindowInfo[]
  readonly panes: readonly TmuxPaneInfo[]
}

export interface RoleAssignment {
  readonly window: number
  readonly role: TmuxRole
  readonly workspaceId: string
  readonly tabId: string | null
}

export interface LayoutDecision {
  readonly assignments: readonly RoleAssignment[]
  readonly selectWindow: number | null
  readonly restoreGeometry: readonly PersistedGeometry[]
}

export interface ReverseTaskLookup {
  readonly workspaceId: string
  readonly tabId: string | null
  readonly role: TmuxRole | null
}

const isRole = (value: string | null): value is TmuxRole =>
  value !== null && (TMUX_ROLES as readonly string[]).includes(value)

export const roleForTabKind = (kind: TabKind): TmuxRole =>
  kind === "engine" ? "engine" : kind === "shell" ? "shell" : "ops"

const inferredRole = (name: string): TmuxRole =>
  name === "engine" ? "engine" : name === "setup" ? "ops" : "shell"

export const decideLayout = (
  observation: LayoutObservation,
  tabs: readonly Tab[],
  state: WorkspaceLayoutState,
): LayoutDecision => {
  const byWindow = new Map(tabs.flatMap((tab) => tab.tmuxWindow === null ? [] : [[tab.tmuxWindow, tab] as const]))
  const assignments = observation.windows.flatMap((window) => {
    const tab = byWindow.get(window.index)
    const expected: RoleAssignment = {
      window: window.index,
      role: tab ? roleForTabKind(tab.kind) : inferredRole(window.name),
      workspaceId: observation.workspaceId,
      tabId: tab?.id ?? null,
    }
    return window.role === expected.role &&
      window.workspaceId === expected.workspaceId &&
      window.tabId === expected.tabId ? [] : [expected]
  })
  const focused = state.focusedTabId === null ? null : tabs.find((tab) => tab.id === state.focusedTabId)
  const fallbackEngine = tabs.find((tab) => tab.kind === "engine" && tab.tmuxWindow !== null)
  const selectWindow = state.zen ? (focused?.tmuxWindow ?? fallbackEngine?.tmuxWindow ?? null) : null
  return {
    assignments,
    selectWindow,
    restoreGeometry: state.zen ? [] : state.geometry,
  }
}

export const observeLayout = (
  tmux: TmuxServiceShape,
  workspaceId: string,
): Effect.Effect<LayoutObservation, import("./service.js").TmuxError> => {
  const session = tmuxSessionName(workspaceId)
  return Effect.all({
    windows: tmux.listWindows(session),
    panes: tmux.listPanes(session),
  }).pipe(Effect.map(({ windows, panes }) => ({ workspaceId, session, windows, panes })))
}

export const labelTmuxWindow = (
  tmux: TmuxServiceShape,
  session: string,
  window: number,
  metadata: { readonly role: TmuxRole; readonly workspaceId: string; readonly tabId: string | null },
): Effect.Effect<void, import("./service.js").TmuxError> => {
  const target = `${session}:${window}`
  return Effect.gen(function* () {
    yield* tmux.setWindowOption(target, "@role", metadata.role)
    yield* tmux.setWindowOption(target, "@workspace_id", metadata.workspaceId)
    yield* tmux.setWindowOption(target, "@task_id", metadata.workspaceId)
    yield* tmux.setWindowOption(target, "@tab_id", metadata.tabId)
    for (const pane of yield* tmux.listPanes(session)) {
      if (pane.window !== window) continue
      yield* tmux.setPaneOption(pane.id, "@role", metadata.role).pipe(Effect.ignore)
      yield* tmux.setPaneOption(pane.id, "@workspace_id", metadata.workspaceId).pipe(Effect.ignore)
      yield* tmux.setPaneOption(pane.id, "@task_id", metadata.workspaceId).pipe(Effect.ignore)
      yield* tmux.setPaneOption(pane.id, "@tab_id", metadata.tabId).pipe(Effect.ignore)
    }
  })
}

export const applyLayoutDecision = (
  tmux: TmuxServiceShape,
  observation: LayoutObservation,
  decision: LayoutDecision,
): Effect.Effect<void, import("./service.js").TmuxError> =>
  Effect.gen(function* () {
    for (const assignment of decision.assignments) {
      yield* labelTmuxWindow(tmux, observation.session, assignment.window, assignment)
    }
    for (const geometry of decision.restoreGeometry) {
      const target = `${observation.session}:${geometry.window}`
      if (observation.windows.some((window) => window.index === geometry.window)) {
        yield* tmux.selectLayout(target, geometry.layout).pipe(Effect.ignore)
        yield* tmux.resizeWindow(target, geometry.cols, geometry.rows).pipe(Effect.ignore)
      }
    }
    if (decision.selectWindow !== null) yield* tmux.selectWindow(observation.session, decision.selectWindow)
  })

export interface TmuxLayoutShape {
  readonly reconcile: (workspaceId: string) => Effect.Effect<WorkspaceLayoutState, NotFoundError | TmuxError>
  readonly setZen: (workspaceId: string, zen: boolean, focusedTabId?: string | null) => Effect.Effect<WorkspaceLayoutState, NotFoundError | TmuxError>
  readonly reverseLookup: (target: string) => Effect.Effect<ReverseTaskLookup | null, TmuxError>
}

export const makeTmuxLayout = (
  tmux: TmuxServiceShape,
  workspaces: WorkspacesRepoShape,
  tabs: TabsRepoShape,
): TmuxLayoutShape => {
  const reconcile: TmuxLayoutShape["reconcile"] = (workspaceId) =>
    Effect.gen(function* () {
      const state = yield* workspaces.getLayoutState(workspaceId)
      if (!(yield* tmux.hasSession(tmuxSessionName(workspaceId)))) return state
      const observation = yield* observeLayout(tmux, workspaceId)
      const rows = yield* tabs.listByWorkspace(workspaceId)
      yield* applyLayoutDecision(tmux, observation, decideLayout(observation, rows, state))
      return state
    })
  return {
    reconcile,
    setZen: (workspaceId, zen, focusedTabId = null) =>
      Effect.gen(function* () {
        const current = yield* workspaces.getLayoutState(workspaceId)
        const rows = yield* tabs.listByWorkspace(workspaceId)
        const observation = (yield* tmux.hasSession(tmuxSessionName(workspaceId)))
          ? yield* observeLayout(tmux, workspaceId)
          : null
        const active = observation?.windows.find((window) => window.active)
        const activeTab = active ? rows.find((tab) => tab.tmuxWindow === active.index) : null
        const next: WorkspaceLayoutState = zen
          ? {
              version: 1, zen: true,
              focusedTabId: focusedTabId ?? rows.find((tab) => tab.kind === "engine")?.id ?? null,
              restoreTabId: activeTab?.id ?? current.restoreTabId,
              geometry: observation?.windows.flatMap((window) =>
                window.layout !== null && window.width !== null && window.height !== null
                  ? [{ window: window.index, layout: window.layout, cols: window.width, rows: window.height }]
                  : []) ?? current.geometry,
            }
          : { ...current, zen: false, focusedTabId: null }
        yield* workspaces.setLayoutState(workspaceId, next)
        if (observation !== null) {
          const decision = decideLayout(observation, rows, next)
          yield* applyLayoutDecision(tmux, observation, {
            ...decision,
            selectWindow: zen
              ? decision.selectWindow
              : rows.find((tab) => tab.id === next.restoreTabId)?.tmuxWindow ?? null,
          })
        }
        return next
      }),
    reverseLookup: (target) => tmux.targetMetadata(target).pipe(
      Effect.map((metadata) => metadata.workspaceId === null ? null : ({
        workspaceId: metadata.workspaceId,
        tabId: metadata.tabId,
        role: isRole(metadata.role) ? metadata.role : null,
      })),
    ),
  }
}
