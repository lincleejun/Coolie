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
  /** 会话 id 生命周期差异进抽象（codex M2：服务端造 id 需先启动后回填——函数形态预留） */
  readonly newSessionId: () => string
  readonly launchCommand: (opts: { readonly sessionId: string; readonly model?: string; readonly effort?: string }) => string[]
  /** hook 事件 → tab 状态；未知事件返回 null（turnDetector 主路径） */
  readonly statusFromHookEvent: (evt: unknown) => TabStatus | null
  /** historyReader：engine 自己的转录文件位置（home = engine 数据目录，claude 为 ~/.claude） */
  readonly transcriptPath: (opts: { readonly home: string; readonly cwd: string; readonly sessionId: string }) => string
  readonly deriveTitle: (jsonl: string) => string | null
  readonly resumeArgs: (sessionId: string) => string[]
}
