import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  ACTIVE_THRESHOLD_MS,
  HOOK_AUTHORITY_MS,
  IDLE_THRESHOLD_MS,
  NOTIFY_AUTHORITY_MS,
  decideStatusFromMtime,
  pollOnce,
  type TranscriptPollerDeps,
} from "../src/engine/monitor.js"
import type { Engine } from "../src/engine/types.js"
import type { Tab } from "@coolie/protocol"
import { codexEngine } from "../src/engine/codex/adapter.js"

const statMtimeMs = (p: string): number | null => { try { return fs.statSync(p).mtimeMs } catch { return null } }

// 两个 fake 引擎：各自 transcriptPath 把 home 编进返回值，便于断言「读了哪个 home」。
const fakeEngine = (id: string): Engine => ({
  id, displayName: id,
  capabilities: { nativeQueue: id === "claude", midSessionModelSwitch: true, resume: true, hooks: true, effort: id === "codex" },
  terminalTitle: "none",
  newSessionId: () => "x",
  launchCommand: () => [id],
  statusFromHookEvent: () => null,
  transcriptPath: ({ home, sessionId }) => `${home}::${id}::${sessionId}`,
  deriveTitle: () => null,
  resumeArgs: (s) => [s],
})
const mkTab = (id: string, engineId: string, sid: string | null): Tab =>
  ({ id, engineId, engineSessionId: sid, status: "idle", lastHookAt: null, tmuxWindow: 0, title: null } as unknown as Tab)

describe("pollOnce per-engine home（F1/F2）", () => {
  it("两引擎 tab 各读自己的 home；null-id codex tab 安全跳过", async () => {
    const claude = fakeEngine("claude"); const codex = fakeEngine("codex")
    const statted: string[] = []
    const deps: TranscriptPollerDeps = {
      listEngineTabs: async () => [
        { tab: mkTab("t-c", "claude", "sid-c"), workspacePath: "/w/c" },
        { tab: mkTab("t-x", "codex", "sid-x"), workspacePath: "/w/x" },
        { tab: mkTab("t-null", "codex", null), workspacePath: "/w/n" }, // F2：null id
      ],
      statMtimeMs: (p) => { statted.push(p); return null }, // 返回 null → 不改状态，只验路径
      setStatus: async () => {},
      resolveEngine: (eid) => (eid === "codex" ? codex : claude),
      homeFor: (eid) => (eid === "codex" ? "/home/codex" : "/home/claude"),
    }
    await pollOnce(deps)
    expect(statted).toContain("/home/claude::claude::sid-c") // claude tab 读 claudeHome
    expect(statted).toContain("/home/codex::codex::sid-x")   // codex tab 读 codexHome（不是 claudeHome！）
    expect(statted.some((p) => p.includes("t-null") || p.includes("/w/n"))).toBe(false) // null-id 未 stat
    expect(statted).toHaveLength(2)
  })
})

