import * as fs from "node:fs"
import * as path from "node:path"

/**
 * 往 <repoRoot>/.git/info/exclude 幂等追加一行（默认 .coolie/）。
 * info/exclude 属 common git dir，所有 worktree 共享——注一次全体生效，且零仓库污染（Conductor 手法）。
 */
export const injectInfoExclude = (repoRoot: string, entry = ".coolie/"): void => {
  // Resolve real git dir (worktrees have .git as a FILE pointing to worktrees/<name>)
  let gitDir = path.join(repoRoot, ".git")
  const st = fs.statSync(gitDir, { throwIfNoEntry: false })
  if (st?.isFile()) {
    const m = fs.readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)
    if (m) gitDir = path.resolve(repoRoot, m[1]!)
  }

  // Hop to commondir if present (worktree gitdirs have a commondir pointer)
  const commonDirFile = path.join(gitDir, "commondir")
  if (fs.existsSync(commonDirFile)) {
    const commondirContent = fs.readFileSync(commonDirFile, "utf8").trim()
    gitDir = path.resolve(gitDir, commondirContent)
  }

  const p = path.join(gitDir, "info", "exclude")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""
  if (cur.split("\n").some((l) => l.trim() === entry)) return
  const sep = cur === "" || cur.endsWith("\n") ? "" : "\n"
  fs.appendFileSync(p, `${sep}${entry}\n`)
}

/** .worktreeinclude 缺席时的默认 pattern（Conductor 默认同款）。 */
export const DEFAULT_INCLUDE_PATTERNS = [".env*"] as const

export const readWorktreeIncludePatterns = (repoRoot: string): string[] => {
  const p = path.join(repoRoot, ".worktreeinclude")
  if (!fs.existsSync(p)) return [...DEFAULT_INCLUDE_PATTERNS]
  const lines = fs.readFileSync(p, "utf8").split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
  return lines.length > 0 ? lines : [...DEFAULT_INCLUDE_PATTERNS]
}

/** 把 repoRoot 下的相对路径文件复制进 worktree（保结构）。列表来自 GitService.listIgnoredMatching。 */
export const copyIncludedFiles = (
  repoRoot: string,
  worktreePath: string,
  relFiles: readonly string[],
): string[] => {
  const copied: string[] = []
  // Normalize bases to handle trailing separators
  const normalizedRepoRoot = path.resolve(repoRoot)
  const normalizedWorktreePath = path.resolve(worktreePath)
  for (const rel of relFiles) {
    const src = path.resolve(normalizedRepoRoot, rel)
    const dst = path.resolve(normalizedWorktreePath, rel)
    // Containment guard: skip if src escapes repoRoot or dst escapes worktreePath
    if (!src.startsWith(normalizedRepoRoot + path.sep) || !dst.startsWith(normalizedWorktreePath + path.sep)) continue
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    copied.push(rel)
  }
  return copied
}
