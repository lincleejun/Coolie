import { describe, expect, it, vi } from "vitest"
import { BackgroundCollector } from "../src/collector/background.js"
import {
  ChecksCollector,
  classifyGhFailure,
  classifyGitPorcelain,
  collectCiStatus,
  projectWorkspaceChecks,
} from "../src/workspace/checks.js"

describe("local checks classifiers (Task 3.7)", () => {
  it("classifies clean, dirty, and conflict porcelain", () => {
    expect(classifyGitPorcelain("")).toEqual({ kind: "clean" })
    expect(classifyGitPorcelain(" M src/a.ts\0")).toEqual({ kind: "dirty", paths: 1 })
    expect(classifyGitPorcelain("UU src/a.ts\0 M src/b.ts\0")).toEqual({ kind: "conflict", paths: 1 })
    expect(classifyGitPorcelain("", { rebaseInProgress: true })).toEqual({ kind: "rebase" })
  })

  it("classifies gh failures as unavailable without aborting", () => {
    expect(classifyGhFailure(new Error("spawn gh ENOENT"))).toEqual({
      status: "unavailable", detail: "gh CLI unavailable",
    })
    expect(classifyGhFailure(new Error("not logged in"))).toMatchObject({ status: "unavailable" })
    expect(classifyGhFailure(new Error("HTTP 502"))).toMatchObject({ status: "unavailable" })
  })

  it("collectCiStatus degrades when gh is missing", async () => {
    const run = vi.fn(async () => { throw new Error("spawn gh ENOENT") })
    const result = await collectCiStatus("/tmp/ws", 12, run)
    expect(result.status).toBe("unavailable")
    expect(result.detail).toBe("gh CLI unavailable")
  })

  it("projects checks with status, time, and action per item", () => {
    const snap = projectWorkspaceChecks({
      workspaceId: "w1",
      status: "active",
      branch: "coolie/a",
      baseBranch: "main",
      baseRef: "abc123def",
      collectedAt: 1000,
      git: { kind: "dirty", paths: 3 },
      runs: [{
        id: "run-w1-test", workspaceId: "w1", runId: "test", scriptType: "run",
        status: "error", startedAt: 900, exitedAt: 950, exitCode: 1,
      }],
      pullRequest: null,
      ci: { status: "unavailable", detail: "gh CLI unavailable", updatedAt: 1000 },
      unsentComments: 2,
    })
    expect(snap.degraded).toBe(true)
    expect(snap.items.map((i) => i.id)).toEqual(expect.arrayContaining([
      "git-dirty", "branch-head", "run-test", "pr-missing", "ci", "comments",
    ]))
    for (const item of snap.items) {
      expect(item.updatedAt).toBeTypeOf("number")
      expect(item.status).toBeTruthy()
      expect(item.label).toBeTruthy()
    }
    expect(snap.items.find((i) => i.id === "git-dirty")?.action?.kind).toBe("view-diff")
    expect(snap.items.find((i) => i.id === "ci")?.status).toBe("unavailable")
  })

  it("skips archived workspaces without error spam", () => {
    const snap = projectWorkspaceChecks({
      workspaceId: "w-arch",
      status: "archived",
      branch: "coolie/a",
      baseBranch: "main",
      baseRef: "abc",
      git: { kind: "unavailable", message: "should not matter" },
      runs: [],
      pullRequest: null,
      unsentComments: 0,
    })
    expect(snap.items).toHaveLength(1)
    expect(snap.items[0]?.status).toBe("skipped")
  })
})

describe("checks / collector in-flight dedupe (Task 3.7)", () => {
  it("dedupes overlapping ChecksCollector ticks", async () => {
    let calls = 0
    const collector = new ChecksCollector(async (id) => {
      calls += 1
      await new Promise((r) => setTimeout(r, 30))
      return projectWorkspaceChecks({
        workspaceId: id,
        status: "active",
        branch: "b",
        baseBranch: "main",
        baseRef: "r",
        git: { kind: "clean" },
        runs: [],
        pullRequest: null,
        ci: { status: "unavailable" },
        unsentComments: 0,
        collectedAt: 1,
      })
    })
    const [a, b] = await Promise.all([collector.collect("w1"), collector.collect("w1")])
    expect(calls).toBe(1)
    expect(a).toEqual(b)
  })

  it("dedupes overlapping BackgroundCollector ticks and skips archived probes", async () => {
    const archived = {
      id: "arch-1", path: "/tmp/arch", branch: "coolie/a", baseRef: "main",
      status: "archived", taskStatus: "done",
    }
    const active = {
      id: "task-1", path: "/tmp/task", branch: "coolie/t", baseRef: "main",
      status: "active", taskStatus: "in_progress",
    }
    let diffCalls = 0
    let prCalls = 0
    let gate: (() => void) | undefined
    const blocker = new Promise<void>((resolve) => { gate = resolve })
    const collector = new BackgroundCollector({
      listWorkspaces: async () => [archived, active],
      diffstat: async () => {
        diffCalls += 1
        await blocker
        return { filesChanged: 0, insertions: 0, deletions: 0 }
      },
      pullRequest: async () => {
        prCalls += 1
        return null
      },
      transcript: async () => ({ active: false, updatedAt: null, title: null }),
      appendEvent: async () => {},
      now: () => 42,
    })

    const p1 = collector.collect()
    const p2 = collector.collect()
    gate!()
    const [s1, s2] = await Promise.all([p1, p2])
    expect(s1).toEqual(s2)
    expect(diffCalls).toBe(1)
    expect(prCalls).toBe(1)
    const arch = s1.find((s) => s.workspaceId === "arch-1")
    expect(arch?.errors).toEqual([])
    expect(arch?.diffstat).toBeNull()
  })
})
