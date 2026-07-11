import { Effect } from "effect"
import { TmuxError, type TmuxServiceShape } from "./service.js"
import { sanitizePromptForPty } from "./sanitize.js"

export interface DeliveryOpts {
  readonly intervalMs?: number
  readonly attempts?: number
  readonly enterDelayMs?: number
}

/** 画面稳定检测（kobe prompt-delivery）：连续两帧 capture 相同才投递。
 * 这是 capturePane 除测试外唯一被允许的用途（不解析内容，只比对相等）。 */
export const waitStable = (
  tmux: TmuxServiceShape, target: string, opts?: DeliveryOpts,
): Effect.Effect<string, TmuxError> =>
  Effect.gen(function* () {
    const interval = opts?.intervalMs ?? 250
    const attempts = opts?.attempts ?? 24
    let prev: string | null = null
    for (let i = 0; i < attempts; i++) {
      const frame = yield* tmux.capturePane(target)
      if (prev !== null && frame === prev) return frame
      prev = frame
      yield* Effect.sleep(interval)
    }
    return yield* new TmuxError({
      op: "wait-stable", message: `画面 ${attempts} 帧内未稳定：${target}`, exitCode: null, stderr: "",
    })
  })

/** 投递流水线（设计文档 §五）：稳定检测 → 消毒 → bracketed paste → 停 150ms → Enter。
 * 150ms：否则粘贴终止符与回车合并进同一次 tty read，回车被当粘贴内容（kobe 实测）。 */
export const deliverPrompt = (
  tmux: TmuxServiceShape, target: string, text: string, opts?: DeliveryOpts,
): Effect.Effect<void, TmuxError> =>
  Effect.gen(function* () {
    yield* waitStable(tmux, target, opts)
    const clean = sanitizePromptForPty(text)
    if (clean === "") return
    yield* tmux.pasteText(target, clean)
    yield* Effect.sleep(opts?.enterDelayMs ?? 150)
    yield* tmux.sendKey(target, "Enter")
  })
