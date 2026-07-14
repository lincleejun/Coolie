import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAttention } from "../src/stores/attention.js"
import { useData } from "../src/stores/data.js"
import { useUi } from "../src/stores/ui.js"

describe("attention store", () => {
  beforeEach(() => {
    useAttention.setState({ needsYou: new Set() })
    useData.setState({
      workspaces: [{ id: "w1", name: "USA" }, { id: "w2", name: "China" }],
    } as any)
    useUi.getState().selectWs("w1")
    vi.stubGlobal("document", { hidden: false, hasFocus: () => true, title: "Coolie" })
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("Notification", undefined)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("raises, clears, counts, and queries workspaces", () => {
    useAttention.getState().raise("w1")
    useAttention.getState().raise("w2")

    expect(useAttention.getState().count()).toBe(2)
    expect(useAttention.getState().isRaised("w1")).toBe(true)

    useAttention.getState().clear("w1")

    expect(useAttention.getState().count()).toBe(1)
    expect(useAttention.getState().isRaised("w1")).toBe(false)
  })

  it("does not count a workspace twice", () => {
    useAttention.getState().raise("w1")
    useAttention.getState().raise("w1")

    expect(useAttention.getState().count()).toBe(1)
  })

  it("raises attention for a completed turn in another workspace", () => {
    useData.getState().applyEvent({
      seq: 1,
      workspaceId: "w2",
      type: "tab.status.changed",
      payload: { status: "awaiting-input" },
      ts: 1,
    })

    expect(useAttention.getState().isRaised("w2")).toBe(true)
    expect(document.title).toBe("(1) Coolie")
  })

  it("does not raise attention while replaying historical events on startup", () => {
    ;(useData.getState().applyEvent as any)({
      seq: 1,
      workspaceId: "w2",
      type: "tab.status.changed",
      payload: { status: "awaiting-input" },
      ts: 1,
    }, { allowAttention: false })

    expect(useAttention.getState().count()).toBe(0)
    expect(document.title).toBe("Coolie")
  })

  it("does not raise attention for the visible selected workspace", () => {
    useData.getState().applyEvent({
      seq: 2,
      workspaceId: "w1",
      type: "tab.status.changed",
      payload: { status: "awaiting-input" },
      ts: 1,
    })

    expect(useAttention.getState().count()).toBe(0)
    expect(document.title).toBe("Coolie")
  })

  it("raises attention for the selected workspace while the document is hidden", () => {
    vi.stubGlobal("document", { hidden: true, hasFocus: () => true, title: "Coolie" })

    useData.getState().applyEvent({
      seq: 3,
      workspaceId: "w1",
      type: "tab.status.changed",
      payload: { status: "awaiting-input" },
      ts: 1,
    })

    expect(useAttention.getState().isRaised("w1")).toBe(true)
  })

  it("raises attention for the selected workspace while the document lacks focus", () => {
    vi.stubGlobal("document", { hidden: false, hasFocus: () => false, title: "Coolie" })
    useData.getState().applyEvent({
      seq: 4, workspaceId: "w1", type: "tab.status.changed",
      payload: { status: "awaiting-input" }, ts: 1,
    })
    expect(useAttention.getState().isRaised("w1")).toBe(true)
  })

  it("is safe when no DOM exists", () => {
    vi.stubGlobal("document", undefined)
    expect(() => useData.getState().applyEvent({
      seq: 5, workspaceId: "w1", type: "tab.status.changed",
      payload: { status: "awaiting-input" }, ts: 1,
    })).not.toThrow()
  })
})
