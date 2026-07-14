import { describe, expect, it, vi } from "vitest"
import { MAX_FANOUT } from "@coolie/protocol"
import {
  buildFanoutRequests,
  fanoutTotal,
  submitFanoutRequests,
} from "../src/composer/Dispatch.js"
import type { EngineInfo } from "../src/stores/types.js"

const engines: EngineInfo[] = [
  {
    id: "claude",
    displayName: "Claude",
    capabilities: {
      nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: true, effort: false,
    },
    models: ["opus"],
  },
  {
    id: "codex",
    displayName: "Codex",
    capabilities: {
      nativeQueue: false, midSessionModelSwitch: true, resume: true, hooks: false, effort: true,
    },
    models: ["gpt-5"],
    efforts: ["low", "high"],
  },
]

describe("Dispatch fan-out request construction", () => {
  it("expands per-engine counts and adds one shared fanoutGroup", () => {
    const requests = buildFanoutRequests(
      { projectId: "p1", engineId: "codex", prompt: "ship", model: "default", effort: "default" },
      { claude: 2, codex: 1 },
      engines,
      "fo-x",
    )
    expect(requests).toHaveLength(3)
    expect(requests.map((request) => request.engineId)).toEqual(["claude", "claude", "codex"])
    expect(requests.every((request) => request.fanoutGroup === "fo-x")).toBe(true)
  })

  it("uses safe defaults for non-selected engines and never sends codex effort to claude", () => {
    const requests = buildFanoutRequests(
      { projectId: "p1", engineId: "codex", prompt: "ship", model: "gpt-5", effort: "high" },
      { claude: 1, codex: 1 },
      engines,
      "fo-x",
    )
    expect(requests[0]).toEqual({
      projectId: "p1",
      engineId: "claude",
      initialPrompt: "ship",
      fanoutGroup: "fo-x",
    })
    expect(requests[1]).toMatchObject({ engineId: "codex", model: "gpt-5", effort: "high" })
  })

  it("shares the protocol total cap", () => {
    expect(fanoutTotal({ claude: MAX_FANOUT })).toBe(MAX_FANOUT)
    expect(fanoutTotal({ claude: MAX_FANOUT, codex: 1 })).toBeGreaterThan(MAX_FANOUT)
  })

  it("sends the selected name pool safely to every fan-out request", () => {
    const requests = buildFanoutRequests(
      {
        projectId: "p1", engineId: "codex", prompt: "ship", model: "default", effort: "default",
        namePool: "custom", customNames: ["alpha", "beta"],
      },
      { claude: 1, codex: 1 },
      engines,
      "fo-x",
    )
    expect(requests).toHaveLength(2)
    expect(requests.every((request) =>
      request.namePool === "custom" &&
      JSON.stringify(request.customNames) === JSON.stringify(["alpha", "beta"]),
    )).toBe(true)
  })
})

it("submits every request after failures and returns partial results without rollback", async () => {
  const create = vi.fn(async (body: Record<string, unknown>) => {
    if (body.engineId === "claude") throw new Error("claude unavailable")
    return { id: "codex-ok" }
  })
  const requests = buildFanoutRequests(
    { projectId: "p1", engineId: "codex", prompt: "ship", model: "default", effort: "default" },
    { claude: 1, codex: 1 },
    engines,
    "fo-x",
  )
  const results = await submitFanoutRequests(requests, create)
  expect(create).toHaveBeenCalledTimes(2)
  expect(results).toEqual([
    { engineId: "claude", ok: false, error: "claude unavailable" },
    { engineId: "codex", ok: true, workspaceId: "codex-ok" },
  ])
})
