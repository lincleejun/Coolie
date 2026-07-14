/**
 * ComposerOps：composer 投递/tab 动作的 Promise 门面（http 路由消费）。
 * 复用 Plan 3 的 deliverPrompt/waitStable/sanitize——绝不绕过消毒与稳定检测。
 * skipStable 的存在理由：engine working 时 TUI spinner 持续重画，waitStable 永远不满足；
 * claude nativeQueue=true 意味着忙时直接 paste 是安全的（TUI 原生排队），此时客户端传 skipStable=true。
 */
import { Effect } from "effect"
import type { TmuxServiceShape } from "./service.js"
import { deliverPrompt, waitStable } from "./delivery.js"
import { sanitizePromptForPty } from "./sanitize.js"

export type InputMode = "send" | "interrupt-send" | "insert" | "interrupt"

export interface ComposerOps {
  input(target: string, opts: { text: string; mode: InputMode; skipStable: boolean }): Promise<void>
  newShellWindow(session: string, cwd: string): Promise<number>
  killWindow(session: string, index: number): Promise<void>
  listWindows?(session: string): Promise<ReadonlyArray<{ readonly index: number; readonly name: string }>>
  newRunWindow?(session: string, cwd: string, script: string): Promise<number>
  respawnRunWindow?(session: string, window: number, cwd: string, script: string): Promise<void>
}

const ENTER_DELAY_MS = 150 // kobe 实测：粘贴终止符与回车必须分开两次 tty read

export const makeComposerOps = (tmux: TmuxServiceShape): ComposerOps => {
  // script 路径只作为 $1 argv 传入；不插值进 shell 程序文本。
  const runCommand = (script: string): readonly string[] => [
    "/bin/sh", "-c",
    'script="$1"; /bin/bash "$script"; code=$?; printf "\\n[coolie run exited %s]\\n" "$code"; exec "${SHELL:-/bin/sh}" -l',
    "coolie-run", script,
  ]
  const pasteClean = (target: string, text: string, enter: boolean) =>
    Effect.gen(function* () {
      const clean = sanitizePromptForPty(text)
      if (clean === "") return
      yield* tmux.pasteText(target, clean)
      if (enter) {
        yield* Effect.sleep(ENTER_DELAY_MS)
        yield* tmux.sendKey(target, "Enter")
      }
    })
  return {
    input: (target, { text, mode, skipStable }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (mode === "interrupt") { yield* tmux.sendKey(target, "Escape"); return }
          if (mode === "interrupt-send") {
            yield* tmux.sendKey(target, "Escape")
            yield* deliverPrompt(tmux, target, text) // Esc 后画面会稳定 → 完整管线
            return
          }
          if (mode === "send") {
            if (skipStable) yield* pasteClean(target, text, true)
            else yield* deliverPrompt(tmux, target, text)
            return
          }
          // insert：paste 不回车
          if (!skipStable) yield* waitStable(tmux, target)
          yield* pasteClean(target, text, false)
        }),
      ),
    newShellWindow: (session, cwd) =>
      Effect.runPromise(tmux.newWindow({ session, name: "shell", cwd })),
    listWindows: (session) => Effect.runPromise(tmux.listWindows(session)),
    newRunWindow: (session, cwd, script) =>
      Effect.runPromise(tmux.newWindow({ session, name: "run", cwd, command: runCommand(script) })),
    respawnRunWindow: (session, window, cwd, script) =>
      Effect.runPromise(tmux.respawnWindow({ session, window, cwd, command: runCommand(script) })),
    killWindow: (session, index) => Effect.runPromise(tmux.killWindow(session, index)),
  }
}
