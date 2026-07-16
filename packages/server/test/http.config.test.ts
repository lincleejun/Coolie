import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import { Effect, Layer } from "effect"
import { EngineRegistry } from "../src/engine/registry.js"
import type { Engine } from "../src/engine/types.js"
import { createApp, newToken } from "../src/http/app.js"

// fakeEngine 显式设 F4 三字段（serverGeneratedId/models/efforts），因它要断言 /config 下发。
const fakeEngine = (id: string, models: string[]): Engine => ({
  id,
  displayName: `Fake ${id}`,
  capabilities: { nativeQueue: id === "claude", midSessionModelSwitch: true, resume: true, hooks: true, effort: id === "codex" },
  terminalTitle: "none",
  serverGeneratedId: id === "codex",
  newSessionId: () => "x",
  launchCommand: () => [id],
  statusFromHookEvent: () => null,
  transcriptPath: () => "/dev/null",
  deriveTitle: () => null,
  resumeArgs: () => [],
  models,
  ...(id === "codex" ? {
    efforts: ["low", "high"],
    modelEfforts: { "gpt-5": ["high"] },
  } : {}),
})

let server: http.Server, base: string, token: string

const startServer = async (reg: ReadonlyMap<string, Engine>) => {
  const layer = Layer.succeed(EngineRegistry, reg)
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
    config: { tmuxSocket: "coolie-test" },
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
}

afterEach(() => server?.close())

const get = async (b: string, p: string, tok: string) =>
  (await fetch(b + p, { headers: { Authorization: `Bearer ${tok}` } })).json()

describe("GET /config engines", () => {
  beforeEach(async () => {
    const reg = new Map<string, Engine>([
      ["claude", fakeEngine("claude", ["default", "opus"])],
      ["codex", fakeEngine("codex", ["gpt-5"])],
    ])
    await startServer(reg)
  })

  it("下发全部注册引擎，非仅 claude", async () => {
    const body = await get(base, "/config", token)
    const ids = body.engines.map((e: any) => e.id).sort()
    expect(ids).toEqual(["claude", "codex"])
    const codex = body.engines.find((e: any) => e.id === "codex")
    expect(codex.capabilities.nativeQueue).toBe(false)
    expect(codex.models).toEqual(["gpt-5"])
    expect(codex.efforts).toEqual(["low", "high"])
    expect(codex.modelEfforts).toEqual({ "gpt-5": ["high"] })
  })

  it("tmuxSocket 随 config 下发；claude 无 efforts 字段", async () => {
    const body = await get(base, "/config", token)
    expect(body.tmuxSocket).toBe("coolie-test")
    const claude = body.engines.find((e: any) => e.id === "claude")
    expect(claude.models).toEqual(["default", "opus"])
    expect("efforts" in claude).toBe(false)
  })
})

describe("GET /config Copilot availability (Task 3.3)", () => {
  afterEach(() => server?.close())

  it("reports built-in Copilot with auth failure without claiming available", async () => {
    const reg = new Map<string, Engine>([
      ["claude", fakeEngine("claude", ["default"])],
      ["copilot", {
        ...fakeEngine("copilot", []),
        displayName: "GitHub Copilot",
        capabilities: {
          nativeQueue: false,
          midSessionModelSwitch: false,
          resume: false,
          hooks: false,
          effort: false,
        },
      }],
    ])
    token = newToken()
    const app = createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, Layer.succeed(EngineRegistry, reg)) as Effect.Effect<any, any, never>),
      token,
      onShutdown: () => {},
      config: { tmuxSocket: "coolie-test" },
      probeCopilotAvailability: async () => ({
        available: false,
        accountHint: null,
        error: "gh: not logged in. Run `gh auth login` to authenticate GitHub Copilot",
      }),
    })
    server = http.createServer(app)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    const body = await get(base, "/config", token)
    const copilot = body.engines.find((e: any) => e.id === "copilot")
    expect(copilot).toMatchObject({
      id: "copilot",
      displayName: "GitHub Copilot",
      custom: false,
      capabilities: { nativeQueue: false },
      availability: {
        available: false,
        error: expect.stringMatching(/gh auth login/i),
      },
    })
  })

  it("reports available Copilot with account hint when probe succeeds", async () => {
    const reg = new Map<string, Engine>([
      ["copilot", { ...fakeEngine("copilot", []), displayName: "GitHub Copilot" }],
    ])
    token = newToken()
    const app = createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, Layer.succeed(EngineRegistry, reg)) as Effect.Effect<any, any, never>),
      token,
      onShutdown: () => {},
      config: { tmuxSocket: "coolie-test" },
      probeCopilotAvailability: async () => ({
        available: true,
        accountHint: "Logged in to github.com as coolie-dev",
        error: null,
      }),
    })
    server = http.createServer(app)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    const body = await get(base, "/config", token)
    expect(body.engines.find((e: any) => e.id === "copilot")?.availability).toEqual({
      available: true,
      accountHint: "Logged in to github.com as coolie-dev",
      error: null,
    })
  })
})
