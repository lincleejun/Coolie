import { Context, Data, Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export class SetupScriptError extends Data.TaggedError("SetupScriptError")<{
  readonly script: string
  readonly exitCode: number | null
  readonly message: string
  readonly outputTail: string
}> {}

export interface SetupResult {
  readonly script: string
  readonly exitCode: number
  readonly outputTail: string
}

export interface SetupRunOpts {
  readonly worktreePath: string
  readonly scripts: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface SetupRunnerShape {
  readonly run: (opts: SetupRunOpts) => Effect.Effect<SetupResult[], SetupScriptError>
}
export class SetupRunner extends Context.Tag("SetupRunner")<SetupRunner, SetupRunnerShape>() {}

/**
 * 三层合并（设计文档 §四）：repo 层取 worktree 里的 checkout 版本（branch 各自生效）；
 * 本机覆盖层在 COOLIE_HOME；local overlay 在主 checkout 的 .coolie/（不入库，被 info/exclude 排除）。
 * 只返回存在的脚本，按 repo → 本机 → local 顺序执行。
 */
export const resolveSetupScripts = (opts: {
  readonly worktreePath: string
  readonly repoRoot: string
  readonly projectId: string
  readonly home: string
}): string[] => {
  const candidates = [
    path.join(opts.worktreePath, ".coolie", "setup.sh"),
    path.join(opts.home, "projects", opts.projectId, "setup.sh"),
    path.join(opts.repoRoot, ".coolie", "setup.local.sh"),
  ]
  return candidates.filter((p) => fs.existsSync(p))
}

const TAIL_CHARS = 4000
const DEFAULT_TIMEOUT_MS = 600_000 // 10 分钟

const runOne = (
  script: string,
  opts: SetupRunOpts,
  log: ((chunk: string) => void) | undefined,
): Promise<SetupResult> =>
  new Promise((resolve, reject) => {
    // 非交互：stdin ignore；stdout/stderr 合流截尾落 events，整流经 log 落 server.log。
    // detached: true 让 bash 自成进程组——超时才能连它留下的后台子进程一起杀
    const child = spawn("bash", [script], {
      cwd: opts.worktreePath,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    let tail = ""
    let timedOut = false
    const push = (c: Buffer): void => {
      const s = c.toString()
      tail = (tail + s).slice(-TAIL_CHARS)
      log?.(s)
    }
    child.stdout.on("data", push)
    child.stderr.on("data", push)
    const timer = setTimeout(() => {
      timedOut = true
      // 杀整个进程组：脚本留下的后台子进程（如 `npm run dev &`）只杀 bash 是清不掉的
      // （Plan 1 daemon.test.ts 的进程组教训同款）
      try { process.kill(-child.pid!, "SIGKILL") } catch { /* 组已不在 */ }
      child.kill("SIGKILL") // 兜底
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(new SetupScriptError({ script, exitCode: null, message: `无法启动 setup script：${e.message}`, outputTail: tail }))
    })
    // 以 'exit' 定局而非 'close'：后台子进程若继承并握住 stdout/stderr 管道，
    // 'close' 要等管道全关、永不触发；'exit' 在 bash 本体退出即触发
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (timedOut)
        return reject(new SetupScriptError({ script, exitCode: null, message: `setup script 超时被杀（${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`, outputTail: tail }))
      if (code === 0) return resolve({ script, exitCode: 0, outputTail: tail })
      reject(new SetupScriptError({ script, exitCode: code, message: `setup script 退出码 ${code}：${script}`, outputTail: tail }))
    })
  })

/** log 参数供 main.ts 接诊断日志（fire-and-forget）；测试用无参版 SetupRunnerLive。 */
export const makeSetupRunnerLive = (log?: (chunk: string) => void): Layer.Layer<SetupRunner> =>
  Layer.succeed(SetupRunner, {
    run: (opts) => Effect.gen(function* () {
      const results: SetupResult[] = []
      for (const script of opts.scripts) {
        results.push(yield* Effect.tryPromise({
          try: () => runOne(script, opts, log),
          catch: (e) => e instanceof SetupScriptError
            ? e
            : new SetupScriptError({ script, exitCode: null, message: String(e), outputTail: "" }),
        }))
      }
      return results
    }),
  })
export const SetupRunnerLive = makeSetupRunnerLive()
