import { describe, it, expect } from "vitest"
import { HOTKEYS_REGISTRY, normalizeChord, resolveHotkey } from "../src/hotkeys/registry.js"
import { pushHotkeyLayer, dispatchHotkey, dispatchHotkeyId, getRunnableHotkeyIds, _resetLayers } from "../src/hotkeys/dispatch.js"

const ev = (o: Partial<{ metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; code: string; key: string }>) =>
  ({ metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, code: "", key: "", ...o })

describe("registry", () => {
  it("注册表无重复 chord/id", () => {
    const chords = HOTKEYS_REGISTRY.map((h) => h.chord)
    expect(new Set(chords).size).toBe(chords.length)
    const ids = HOTKEYS_REGISTRY.map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it("normalizeChord：物理键（code）匹配；Ctrl/无修饰返回 null", () => {
    expect(normalizeChord(ev({ metaKey: true, code: "KeyN" }))).toBe("meta+n")
    expect(normalizeChord(ev({ metaKey: true, code: "BracketRight" }))).toBe("meta+]")
    expect(normalizeChord(ev({ metaKey: true, code: "Period" }))).toBe("meta+.")
    expect(normalizeChord(ev({ metaKey: true, code: "Digit3" }))).toBe("meta+3")
    expect(normalizeChord(ev({ ctrlKey: true, code: "KeyA" }))).toBeNull() // Ctrl 系永远透传
    expect(normalizeChord(ev({ code: "KeyJ" }))).toBeNull()
  })
  it("resolveHotkey 命中 Cmd+1..9 / Cmd+L / Cmd+.", () => {
    expect(resolveHotkey(ev({ metaKey: true, code: "Digit1" }))?.id).toBe("workspace.jump.1")
    expect(resolveHotkey(ev({ metaKey: true, code: "KeyL" }))?.id).toBe("composer.focus")
    expect(resolveHotkey(ev({ metaKey: true, code: "Period" }))?.id).toBe("engine.interrupt")
  })
})

describe("LIFO binding stack", () => {
  it("顶层 layer 优先，pop 后回落", () => {
    _resetLayers()
    const hits: string[] = []
    pushHotkeyLayer({ "workspace.new": () => hits.push("base") })
    const pop = pushHotkeyLayer({ "workspace.new": () => hits.push("modal") })
    dispatchHotkey(ev({ metaKey: true, code: "KeyN" }))
    pop()
    dispatchHotkey(ev({ metaKey: true, code: "KeyN" }))
    expect(hits).toEqual(["modal", "base"])
  })
  it("未命中任何 layer → false", () => {
    _resetLayers()
    expect(dispatchHotkey(ev({ metaKey: true, code: "KeyN" }))).toBe(false)
  })
  it("按 action id 路由同样遵守 LIFO，且可枚举当前动作", () => {
    _resetLayers()
    const hits: string[] = []
    pushHotkeyLayer({ "workspace.new": () => hits.push("base") })
    const pop = pushHotkeyLayer({ "workspace.new": () => hits.push("modal"), "app.cheatsheet": () => {} })
    expect(dispatchHotkeyId("workspace.new")).toBe(true)
    expect(getRunnableHotkeyIds()).toEqual(new Set(["workspace.new", "app.cheatsheet"]))
    pop()
    expect(dispatchHotkeyId("workspace.new")).toBe(true)
    expect(hits).toEqual(["modal", "base"])
  })
})
