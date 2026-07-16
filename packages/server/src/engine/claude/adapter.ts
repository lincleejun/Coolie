import { randomUUID } from "node:crypto"
import type { TabStatus } from "@coolie/protocol"
import type { Engine } from "../types.js"
import { discoverClaudeBinary } from "./binary.js"
import { encodeCwd, transcriptPath, deriveTitle, resumeArgs, claudeTranscriptReader } from "./transcript.js"
import { seedFolderTrust, defaultClaudeConfigPath } from "./trust.js"

const HOOK_STATUS: Record<string, TabStatus> = {
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "awaiting-input",
  Notification: "awaiting-input",
  SessionEnd: "idle",
  // SessionStart：会话刚就绪，TUI 已 attach stdin，等价于「等你输入」
  SessionStart: "awaiting-input",
}

/** GUI 模型选择器选项（/model 别名；spec §六 UI 禁止硬编码 vendor 字符串——由 server 下发） */
export const claudeModels = ["default", "opus", "sonnet", "haiku"]

export const claudeEngine: Engine = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: { nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: true, effort: false },
  terminalTitle: "engine-owned",
  serverGeneratedId: false,
  models: claudeModels,
  newSessionId: () => randomUUID(),
  launchCommand: ({ sessionId, model, resume }) => {
    // 用户/测试覆盖 seam（kobe engineCommand.<vendor> 同款）：原样使用，绝不追加 flag
    const override = (process.env.COOLIE_CLAUDE_CMD ?? "").trim()
    if (override !== "") return override.split(/\s+/)
    const bin = discoverClaudeBinary() ?? "claude"
    const args = resume === true ? [bin, ...resumeArgs(sessionId)] : [bin, "--session-id", sessionId]
    if (model) args.push("--model", model)
    return args // effort：claude 无此参数（capabilities.effort=false，Noop 降级）
  },
  statusFromHookEvent: (evt) => {
    const name = (evt as any)?.hook_event_name
    return typeof name === "string" ? HOOK_STATUS[name] ?? null : null
  },
  transcriptPath: ({ home, cwd, sessionId }) => transcriptPath(home, cwd, sessionId),
  deriveTitle,
  resumeArgs,
  // Coolie 自建 worktree 隐式受信：起 session 前预置 hasTrustDialogAccepted，跳过 trust dialog 死锁。
  prepareWorkspace: ({ cwd, claudeConfigPath }) => seedFolderTrust(claudeConfigPath ?? defaultClaudeConfigPath(), cwd),
  transcriptReader: claudeTranscriptReader,
}
export { encodeCwd }
