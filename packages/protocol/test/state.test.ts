import { describe, expect, it } from "vitest"
import {
  ROUTES,
  decodeCoolieStateSnapshot,
  emptyCoolieStateSnapshot,
  QUEUE_DELIVERY_GUARANTEE,
} from "../src/index.js"

const baseWorkspace = {
  id: "w1",
  projectId: "p1",
  name: "usa-yellowstone",
  path: "/tmp/ws",
  branch: "coolie/fix-x",
  baseBranch: "main",
  baseRef: "abc123",
  status: "active" as const,
  pinned: false,
  createdAt: 1,
  archivedAt: null,
  portBase: 40000,
}

const baseTab = {
  id: "t1",
  workspaceId: "w1",
  kind: "engine" as const,
  engineId: "claude",
  engineSessionId: "sess-1",
  tmuxWindow: 1,
  title: "Claude",
  status: "idle" as const,
  lastHookAt: null,
}

const baseAttention = {
  id: "a1",
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

const baseRun = {
  id: "run-1",
  workspaceId: "w1",
  runId: "dev-server",
  scriptType: "run" as const,
  status: "running" as const,
  startedAt: 200,
  exitedAt: null,
  exitCode: null,
}

const baseQueuedPrompt = {
  id: 1,
  queueId: 1,
  messageId: "queue:1",
  tabId: "t1",
  text: "hello",
  mode: "send" as const,
  createdAt: 50,
  position: 1,
  deliveryGuarantee: QUEUE_DELIVERY_GUARANTEE,
}

describe("CoolieStateSnapshot protocol", () => {
  it("round-trips a populated snapshot", () => {
    const snapshot = decodeCoolieStateSnapshot({
      asOfSeq: 99,
      generatedAt: 1720000000000,
      scope: { workspaceId: "w1" },
      projects: [{
        id: "p1",
        name: "Coolie",
        repoRoot: "/tmp/repo",
        defaultBaseBranch: "main",
        createdAt: 1,
      }],
      workspaces: [baseWorkspace],
      tabs: [baseTab],
      openAttention: [baseAttention],
      queuedPrompts: [baseQueuedPrompt],
      activeRuns: [baseRun],
    })
    expect(snapshot.asOfSeq).toBe(99)
    expect(snapshot.scope?.workspaceId).toBe("w1")
    expect(snapshot.workspaces[0]!.branch).toBe("coolie/fix-x")
    expect(snapshot.openAttention[0]!.kind).toBe("turn-finished")
    expect(snapshot.queuedPrompts[0]!.deliveryGuarantee).toBe("at-least-once")
    expect(snapshot.activeRuns[0]!.runId).toBe("dev-server")
  })

  it("accepts an empty snapshot baseline", () => {
    const snapshot = emptyCoolieStateSnapshot(0, 1720000000000)
    expect(snapshot.asOfSeq).toBe(0)
    expect(snapshot.projects).toEqual([])
    expect(snapshot.openAttention).toEqual([])
    expect(snapshot.activeRuns).toEqual([])
  })

  it("rejects negative asOfSeq", () => {
    expect(() => decodeCoolieStateSnapshot({
      asOfSeq: -1,
      generatedAt: 1,
      scope: null,
      projects: [],
      workspaces: [],
      tabs: [],
      openAttention: [],
      queuedPrompts: [],
      activeRuns: [],
    })).toThrow(/asOfSeq/)
  })

  it("rejects open attention with acknowledgedAt", () => {
    expect(() => decodeCoolieStateSnapshot({
      asOfSeq: 1,
      generatedAt: 1,
      scope: null,
      projects: [],
      workspaces: [],
      tabs: [],
      openAttention: [{ ...baseAttention, acknowledgedAt: 101 }],
      queuedPrompts: [],
      activeRuns: [],
    })).toThrow(/acknowledgedAt/)
  })

  it("rejects running run with exit metadata", () => {
    expect(() => decodeCoolieStateSnapshot({
      asOfSeq: 1,
      generatedAt: 1,
      scope: null,
      projects: [],
      workspaces: [],
      tabs: [],
      openAttention: [],
      queuedPrompts: [],
      activeRuns: [{ ...baseRun, exitedAt: 300, exitCode: 0 }],
    })).toThrow(/exit metadata/)
  })

  it("rejects invalid attention kind", () => {
    expect(() => decodeCoolieStateSnapshot({
      asOfSeq: 1,
      generatedAt: 1,
      scope: null,
      projects: [],
      workspaces: [],
      tabs: [],
      openAttention: [{ ...baseAttention, kind: "unknown" }],
      queuedPrompts: [],
      activeRuns: [],
    })).toThrow()
  })
})

describe("GET /state route schema", () => {
  it("declares explicit request/response shapes", () => {
    const route = ROUTES.find((entry) => entry.method === "GET" && entry.path === "/state")
    expect(route).toBeDefined()
    expect(route!.request).toBe("query: workspace?")
    expect(route!.response).toContain("CoolieStateSnapshot")
    expect(route!.example).toBe("GET /state?workspace=WORKSPACE_ID")
  })
})
