/** composer 键位 → 发送动作（spec §7.2 表格的纯函数化）。skipStable 语义见 server tmux/ops.ts 注释。 */
export type ComposerAction =
  | { kind: "none" } | { kind: "newline" } | { kind: "blur" }
  | { kind: "send"; skipStable: boolean }
  | { kind: "insert"; skipStable: boolean }
  | { kind: "interrupt-send" }

export interface ComposerKeyEvent {
  key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean
}

export const planComposerKey = (e: ComposerKeyEvent, ctx: { engineWorking: boolean }): ComposerAction => {
  if (e.key === "Escape") return { kind: "blur" }
  if (e.key !== "Enter") return { kind: "none" }
  if (e.metaKey) return { kind: "interrupt-send" }
  if (e.shiftKey) return { kind: "newline" }
  if (e.altKey) return { kind: "insert", skipStable: ctx.engineWorking }
  return { kind: "send", skipStable: ctx.engineWorking }
}
