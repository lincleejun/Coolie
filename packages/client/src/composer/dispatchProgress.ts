/** Pure helpers for Dispatcher create-stage progress (Task 3.4). */

export const DISPATCH_STAGES = [
  "intent",
  "environment",
  "setup",
  "engine",
  "delivery",
  "active",
] as const

export type DispatchStage = (typeof DISPATCH_STAGES)[number]

export type DispatchProgress = {
  readonly workspaceId: string
  readonly current: DispatchStage
  readonly completed: readonly DispatchStage[]
  readonly failure: { readonly tag: string; readonly message: string } | null
}

const stageIndex = (stage: DispatchStage): number => DISPATCH_STAGES.indexOf(stage)

/** Mark every stage before `current` completed; keep failure if present. */
export const progressAt = (
  workspaceId: string,
  current: DispatchStage,
  failure: DispatchProgress["failure"] = null,
): DispatchProgress => ({
  workspaceId,
  current,
  completed: DISPATCH_STAGES.slice(0, stageIndex(current)),
  failure,
})

export const advanceProgress = (
  prev: DispatchProgress | null,
  workspaceId: string,
  next: DispatchStage,
): DispatchProgress => {
  const base = prev?.workspaceId === workspaceId ? prev : progressAt(workspaceId, "intent")
  if (stageIndex(next) < stageIndex(base.current) && next !== "active") return base
  return progressAt(workspaceId, next, base.failure)
}

export const failProgress = (
  prev: DispatchProgress | null,
  workspaceId: string,
  failure: { readonly tag: string; readonly message: string },
): DispatchProgress => {
  const base = prev?.workspaceId === workspaceId ? prev : progressAt(workspaceId, "intent")
  return { ...base, failure }
}

/** Map Coolie SSE event types onto create stages. */
export const stageFromEventType = (type: string): DispatchStage | "error" | null => {
  switch (type) {
    case "workspace.intent.created":
    case "workspace.creating":
      return "intent"
    case "workspace.environment.copied":
      return "environment"
    case "workspace.setup.started":
      return "setup"
    case "workspace.setup.finished":
      return "engine"
    case "engine.started":
      return "delivery"
    case "prompt.delivered":
    case "prompt.delivery.degraded":
      return "delivery"
    case "workspace.created":
      return "active"
    case "workspace.error":
      return "error"
    default:
      return null
  }
}

export const applyDispatchEvent = (
  prev: DispatchProgress | null,
  event: { readonly type: string; readonly workspaceId?: string | null; readonly payload?: unknown },
): DispatchProgress | null => {
  const workspaceId = event.workspaceId
  if (!workspaceId) return prev
  const mapped = stageFromEventType(event.type)
  if (mapped === null) return prev
  if (mapped === "error") {
    const payload = (event.payload ?? {}) as { error?: { tag?: string; message?: string }; tag?: string; message?: string }
    const err = payload.error ?? payload
    return failProgress(prev, workspaceId, {
      tag: typeof err.tag === "string" ? err.tag : "Error",
      message: typeof err.message === "string" ? err.message : "create failed",
    })
  }
  return advanceProgress(prev, workspaceId, mapped)
}

/** After intent POST succeeds, Composer must unlock immediately (ensure runs in background). */
export const canCreateMore = (intentInFlight: boolean): boolean => !intentInFlight
