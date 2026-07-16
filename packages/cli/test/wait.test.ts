import { describe, expect, it, vi } from "vitest"
import {
  decodeCoolieStateSnapshot,
  emptyCoolieStateSnapshot,
  type CoolieStateSnapshot,
  type Tab,
} from "@coolie/protocol"
import {
  matchesWaitCondition,
  parseWaitTimeout,
  waitForWorkspace,
  WAIT_EXIT,
  WaitValidationError,
  type WaitDeps,
} from "../src/wait.js"

const tab = (overrides: Partial<Tab> & Pick<Tab, "id" | "workspaceId" | "status">): Tab =>
  ({
    kind: "engine",
    engineId: "claude",
    engineSessionId: "sess",
    tmuxWindow: 0,
    title: "engine",
    lastHookAt: null,
    ...overrides,
  }) as Tab

const baseWorkspace = {
  id: "w1",
  projectId: "p1",
  name: "task",
  path: "/tmp/ws",
  branch: "main",
  baseBranch: "main",
  baseRef: "abc",
  status: "active" as const,
  pinned: false,
  createdAt: 1,
  archivedAt: null,
  portBase: 40_000,
}

const snapshot = (overrides: Partial<CoolieStateSnapshot> & { workspaceId?: string }): CoolieStateSnapshot => {
  const workspaceId = overrides.workspaceId ?? "w1"
  const base = emptyCoolieStateSnapshot(overrides.asOfSeq ?? 1, overrides.generatedAt ?? 1_000)
  return decodeCoolieStateSnapshot({
    ...base,
    ...overrides,
    scope: { workspaceId },
    workspaces: overrides.workspaces ?? [{ ...baseWorkspace, id: workspaceId }],
    tabs: overrides.tabs ?? [],
    openAttention: overrides.openAttention ?? [],
  })
}

describe("parseWaitTimeout", () => {
  it("accepts plain milliseconds and duration suffixes", () => {
    expect(parseWaitTimeout("500")).toBe(500)
    expect(parseWaitTimeout("30s")).toBe(30_000)
    expect(parseWaitTimeout("2m")).toBe(120_000)
  })

  it("rejects invalid durations", () => {
    expect(() => parseWaitTimeout("")).toThrow(WaitValidationError)
    expect(() => parseWaitTimeout("nope")).toThrow(/invalid timeout/)
    expect(() => parseWaitTimeout("0s")).toThrow(/invalid timeout/)
  })
})

describe("matchesWaitCondition", () => {
  it("matches attention from open inbox items or awaiting-input tabs", () => {
    const ws = "w1"
    expect(matchesWaitCondition(snapshot({ workspaceId: ws, tabs: [tab({ id: "t1", workspaceId: ws, status: "working" })] }), ws, "attention")).toBe(false)
    expect(matchesWaitCondition(snapshot({
      workspaceId: ws,
      tabs: [tab({ id: "t1", workspaceId: ws, status: "awaiting-input" })],
    }), ws, "attention")).toBe(true)
    expect(matchesWaitCondition(snapshot({
      workspaceId: ws,
      openAttention: [{
        id: "a1", workspaceId: ws, tabId: "t1", kind: "turn-finished", source: "hook",
        sourceEventSeq: 1, sessionTurnId: null, summary: "done", state: "open",
        createdAt: 1, acknowledgedAt: null,
      }],
    }), ws, "attention")).toBe(true)
  })

  it("matches idle only when every engine tab is idle", () => {
    const ws = "w1"
    expect(matchesWaitCondition(snapshot({ workspaceId: ws, tabs: [] }), ws, "idle")).toBe(false)
    expect(matchesWaitCondition(snapshot({
      workspaceId: ws,
      tabs: [
        tab({ id: "t1", workspaceId: ws, status: "idle" }),
        tab({ id: "t2", workspaceId: ws, status: "working" }),
      ],
    }), ws, "idle")).toBe(false)
    expect(matchesWaitCondition(snapshot({
      workspaceId: ws,
      tabs: [tab({ id: "t1", workspaceId: ws, status: "idle" })],
    }), ws, "idle")).toBe(true)
  })

  it("matches error from tab status or error attention", () => {
    const ws = "w1"
    expect(matchesWaitCondition(snapshot({
      workspaceId: ws,
      tabs: [tab({ id: "t1", workspaceId: ws, status: "error" })],
    }), ws, "error")).toBe(true)
    expect(matchesWaitCondition(snapshot({
      workspaceId: ws,
      openAttention: [{
        id: "a1", workspaceId: ws, tabId: "t1", kind: "error", source: "hook",
        sourceEventSeq: 1, sessionTurnId: null, summary: "boom", state: "open",
        createdAt: 1, acknowledgedAt: null,
      }],
    }), ws, "error")).toBe(true)
  })
})

