import { Effect } from "effect"
import { StateRepo } from "../repo/state.js"

export const readStateSnapshot = (workspaceId?: string) =>
  Effect.gen(function* () {
    return yield* (yield* StateRepo).read(
      workspaceId !== undefined ? { workspaceId } : undefined,
    )
  })
