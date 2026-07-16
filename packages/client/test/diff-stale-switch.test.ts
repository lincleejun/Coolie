import { describe, expect, it } from "vitest"
import { shouldApplyAsyncResult, shouldApplyWsResult } from "../src/rightpanel/stale.js"

describe("shouldApplyAsyncResult (task-switch stale guard)", () => {
  it("applies only when the request still matches the live workspace", () => {
    expect(shouldApplyAsyncResult("ws-a", "ws-a", false)).toBe(true)
    expect(shouldApplyAsyncResult("ws-a", "ws-b", false)).toBe(false)
    expect(shouldApplyAsyncResult("ws-a", "ws-a", true)).toBe(false)
    expect(shouldApplyAsyncResult("ws-a", null, false)).toBe(false)
    expect(shouldApplyAsyncResult("ws-a", undefined, false)).toBe(false)
  })

  it("shouldApplyWsResult mirrors the same guard with arg order for call sites", () => {
    expect(shouldApplyWsResult(false, "ws-a", "ws-a")).toBe(true)
    expect(shouldApplyWsResult(true, "ws-a", "ws-a")).toBe(false)
    expect(shouldApplyWsResult(false, "ws-a", "ws-b")).toBe(false)
  })
})
