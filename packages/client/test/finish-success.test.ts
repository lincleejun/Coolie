import { describe, expect, it } from "vitest"
import { Workspace } from "@coolie/protocol"

/** Pure helpers mirroring FinishSuccessPanel visibility rules (Task 3.8). */
const shouldShowFinishSuccess = (ws: Workspace | undefined): boolean =>
  !!ws && ws.status === "active" && ws.finishResult !== null && ws.finishResult !== undefined

const finishActions = (ws: Workspace): readonly string[] => {
  const actions = ["archive", "keepWorking", "viewChecks"]
  if (ws.finishResult?.prUrl) return ["openPr", ...actions]
  return actions
}

describe("FinishSuccessPanel rules (Task 3.8)", () => {
  const base = {
    id: "w1",
    projectId: "p1",
    name: "zion",
    path: "/tmp/zion",
    branch: "coolie/zion",
    baseBranch: "main",
    baseRef: "abc",
    pinned: false,
    createdAt: 1,
    archivedAt: null,
    portBase: 1,
  }

  it("shows success panel only for active workspaces with finishResult", () => {
    const withResult = new Workspace({
      ...base,
      status: "active",
      finishResult: {
        prUrl: "https://example.test/pr/1",
        mergedBack: false,
        warnings: [],
        finishedAt: 1,
        createPr: true,
        mergeBack: false,
      },
    })
    expect(shouldShowFinishSuccess(withResult)).toBe(true)
    expect(finishActions(withResult)).toEqual(["openPr", "archive", "keepWorking", "viewChecks"])

    const mergeOnly = new Workspace({
      ...base,
      status: "active",
      finishResult: {
        mergedBack: true,
        warnings: [],
        finishedAt: 1,
        createPr: false,
        mergeBack: true,
      },
    })
    expect(finishActions(mergeOnly)).toEqual(["archive", "keepWorking", "viewChecks"])

    expect(shouldShowFinishSuccess(new Workspace({ ...base, status: "active", finishResult: null }))).toBe(false)
    expect(shouldShowFinishSuccess(new Workspace({
      ...base,
      status: "archived",
      finishResult: {
        prUrl: "https://example.test/pr/1",
        mergedBack: false,
        warnings: [],
        finishedAt: 1,
        createPr: true,
        mergeBack: false,
      },
    }))).toBe(false)
  })
})
