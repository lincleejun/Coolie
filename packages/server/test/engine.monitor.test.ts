import { describe, it, expect } from "vitest"
import { pollOnce, type TranscriptPollerDeps } from "../src/engine/monitor.js"
import type { Engine } from "../src/engine/types.js"
import type { Tab } from "@coolie/protocol"

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
