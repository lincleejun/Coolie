import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pollOnce, type TranscriptPollerDeps, ACTIVE_THRESHOLD_MS, IDLE_THRESHOLD_MS } from "../src/engine/monitor.js"
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
