import { describe, it, expect } from "vitest"
import { engineHome } from "../src/engine/registry.js"

describe("engineHome", () => {
  it("engineHome 按引擎 id 选目录，未知兜底 claudeHome", () => {
    const cfg = { claudeHome: "/c", codexHome: "/x" }
    expect(engineHome("claude", cfg)).toBe("/c")
    expect(engineHome("codex", cfg)).toBe("/x")
    expect(engineHome("mystery", cfg)).toBe("/c")
    expect(engineHome(null, cfg)).toBe("/c")
  })
})
