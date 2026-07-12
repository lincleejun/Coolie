import { Effect } from "effect"
import { TmuxError, type TmuxServiceShape } from "./service.js"
import { sanitizePromptForPty } from "./sanitize.js"

export interface DeliveryOpts {
  readonly intervalMs?: number
  readonly attempts?: number
  readonly enterDelayMs?: number
  /** 冷启动兜底（Plan3 Task15）：距 waitStable 调用起至少经过这么久才允许判定稳定——
   * 纯连续帧相等在 engine 冷启动的空白/瞬时稳定窗口里会误判，minElapsedMs 撑住这段时间。
   * 默认 1500ms（真实 claude 冷启动 <1s，留出安全边际）；测试用 cat 类瞬间就绪的 pane 可传 0 保持秒回。 */
  readonly minElapsedMs?: number
  /** 需要连续多少帧相同才算稳定（默认 3，强于旧版的 2）。下限钳在 2。 */
  readonly stableFrames?: number
}

/** 画面稳定检测（kobe prompt-delivery，Plan3 Task15 强化）：
 * 连续 stableFrames 帧相同、且帧内容非空、且距调用起已过 minElapsedMs 才判定稳定再投递——
 * 单看「两帧相等」在 engine 冷启动的空白瞬时稳定窗口里会被误判（capturePane 唯一允许的非测试用途：不解析内容，只比对相等/非空）。 */
export const waitStable = (
  tmux: TmuxServiceShape, target: string, opts?: DeliveryOpts,
): Effect.Effect<string, TmuxError> =>
  Effect.gen(function* () {
    const interval = opts?.intervalMs ?? 250
    const attempts = opts?.attempts ?? 24
    const minElapsedMs = opts?.minElapsedMs ?? 1500
    const stableFrames = Math.max(2, opts?.stableFrames ?? 3)
    const start = Date.now()
    let prev: string | null = null
    let streak = 0
    for (let i = 0; i < attempts; i++) {
      const frame = yield* tmux.capturePane(target)
      const nonEmpty = frame !== ""
      streak = nonEmpty && prev !== null && frame === prev ? streak + 1 : (nonEmpty ? 1 : 0)
      prev = frame
      if (streak >= stableFrames && Date.now() - start >= minElapsedMs) return frame
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
