import { Context, Data, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { CoolieConfig } from "../config.js"
import { sanitizedTmuxEnv, shellQuote } from "./env.js"
import { makeControlClient, type ControlClient } from "./control.js"

export class TmuxError extends Data.TaggedError("TmuxError")<{
  readonly op: string
  readonly message: string
  readonly exitCode: number | null
  readonly stderr: string
}> {}

export interface TmuxWindowInfo { readonly index: number; readonly name: string }

export interface TmuxServiceShape {
  readonly socket: string
  readonly version: () => Effect.Effect<string, TmuxError>
  readonly hasSession: (name: string) => Effect.Effect<boolean, TmuxError>
  readonly newSession: (opts: {
    readonly name: string; readonly cwd: string; readonly windowName: string
    readonly command: readonly string[]; readonly env?: Readonly<Record<string, string>>
  }) => Effect.Effect<void, TmuxError>
  readonly newWindow: (opts: {
    readonly session: string; readonly name: string; readonly cwd: string
    readonly command?: readonly string[]
  }) => Effect.Effect<number, TmuxError>
  /** -k 原地替换 window 进程（Resume 语义）：布局/窗口序号零变动；session env 自动继承 */
  readonly respawnWindow: (opts: {
    readonly session: string; readonly window: number; readonly cwd: string
    readonly command: readonly string[]
  }) => Effect.Effect<void, TmuxError>
  /** 幂等：session 不存在视为成功（tmux 已达目标状态） */
  readonly killSession: (name: string) => Effect.Effect<void, TmuxError>
  /** 无 server 时返回 []（不视为错误） */
  readonly listSessions: () => Effect.Effect<string[], TmuxError>
  readonly listWindows: (session: string) => Effect.Effect<TmuxWindowInfo[], TmuxError>
  readonly listClients: () => Effect.Effect<string[], TmuxError>
  /** ⚠ 仅测试断言与 waitStable 稳定检测可用（Global Constraints：绝不 scrape 状态） */
  readonly capturePane: (target: string) => Effect.Effect<string, TmuxError>
  /** 文本投递：load-buffer(stdin) + paste-buffer -p —— 字节保真、可含换行、bracketed paste
   * （control-mode 行协议无法携带内嵌换行，故文本走 buffer 路径；见 Task 4 注释） */
  readonly pasteText: (target: string, text: string) => Effect.Effect<void, TmuxError>
  /** 命名键（Enter/Escape/C-c…）；Task 4 起走持久 control-mode client 热路径 */
  readonly sendKey: (target: string, key: string) => Effect.Effect<void, TmuxError>
  /** kill-window（shell tab 关闭）；window 不存在视为成功（幂等） */
  readonly killWindow: (session: string, index: number) => Effect.Effect<void, TmuxError>
}
export class TmuxService extends Context.Tag("TmuxService")<TmuxService, TmuxServiceShape>() {}

const runTmux = (
  socket: string, op: string, args: readonly string[], stdin?: string,
): Effect.Effect<string, TmuxError> =>
  Effect.async<string, TmuxError>((resume) => {
    const child = execFile(
      "tmux", ["-L", socket, ...args],
      { env: sanitizedTmuxEnv(), maxBuffer: 4 * 1024 * 1024 },
      (error: any, stdout, stderr) => {
        if (error) {
          const enoent = error?.code === "ENOENT"
          resume(Effect.fail(new TmuxError({
            op,
            message: enoent
              ? "tmux 不在 PATH（brew install tmux 后重试；coolie doctor 可检查）"
              : `tmux ${op} 失败：${String(stderr || error.message).trim()}`,
            exitCode: typeof error.code === "number" ? error.code : null,
            stderr: String(stderr ?? ""),
          })))
        } else resume(Effect.succeed(stdout))
      },
    )
    if (stdin !== undefined) { child.stdin?.write(stdin); child.stdin?.end() }
  })

/** exitCode 非 null = tmux 跑起来了但说「不」（session 不存在/no server）；null = 没跑起来（ENOENT 等），必须上抛 */
const benignFalse = (e: TmuxError): Effect.Effect<boolean, TmuxError> =>
  e.exitCode !== null ? Effect.succeed(false) : Effect.fail(e)

export const makeTmuxService = (socket: string, ctl?: ControlClient): TmuxServiceShape => ({
  socket,
  version: () => runTmux(socket, "version", ["-V"]).pipe(Effect.map((s) => s.trim())),
  hasSession: (name) =>
    runTmux(socket, "has-session", ["has-session", "-t", `=${name}`]).pipe(Effect.as(true), Effect.catchAll(benignFalse)),
  newSession: ({ name, cwd, windowName, command, env }) => {
    const envFlags = Object.entries(env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])
    return runTmux(socket, "new-session",
      ["new-session", "-d", "-s", name, "-n", windowName, "-c", cwd, "-x", "220", "-y", "50", ...envFlags, shellQuote(command)],
    ).pipe(Effect.asVoid)
  },
  newWindow: ({ session, name, cwd, command }) =>
    runTmux(socket, "new-window",
      ["new-window", "-t", `=${session}:`, "-n", name, "-c", cwd, "-P", "-F", "#{window_index}",
        ...(command && command.length > 0 ? [shellQuote(command)] : [])],
    ).pipe(Effect.map((out) => Number(out.trim()))),
  respawnWindow: ({ session, window, cwd, command }) =>
    runTmux(socket, "respawn-window",
      ["respawn-window", "-k", "-c", cwd, "-t", `=${session}:${window}`, shellQuote(command)],
    ).pipe(Effect.asVoid),
  killSession: (name) =>
    runTmux(socket, "kill-session", ["kill-session", "-t", `=${name}`]).pipe(
      Effect.asVoid,
      Effect.catchAll((e) => e.exitCode !== null ? Effect.void : Effect.fail(e)),
    ),
  listSessions: () =>
    runTmux(socket, "list-sessions", ["list-sessions", "-F", "#{session_name}"]).pipe(
      Effect.map((out) => out.split("\n").filter((s) => s !== "")),
      Effect.catchAll((e) => e.exitCode !== null ? Effect.succeed([] as string[]) : Effect.fail(e)),
    ),
  listWindows: (session) =>
    runTmux(socket, "list-windows", ["list-windows", "-t", `=${session}`, "-F", "#{window_index}\t#{window_name}"]).pipe(
      Effect.map((out) => out.split("\n").filter((s) => s !== "").map((l) => {
        const [i, ...rest] = l.split("\t")
        return { index: Number(i), name: rest.join("\t") }
      })),
    ),
  listClients: () =>
    runTmux(socket, "list-clients", ["list-clients", "-F", "#{client_tty}"]).pipe(
      Effect.map((out) => out.split("\n").filter((s) => s !== "")),
      Effect.catchAll((e) => e.exitCode !== null ? Effect.succeed([] as string[]) : Effect.fail(e)),
    ),
  capturePane: (target) => runTmux(socket, "capture-pane", ["capture-pane", "-p", "-t", `=${target}`]),
  pasteText: (target, text) => {
    // F4：buffer 名带随机后缀——并发 create 的两次投递不会互踩同名 buffer；-d 用完即删
    const buf = `coolie-paste-${Math.random().toString(36).slice(2, 10)}`
    return runTmux(socket, "load-buffer", ["load-buffer", "-b", buf, "-"], text).pipe(
      Effect.andThen(runTmux(socket, "paste-buffer", ["paste-buffer", "-p", "-d", "-b", buf, "-t", `=${target}`])),
      Effect.asVoid,
    )
  },
  sendKey: (target, key) =>
    ctl
      ? Effect.tryPromise({
          try: () => ctl.exec(`send-keys -t =${target} ${key}`),
          catch: (e) => new TmuxError({ op: "send-keys", message: e instanceof Error ? e.message : String(e), exitCode: null, stderr: "" }),
        })
      : runTmux(socket, "send-keys", ["send-keys", "-t", `=${target}`, key]).pipe(Effect.asVoid),
  killWindow: (session, index) =>
    runTmux(socket, "kill-window", ["kill-window", "-t", `=${session}:${index}`]).pipe(
      Effect.asVoid,
      Effect.catchAll((e) => e.exitCode !== null ? Effect.void : Effect.fail(e)),
    ),
})

export const TmuxServiceLive = Layer.scoped(
  TmuxService,
  Effect.gen(function* () {
    const cfg = yield* CoolieConfig
    const ctl = yield* Effect.acquireRelease(
      Effect.sync(() => makeControlClient(cfg.tmuxSocket)),
      (c) => Effect.sync(() => c.dispose()),
    )
    return makeTmuxService(cfg.tmuxSocket, ctl)
  }),
)
