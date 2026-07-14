import { describe, expect, it, vi } from "vitest"
import {
  createTerminalRecovery,
  planTerminalRecoveryUi,
  readableRecoveryError,
} from "../src/terminal/resume.js"

describe("terminal recovery UI policy", () => {
  it("offers engine Resume for exited, dead, and error states", () => {
    expect(planTerminalRecoveryUi("engine", "exited", "idle")).toEqual({ interrupted: true, showResume: true })
    expect(planTerminalRecoveryUi("engine", "dead", "idle")).toEqual({ interrupted: true, showResume: true })
    expect(planTerminalRecoveryUi("engine", "open", "error")).toEqual({ interrupted: true, showResume: true })
  })

  it("keeps shell recovery reconnect-only", () => {
    expect(planTerminalRecoveryUi("shell", "dead", "error")).toEqual({ interrupted: true, showResume: false })
    expect(planTerminalRecoveryUi("shell", "open", "error")).toEqual({ interrupted: false, showResume: false })
  })
})

describe("engine terminal recovery", () => {
  it.each(["respawned", "recreated"] as const)(
    "refreshes tabs and reconnects after action=%s",
    async (action) => {
      const calls: string[] = []
      const recovery = createTerminalRecovery({
        resume: async () => { calls.push("resume"); return { action } },
        refreshTabs: async () => { calls.push("refresh") },
        reconnect: () => { calls.push("reconnect") },
      })

      await expect(recovery.run()).resolves.toEqual({ action })
      expect(calls).toEqual(["resume", "refresh", "reconnect"])
      expect(recovery.pending()).toBe(false)
    },
  )

  it("coalesces duplicate clicks while recovery is in flight", async () => {
    let finish!: (value: { action: "respawned" }) => void
    const resume = vi.fn(() => new Promise<{ action: "respawned" }>((resolve) => { finish = resolve }))
    const reconnect = vi.fn()
    const recovery = createTerminalRecovery({
      resume,
      refreshTabs: vi.fn(async () => {}),
      reconnect,
    })

    const first = recovery.run()
    const second = recovery.run()
    expect(recovery.pending()).toBe(true)
    expect(second).toBe(first)
    expect(resume).toHaveBeenCalledTimes(1)

    finish({ action: "respawned" })
    await first
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it("surfaces a readable API failure without reconnecting implicitly", async () => {
    const reconnect = vi.fn()
    const recovery = createTerminalRecovery({
      resume: async () => { throw new Error("tmux session unavailable") },
      refreshTabs: vi.fn(async () => {}),
      reconnect,
    })

    await expect(recovery.run()).rejects.toThrow("tmux session unavailable")
    expect(readableRecoveryError(new Error("tmux session unavailable"))).toBe("恢复失败：tmux session unavailable")
    expect(readableRecoveryError("offline")).toBe("恢复失败：offline")
    expect(reconnect).not.toHaveBeenCalled()
    expect(recovery.pending()).toBe(false)
  })
})
