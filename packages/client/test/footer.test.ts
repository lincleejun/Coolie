import { describe, expect, it } from "vitest"
import { footerHints } from "../src/chrome/Footer.js"
import { HOTKEYS_REGISTRY } from "../src/hotkeys/registry.js"

describe("footer 快捷键提示", () => {
  it("从 registry 选择高频键并美化 chord", () => {
    const hints = footerHints(HOTKEYS_REGISTRY)
    expect(hints.some((h) => h.id === "app.commandPalette" && h.chord === "⌘K")).toBe(true)
    expect(hints.some((h) => h.id === "workspace.new")).toBe(true)
  })

  it("即时反映有效 registry 的用户覆盖", () => {
    const registry = HOTKEYS_REGISTRY.map((hotkey) =>
      hotkey.id === "composer.focus" ? { ...hotkey, chord: "meta+shift+l" } : hotkey)
    expect(footerHints(registry).find((h) => h.id === "composer.focus")?.chord).toBe("⌘⇧L")
  })
})
