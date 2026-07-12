import type { Tab, TabStatus } from "@coolie/protocol"
import type { Engine } from "./types.js"

export const HOOK_AUTHORITY_MS = 10 * 60_000
export const ACTIVE_THRESHOLD_MS = 3_000
export const IDLE_THRESHOLD_MS = 30_000

/** 纯仲裁（agent-deck sessionstatus 收敛教训：推导逻辑只此一处）：
 * hooks 近期有信号 → 让位；否则用转录 mtime 推断 working/awaiting-input。 */
export const decideStatusFromMtime = (i: {
  readonly nowMs: number
  readonly mtimeMs: number | null
  readonly lastHookAtMs: number | null
  readonly current: TabStatus
}): TabStatus | null => {
  if (i.lastHookAtMs !== null && i.nowMs - i.lastHookAtMs < HOOK_AUTHORITY_MS) return null
  if (i.mtimeMs === null) return null
  const age = i.nowMs - i.mtimeMs
  if (age <= ACTIVE_THRESHOLD_MS) return i.current === "working" ? null : "working"
  if (age >= IDLE_THRESHOLD_MS) return i.current === "working" ? "awaiting-input" : null
  return null
}

export interface TranscriptPollerDeps {
  readonly listEngineTabs: () => Promise<Array<{ tab: Tab; workspacePath: string }>>
  readonly statMtimeMs: (p: string) => number | null
  readonly setStatus: (tabId: string, status: TabStatus) => Promise<void>
  /** F1：按 tab.engineId 查引擎（注册表）——不同引擎的 tab 各用自己的 transcriptPath。 */
  readonly resolveEngine: (engineId: string | null) => Engine | undefined
  /** F1：按 tab.engineId 解析 per-engine 转录目录（engineHome）。 */
  readonly homeFor: (engineId: string | null) => string
  readonly now?: () => number
}

export const pollOnce = async (deps: TranscriptPollerDeps): Promise<void> => {
  const now = (deps.now ?? Date.now)()
  for (const { tab, workspacePath } of await deps.listEngineTabs()) {
    // F2：codex 服务端造 id 在首个 SessionStart hook 回填前为 null；此期 rollout 文件尚不存在，
    // mtime 兜底无从做起，状态由 hooks 独家负责（F3 的 --dangerously-bypass-hook-trust 保证 hook 首启即达）。
    if (tab.engineSessionId === null) continue
    const engine = deps.resolveEngine(tab.engineId)
    if (engine === undefined) continue // 未注册引擎：跳过（防御）
    const home = deps.homeFor(tab.engineId)
    const p = engine.transcriptPath({ home, cwd: workspacePath, sessionId: tab.engineSessionId })
    const next = decideStatusFromMtime({
      nowMs: now, mtimeMs: deps.statMtimeMs(p), lastHookAtMs: tab.lastHookAt, current: tab.status,
    })
    if (next !== null) await deps.setStatus(tab.id, next)
  }
}

/** 轮询失败绝不影响主流程（吞掉）；unref 不阻进程退出。返回 stop。 */
export const startTranscriptPoller = (deps: TranscriptPollerDeps, intervalMs = 2000): (() => void) => {
  const t = setInterval(() => { void pollOnce(deps).catch(() => {}) }, intervalMs)
  t.unref()
  return () => clearInterval(t)
}
