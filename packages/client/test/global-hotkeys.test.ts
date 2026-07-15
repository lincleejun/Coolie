import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { dispatchGlobalHotkey, orderedActiveWs } from "../src/hotkeys/useGlobalHotkeys.js"
import { useData } from "../src/stores/data.js"
import { consumeModalKey, useUi, type ModalId } from "../src/stores/ui.js"
import type { Workspace } from "@coolie/protocol"
import { _resetLayers, pushHotkeyLayer } from "../src/hotkeys/dispatch.js"
import { confirmDialog, pendingDialogCount, resolveActiveDialog } from "../src/chrome/dialogs.js"

const ws = (o: Partial<Workspace> & { id: string }): Workspace => ({
  projectId: "P",
  name: o.id,
  branch: "main",
  status: "active",
  pinned: false,
  createdAt: 0,
  ...o,
}) as Workspace

describe("orderedActiveWs", () => {
  beforeEach(() => {
    useData.setState({ workspaces: [] })
    useUi.setState({ selectedWs: null })
  })

  it("只含普通 active/creating/error task，剔除 archived 和 main", () => {
    useData.setState({
      workspaces: [
        ws({ id: "a", status: "active" }),
        ws({ id: "b", status: "archived" }),
        ws({ id: "c", status: "creating" }),
        ws({ id: "d", status: "error" }),
        ws({ id: "main", status: "active", kind: "main" }),
      ],
    })
    expect(orderedActiveWs().map((w) => w.id)).toEqual(["a", "c", "d"])
  })

  it("pinned 优先，pinned/未 pinned 各组保持原有稳定顺序", () => {
    useData.setState({
      workspaces: [
        ws({ id: "old", pinned: false, createdAt: 100 }),
        ws({ id: "new", pinned: false, createdAt: 300 }),
        ws({ id: "pinOld", pinned: true, createdAt: 50 }),
        ws({ id: "pinNew", pinned: true, createdAt: 200 }),
      ],
    })
    expect(orderedActiveWs().map((w) => w.id)).toEqual(["pinOld", "pinNew", "old", "new"])
  })
})

describe("global hotkeys while an app dialog is active", () => {
  afterEach(() => {
    while (pendingDialogCount() > 0) resolveActiveDialog(false)
    useUi.setState({
      cheatsheetOpen: false,
      paletteOpen: false,
      settingsOpen: false,
      modalStack: [],
    })
    _resetLayers()
  })

  const modalClasses: readonly ModalId[] = [
    "dialog",
    "settings",
    "command-palette",
    "cheatsheet",
    "project-picker",
    "tmux-guide",
    "future-overlay",
  ]

  it.each(modalClasses.flatMap((modal) => [
    [modal, "w", "tab.close", "KeyW"],
    [modal, "1", "workspace.jump.1", "Digit1"],
  ] as const))("%s consumes Cmd+%s without running %s", (modal, key, action, code) => {
    const run = vi.fn()
    pushHotkeyLayer({ [action]: run })
    useUi.getState().openModal(modal)
    const event = {
      key, code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent

    expect(dispatchGlobalHotkey(event)).toBe(true)
    expect(run).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
    useUi.getState().closeModal(modal)
  })

  it("registers queued dialogs in the application-wide barrier", () => {
    void confirmDialog("Confirm", "Keep focus here")
    expect(useUi.getState().modalStack).toContain("dialog")
    resolveActiveDialog(false)
    expect(useUi.getState().modalStack).not.toContain("dialog")
  })

  it("allows ordinary modal input while blocking only registered global chords", () => {
    useUi.getState().openModal("dialog")
    const event = {
      key: "a", code: "KeyA", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent
    expect(dispatchGlobalHotkey(event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it("app dialog Escape resolves locally without reaching interrupt", () => {
    const interrupt = vi.fn()
    pushHotkeyLayer({ "engine.interrupt": interrupt })
    void confirmDialog("Confirm", "Keep focus here")
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }

    expect(consumeModalKey(event, "Escape", () => resolveActiveDialog(false))).toBe(true)
    expect(pendingDialogCount()).toBe(0)
    expect(interrupt).not.toHaveBeenCalled()
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
  })

  it.each([
    ["settings", () => useUi.getState().setSettings(false)],
    ["command-palette", () => useUi.getState().setPalette(false)],
    ["cheatsheet", () => useUi.getState().setCheatsheet(false)],
    ["project-picker", () => useUi.getState().closeModal("project-picker")],
  ] as const)("%s Escape closes locally without reaching interrupt", (modal, close) => {
    const interrupt = vi.fn()
    pushHotkeyLayer({ "engine.interrupt": interrupt })
    useUi.getState().openModal(modal)
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      nativeEvent: { stopImmediatePropagation: vi.fn() },
    }

    expect(consumeModalKey(event, "Escape", close)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(event.nativeEvent.stopImmediatePropagation).toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
    expect(useUi.getState().modalStack).not.toContain(modal)
  })
})
