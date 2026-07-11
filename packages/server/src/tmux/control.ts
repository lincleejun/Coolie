import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { sanitizedTmuxEnv } from "./env.js"

/**
 * 持久 tmux control-mode client（agent-deck keysender 同款动机：macOS 逐次 fork+exec
 * send-keys 有 10–50ms 延迟，打断/回车热路径要 <1ms）。
 * - 子进程：`tmux -C new-session -A -s coolie-ctl "sleep …"`（hub session 只是落脚点）
 * - 行协议：一行一命令，按序回 %begin…%end（成功）/ %begin…%error（失败）块
 * - ⚠ 连接守卫块（F1，实证）：new-session -A 自身的 %begin…%end/%error 回复块**永远最先到**
 *   （每次重连亦然）——必须吞掉、不结算 pending，否则所有回复整体错位一格
 * - 死了下次 exec 自动重连；命令超时杀 child（卡死的 client 不可信）
 * - 局限（文档化）：命令行不能携带内嵌换行 → 文本投递走 TmuxService.pasteText 的 buffer 路径
 */
export interface ControlClient {
  readonly exec: (command: string) => Promise<void>
  readonly dispose: () => void
  readonly isAlive: () => boolean
  readonly childPid: () => number | null
}

interface Pending { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export const makeControlClient = (
  socket: string,
  opts?: { readonly hubSession?: string; readonly timeoutMs?: number },
): ControlClient => {
  const hub = opts?.hubSession ?? "coolie-ctl"
  const timeoutMs = opts?.timeoutMs ?? 3000
  let child: ChildProcessWithoutNullStreams | null = null
  let pending: Pending[] = []
  let buf = ""
  let disposed = false
  /** F1：连接守卫——每次 (re)spawn 后的第一个 %end/%error 块属于 new-session -A 本身，必须吞掉 */
  let awaitingGuard = false
  /**
   * 世代计数（generation-scoped state，修复 timeout↔respawn 竞态）：每次 (re)spawn 递增，
   * 新 child 的 exit/error/onLine 闭包各自捕获自己的 gen。超时/exit 触发的收尾动作先比对
   * `gen !== generation`——若已经不是当前这一代，说明更新的 child 早已接管，直接放弃
   * （不 failAll、不碰 `child`），防止陈旧 child 的迟到事件结算/清空活着的新 child 状态。
   */
  let generation = 0

  const settle = (err: Error | null): void => {
    const p = pending.shift()
    if (!p) return // 杂散回复防御（守卫块另由 awaitingGuard 单独处理）
    clearTimeout(p.timer)
    err ? p.reject(err) : p.resolve()
  }
  const failAll = (why: string): void => { while (pending.length > 0) settle(new Error(why)) }

  const onLine = (line: string): void => {
    if (line.startsWith("%end") || line.startsWith("%error")) {
      if (awaitingGuard) { awaitingGuard = false; return } // F1：守卫块不结算 pending
      if (line.startsWith("%end")) settle(null)
      else settle(new Error(`tmux control error: ${line}`))
    }
    // %begin/%session-changed/%output 等其余通知：忽略
  }

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (child && child.exitCode === null && !child.killed) return child
    const gen = ++generation // 这次 (re)spawn 是新的一代；旧一代的收尾动作从此全部失效
    const spawned = spawn(
      "tmux",
      ["-L", socket, "-C", "-f", "/dev/null", "new-session", "-A", "-s", hub, "-x", "40", "-y", "10", "sleep 2147483647"],
      { env: sanitizedTmuxEnv(), stdio: ["pipe", "pipe", "pipe"] },
    )
    child = spawned
    awaitingGuard = true // F1：这个连接的第一个回复块是守卫块（重连同样成立）
    buf = ""
    spawned.stdout.on("data", (c: Buffer) => {
      if (gen !== generation) return // 陈旧世代的杂散输出：新 child 已接管，忽略
      buf += c.toString("utf8")
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
    })
    spawned.on("error", () => {
      if (gen !== generation) return
      failAll("tmux control client spawn error")
    })
    spawned.on("exit", () => {
      // ⚠ 竞态修复核心：这个 exit 事件可能迟到——期间已经有更新的一代 respawn 了。
      // 若如此，`child`/`pending` 早已属于新一代，绝不能在此无条件 failAll/置空（会误杀活着的新 child）。
      if (gen !== generation) return
      failAll("tmux control client exited")
      child = null
    })
    return spawned
  }

  return {
    exec: (command) => {
      if (disposed) return Promise.reject(new Error("control client disposed"))
      const c = ensureChild()
      const gen = generation // 本次 exec 绑定的世代——超时收尾前先确认自己还代表当前 child
      return new Promise<void>((resolve, reject) => {
        const entry: Pending = {
          resolve, reject,
          timer: setTimeout(() => {
            if (gen !== generation) return // 已经被更新世代的 respawn 处理过，本 timer 是陈旧的
            // 超时：这一代 child 不可信了（可能卡死，可能马上要送来错位的迟到回复）。整代连坐——
            // 拒绝所有排队命令（不只这一条）、清空队列、杀 child、置空，彻底消灭“陈旧 pending[0]”
            // 被下一代真实回复顶包结算的窗口（F1 的镜像问题：这次是 respawn 而非重连本身）。
            failAll(`tmux control command timeout (${timeoutMs}ms): ${command}`)
            child?.kill("SIGKILL")
            child = null
          }, timeoutMs),
        }
        pending.push(entry)
        c.stdin.write(command + "\n")
      })
    },
    dispose: () => { disposed = true; failAll("control client disposed"); child?.kill(); child = null },
    isAlive: () => child !== null && child.exitCode === null && !child.killed,
    childPid: () => (child && child.exitCode === null ? child.pid ?? null : null),
  }
}
