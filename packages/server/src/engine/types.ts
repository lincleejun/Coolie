import type { TabStatus } from "@coolie/protocol"

/** 能力位（kobe registry 六件套裁剪版）：缺失能力 = Noop 降级，调用方必须 guard；UI 禁止硬编码 vendor 字符串。 */
export interface EngineCapabilities {
  /** engine TUI 原生支持 mid-turn 排队（claude ✓）——无此能力的 engine 走 server 端 queue（M2） */
  readonly nativeQueue: boolean
  readonly midSessionModelSwitch: boolean
  readonly resume: boolean
  readonly hooks: boolean
  /** reasoning effort 参数（codex ✓ / claude ✗） */
  readonly effort: boolean
}

export interface Engine {
  readonly id: string
  readonly displayName: string
  readonly capabilities: EngineCapabilities
  /** claude 自己写 OSC title（ownsStatus）→ "engine-owned"；无 title 行为的 engine → "none" */
  readonly terminalTitle: "engine-owned" | "none"
  /** true = 服务端造 id（codex），bootstrap 起始存 engineSessionId=null，首个 hook 回填；
   * 缺省/false = 客户端造 id（claude/fake），launchCommand 传 --session-id。
   * **F4：可选，默认 false**——M1 既有 4 个测试 fake（http-heal/heal/lifecycle-tmux/bootstrap-prompt-gate）
   * 与真 claudeEngine 无须逐个补字段即通过 typecheck；bootstrap 用 `engine.serverGeneratedId === true` 判定。 */
  readonly serverGeneratedId?: boolean
  /** GUI 模型选择器选项（/config 下发，UI 禁止硬编码 vendor 字符串）。
   * **F4：可选，默认 `[]`**（`GET /config` 侧 `e.models ?? []`）——同上，既有 fake 不必补。
   * claude/codex 两真 adapter 仍显式设 `models`（否则 /config 下发空数组，GUI 无选项）。 */
  readonly models?: readonly string[]
  /** reasoning effort 档位（codex ✓ none/low/medium/high/xhigh；claude 无 → undefined）。 */
  readonly efforts?: readonly string[]
  /** 会话 id 生命周期差异进抽象（codex M2：服务端造 id 需先启动后回填——函数形态预留） */
  readonly newSessionId: () => string
  readonly launchCommand: (opts: {
    readonly sessionId: string; readonly model?: string; readonly effort?: string
    /** true = 复活既有会话（claude: --resume <sessionId>）；缺省/false = 新会话（--session-id） */
    readonly resume?: boolean
  }) => string[]
  /** hook 事件 → tab 状态；未知事件返回 null（turnDetector 主路径） */
  readonly statusFromHookEvent: (evt: unknown) => TabStatus | null
  /** historyReader：engine 自己的转录文件位置（home = engine 数据目录，claude 为 ~/.claude） */
  readonly transcriptPath: (opts: { readonly home: string; readonly cwd: string; readonly sessionId: string }) => string
  readonly deriveTitle: (jsonl: string) => string | null
  readonly resumeArgs: (sessionId: string) => string[]
  /** worktree 起 session 前的预备钩子（可选）：claude 借此预置文件夹信任，跳过新 worktree 首启的
   * 「Do you trust this folder?」对话框（该对话框在回答前不触发 SessionStart，会死锁就绪门控）。
   * 无此需求的 engine（fake/codex）不实现 = Noop，bootstrap guard 调用。 */
  readonly prepareWorkspace?: (ctx: { readonly cwd: string; readonly claudeConfigPath?: string | undefined; readonly codexConfigPath?: string | undefined }) => void
}
