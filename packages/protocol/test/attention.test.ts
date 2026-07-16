import { describe, expect, it } from "vitest"
import { decodeAttentionItemStrict } from "../src/attention.js"

const baseItem = {
  id: "attn-1",
  workspaceId: "w1",
  tabId: "t1",
  kind: "turn-finished" as const,
  source: "hook" as const,
  sourceEventSeq: 42,
  sessionTurnId: "turn-1",
  summary: "Turn finished",
  state: "open" as const,
  createdAt: 100,
  acknowledgedAt: null,
}

describe("attention protocol", () => {
  it("decodes a valid open item", () => {
    expect(decodeAttentionItemStrict(baseItem)).toEqual(baseItem)
  })

  it("decodes a valid acknowledged item", () => {
    const item = {
      ...baseItem,
      state: "acknowledged" as const,
      acknowledgedAt: 200,
    }
    expect(decodeAttentionItemStrict(item)).toEqual(item)
  })

  it("rejects open items with acknowledgedAt", () => {
    expect(() => decodeAttentionItemStrict({ ...baseItem, acknowledgedAt: 200 }))
      .toThrow(/open attention item/)
  })

  it("rejects acknowledged items without acknowledgedAt", () => {
    expect(() => decodeAttentionItemStrict({ ...baseItem, state: "acknowledged" }))
      .toThrow(/acknowledged attention item/)
  })

  it("rejects invalid sourceEventSeq", () => {
    expect(() => decodeAttentionItemStrict({ ...baseItem, sourceEventSeq: 0 }))
      .toThrow(/sourceEventSeq/)
    expect(() => decodeAttentionItemStrict({ ...baseItem, sourceEventSeq: -1 }))
      .toThrow(/sourceEventSeq/)
  })

  it("rejects unknown kind and source literals", () => {
    expect(() => decodeAttentionItemStrict({ ...baseItem, kind: "toast" }))
      .toThrow()
    expect(() => decodeAttentionItemStrict({ ...baseItem, source: "polling" }))
      .toThrow()
  })
})
