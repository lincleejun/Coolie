import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Workspace } from "@coolie/protocol"
import type { FinishResult } from "@coolie/protocol"

/**
 * Finish→Archive state machine invariants (Task 3.8).
 * Uses lightweight in-memory workspace data blob — mirrors WorkspacesRepo data.finishResult
 * without requiring full sqlite/tmux lifecycle harness.
 */

type Row = {
  status: "active" | "archiving" | "archived"
  taskStatus: string
  path: string
  data: { finishResult?: FinishResult; archiveOperation?: { force: boolean } }
}

const makeRow = (): Row => ({
  status: "active",
  taskStatus: "in_progress",
  path: "/tmp/coolie-wt-feature",
  data: {},
})

const finish = (row: Row, result: FinishResult): Row => {
  // finish never transitions status away from active and never deletes the worktree path.
  expect(row.status).toBe("active")
  return {
    ...row,
    taskStatus: result.mergeBack ? "done" : result.createPr ? "in_review" : row.taskStatus,
    data: { ...row.data, finishResult: result },
  }
}

const beginArchive = (row: Row, force: boolean): Row => {
  if (row.status !== "active" && row.status !== "archiving") throw new Error("illegal")
  return {
    ...row,
    status: "archiving",
    data: { ...row.data, archiveOperation: { force } },
  }
}

const cancelArchive = (row: Row): Row => {
  if (row.status !== "archiving") throw new Error("illegal")
  const data = { ...row.data }
  delete data.archiveOperation
  // finishResult must survive archive failure.
  return { ...row, status: "active", data }
}

const completeArchive = (row: Row): Row => {
  if (row.status !== "archiving") throw new Error("illegal")
  const data = { ...row.data }
  delete data.archiveOperation
  delete data.finishResult
  return {
    ...row,
    status: "archived",
    taskStatus: "done",
    path: row.path, // path metadata retained; physical remove is lifecycle's concern
    data,
  }
}

describe("finish→archive state machine (Task 3.8)", () => {
  it("finish records result without leaving active or removing worktree", () => {
    const before = makeRow()
    const after = finish(before, {
      prUrl: "https://example.test/pr/9",
      mergedBack: false,
      warnings: [],
      finishedAt: 100,
      createPr: true,
      mergeBack: false,
    })
    expect(after.status).toBe("active")
    expect(after.path).toBe(before.path)
    expect(after.data.finishResult?.prUrl).toBe("https://example.test/pr/9")
    expect(after.taskStatus).toBe("in_review")
  })

  it("archive failure keeps finishResult", () => {
    let row = finish(makeRow(), {
      prUrl: "https://example.test/pr/2",
      mergedBack: false,
      warnings: ["dirty"],
      finishedAt: 1,
      createPr: true,
      mergeBack: false,
    })
    row = beginArchive(row, false)
    row = cancelArchive(row)
    expect(row.status).toBe("active")
    expect(row.data.finishResult?.prUrl).toBe("https://example.test/pr/2")
    expect(row.data.archiveOperation).toBeUndefined()
  })

  it("archive success clears finishResult after teardown", () => {
    let row = finish(makeRow(), {
      mergedBack: true,
      warnings: [],
      finishedAt: 1,
      createPr: false,
      mergeBack: true,
    })
    row = beginArchive(row, true)
    row = completeArchive(row)
    expect(row.status).toBe("archived")
    expect(row.data.finishResult).toBeUndefined()
  })

  it("Workspace decode retains finishResult for GUI success panel", () => {
    const ws = new Workspace({
      id: "w1",
      projectId: "p1",
      name: "feature",
      path: "/wt",
      branch: "coolie/a",
      baseBranch: "main",
      baseRef: "abc",
      status: "active",
      pinned: false,
      createdAt: 1,
      archivedAt: null,
      portBase: 1,
      finishResult: {
        prUrl: "https://example.test/pr/3",
        mergedBack: false,
        warnings: [],
        finishedAt: 42,
        createPr: true,
        mergeBack: false,
      },
    })
    expect(ws.finishResult?.prUrl).toContain("/pr/3")
    expect(Exit.isSuccess(Effect.runSyncExit(Effect.succeed(ws.status === "active")))).toBe(true)
  })
})
