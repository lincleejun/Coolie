import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import {
  createWorkspaceSerial,
  drainWorkspace,
  resumeQueuedWorkspaces,
  startQueueDrainer,
  type DrainDeps,
} from "../src/engine/queue-drain.js"
import { EVENT_CHANNEL } from "../src/events/bus.js"

const deps = (overrides: Partial<DrainDeps> = {}): DrainDeps => ({
  resolveEngineTab: async () => ({
    tab: { id: "t1", status: "awaiting-input", tmuxWindow: 0 } as any,
    wsActive: true,
    nativeQueue: false,
  }),
  claimNext: async () => ({ id: 7, workspaceId: "w1", tabId: "t1", text: "下一条", mode: "send", state: "inflight", createdAt: 1 }),
  release: async () => {},
  deliver: async () => {},
  markWorking: async () => {},
  onDelivered: async () => {},
  onFailed: async () => {},
  ...overrides,
})

describe("queue drainer", () => {
  it("delivers exactly one oldest prompt on turn completion", async () => {
    const deliver = vi.fn(async () => {})
    const markWorking = vi.fn(async () => {})
    const onDelivered = vi.fn(async () => {})
    expect(await drainWorkspace(deps({ deliver, markWorking, onDelivered }), "w1")).toBe(true)
    expect(deliver).toHaveBeenCalledWith("coolie-w1:0", "下一条")
    expect(markWorking).toHaveBeenCalledWith("t1")
    expect(onDelivered).toHaveBeenCalledWith(7)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("retains failed prompt and records a failure event", async () => {
    const onDelivered = vi.fn(async () => {})
    const onFailed = vi.fn(async () => {})
    const error = new Error("tmux failed")
    expect(await drainWorkspace(deps({ deliver: async () => { throw error }, onDelivered, onFailed }), "w1")).toBe(false)
    expect(onDelivered).not.toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalledWith("w1", 7, error)
  })

  it("does not drain working, archived, or nativeQueue workspaces", async () => {
    const deliver = vi.fn(async () => {})
    for (const resolved of [
      { tab: { status: "working" }, wsActive: true, nativeQueue: false },
      { tab: { status: "awaiting-input" }, wsActive: false, nativeQueue: false },
      { tab: { status: "awaiting-input" }, wsActive: true, nativeQueue: true },
    ]) {
      expect(await drainWorkspace(deps({ resolveEngineTab: async () => resolved as any, deliver }), "w1")).toBe(false)
    }
    expect(deliver).not.toHaveBeenCalled()
  })

  it("only drains a real awaiting-input edge, never idle", async () => {
    const bus = new EventEmitter()
    const deliver = vi.fn(async () => {})
    const stop = startQueueDrainer(bus, deps({ deliver }))
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "idle" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deliver).not.toHaveBeenCalled()
    stop()
  })

  it("rechecks awaiting-input after claiming and releases when the edge went stale", async () => {
    const deliver = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    let reads = 0
    const resolveEngineTab = async () => ({
      tab: { id: "t1", status: ++reads === 1 ? "awaiting-input" : "idle", tmuxWindow: 0 } as any,
      wsActive: true,
      nativeQueue: false,
    })
    expect(await drainWorkspace(deps({ resolveEngineTab, deliver, release }), "w1")).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith(7)
  })

  it("subscribes to awaiting-input and can be stopped", async () => {
    const bus = new EventEmitter()
    const deliver = vi.fn(async () => {})
    const stop = startQueueDrainer(bus, deps({ deliver }))
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "working" } })
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "awaiting-input" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deliver).toHaveBeenCalledTimes(1)
    stop()
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "awaiting-input" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("interrupt 的乐观 awaiting-input 不触发队列投递", async () => {
    const bus = new EventEmitter()
    const deliver = vi.fn(async () => {})
    const stop = startQueueDrainer(bus, deps({ deliver }))
    bus.emit(EVENT_CHANNEL, {
      type: "tab.status.changed",
      workspaceId: "w1",
      payload: { status: "awaiting-input", source: "interrupt" },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deliver).not.toHaveBeenCalled()
    stop()
  })

  it("recovers restart inflight rows and scans existing queued workspaces once", async () => {
    const recoverInflight = vi.fn(async () => 1)
    const deliver = vi.fn(async () => {})
    await resumeQueuedWorkspaces(
      createWorkspaceSerial(),
      deps({ deliver }),
      { recoverInflight, listWorkspaceIds: async () => ["w1"] },
    )
    expect(recoverInflight).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledOnce()
  })

  it("recovers every exact engine-tab queue target after restart", async () => {
    const resolveEngineTab = vi.fn(async (_workspaceId: string, tabId?: string) => ({
      tab: { id: tabId, status: "awaiting-input", tmuxWindow: tabId === "t1" ? 1 : 2 } as any,
      wsActive: true,
      nativeQueue: false,
    }))
    const claimNext = vi.fn(async (workspaceId: string, tabId?: string) => ({
      id: tabId === "t1" ? 1 : 2,
      workspaceId,
      tabId: tabId!,
      text: tabId!,
      mode: "send" as const,
      state: "inflight" as const,
      createdAt: 1,
    }))
    const deliver = vi.fn(async () => {})
    await resumeQueuedWorkspaces(
      createWorkspaceSerial(),
      deps({ resolveEngineTab, claimNext, deliver }),
      {
        recoverInflight: async () => 0,
        listWorkspaceIds: async () => ["w1"],
        listTargets: async () => [
          { workspaceId: "w1", tabId: "t1" },
          { workspaceId: "w1", tabId: "t2" },
        ],
      },
    )
    expect(deliver.mock.calls).toEqual([
      ["coolie-w1:1", "t1"],
      ["coolie-w1:2", "t2"],
    ])
  })

  it("serializes one workspace without blocking another", async () => {
    const serial = createWorkspaceSerial()
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const first = serial.run("w1", async () => { await gate; return "first" })
    const second = serial.run("w1", async () => "second")
    await expect(serial.run("w2", async () => "other")).resolves.toBe("other")
    open()
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
  })
})
