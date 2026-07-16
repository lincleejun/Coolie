import { Effect } from "effect"
import type { WorkspaceChecksSnapshot } from "@coolie/protocol"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { RunManager } from "../runs/manager.js"
import { ConflictError, NotFoundError } from "../repo/errors.js"
import type { BackgroundCollector } from "../collector/background.js"
import {
  collectCiStatus,
  projectWorkspaceChecks,
  readGitPorcelain,
} from "../workspace/checks.js"
import type { AppServices } from "./app.js"

/** In-flight dedupe for overlapping GET /workspaces/:id/checks. */
const inflight = new Map<string, Promise<WorkspaceChecksSnapshot>>()

export const collectWorkspaceChecksEffect = (
  workspaceId: string,
  opts: {
    readonly unsentComments: number
    readonly collector?: Pick<BackgroundCollector, "collect" | "snapshots">
  },
): Effect.Effect<WorkspaceChecksSnapshot, ConflictError | NotFoundError, AppServices> =>
  Effect.gen(function* () {
    const ws = yield* (yield* WorkspacesRepo).get(workspaceId)

    if (ws.status === "archived" || ws.status === "archiving") {
      return projectWorkspaceChecks({
        workspaceId: ws.id,
        status: ws.status,
        branch: ws.branch,
        baseBranch: ws.baseBranch,
        baseRef: ws.baseRef,
        git: { kind: "clean" },
        runs: [],
        pullRequest: null,
        ci: { status: "skipped", detail: "archived" },
        unsentComments: 0,
      })
    }
    if (ws.status !== "active")
      return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })

    const existing = inflight.get(workspaceId)
    if (existing) return yield* Effect.promise(() => existing)

    const runs = yield* (yield* RunManager).list(workspaceId)
    const unsentComments = opts.unsentComments
    const collector = opts.collector

    const promise = (async (): Promise<WorkspaceChecksSnapshot> => {
      const git = await readGitPorcelain(ws.path)
      let pullRequest = collector?.snapshots().find((s) => s.workspaceId === workspaceId)?.pullRequest ?? null
      if (pullRequest === null && collector) {
        try {
          const snaps = await collector.collect(workspaceId)
          pullRequest = snaps[0]?.pullRequest ?? null
        } catch { /* degrade without aborting local checks */ }
      }
      const ci = await collectCiStatus(ws.path, pullRequest?.number ?? null)
      return projectWorkspaceChecks({
        workspaceId: ws.id,
        status: ws.status,
        branch: ws.branch,
        baseBranch: ws.baseBranch,
        baseRef: ws.baseRef,
        git,
        runs,
        pullRequest,
        ci,
        unsentComments,
      })
    })()

    inflight.set(workspaceId, promise)
    try {
      return yield* Effect.promise(() => promise)
    } finally {
      if (inflight.get(workspaceId) === promise) inflight.delete(workspaceId)
    }
  })
