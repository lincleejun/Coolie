import { describe, expect, it } from "vitest"
import { MAX_FANOUT, expandAgents, parseAgentsSpec } from "../src/fanout.js"

describe("parseAgentsSpec", () => {
  it("parses multiple engine counts and normalizes whitespace/case", () => {
    expect(parseAgentsSpec(" Claude:2, codex:1 ")).toEqual([
      { engineId: "claude", count: 2 },
      { engineId: "codex", count: 1 },
    ])
  })

  it.each(["", "claude", "claude:0", "claude:-1", "claude:1.5", "claude:1,"])(
    "rejects invalid spec %j",
    (raw) => expect(() => parseAgentsSpec(raw)).toThrow(),
  )

  it("rejects totals above the shared cap before expansion", () => {
    expect(() => parseAgentsSpec(`claude:${MAX_FANOUT + 1}`)).toThrow(/上限/)
  })
})

describe("expandAgents", () => {
  it("expands instances in declaration order", () => {
    expect(expandAgents([
      { engineId: "claude", count: 2 },
      { engineId: "codex", count: 1 },
    ])).toEqual(["claude", "claude", "codex"])
  })
})

it("exports the protocol fan-out cap", () => {
  expect(MAX_FANOUT).toBe(16)
})
