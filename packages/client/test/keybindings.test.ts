import { beforeEach, describe, expect, it, vi } from "vitest"
import { HOTKEYS_REGISTRY, resolveHotkey } from "../src/hotkeys/registry.js"
import {
  loadKeybindingOverrides,
  mergeKeybindings,
  parseKeybindingJson,
  validateKeybindingOverrides,
  exportKeybindingsYaml,
  parseKeybindingsYaml,
} from "../src/settings/keybindings.js"
import { useSettings } from "../src/settings/settings.js"

describe("用户快捷键覆盖", () => {
  it("合并已知 action，且不修改单一真源", () => {
    const merged = mergeKeybindings(HOTKEYS_REGISTRY, { "composer.focus": "meta+shift+l" })
    expect(merged.find((h) => h.id === "composer.focus")?.chord).toBe("meta+shift+l")
    expect(HOTKEYS_REGISTRY.find((h) => h.id === "composer.focus")?.chord).toBe("meta+l")
  })

  it.each([
    [{ "bogus.id": "meta+z" }, "未知 action"],
    [{ "composer.focus": "ctrl+l" }, "键位格式"],
    [{ "composer.focus": "meta+n" }, "键位冲突"],
  ])("拒绝坏配置并返回可读错误：%o", (overrides, message) => {
    const result = validateKeybindingOverrides(HOTKEYS_REGISTRY, overrides)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(message)
  })

  it("JSON 必须是 string:string 对象", () => {
    expect(parseKeybindingJson(HOTKEYS_REGISTRY, "[]").ok).toBe(false)
    expect(parseKeybindingJson(HOTKEYS_REGISTRY, '{"composer.focus":42}').ok).toBe(false)
    expect(parseKeybindingJson(HOTKEYS_REGISTRY, "{").ok).toBe(false)
  })

  it("supports null unbind and YAML compatibility", () => {
    const yaml = exportKeybindingsYaml({ "composer.focus": null, "app.settings": "meta+shift+," })
    const parsed = parseKeybindingsYaml(HOTKEYS_REGISTRY, yaml)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.overrides["composer.focus"]).toBeNull()
      expect(mergeKeybindings(HOTKEYS_REGISTRY, parsed.overrides).some((item) => item.id === "composer.focus")).toBe(false)
    }
  })
})

describe("localStorage 安全加载", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("node 无 DOM 时回默认空覆盖", () => {
    vi.stubGlobal("localStorage", undefined)
    expect(loadKeybindingOverrides(HOTKEYS_REGISTRY)).toEqual({ overrides: {}, error: null })
  })

  it("持久化坏配置时安全回默认并暴露错误", () => {
    vi.stubGlobal("localStorage", { getItem: () => '{"composer.focus":"ctrl+l"}' })
    const loaded = loadKeybindingOverrides(HOTKEYS_REGISTRY)
    expect(loaded.overrides).toEqual({})
    expect(loaded.error).toContain("键位格式")
  })
})

describe("settings store", () => {
  it("即时应用有效 JSON；错误不覆盖上次有效配置", () => {
    useSettings.getState().resetKeybindings()
    expect(useSettings.getState().applyKeybindingJson('{"composer.focus":"meta+shift+l"}').ok).toBe(true)
    expect(useSettings.getState().effectiveHotkeys.find((h) => h.id === "composer.focus")?.chord)
      .toBe("meta+shift+l")
    expect(resolveHotkey({
      metaKey: true, shiftKey: true, altKey: false, ctrlKey: false, code: "KeyL", key: "L",
    })?.id).toBe("composer.focus")

    const invalid = useSettings.getState().applyKeybindingJson('{"composer.focus":"meta+n"}')
    expect(invalid.ok).toBe(false)
    expect(useSettings.getState().effectiveHotkeys.find((h) => h.id === "composer.focus")?.chord)
      .toBe("meta+shift+l")
    expect(useSettings.getState().keybindingError).toContain("键位冲突")
  })
})
