import { Effect } from "effect"
import { RunManager } from "../runs/manager.js"

export const listWorkspaceRuns = (workspaceId: string) =>
  Effect.gen(function* () {
    return yield* (yield* RunManager).list(workspaceId)
  })

export const startWorkspaceRun = (workspaceId: string, runId: string) =>
  Effect.gen(function* () {
    return yield* (yield* RunManager).start(workspaceId, runId)
  })

export const stopWorkspaceRun = (workspaceId: string, runId: string) =>
  Effect.gen(function* () {
    return yield* (yield* RunManager).stop(workspaceId, runId)
  })

export const readWorkspaceRunLog = (workspaceId: string, runId: string) =>
  Effect.gen(function* () {
    return yield* (yield* RunManager).getLog(workspaceId, runId)
  })
