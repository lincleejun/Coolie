import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AttentionItem } from "@coolie/protocol"
import { useAttention } from "../src/stores/attention.js"
import { useData } from "../src/stores/data.js"
import { useUi } from "../src/stores/ui.js"
import { makeApi, type ServerInfo } from "../src/api/client.js"

const sampleItem = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "att-1",
  workspaceId: "w2",
  tabId: "t2",
  kind: "turn-finished",
  source: "hook",
  sourceEventSeq: 10,
  sessionTurnId: null,
  summary: "China",
  state: "open",
  createdAt: 1,
  acknowledgedAt: null,
  ...overrides,
})

describe("attention store", () => {
  beforeEach(() => {
    useAttention.setState({ items: {} })
    useData.setState({
      workspaces: [{ id: "w1", name: "USA" }, { id: "w2", name: "China" }],
    } as any)
    useUi.getState().selectWs("w1")
    vi.stubGlobal("document", { hidden: false, hasFocus: () => true, title: "Coolie" })
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("Notification", undefined)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("loads bootstrap snapshot without notifying", () => {
    useAttention.getState().loadSnapshot([sampleItem()])
    expect(useAttention.getState().count()).toBe(1)
    expect(document.title).toBe("(1) Coolie")
  })

  it("merges durable items and counts unique workspaces", () => {
    useAttention.getState().mergeItems([
      sampleItem(),
      sampleItem({ id: "att-2", workspaceId: "w2", tabId: "t3" }),
    ], { notify: false })

    expect(useAttention.getState().count()).toBe(1)
    expect(useAttention.getState().isRaised("w2")).toBe(true)
  })

  it("raises attention for a completed turn in another workspace", async () => {
    const info: ServerInfo = { port: 1, token: "t", pid: 1 }
    const api = makeApi(info)
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/attention?workspace=w2")) {
        return new Response(JSON.stringify([sampleItem()]), { status: 200 })
      }
      return new Response("{}", { status: 404 })
    }))
    useData.getState().setApi(api)

    useData.getState().applyEvent({
      seq: 1,
      workspaceId: "w2",
      type: "tab.status.changed",
      payload: { status: "awaiting-input", tabId: "t2" },
      ts: 1,
    })

    await vi.waitFor(() => {
      expect(useAttention.getState().isRaised("w2")).toBe(true)
    })
    expect(document.title).toBe("(1) Coolie")
  })

  it("does not raise attention while replaying historical events on startup", async () => {
    const info: ServerInfo = { port: 1, token: "t", pid: 1 }
    const api = makeApi(info)
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([sampleItem()]), { status: 200 })))
    useData.getState().setApi(api)

    await (useData.getState().applyEvent as any)({
      seq: 1,
      workspaceId: "w2",
      type: "tab.status.changed",
      payload: { status: "awaiting-input" },
      ts: 1,
    }, { allowAttention: false })

    expect(useAttention.getState().count()).toBe(0)
    expect(document.title).toBe("Coolie")
  })

  it("does not raise attention for the visible selected workspace", async () => {
    useUi.getState().selectTab("w1", "t1")
    const info: ServerInfo = { port: 1, token: "t", pid: 1 }
    const api = makeApi(info)
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      sampleItem({ workspaceId: "w1", tabId: "t1", summary: "USA" }),
    ]), { status: 200 })))
    useData.getState().setApi(api)

    useData.getState().applyEvent({
      seq: 2,
      workspaceId: "w1",
      type: "tab.status.changed",
      payload: { status: "awaiting-input", tabId: "t1" },
      ts: 1,
    })

    await vi.waitFor(() => {
      expect(useAttention.getState().count()).toBe(0)
    })
    expect(document.title).toBe("Coolie")
  })

  it("raises attention for the selected workspace while the document is hidden", async () => {
    vi.stubGlobal("document", { hidden: true, hasFocus: () => true, title: "Coolie" })
    const info: ServerInfo = { port: 1, token: "t", pid: 1 }
    const api = makeApi(info)
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      sampleItem({ workspaceId: "w1", tabId: "t1", summary: "USA" }),
    ]), { status: 200 })))
    useData.getState().setApi(api)

    useData.getState().applyEvent({
      seq: 3,
      workspaceId: "w1",
      type: "tab.status.changed",
      payload: { status: "awaiting-input", tabId: "t1" },
      ts: 1,
    })

    await vi.waitFor(() => {
      expect(useAttention.getState().isRaised("w1")).toBe(true)
    })
  })

  it("retains items when sync fails", async () => {
    useAttention.getState().loadSnapshot([sampleItem()])
    const info: ServerInfo = { port: 1, token: "t", pid: 1 }
    const api = makeApi(info)
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    await useAttention.getState().syncWorkspace(api, "w2")
    expect(useAttention.getState().isRaised("w2")).toBe(true)
  })

  it("acks visible tab and removes item on success", async () => {
    useAttention.getState().loadSnapshot([sampleItem({ workspaceId: "w1", tabId: "t1", id: "att-visible" })])
    const info: ServerInfo = { port: 1, token: "t", pid: 1 }
    const api = makeApi(info)
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/attention/att-visible/ack") && init?.method === "POST")
        return new Response(JSON.stringify(sampleItem({ id: "att-visible", state: "acknowledged", acknowledgedAt: 2 })), { status: 200 })
      return new Response("{}", { status: 404 })
    }))
    await useAttention.getState().tryAckVisible(api, "w1", "t1")
    expect(useAttention.getState().isRaised("w1")).toBe(false)
  })

  it("removes acknowledged items from SSE", () => {
    useAttention.getState().loadSnapshot([sampleItem()])
    useData.getState().applyEvent({
      seq: 9,
      workspaceId: "w2",
      type: "attention.acknowledged",
      payload: { id: "att-1", tabId: "t2", kind: "turn-finished" },
      ts: 2,
    })
    expect(useAttention.getState().count()).toBe(0)
  })

  it("is safe when no DOM exists", async () => {
    vi.stubGlobal("document", undefined)
    const info: ServerInfo = { port: 1, token: "t", pid: 1 }
    useData.getState().setApi(makeApi(info))
    await expect(useData.getState().applyEvent({
      seq: 5, workspaceId: "w1", type: "tab.status.changed",
      payload: { status: "awaiting-input" }, ts: 1,
    })).resolves.toBeUndefined()
  })
})
