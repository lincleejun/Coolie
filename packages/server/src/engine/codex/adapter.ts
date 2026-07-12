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
  capabilities: { nativeQueue: false, midSessionModelSwitch: true, resume: true, hooks: true, effort: true },
  terminalTitle: "engine-owned", // codex OSC0 标题可配（codex.md §8）
  serverGeneratedId: true,       // 服务端造 id：bootstrap 起始存 null，首个 SessionStart hook 回填
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
    // F3 已核实（codex-cli 0.139.0 交互式 codex 支持此 flag）：无条件旁路 hook trust，
    // 因 Coolie 亲自注入 .codex/hooks.json（来源已 vet），保证 SessionStart hook 首启即触发。
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
