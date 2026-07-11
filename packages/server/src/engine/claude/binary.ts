import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

/**
 * claude 二进制多路径发现（opcode claude_binary.rs 路线，GUI 进程 PATH 极简的解药）：
 * COOLIE_CLAUDE_BIN 显式指定 > which > 标准安装位置（~/.local/bin、~/.claude/local、homebrew、nvm）。
 * 找不到返回 null，调用方降级用裸 "claude"（依赖 PATH）并由 doctor 提示。
 */
export const discoverClaudeBinary = (opts?: {
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: (p: string) => boolean
  readonly which?: () => string | null
}): string | null => {
  const env = opts?.env ?? process.env
  const probe = opts?.probe ?? ((p: string) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false }
  })
  const which = opts?.which ?? (() => {
    try { return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null } catch { return null }
  })
  const explicit = env.COOLIE_CLAUDE_BIN
  if (explicit && probe(explicit)) return explicit
  const w = which()
  if (w && probe(w)) return w
  const home = os.homedir()
  const candidates = [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]
  const nvm = path.join(home, ".nvm", "versions", "node")
  try { for (const v of fs.readdirSync(nvm)) candidates.push(path.join(nvm, v, "bin", "claude")) } catch { /* 无 nvm */ }
  for (const c of candidates) if (probe(c)) return c
  return null
}
