import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

/**
 * Copilot CLI binary discovery (mirrors claude/binary.ts).
 * COOLIE_COPILOT_BIN > which > standard install paths.
 * Returns null when missing; callers fall back to bare "copilot".
 */
export const discoverCopilotBinary = (opts?: {
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: (p: string) => boolean
  readonly which?: () => string | null
}): string | null => {
  const env = opts?.env ?? process.env
  const probe = opts?.probe ?? ((p: string) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false }
  })
  const which = opts?.which ?? (() => {
    try { return execFileSync("which", ["copilot"], { encoding: "utf8" }).trim() || null } catch { return null }
  })
  const explicit = env.COOLIE_COPILOT_BIN
  if (explicit && probe(explicit)) return explicit
  const w = which()
  if (w && probe(w)) return w
  const home = os.homedir()
  const candidates = [
    path.join(home, ".local", "bin", "copilot"),
    "/opt/homebrew/bin/copilot",
    "/usr/local/bin/copilot",
  ]
  for (const c of candidates) if (probe(c)) return c
  return null
}
