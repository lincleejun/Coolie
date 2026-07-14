import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import type { TabStatus } from "@coolie/protocol"
import type { Engine } from "../types.js"
import { codexTranscriptPath, codexDeriveTitle } from "./transcript.js"
import { seedCodexTrust, defaultCodexConfigPath } from "./trust.js"

/** codex 二进制多路径发现（opcode 路线，同 claude binary.ts）。 */
export const discoverCodexBinary = (): string | null => {
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

export interface CodexModelCatalog {
  models: string[]
  modelEfforts: Record<string, string[]>
}

/** Account-aware GUI options from Codex's own cache. Explicit env configuration remains authoritative. */
export const loadCodexModelCatalog = (
  override = process.env.COOLIE_CODEX_MODELS,
  cachePath = `${defaultCodexHome()}/models_cache.json`,
): CodexModelCatalog => {
  const configured = override?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
  if (configured.length > 0) return { models: configured, modelEfforts: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { models?: unknown[] }
    const models: string[] = []
    const modelEfforts: Record<string, string[]> = {}
    for (const item of parsed.models ?? []) {
      if (typeof item !== "object" || item === null) continue
      const model = item as {
        slug?: unknown
        visibility?: unknown
        supported_reasoning_levels?: unknown
      }
      if (typeof model.slug !== "string" || model.slug === "" || model.visibility !== "list") continue
      if (!models.includes(model.slug)) models.push(model.slug)
      if (Array.isArray(model.supported_reasoning_levels)) {
        const efforts = model.supported_reasoning_levels
          .map((level) => typeof level === "object" && level !== null ? (level as { effort?: unknown }).effort : null)
          .filter((effort): effort is string => typeof effort === "string" && effort !== "")
        if (efforts.length > 0) modelEfforts[model.slug] = [...new Set(efforts)]
      }
    }
    return { models, modelEfforts }
  } catch {
    // No cache yet: keep only "default" in the UI instead of advertising stale/invalid model names.
    return { models: [], modelEfforts: {} }
  }
}

const codexModelCatalog = loadCodexModelCatalog()
export const codexModels = codexModelCatalog.models
export const codexModelEfforts = codexModelCatalog.modelEfforts
/** Union used while the CLI-default model is selected. */
export const codexEfforts = [...new Set(Object.values(codexModelEfforts).flat())]
export const resolvedCodexEfforts = codexEfforts.length > 0 ? codexEfforts : ["low", "medium", "high", "xhigh"]

export const codexEngine: Engine = {
  id: "codex",
  displayName: "Codex",
  // hooks:false —— codex 0.139.0 实测 hooks 四断点（task-12-report §3）：features.hooks 默认关、项目级
  // .codex/hooks.json 不被发现、--dangerously-bypass-hook-trust 不激活未信任 hooks、SessionStart 推迟到
  // 首个 turn。此常量记录旧版基线；registry 在启动时对 >=0.144 打 hooks 能力补丁。旧版无-hooks 通路：
  // 投递不等任何就绪信号——照常强化 waitStable
  // （TUI ~2s 稳定、composer 实测不吞字），id 回填由 bootstrap 布防的后台 rollout watcher 完成（TUI 的
  // rollout 首 turn 才懒落盘，做投递前门控 = 死锁——真机 RE-SMOKE 实测，勿回退）；turn-complete 优先
  // 由 per-session notify 即时回报，mtime 轮询保留为最终安全网。
  capabilities: { nativeQueue: false, midSessionModelSwitch: true, resume: true, hooks: false, effort: true },
  terminalTitle: "engine-owned", // codex OSC0 标题可配（codex.md §8）
  serverGeneratedId: true,       // 服务端造 id：bootstrap 起始存 null，rollout 文件出现后回填真 id
  models: codexModels,
  modelEfforts: codexModelEfforts,
  efforts: resolvedCodexEfforts,
  // 占位 id：codex 不支持预指定 session id，此值永不传给 codex（serverGeneratedId 分流后 bootstrap 都不会用它）。
  newSessionId: () => randomUUID(),
  launchCommand: ({ sessionId, model, effort, resume, workspaceId, home }) => {
    const override = (process.env.COOLIE_CODEX_CMD ?? "").trim()
    if (override !== "") return override.split(/\s+/)
    const bin = discoverCodexBinary() ?? "codex"
    const args = resume === true ? [bin, "resume", sessionId] : [bin]
    args.push("-c", 'tui.terminal_title=["activity","thread-title"]')
    if (resume !== true && workspaceId && home) {
      const script = `${home}/hooks/codex-notify.sh`
      args.push("-c", `notify=[${JSON.stringify(script)},${JSON.stringify(workspaceId)}]`)
    }
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
