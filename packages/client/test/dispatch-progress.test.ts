import { describe, expect, it } from "vitest"
import {
  applyDispatchEvent,
  canCreateMore,
  progressAt,
  DISPATCH_STAGES,
} from "../src/composer/dispatchProgress.js"

describe("applyDispatchEvent", () => {
  it("advances stages and grows completed set", () => {
    let state = applyDispatchEvent(null, { type: "workspace.intent.created", workspaceId: "w1" })
    expect(state).toMatchObject({ current: "intent", completed: [] })

    state = applyDispatchEvent(state, { type: "workspace.environment.copied", workspaceId: "w1" })
    expect(state?.current).toBe("environment")
    expect(state?.completed).toEqual(["intent"])

    state = applyDispatchEvent(state, { type: "workspace.setup.started", workspaceId: "w1" })
    expect(state?.current).toBe("setup")
    expect(state?.completed).toEqual(["intent", "environment"])

    state = applyDispatchEvent(state, { type: "workspace.setup.finished", workspaceId: "w1" })
    expect(state?.current).toBe("engine")

    state = applyDispatchEvent(state, { type: "engine.started", workspaceId: "w1" })
    expect(state?.current).toBe("delivery")

    state = applyDispatchEvent(state, { type: "prompt.delivered", workspaceId: "w1" })
    expect(state?.current).toBe("delivery")

    state = applyDispatchEvent(state, { type: "workspace.created", workspaceId: "w1" })
    expect(state?.current).toBe("active")
    expect(state?.completed).toEqual(DISPATCH_STAGES.slice(0, -1))
  })

  it("surfaces typed failure tag and message", () => {
    const state = applyDispatchEvent(
      progressAt("w1", "setup"),
      {
        type: "workspace.error",
        workspaceId: "w1",
        payload: { error: { tag: "SetupScriptError", message: "npm ci failed" } },
      },
    )
    expect(state?.failure).toEqual({ tag: "SetupScriptError", message: "npm ci failed" })
    expect(state?.current).toBe("setup")
  })
})

describe("canCreateMore", () => {
  it("unlocks create-more as soon as the intent POST is no longer in flight", () => {
    expect(canCreateMore(true)).toBe(false)
    expect(canCreateMore(false)).toBe(true)
  })
})
