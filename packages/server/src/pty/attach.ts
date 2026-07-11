import * as pty from "node-pty"
import * as os from "node:os"
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
