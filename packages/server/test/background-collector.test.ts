import { describe, expect, it, vi } from "vitest"
import { BackgroundCollector, collectPullRequest } from "../src/collector/background.js"

const workspace = {
  id: "task-1", path: "/tmp/task-1", branch: "coolie/task-1", baseRef: "main",
  status: "active", taskStatus: "in_progress",
}

describe("background collector", () => {
  it("aggregates snapshots and emits durable events only when values change", async () => {
    const appendEvent = vi.fn(async () => {})
    const collector = new BackgroundCollector({
      listWorkspaces: async () => [workspace],
      diffstat: async () => ({ filesChanged: 2, insertions: 3, deletions: 1 }),
      pullRequest: async () => ({ number: 7, state: "OPEN", url: "https://example/pr/7", title: "Task" }),
      transcript: async () => ({ active: true, updatedAt: 100, title: "Task" }),
      appendEvent,
      now: () => 123,
    })

    expect(await collector.collect()).toEqual([expect.objectContaining({ workspaceId: "task-1", collectedAt: 123 })])
    await collector.collect()
    expect(appendEvent).toHaveBeenCalledTimes(1)
  })

  it("degrades individual collector failures without dropping the task", async () => {
    const collector = new BackgroundCollector({
      listWorkspaces: async () => [workspace],
      diffstat: async () => { throw new Error("git unavailable") },
      pullRequest: async () => null,
      transcript: async () => { throw new Error("missing transcript") },
      appendEvent: async () => {},
    })
    const [snapshot] = await collector.collect()
    expect(snapshot?.diffstat).toBeNull()
    expect(snapshot?.errors).toEqual(expect.arrayContaining([
      "diffstat: git unavailable", "transcript: missing transcript",
    ]))
  })

  it("prunes deleted workspaces only on full passes, including fingerprints", async () => {
    const other = { ...workspace, id: "task-2", path: "/tmp/task-2", branch: "coolie/task-2" }
    let listed = [workspace, other]
    const appendEvent = vi.fn(async () => {})
    const collector = new BackgroundCollector({
      listWorkspaces: async () => listed,
      diffstat: async () => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
      pullRequest: async () => null,
      transcript: async () => ({ active: false, updatedAt: null, title: null }),
      appendEvent,
      now: () => 123,
    })

    await collector.collect()
    listed = [other]
    await collector.collect("task-2")
    expect(collector.snapshots().map((snapshot) => snapshot.workspaceId)).toEqual(["task-1", "task-2"])

    await collector.collect()
    expect(collector.snapshots().map((snapshot) => snapshot.workspaceId)).toEqual(["task-2"])

    listed = [workspace, other]
    await collector.collect()
    expect(appendEvent).toHaveBeenCalledTimes(3)
  })

  it("invokes gh with argv and a bounded timeout", async () => {
    const run = vi.fn(async () => '[{"number":2,"state":"OPEN","url":"u","title":"t"}]')
    expect(await collectPullRequest(workspace, run, 321)).toEqual(expect.objectContaining({ number: 2 }))
    expect(run).toHaveBeenCalledWith("gh", expect.arrayContaining(["--head", "coolie/task-1"]), {
      cwd: "/tmp/task-1", timeoutMs: 321,
    })
  })
})
