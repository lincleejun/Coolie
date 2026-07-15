import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { Tab } from "@coolie/protocol"
import { DEFAULT_LAYOUT_STATE, decideLayout, makeTmuxLayout, roleForTabKind } from "../src/tmux/layout.js"
import type { LayoutObservation, WorkspaceLayoutState } from "../src/tmux/layout.js"
import type { TmuxServiceShape } from "../src/tmux/service.js"
import type { WorkspacesRepoShape } from "../src/repo/workspaces.js"
import type { TabsRepoShape } from "../src/repo/tabs.js"

const observation = (windows: LayoutObservation["windows"]): LayoutObservation => ({
  workspaceId: "w1",
  session: "coolie-w1",
  windows,
  panes: [],
})

const window = (index: number, name: string, role: string | null = null, tabId: string | null = null) => ({
  index, name, role, workspaceId: role ? "w1" : null, tabId,
  layout: `layout-${index}`, width: 120, height: 30, active: index === 0,
})

const tab = (id: string, kind: Tab["kind"], tmuxWindow: number): Tab => ({
  id, workspaceId: "w1", kind, tmuxWindow, engineId: kind === "engine" ? "claude" : null,
  engineSessionId: null, title: null, status: "idle", lastHookAt: null,
}) as Tab

describe("tmux layout decisions", () => {
  it("maps tab kinds to stable Kobe roles", () => {
    expect(roleForTabKind("engine")).toBe("engine")
    expect(roleForTabKind("setup")).toBe("ops")
    expect(roleForTabKind("run")).toBe("ops")
    expect(roleForTabKind("shell")).toBe("shell")
  })

  it("labels missing metadata without closing unknown user windows", () => {
    const plan = decideLayout(
      observation([window(0, "engine"), window(1, "shell"), window(7, "notes")]),
      [tab("t0", "engine", 0), tab("t1", "shell", 1)],
      DEFAULT_LAYOUT_STATE,
    )
    expect(plan.assignments).toEqual([
      { window: 0, role: "engine", workspaceId: "w1", tabId: "t0" },
      { window: 1, role: "shell", workspaceId: "w1", tabId: "t1" },
      { window: 7, role: "shell", workspaceId: "w1", tabId: null },
    ])
    expect(plan.selectWindow).toBeNull()
  })

  it("zen selects the requested engine and suppresses geometry restore", () => {
    const plan = decideLayout(
      observation([window(0, "engine", "engine", "t0"), window(2, "engine", "engine", "t2")]),
      [tab("t0", "engine", 0), tab("t2", "engine", 2)],
      { ...DEFAULT_LAYOUT_STATE, zen: true, focusedTabId: "t2", geometry: [{ window: 0, layout: "old", cols: 90, rows: 24 }] },
    )
    expect(plan.selectWindow).toBe(2)
    expect(plan.restoreGeometry).toEqual([])
    expect(plan.assignments).toEqual([])
  })

  it("persists zen focus then restores saved geometry and prior tab", async () => {
    let state: WorkspaceLayoutState = DEFAULT_LAYOUT_STATE
    const selected: number[] = []
    const restored: string[] = []
    const windows = [
      { ...window(0, "engine", "engine", "t0"), active: false },
      { ...window(2, "engine", "engine", "t2"), active: true },
    ]
    const tmux = {
      hasSession: () => Effect.succeed(true),
      listWindows: () => Effect.succeed(windows),
      listPanes: () => Effect.succeed([]),
      setWindowOption: () => Effect.void,
      setPaneOption: () => Effect.void,
      selectWindow: (_session: string, index: number) => Effect.sync(() => { selected.push(index) }),
      selectLayout: (_target: string, value: string) => Effect.sync(() => { restored.push(value) }),
      resizeWindow: () => Effect.void,
    } as unknown as TmuxServiceShape
    const workspaces = {
      getLayoutState: () => Effect.succeed(state),
      setLayoutState: (_id: string, next: typeof state) => Effect.sync(() => { state = next }),
    } as unknown as WorkspacesRepoShape
    const tabs = {
      listByWorkspace: () => Effect.succeed([tab("t0", "engine", 0), tab("t2", "engine", 2)]),
    } as unknown as TabsRepoShape
    const layout = makeTmuxLayout(tmux, workspaces, tabs)
    await Effect.runPromise(layout.setZen("w1", true, "t0"))
    expect(state).toMatchObject({ zen: true, focusedTabId: "t0", restoreTabId: "t2" })
    expect(selected).toEqual([0])
    await Effect.runPromise(layout.setZen("w1", false))
    expect(state.zen).toBe(false)
    expect(selected).toEqual([0, 2])
    expect(restored).toEqual(["layout-0", "layout-2"])
  })
})
