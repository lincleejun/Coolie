import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import type { TabStatus } from "@coolie/protocol"
import type { Engine } from "../types.js"
import { codexTranscriptPath, codexDeriveTitle } from "./transcript.js"
import { seedCodexTrust, defaultCodexConfigPath } from "./trust.js"

/** codex 二进制多路径发现（opcode 路线，同 claude binary.ts）。 */
const discoverCodexBinary = (): string | null => {
  const candidates = [
    process.env.COOLIE_CODEX_BIN,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((p): p is string => typeof p === "string" && p !== "")
  for (const c of candidates) { try { if (fs.existsSync(c)) return c } catch { /* skip */ } }
  return null
}

/** hook 事件 → tab 状态（codex 事件名与 claude 旁路同集，codex.md §6）。 */
const HOOK_STATUS: Record<string, TabStatus> = {
  UserPromptSubmit: "working",
  Stop: "awaiting-input",
  SessionStart: "awaiting-input", // 会话就绪、TUI attach stdin，等价「等你输入」
  SessionEnd: "idle",
}

const defaultCodexHome = (): string => process.env.COOLIE_CODEX_HOME ?? `${process.env.HOME}/.codex`

/** GUI 模型选择器选项（占位，可经 COOLIE_CODEX_MODELS 逗号分隔覆写）。 */
export const codexModels = (process.env.COOLIE_CODEX_MODELS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])
  .length > 0
  ? process.env.COOLIE_CODEX_MODELS!.split(",").map((s) => s.trim()).filter(Boolean)
  : ["gpt-5-codex", "gpt-5"]

/** reasoning effort 档位（codex.md §2）。 */
export const codexEfforts = ["low", "medium", "high", "xhigh"]

export const codexEngine: Engine = {
  id: "codex",
  displayName: "Codex",
  // hooks:false —— codex 0.139.0 实测 hooks 四断点（task-12-report §3）：features.hooks 默认关、项目级
  // .codex/hooks.json 不被发现、--dangerously-bypass-hook-trust 不激活未信任 hooks、SessionStart 推迟到
  // 首个 turn。故 codex 走无-hooks 通路（RE-SMOKE 反转版）：投递不等任何就绪信号——照常强化 waitStable
  // （TUI ~2s 稳定、composer 实测不吞字），id 回填由 bootstrap 布防的后台 rollout watcher 完成（TUI 的
  // rollout 首 turn 才懒落盘，做投递前门控 = 死锁——真机 RE-SMOKE 实测，勿回退）；状态由 mtime 轮询
  // 独家负责（monitor，lastHookAt 恒 null → mtime 恒当值）。
  // 【hooks 重启检查】codex≥0.144 一旦实测确认「项目级 .codex/hooks.json 被发现 + features.hooks 默认开 +
  // SessionStart 首启即触发」，把此位改回 true 即可：bootstrap gateOnHooks 自动接管就绪、watcher 不再布防
  // （能力驱动），/hooks/codex 端点 + injectCodexHooks + statusFromHookEvent 已就绪，无需改调用点。
  capabilities: { nativeQueue: false, midSessionModelSwitch: true, resume: true, hooks: false, effort: true },
  terminalTitle: "engine-owned", // codex OSC0 标题可配（codex.md §8）
  serverGeneratedId: true,       // 服务端造 id：bootstrap 起始存 null，rollout 文件出现后回填真 id
  models: codexModels,
  efforts: codexEfforts,
  // 占位 id：codex 不支持预指定 session id，此值永不传给 codex（serverGeneratedId 分流后 bootstrap 都不会用它）。
  newSessionId: () => randomUUID(),
  launchCommand: ({ sessionId, model, effort, resume }) => {
    const override = (process.env.COOLIE_CODEX_CMD ?? "").trim()
    if (override !== "") return override.split(/\s+/)
    const bin = discoverCodexBinary() ?? "codex"
    const args = resume === true ? [bin, "resume", sessionId] : [bin]
    args.push("-c", 'tui.terminal_title=["activity","thread-title"]')
    if (model) args.push("--model", model)
    if (effort) args.push("-c", `model_reasoning_effort=${effort}`)
    // 保留此 flag（0.139.0 实测：只抑制 hook trust review 对话框，不激活未信任 hooks——见 task-12-report §3
    // 断点 3）：无害且 future-ready，避免未来重启 hooks 时首启弹信任对话框死锁就绪门控。当前无-hooks 通路
    // 不依赖它，就绪由 rollout 文件门控。
    args.push("--dangerously-bypass-hook-trust")
    return args
  },
  statusFromHookEvent: (evt) => {
    const name = (evt as any)?.hook_event_name
    return typeof name === "string" ? HOOK_STATUS[name] ?? null : null
  },
  transcriptPath: ({ home, sessionId }) => codexTranscriptPath(home, sessionId),
  deriveTitle: codexDeriveTitle,
  resumeArgs: (sessionId) => ["resume", sessionId],
  // Coolie 自建 worktree 隐式受信：起 session 前预置 config.toml project trust，跳过 TUI 首启信任对话框。
  prepareWorkspace: ({ cwd, codexConfigPath }) => seedCodexTrust(codexConfigPath ?? defaultCodexConfigPath(defaultCodexHome()), cwd),
}
