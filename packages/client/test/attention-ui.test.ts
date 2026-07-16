import { describe, expect, it } from "vitest"
import type { AttentionItem } from "@coolie/protocol"
import {
  defaultInboxFilter,
  filterAttentionItems,
  inboxItemStatusLabel,
  moveInboxSelection,
  pickNextAttentionItem,
  sortAttentionItems,
} from "../src/attention/inbox-logic.js"
import { jumpToAttentionItem } from "../src/attention/inbox-logic.js"

const sample = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "att-1",
  workspaceId: "w1",
  tabId: "t1",
  kind: "turn-finished",
  source: "hook",
  sourceEventSeq: 1,
  sessionTurnId: null,
  summary: "Done",
  state: "open",
  createdAt: 10,
  acknowledgedAt: null,
  ...overrides,
})

describe("inbox logic", () => {
  const workspaceById = new Map([
    ["w1", { projectId: "p1", status: "active" as const }],
    ["w2", { projectId: "p1", status: "archived" as const }],
    ["w3", { projectId: "p2", status: "error" as const }],
  ])

  it("filters by project, workspace, and kind", () => {
    const items = [
      sample({ id: "a1", workspaceId: "w1", kind: "turn-finished" }),
      sample({ id: "a2", workspaceId: "w2", kind: "error", createdAt: 20 }),
      sample({ id: "a3", workspaceId: "w3", kind: "permission", createdAt: 30 }),
    ]
    expect(filterAttentionItems(items, defaultInboxFilter(), workspaceById)).toHaveLength(3)
    expect(filterAttentionItems(items, { ...defaultInboxFilter(), projectId: "p2" }, workspaceById).map((item) => item.id))
      .toEqual(["a3"])
    expect(filterAttentionItems(items, { ...defaultInboxFilter(), workspaceId: "w2" }, workspaceById).map((item) => item.id))
      .toEqual(["a2"])
    expect(filterAttentionItems(items, { ...defaultInboxFilter(), kind: "error" }, workspaceById).map((item) => item.id))
      .toEqual(["a2"])
  })

  it("picks the oldest filtered item for next attention", () => {
    const items = [
      sample({ id: "a2", workspaceId: "w1", createdAt: 20 }),
      sample({ id: "a1", workspaceId: "w1", createdAt: 10 }),
    ]
    expect(pickNextAttentionItem(items, defaultInboxFilter(), workspaceById)?.id).toBe("a1")
    expect(sortAttentionItems(items).map((item) => item.id)).toEqual(["a1", "a2"])
  })

  it("labels archived and error inbox states", () => {
    expect(inboxItemStatusLabel({ status: "archived" }, "turn-finished")).toBe("archived")
    expect(inboxItemStatusLabel({ status: "error" }, "turn-finished")).toBe("error")
    expect(inboxItemStatusLabel({ status: "active" }, "error")).toBe("error")
    expect(inboxItemStatusLabel({ status: "active" }, "turn-finished")).toBe("open")
  })

  it("wraps keyboard selection", () => {
    expect(moveInboxSelection(1, 1, 3)).toBe(2)
    expect(moveInboxSelection(0, -1, 3)).toBe(2)
  })

  it("jumps to workspace and tab", () => {
    const calls: string[] = []
    jumpToAttentionItem(sample({ workspaceId: "w9", tabId: "t9" }), (id) => calls.push(`ws:${id}`), (wsId, tabId) => {
      calls.push(`tab:${wsId}/${tabId}`)
    })
    expect(calls).toEqual(["ws:w9", "tab:w9/t9"])
  })
})
