import { afterEach, beforeEach, describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { codexEngine, loadCodexModelCatalog } from "../src/engine/codex/adapter.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { Effect } from "effect"
import { EngineRegistry } from "../src/engine/registry.js"

let testHome = ""

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-codex-adapter-"))
  process.env.COOLIE_CODEX_HOME = path.join(testHome, "codex-home")
  process.env.COOLIE_CODEX_CONFIG = path.join(testHome, "config.toml")
  process.env.COOLIE_CODEX_HOOKS = "0"
})

afterEach(() => {
  delete process.env.COOLIE_CODEX_HOME
  delete process.env.COOLIE_CODEX_CONFIG
  delete process.env.COOLIE_CODEX_HOOKS
  fs.rmSync(testHome, { recursive: true, force: true })
})

describe("codexEngine", () => {
  it("模型选项读取 Codex cache，并允许环境配置显式覆盖", () => {
    const cache = path.join(testHome, "models_cache.json")
    fs.writeFileSync(cache, JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
        { slug: "hidden-model", visibility: "hide", supported_reasoning_levels: [{ effort: "high" }] },
      ],
    }))
    expect(loadCodexModelCatalog(undefined, cache)).toEqual({
      models: ["gpt-5.6-sol"],
      modelEfforts: { "gpt-5.6-sol": ["low", "ultra"] },
    })
    expect(loadCodexModelCatalog(" custom-a, custom-b ", "/missing")).toEqual({
      models: ["custom-a", "custom-b"],
      modelEfforts: {},
    })
  })
  it("能力位与 claude 分流：nativeQueue=false、effort=true、serverGeneratedId=true、hooks=false（0.139 无-hooks 通路）", () => {
    expect(codexEngine.capabilities.nativeQueue).toBe(false)
    expect(codexEngine.capabilities.effort).toBe(true)
    expect(codexEngine.serverGeneratedId).toBe(true)
    // hooks 四断点（task-12-report §3）：codex 走 rollout 就绪门控，不依赖 hooks。
    expect(codexEngine.capabilities.hooks).toBe(false)
  })
  it("launchCommand 绝不含 --session-id；resume 走 codex resume <id>", () => {
    const fresh = codexEngine.launchCommand({ sessionId: "SID", model: "gpt-5", effort: "high" })
    expect(fresh).not.toContain("--session-id")
    expect(fresh.join(" ")).toContain("model_reasoning_effort=high")
    expect(fresh).toContain("--model"); expect(fresh).toContain("gpt-5")
    expect(fresh).toContain("--dangerously-bypass-hook-trust") // 保留：抑制 trust 对话框，future-ready（无-hooks 通路不依赖）
  })
  it("bypass-hook-trust flag 在 resume 与 fresh 两路都在", () => {
    expect(codexEngine.launchCommand({ sessionId: "SID" })).toContain("--dangerously-bypass-hook-trust")
    expect(codexEngine.launchCommand({ sessionId: "SID", resume: true })).toContain("--dangerously-bypass-hook-trust")
    const res = codexEngine.launchCommand({ sessionId: "SID", resume: true })
    expect(res.join(" ")).toContain("resume SID")
    expect(res).not.toContain("--session-id")
  })
  it("notify lane 仅在 fresh session 注入 per-session notify 配置", () => {
    const opts = { sessionId: "", workspaceId: "ws-1", home: "/tmp/coolie home" }
    const fresh = codexEngine.launchCommand(opts)
    expect(fresh.join(" ")).toContain('notify=["/tmp/coolie home/hooks/codex-notify.sh","ws-1"]')
    const resumed = codexEngine.launchCommand({ ...opts, sessionId: "SID", resume: true })
    expect(resumed.join(" ")).not.toContain("notify=[")
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
