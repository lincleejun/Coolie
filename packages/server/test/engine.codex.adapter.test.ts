import { describe, it, expect } from "vitest"
import { codexEngine } from "../src/engine/codex/adapter.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { Effect } from "effect"
import { EngineRegistry } from "../src/engine/registry.js"

describe("codexEngine", () => {
  it("能力位与 claude 分流：nativeQueue=false、effort=true、serverGeneratedId=true", () => {
    expect(codexEngine.capabilities.nativeQueue).toBe(false)
    expect(codexEngine.capabilities.effort).toBe(true)
    expect(codexEngine.serverGeneratedId).toBe(true)
  })
  it("launchCommand 绝不含 --session-id；resume 走 codex resume <id>", () => {
    const fresh = codexEngine.launchCommand({ sessionId: "SID", model: "gpt-5", effort: "high" })
    expect(fresh).not.toContain("--session-id")
    expect(fresh.join(" ")).toContain("model_reasoning_effort=high")
    expect(fresh).toContain("--model"); expect(fresh).toContain("gpt-5")
    expect(fresh).toContain("--dangerously-bypass-hook-trust") // F3：hooks 首启即触发
  })
  it("bypass-hook-trust flag 在 resume 与 fresh 两路都在", () => {
    expect(codexEngine.launchCommand({ sessionId: "SID" })).toContain("--dangerously-bypass-hook-trust")
    expect(codexEngine.launchCommand({ sessionId: "SID", resume: true })).toContain("--dangerously-bypass-hook-trust")
    const res = codexEngine.launchCommand({ sessionId: "SID", resume: true })
    expect(res.join(" ")).toContain("resume SID")
    expect(res).not.toContain("--session-id")
  })
  it("COOLIE_CODEX_CMD 覆写 seam 原样使用", () => {
    const prev = process.env.COOLIE_CODEX_CMD
    process.env.COOLIE_CODEX_CMD = "cat"
    try { expect(codexEngine.launchCommand({ sessionId: "x" })).toEqual(["cat"]) }
    finally { process.env.COOLIE_CODEX_CMD = prev }
  })
  it("注册进 EngineRegistryLive", () =>
    Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const reg = yield* EngineRegistry
      expect(reg.get("codex")?.id).toBe("codex")
      expect(reg.get("claude")?.id).toBe("claude")
    }), EngineRegistryLive)))
})
