import * as pty from "node-pty"
import * as os from "node:os"
import { execFile } from "node:child_process"
import { sanitizedTmuxEnv } from "../tmux/env.js"

export interface AttachOpts {
  readonly socket: string
  readonly session: string
  readonly window: number
  readonly cols: number
  readonly rows: number
}

/** node-pty 里跑 `tmux attach`：pty 是 tmux 的客户端，杀它只断观看，session/engine 无感。
 * encoding:null = 字节保真直通（Superset byte-fidelity 教训：utf8 decode 会截断半个多字节字符）。 */
export const spawnTmuxAttach = ({ socket, session, window, cols, rows }: AttachOpts): pty.IPty =>
  pty.spawn("tmux", ["-L", socket, "attach", "-t", `=${session}:${window}`], {
    name: "xterm-256color", cols, rows, cwd: os.homedir(),
    env: sanitizedTmuxEnv(),
    // node-pty 支持 encoding:null（emit Buffer）；typings 只写 string，显式 cast 并在 onData 侧归一
    encoding: null as unknown as string,
  })

const runTmux = (socket: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("tmux", ["-L", socket, ...args], { env: sanitizedTmuxEnv() }, (err) =>
      err ? reject(err) : resolve(),
    )
  })

let viewCounter = 0
/** 每 WS 连接的一次性 grouped view session 名。grouped session 共享 window 列表但 current-window 独立，
 * 是「多 tab 各看各 window」的正解（D1：同 session 多 attach 客户端共享 current-window，切 window 互踢）。 */
export const viewSessionName = (session: string): string => {
  viewCounter = (viewCounter + 1) % 1_000_000
  return `${session}-view-${Date.now().toString(36)}-${viewCounter}`
}

/** 建 grouped view（`new-session -t <session>` 与之组内共享 windows）并 select 目标 window。
 * 该 view 的 current-window 独立于真 session 与其它 view——本连接的 xterm 只跟这个 view 的 window。 */
export const createGroupedView = async (opts: {
  readonly socket: string; readonly session: string; readonly viewSession: string; readonly window: number
}): Promise<void> => {
  const { socket, session, viewSession, window } = opts
  await runTmux(socket, ["new-session", "-d", "-s", viewSession, "-t", session])
  // conductor 风格：终端里不出现 tmux 绿色状态行。status 是 session 级选项，grouped view 是独立 session，
  // 必须各自关（否则每个 view 的状态栏时钟每秒重画 → 无谓字节流 + 状态栏污染画面）。失败不致命。
  await runTmux(socket, ["set-option", "-t", viewSession, "status", "off"]).catch(() => {})
  await runTmux(socket, ["select-window", "-t", `=${viewSession}:${window}`])
}

/** 杀 grouped view session：只回收这一个观看会话，绝不动真 session/windows（grouped 语义已验证）。幂等。 */
export const killGroupedView = (socket: string, viewSession: string): Promise<void> =>
  runTmux(socket, ["kill-session", "-t", `=${viewSession}`]).catch(() => {})
