import * as fs from "node:fs"
import * as path from "node:path"

const MAX_BYTES = 64 * 1024
const CANDIDATES = [
  [".coolie", "pr-instructions.md"],
  [".github", "pull_request_template.md"],
] as const

export interface PrInstructions {
  content: string
  source: string | null
}

export const readPrInstructions = (worktreePath: string): PrInstructions => {
  const root = fs.realpathSync(worktreePath)
  for (const parts of CANDIDATES) {
    const candidate = path.join(root, ...parts)
    if (!fs.existsSync(candidate)) continue
    const real = fs.realpathSync(candidate)
    if (real !== root && !real.startsWith(`${root}${path.sep}`))
      throw new Error("PR instruction path escapes the workspace")
    const stat = fs.statSync(real)
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("PR instructions must be a file smaller than 64 KiB")
    return { content: fs.readFileSync(real, "utf8"), source: parts.join("/") }
  }
  return {
    content: "Review the current changes and create a pull request. Summarize the change and include a test plan.",
    source: null,
  }
}
