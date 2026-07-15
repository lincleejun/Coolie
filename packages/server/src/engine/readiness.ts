import { Context, Effect } from "effect"

export interface SessionReadinessGate {
  readonly wait: Effect.Effect<void>
  readonly close: () => void
}

export interface SessionReadinessShape {
  /** Bootstrap arms exactly one process-local gate before launching the engine. */
  readonly arm: (workspaceId: string) => SessionReadinessGate
  /** SessionStart calls this synchronously before waiting for workspace serialization. */
  readonly signal: (workspaceId: string) => boolean
}

export class SessionReadiness extends Context.Tag("SessionReadiness")<
  SessionReadiness,
  SessionReadinessShape
>() {}

export const makeSessionReadiness = (): SessionReadinessShape => {
  const gates = new Map<string, {
    readonly token: symbol
    readonly promise: Promise<void>
    readonly resolve: () => void
  }>()
  return {
    arm: (workspaceId) => {
      const token = Symbol(workspaceId)
      let resolve!: () => void
      const promise = new Promise<void>((done) => { resolve = done })
      gates.set(workspaceId, { token, promise, resolve })
      return {
        wait: Effect.promise(() => promise),
        close: () => {
          if (gates.get(workspaceId)?.token === token) gates.delete(workspaceId)
        },
      }
    },
    signal: (workspaceId) => {
      const gate = gates.get(workspaceId)
      if (!gate) return false
      gate.resolve()
      return true
    },
  }
}
