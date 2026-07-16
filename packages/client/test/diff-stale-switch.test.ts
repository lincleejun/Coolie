import { describe, expect, it } from "vitest"
import { shouldApplyAsyncResult } from "../src/rightpanel/stale.js"

describe("shouldApplyAsyncResult (task-switch stale guard)", () => {
  it("applies only when the request still matches the current workspace", () => {
    expect(shouldApplyAsyncResult("ws-a", "ws-a", false)).toBe(true)
    expect(shouldApplyAsyncResult("ws-a", "ws-b", false)).toBe(false)
    expect(shouldApplyAsyncResult("ws-a", "ws-a", true)).toBe(false)
  })
})