describe("codex 无-hooks 通路：id 回填后 mtime 轮询独家驱动状态（真 codexEngine + 真 rollout 文件，端到端）", () => {
  it("rollout 新鲜 → working；陈旧 → awaiting-input（lastHookAt 恒 null，mtime 恒当值）", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cxmon-"))
    const sid = "019f5586-002d-73c1-98b9-ef17a05f06c9"
    const dir = path.join(home, "sessions", "2026", "07", "12")
    fs.mkdirSync(dir, { recursive: true })
    const rollout = path.join(dir, `rollout-2026-07-12T00-00-00-${sid}.jsonl`)
    fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: "/w/x" } }) + "\n")

    const now = Date.now()
    const codexTab = { id: "t-cx", engineId: "codex", engineSessionId: sid, status: "idle", lastHookAt: null, tmuxWindow: 0, title: null } as unknown as Tab
    const set: Array<[string, string]> = []
    const deps = (mtimeAgeMs: number, current: string): TranscriptPollerDeps => ({
      listEngineTabs: async () => [{ tab: { ...codexTab, status: current } as Tab, workspacePath: "/w/x" }],
      statMtimeMs: () => now - mtimeAgeMs, // codexEngine.transcriptPath 会真找到上面这个 rollout；此处直接注入其 mtime 龄
      setStatus: async (id, s) => { set.push([id, s]) },
      resolveEngine: () => codexEngine,
      homeFor: () => home,
      now: () => now,
    })

    // 先确认真 codexEngine.transcriptPath 能按 sid 反查到 rollout（回填后 mtime 轮询有的可 stat）
    expect(codexEngine.transcriptPath({ home, cwd: "/w/x", sessionId: sid })).toBe(rollout)

    // 新鲜（≤3s）且非 working → working
    await pollOnce(deps(ACTIVE_THRESHOLD_MS - 500, "idle"))
    expect(set).toContainEqual(["t-cx", "working"])
    set.length = 0
    // 陈旧（≥30s）且当前 working → awaiting-input
    await pollOnce(deps(IDLE_THRESHOLD_MS + 1000, "working"))
    expect(set).toContainEqual(["t-cx", "awaiting-input"])

    fs.rmSync(home, { recursive: true, force: true })
  })
})

describe("H1：mtime 授权窗按引擎 hooks 能力门控", () => {
  const now = 10_000_000

  it("短窗内让位，短窗后 fresh mtime 可纠回 working", () => {
    expect(decideStatusFromMtime({
      nowMs: now,
      mtimeMs: now - 1_000,
      lastHookAtMs: now - 2_000,
      current: "awaiting-input",
      hookAuthorityMs: NOTIFY_AUTHORITY_MS,
    })).toBeNull()
    expect(decideStatusFromMtime({
      nowMs: now,
      mtimeMs: now - 1_000,
      lastHookAtMs: now - NOTIFY_AUTHORITY_MS - 1,
      current: "awaiting-input",
      hookAuthorityMs: NOTIFY_AUTHORITY_MS,
    })).toBe("working")
  })

  it("短窗后 30s 静默安全网照常接管", () => {
    expect(decideStatusFromMtime({
      nowMs: now,
      mtimeMs: now - IDLE_THRESHOLD_MS - 1,
      lastHookAtMs: now - NOTIFY_AUTHORITY_MS - 1,
      current: "working",
      hookAuthorityMs: NOTIFY_AUTHORITY_MS,
    })).toBe("awaiting-input")
  })

  it("缺省仍用 10 分钟 hook 权威窗", () => {
    expect(decideStatusFromMtime({
      nowMs: now,
      mtimeMs: now - IDLE_THRESHOLD_MS - 1,
      lastHookAtMs: now - 6_000,
      current: "working",
    })).toBeNull()
    expect(HOOK_AUTHORITY_MS).toBe(10 * 60_000)
  })

  it("pollOnce 仅给无 hooks 引擎使用 5 秒短窗", async () => {
    const updates: Array<[string, string]> = []
    const hooked = fakeEngine("claude")
    const unhooked = {
      ...fakeEngine("codex"),
      capabilities: { ...fakeEngine("codex").capabilities, hooks: false },
    }
    const tab = (id: string, engineId: string) => ({
      ...mkTab(id, engineId, "sid"),
      status: "awaiting-input",
      lastHookAt: now - NOTIFY_AUTHORITY_MS - 1,
    } as Tab)
    await pollOnce({
      listEngineTabs: async () => [
        { tab: tab("hooked", "claude"), workspacePath: "/w/c" },
        { tab: tab("unhooked", "codex"), workspacePath: "/w/x" },
      ],
      statMtimeMs: () => now - 1_000,
      setStatus: async (id, status) => { updates.push([id, status]) },
      resolveEngine: (id) => id === "claude" ? hooked : unhooked,
      homeFor: () => "/home",
      now: () => now,
    })
    expect(updates).toEqual([["unhooked", "working"]])
  })
})
