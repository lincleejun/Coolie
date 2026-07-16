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

export type FilesToCopySource = "worktreeinclude" | "project" | "default"

export interface ResolvedFilesToCopyRules {
  readonly source: FilesToCopySource
  readonly patterns: readonly string[]
}

const WORKTREE_INCLUDE = ".worktreeinclude"

const normalizeRelPath = (rel: string): string => rel.replace(/\\/g, "/")

/** Parse gitignore-style include lines; drop comments and blanks. */
export const parseIncludeRuleLines = (content: string): string[] =>
  content.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))

/** Read repo-root `.worktreeinclude` when present; null when absent. */
export const readWorktreeIncludeFileLines = (repoRoot: string): string[] | null => {
  const p = path.join(repoRoot, WORKTREE_INCLUDE)
  if (!fs.existsSync(p)) return null
  return parseIncludeRuleLines(fs.readFileSync(p, "utf8"))
}

/**
 * Resolve Files-to-copy rules with fixed precedence (FR-3.1):
 * `.worktreeinclude` > project settings > built-in `.env*`.
 * An existing `.worktreeinclude` fully replaces lower layers; an empty file copies nothing.
 */
export const resolveFilesToCopyRules = (
  repoRoot: string,
  projectPatterns?: readonly string[],
): ResolvedFilesToCopyRules => {
  const worktreeInclude = readWorktreeIncludeFileLines(repoRoot)
  if (worktreeInclude !== null)
    return { source: "worktreeinclude", patterns: worktreeInclude }
  const project = (projectPatterns ?? []).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
  if (project.length > 0)
    return { source: "project", patterns: project }
  return { source: "default", patterns: [...DEFAULT_INCLUDE_PATTERNS] }
}

/** Back-compat helper returning only the resolved pattern list. */
export const readWorktreeIncludePatterns = (repoRoot: string): string[] =>
  [...resolveFilesToCopyRules(repoRoot).patterns]

const splitRule = (rule: string): { negated: boolean; pattern: string } => {
  const trimmed = rule.trim()
  if (trimmed.startsWith("!"))
    return { negated: true, pattern: trimmed.slice(1).trim() }
  return { negated: false, pattern: trimmed }
}

const escapeRegex = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, "\\$&")

/** Convert one gitignore-style rule into a matcher for repo-relative paths. */
export const gitignoreRuleToRegExp = (rule: string): RegExp => {
  const { pattern } = splitRule(rule)
  if (pattern === "") return /^$/

  let body = pattern
  const dirOnly = body.endsWith("/")
  const anchored = body.startsWith("/")
  if (anchored) body = body.slice(1)
  if (dirOnly) body = body.slice(0, -1)

  let re = ""
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!
    if (ch === "*") {
      if (body[i + 1] === "*") {
        re += ".*"
        i += 1
      } else {
        re += "[^/]*"
      }
    } else if (ch === "?") {
      re += "[^/]"
    } else {
      re += escapeRegex(ch)
    }
  }

  if (anchored || pattern.includes("/"))
    return new RegExp(`^${re}${dirOnly ? "(?:/.*)?$" : "$"}`)
  return new RegExp(`(?:^|/)${re}${dirOnly ? "(?:/.*)?$" : "(?:$|/)"}`)
}

export const pathMatchesGitignoreRule = (relPath: string, rule: string): boolean => {
  const { pattern } = splitRule(rule)
  if (pattern === "") return false
  return gitignoreRuleToRegExp(rule).test(normalizeRelPath(relPath))
}

/** Last matching rule wins; leading `!` negates the match. */
export const isIncludedByRules = (relPath: string, rules: readonly string[]): boolean => {
  const normalized = normalizeRelPath(relPath)
  let included = false
  for (const rule of rules) {
    if (!rule.trim() || rule.trim().startsWith("#")) continue
    if (!pathMatchesGitignoreRule(normalized, rule)) continue
    included = !splitRule(rule).negated
  }
  return included
}

/** Apply resolved rules to gitignored untracked candidates. */
export const selectIncludedPaths = (
  candidates: readonly string[],
  rules: readonly string[],
): string[] => candidates.filter((rel) => isIncludedByRules(rel, rules))

/** 把 repoRoot 下的相对路径文件复制进 worktree（保结构）。 */
export const copyIncludedFiles = (
  repoRoot: string,
  worktreePath: string,
  relFiles: readonly string[],
): string[] => {
  const copied: string[] = []
  const normalizedRepoRoot = path.resolve(repoRoot)
  const normalizedWorktreePath = path.resolve(worktreePath)
  for (const rel of relFiles) {
    const src = path.resolve(normalizedRepoRoot, rel)
    const dst = path.resolve(normalizedWorktreePath, rel)
    if (!src.startsWith(normalizedRepoRoot + path.sep) || !dst.startsWith(normalizedWorktreePath + path.sep)) continue
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    copied.push(rel)
  }
  return copied
}
