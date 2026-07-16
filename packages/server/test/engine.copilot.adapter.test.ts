import { afterEach, describe, it, expect } from "vitest"
import { Effect } from "effect"
import { copilotEngine } from "../src/engine/copilot/adapter.js"
import { discoverCopilotBinary } from "../src/engine/copilot/binary.js"
import { probeCopilot, probeCopilotAuth, probeCopilotBinary, probeCopilotVersion } from "../src/engine/copilot/account.js"
import { EngineRegistry, EngineRegistryLive, makeEngineRegistry } from "../src/engine/registry.js"

/**
 * Real CLI opt-in smoke (not CI default):
 *   COOLIE_COPILOT_SMOKE=1 bunx vitest run packages/server/test/engine.copilot.adapter.test.ts
 * Requires `copilot` and `gh` on PATH; does not touch ~/.coolie / ~/.claude / ~/.codex.
 */

describe("copilotEngine", () => {
  afterEach(() => {
    delete process.env.COOLIE_COPILOT_CMD
    delete process.env.COOLIE_COPILOT_BIN
  })

  it("claims only unverified-safe capabilities (all false / none)", () => {
    expect(copilotEngine.id).toBe("copilot")
    expect(copilotEngine.displayName).toBe("GitHub Copilot")
    expect(copilotEngine.capabilities).toEqual({
      nativeQueue: false,
      midSessionModelSwitch: false,
      resume: false,
      hooks: false,
      effort: false,
    })
    expect(copilotEngine.terminalTitle).toBe("none")
    expect(copilotEngine.models).toEqual([])
    expect(copilotEngine.transcriptReader).toBeUndefined()
    expect(copilotEngine.statusFromHookEvent({})).toBeNull()
    expect(copilotEngine.resumeArgs("sid")).toEqual([])
    expect(copilotEngine.deriveTitle("anything")).toBeNull()
  })

  it("launchCommand defaults to allow-all-tools and honors COOLIE_COPILOT_CMD override", () => {
    const fresh = copilotEngine.launchCommand({ sessionId: "SID" })
    expect(fresh.at(-1)).toBe("--allow-all-tools")
    expect(fresh).not.toContain("--session-id")
    expect(fresh).not.toContain("SID")

    process.env.COOLIE_COPILOT_CMD = "cat"
    expect(copilotEngine.launchCommand({ sessionId: "SID" })).toEqual(["cat"])
  })

  it("registry defaults include built-in copilot without preset", () => {
    const registry = makeEngineRegistry()
    expect(registry.get("copilot")).toBe(copilotEngine)
    expect([...registry.keys()]).toEqual(expect.arrayContaining(["claude", "codex", "copilot"]))
  })

  it("registers into EngineRegistryLive", () =>
    Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const reg = yield* EngineRegistry
      expect(reg.get("copilot")?.id).toBe("copilot")
      expect(reg.get("copilot")?.capabilities.nativeQueue).toBe(false)
    }), EngineRegistryLive)))
})

describe("discoverCopilotBinary", () => {
  it("prefers COOLIE_COPILOT_BIN when probeable", () => {
    expect(discoverCopilotBinary({
      env: { COOLIE_COPILOT_BIN: "/tmp/fake-copilot" },
      probe: (p) => p === "/tmp/fake-copilot",
      which: () => null,
    })).toBe("/tmp/fake-copilot")
  })

  it("returns null when missing", () => {
    expect(discoverCopilotBinary({
      env: {},
      probe: () => false,
      which: () => null,
    })).toBeNull()
  })
})

describe("copilot account probes (split unavailable / version / auth)", () => {
  it("reports binary unavailable separately from auth", async () => {
    const result = await probeCopilot({
      env: {},
      probe: () => false,
      which: () => null,
      exec: async () => "should-not-run-version",
      ghArgv: ["gh", "auth", "status"],
    })
    // Override exec for auth only path — version skipped when binary missing
    expect(result.binary.available).toBe(false)
    expect(result.binary.error).toMatch(/not found/)
    expect(result.version.ok).toBe(false)
    expect(result.version.error).toMatch(/not found/)
  })

  it("probes version via injectable exec without claiming capabilities", async () => {
    const version = await probeCopilotVersion({
      binaryPath: "/fake/copilot",
      exec: async (argv) => {
        expect(argv).toEqual(["/fake/copilot", "--version"])
        return "copilot 1.2.3\n"
      },
    })
    expect(version).toEqual({ ok: true, version: "copilot 1.2.3", error: null })
    expect(copilotEngine.capabilities.resume).toBe(false)
  })

  it("probes auth via gh independently of binary", async () => {
    const auth = await probeCopilotAuth({
      exec: async (argv) => {
        expect(argv).toEqual(["gh", "auth", "status"])
        return "Logged in to github.com as coolie-dev\n"
      },
    })
    expect(auth.ok).toBe(true)
    expect(auth.accountHint).toContain("coolie-dev")

    const missing = await probeCopilotAuth({
      exec: async () => { throw new Error("gh: command not found") },
    })
    expect(missing).toEqual({ ok: false, accountHint: null, error: "gh: command not found" })
  })

  it("probeCopilotBinary exposes path when available", () => {
    expect(probeCopilotBinary({
      env: { COOLIE_COPILOT_BIN: "/opt/copilot" },
      probe: (p) => p === "/opt/copilot",
      which: () => null,
    })).toEqual({ available: true, path: "/opt/copilot", error: null })
  })
})

describe("copilot real CLI smoke (opt-in)", () => {
  const enabled = process.env.COOLIE_COPILOT_SMOKE === "1"
  ;(enabled ? it : it.skip)("probes real copilot --version and gh auth status", async () => {
    const result = await probeCopilot()
    // Soft assertions: document shape; do not require auth in CI smoke hosts
    expect(result.binary).toHaveProperty("available")
    expect(result.version).toHaveProperty("ok")
    expect(result.auth).toHaveProperty("ok")
  })
})
