import { execFileSync } from "node:child_process"
import { discoverCodexBinary } from "./adapter.js"

export interface CodexVersion {
  readonly major: number
  readonly minor: number
}

/** Codex 0.144 修复了 hooks 的启用、项目配置发现与 trust bypass；更早版本走 notify lane。 */
export const parseCodexVersion = (out: string): CodexVersion | null => {
  const match = /\b(\d+)\.(\d+)\.\d+\b/.exec(out)
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

export const codexVersionSupportsHooks = (version: CodexVersion): boolean =>
  version.major > 0 || version.minor >= 144

const defaultProbe = (): string | null => {
  try {
    return execFileSync(discoverCodexBinary() ?? "codex", ["--version"], {
      encoding: "utf8",
      timeout: 3000,
    })
  } catch {
    return null
  }
}

/** 启动时定档：显式覆写优先；探测失败保守使用 notify + mtime lane。 */
export const resolveCodexHooks = (probe: () => string | null = defaultProbe): boolean => {
  const override = (process.env.COOLIE_CODEX_HOOKS ?? "").trim().toLowerCase()
  if (override === "1" || override === "true") return true
  if (override === "0" || override === "false") return false
  const output = probe()
  if (output === null) return false
  const version = parseCodexVersion(output)
  return version !== null && codexVersionSupportsHooks(version)
}
