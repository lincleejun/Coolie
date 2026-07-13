import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { EngineRegistry, EngineRegistryLive } from "../src/engine/registry.js"
import {
  codexVersionSupportsHooks,
  parseCodexVersion,
  resolveCodexHooks,
} from "../src/engine/codex/version.js"

let testHome = ""

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-codex-version-"))
  process.env.COOLIE_CODEX_HOME = path.join(testHome, "home")
  process.env.COOLIE_CODEX_CONFIG = path.join(testHome, "config.toml")
  delete process.env.COOLIE_CODEX_HOOKS
})

afterEach(() => {
  delete process.env.COOLIE_CODEX_HOOKS
  delete process.env.COOLIE_CODEX_HOME
  delete process.env.COOLIE_CODEX_CONFIG
  fs.rmSync(testHome, { recursive: true, force: true })
})

describe("codex hooks 版本门控", () => {
  it("解析 codex-cli semver 并拒绝无效输出", () => {
    expect(parseCodexVersion("codex-cli 0.144.1")).toEqual({ major: 0, minor: 144 })
    expect(parseCodexVersion("codex-cli 0.139.0\n")).toEqual({ major: 0, minor: 139 })
    expect(parseCodexVersion("garbage")).toBeNull()
  })

  it("0.144 起支持 hooks，0.139 不支持，1.x 支持", () => {
    expect(codexVersionSupportsHooks({ major: 0, minor: 144 })).toBe(true)
    expect(codexVersionSupportsHooks({ major: 0, minor: 139 })).toBe(false)
    expect(codexVersionSupportsHooks({ major: 1, minor: 0 })).toBe(true)
  })

  it("env 覆写优先于版本探测", () => {
    process.env.COOLIE_CODEX_HOOKS = "true"
    expect(resolveCodexHooks(() => "codex-cli 0.139.0")).toBe(true)
    process.env.COOLIE_CODEX_HOOKS = "false"
    expect(resolveCodexHooks(() => "codex-cli 0.144.1")).toBe(false)
  })

  it("无覆写时按版本定 lane，探测失败保守走 notify lane", () => {
    expect(resolveCodexHooks(() => "codex-cli 0.144.1")).toBe(true)
    expect(resolveCodexHooks(() => "codex-cli 0.139.0")).toBe(false)
    expect(resolveCodexHooks(() => null)).toBe(false)
  })

  it("EngineRegistryLive 在启动时按覆写补丁 codex hooks 能力", async () => {
    process.env.COOLIE_CODEX_HOOKS = "1"
    const hooks = await Effect.runPromise(Effect.provide(EngineRegistry, EngineRegistryLive))
    expect(hooks.get("codex")?.capabilities.hooks).toBe(true)

    process.env.COOLIE_CODEX_HOOKS = "0"
    const notify = await Effect.runPromise(Effect.provide(EngineRegistry, EngineRegistryLive))
    expect(notify.get("codex")?.capabilities.hooks).toBe(false)
  })
})