describe("waitForWorkspace", () => {
  it("returns immediately when the initial snapshot already matches", async () => {
    const ws = "w1"
    const deps: WaitDeps = {
      fetchSnapshot: vi.fn(async () => snapshot({
        workspaceId: ws,
        asOfSeq: 7,
        generatedAt: 42,
        tabs: [tab({ id: "t1", workspaceId: ws, status: "idle" })],
      })),
      streamAfter: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => 0),
    }

    const result = await waitForWorkspace({ workspaceId: ws, waitFor: "idle", timeoutMs: 1_000, deps })
    expect(result.ok).toBe(true)
    expect(result.asOfSeq).toBe(7)
    expect(deps.streamAfter).not.toHaveBeenCalled()
  })

  it("does not miss events that land between snapshot and subscribe", async () => {
    const ws = "w1"
    let current = snapshot({
      workspaceId: ws,
      asOfSeq: 3,
      generatedAt: 10,
      tabs: [tab({ id: "t1", workspaceId: ws, status: "working" })],
    })
    let subscribedAfter = -1
    const deps: WaitDeps = {
      fetchSnapshot: vi.fn(async () => current),
      streamAfter: vi.fn(async (after, workspaceId, onActivity, signal) => {
        subscribedAfter = after
        expect(workspaceId).toBe(ws)
        current = snapshot({
          workspaceId: ws,
          asOfSeq: 4,
          generatedAt: 11,
          tabs: [tab({ id: "t1", workspaceId: ws, status: "idle" })],
        })
        onActivity()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => 0),
    }

    const result = await waitForWorkspace({ workspaceId: ws, waitFor: "idle", timeoutMs: 1_000, deps })
    expect(subscribedAfter).toBe(3)
    expect(result.ok).toBe(true)
    expect(result.asOfSeq).toBe(4)
  })

  it("handles multiple stream activity callbacks before matching", async () => {
    const ws = "w1"
    let current = snapshot({
      workspaceId: ws,
      asOfSeq: 5,
      tabs: [tab({ id: "t1", workspaceId: ws, status: "working" })],
    })
    const activitySeqs: number[] = []
    const deps: WaitDeps = {
      fetchSnapshot: vi.fn(async () => current),
      streamAfter: vi.fn(async (after, _workspaceId, onActivity, signal) => {
        expect(after).toBe(5)
        current = snapshot({
          workspaceId: ws,
          asOfSeq: 6,
          tabs: [tab({ id: "t1", workspaceId: ws, status: "working" })],
        })
        onActivity()
        activitySeqs.push(current.asOfSeq)
        current = snapshot({
          workspaceId: ws,
          asOfSeq: 7,
          tabs: [tab({ id: "t1", workspaceId: ws, status: "idle" })],
        })
        onActivity()
        activitySeqs.push(current.asOfSeq)
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => 0),
    }

    const result = await waitForWorkspace({ workspaceId: ws, waitFor: "idle", timeoutMs: 2_000, deps })
    expect(activitySeqs).toEqual([6, 7])
    expect(result.ok).toBe(true)
    expect(result.asOfSeq).toBe(7)
  })

  it("returns timeout when the deadline passes", async () => {
    const ws = "w1"
    const busy = snapshot({
      workspaceId: ws,
      tabs: [tab({ id: "t1", workspaceId: ws, status: "working" })],
    })
    const now = vi.fn()
    now.mockReturnValueOnce(0).mockReturnValue(20)
    const deps: WaitDeps = {
      fetchSnapshot: vi.fn(async () => busy),
      streamAfter: vi.fn(async (_after, _ws, _onActivity, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }),
      sleep: vi.fn(async () => {}),
      now,
    }

    const timeout = await waitForWorkspace({ workspaceId: ws, waitFor: "idle", timeoutMs: 10, deps })
    expect(timeout.ok).toBe(false)
    expect(timeout.reason).toBe("timeout")
  })

  it("returns aborted when the caller signal is canceled", async () => {
    const ws = "w1"
    const busy = snapshot({
      workspaceId: ws,
      tabs: [tab({ id: "t1", workspaceId: ws, status: "working" })],
    })
    const controller = new AbortController()
    const deps: WaitDeps = {
      fetchSnapshot: vi.fn(async () => busy),
      streamAfter: vi.fn(async (_after, _ws, _onActivity, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => 0),
    }
    const pending = waitForWorkspace({
      workspaceId: ws,
      waitFor: "idle",
      timeoutMs: 1_000,
      signal: controller.signal,
      deps,
    })
    await Promise.resolve()
    controller.abort()
    const aborted = await pending
    expect(aborted.ok).toBe(false)
    expect(aborted.reason).toBe("aborted")
  })
})

describe("WAIT_EXIT", () => {
  it("documents stable CLI exit codes", () => {
    expect(WAIT_EXIT.matched).toBe(0)
    expect(WAIT_EXIT.timeout).toBe(1)
    expect(WAIT_EXIT.invalid).toBe(2)
    expect(WAIT_EXIT.aborted).toBe(130)
  })
})
