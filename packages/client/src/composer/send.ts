/** composer 键位 → 发送动作（spec §7.2 表格的纯函数化）。skipStable 语义见 server tmux/ops.ts 注释。 */
export type ComposerAction =
  | { kind: "none" } | { kind: "newline" } | { kind: "blur" }
  | { kind: "send"; skipStable: boolean }
  | { kind: "insert"; skipStable: boolean }
  | { kind: "interrupt-send" }

export interface ComposerKeyEvent {
  key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean
}

export const planComposerKey = (e: ComposerKeyEvent, ctx: { engineWorking: boolean; nativeQueue: boolean }): ComposerAction => {
  if (e.key === "Escape") return { kind: "blur" }
  if (e.key !== "Enter") return { kind: "none" }
  if (e.metaKey) return { kind: "interrupt-send" }
  if (e.shiftKey) return { kind: "newline" }
  // skipStable 只在 engine 忙 且 引擎具备 nativeQueue 能力时直投（spec §7.2）；否则仍走完整稳定检测
  const skipStable = ctx.engineWorking && ctx.nativeQueue
  if (e.altKey) return { kind: "insert", skipStable }
  return { kind: "send", skipStable }
}
