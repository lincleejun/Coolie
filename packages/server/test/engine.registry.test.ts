import { describe, it, expect } from "vitest"
import { engineHome, makeEngineRegistry } from "../src/engine/registry.js"
import { copilotPreset } from "../src/engine/custom-store.js"

describe("engineHome", () => {
  it("engineHome 按引擎 id 选目录，未知兜底 claudeHome", () => {
    const cfg = { claudeHome: "/c", codexHome: "/x" }
    expect(engineHome("claude", cfg)).toBe("/c")
    expect(engineHome("codex", cfg)).toBe("/x")
    expect(engineHome("mystery", cfg)).toBe("/c")
    expect(engineHome(null, cfg)).toBe("/c")
  })
})

describe("custom registry merge", () => {
  it("defaults include built-in copilot without a preset row", () => {
    const registry = makeEngineRegistry()
    expect(registry.has("copilot")).toBe(true)
    expect(registry.get("copilot")?.displayName).toBe("GitHub Copilot")
  })

  it("keeps built-ins and merges only enabled custom engines", () => {
    const disabled = { ...copilotPreset("disabled-agent"), enabled: false }
    const registry = makeEngineRegistry([copilotPreset("work-copilot"), disabled])
    expect([...registry.keys()]).toEqual(expect.arrayContaining(["claude", "codex", "copilot", "work-copilot"]))
    expect(registry.has("disabled-agent")).toBe(false)
    expect(registry.get("copilot")?.displayName).toBe("GitHub Copilot")
    expect(registry.get("work-copilot")?.displayName).toBe("GitHub Copilot")
  })
})
