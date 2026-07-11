import { describe, it, expect } from "vitest"
import { Tab } from "@coolie/protocol"
import { decideStatusFromMtime, pollOnce, HOOK_AUTHORITY_MS, ACTIVE_THRESHOLD_MS, IDLE_THRESHOLD_MS } from "../src/engine/monitor.js"
import { claudeEngine } from "../src/engine/claude/adapter.js"

const NOW = 1_000_000_000

describe("decideStatusFromMtime（纯仲裁）", () => {
  it("hooks 近期有信号 → 让位（null），无论 mtime 多新", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW, lastHookAtMs: NOW - 5000, current: "idle" })).toBeNull()
  })
  it("hook 信号过期（>10min）→ mtime 接管", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - 1000, lastHookAtMs: NOW - HOOK_AUTHORITY_MS - 1, current: "idle" }))
      .toBe("working")
  })
  it("无转录 → null", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: null, lastHookAtMs: null, current: "working" })).toBeNull()
  })
  it("mtime 新鲜（≤3s）且非 working → working；已是 working → null（不重复写）", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - ACTIVE_THRESHOLD_MS, lastHookAtMs: null, current: "idle" })).toBe("working")
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - 1000, lastHookAtMs: null, current: "working" })).toBeNull()
  })
  it("mtime 陈旧（≥30s）且 working → awaiting-input；非 working → null", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - IDLE_THRESHOLD_MS, lastHookAtMs: null, current: "working" })).toBe("awaiting-input")
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - IDLE_THRESHOLD_MS, lastHookAtMs: null, current: "idle" })).toBeNull()
  })
  it("中间地带（3s < age < 30s）→ null（保持现状）", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - 10_000, lastHookAtMs: null, current: "working" })).toBeNull()
  })
})

describe("pollOnce（注入 fakes）", () => {
  const mkTab = (over: Partial<ConstructorParameters<typeof Tab>[0]> = {}) => new Tab({
    id: "t1", workspaceId: "w1", kind: "engine", engineId: "claude",
    engineSessionId: "s-1", tmuxWindow: 0, title: null, status: "idle", lastHookAt: null, ...over,
  })

  it("stats the engine transcript path and applies the decision", async () => {
    const statted: string[] = []
    const set: Array<[string, string]> = []
    await pollOnce({
      listEngineTabs: async () => [{ tab: mkTab(), workspacePath: "/tmp/wsx" }],
      statMtimeMs: (p) => { statted.push(p); return NOW - 1000 },
      setStatus: async (id, s) => { set.push([id, s]) },
      engine: claudeEngine, home: "/h/.claude", now: () => NOW,
    })
    expect(statted[0]).toBe(claudeEngine.transcriptPath({ home: "/h/.claude", cwd: "/tmp/wsx", sessionId: "s-1" }))
    expect(set).toEqual([["t1", "working"]])
  })

  it("skips tabs without engineSessionId and null decisions", async () => {
    const set: Array<[string, string]> = []
    await pollOnce({
      listEngineTabs: async () => [
        { tab: mkTab({ id: "t2", engineSessionId: null }), workspacePath: "/a" },
        { tab: mkTab({ id: "t3", status: "working" }), workspacePath: "/b" }, // fresh mtime + already working → null
      ],
      statMtimeMs: () => NOW - 1000,
      setStatus: async (id, s) => { set.push([id, s]) },
      engine: claudeEngine, home: "/h", now: () => NOW,
    })
    expect(set).toEqual([])
  })
})
