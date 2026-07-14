/**
 * 只读 git 观察面（GUI 左栏 diff 计数 / 右栏 Changes / @文件列表）。
 * Promise 版而非 Effect：这些端点无写操作、无回滚语义，http 路由直接 await + try/catch 映射 GitError 即可，
 * 不值得为其扩 AppServices union（避免波及全部既有 http 测试的 runtime 类型）。
 */
import { execFile } from "node:child_process"

export interface DiffStat { filesChanged: number; insertions: number; deletions: number }
export interface FileChange { path: string; insertions: number; deletions: number }
export interface ChangesReport {
  againstBase: FileChange[]; committed: FileChange[]
  staged: FileChange[]; unstaged: FileChange[]; untracked: string[]
}

const run = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} 失败：${String(stderr || error.message).trim()}`))
      else resolve(stdout)
    })
  })

export const parseShortstat = (out: string): DiffStat => ({
  filesChanged: Number(out.match(/(\d+) files? changed/)?.[1] ?? 0),
  insertions: Number(out.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
  deletions: Number(out.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
})

/** numstat 行：`ins\tdel\tpath`；二进制为 `-\t-\tpath` → 0/0（M1 不标 binary 位） */
export const parseNumstat = (out: string): FileChange[] =>
  out.split("\n").filter((l) => l !== "").map((l) => {
    const [ins, del, ...rest] = l.split("\t")
    return {
      path: rest.join("\t"),
      insertions: ins === "-" ? 0 : Number(ins),
      deletions: del === "-" ? 0 : Number(del),
    }
  })

export const diffShortstat = (worktree: string, baseRef: string): Promise<DiffStat> =>
  run(worktree, ["diff", "--shortstat", baseRef]).then(parseShortstat)

export const collectChanges = async (worktree: string, baseRef: string): Promise<ChangesReport> => {
  const [againstBase, committed, staged, unstaged, untrackedRaw] = await Promise.all([
    run(worktree, ["diff", "--no-renames", "--numstat", baseRef]),          // base vs 工作树（总账）
    run(worktree, ["diff", "--no-renames", "--numstat", baseRef, "HEAD"]),  // base 之后已提交的
    run(worktree, ["diff", "--no-renames", "--numstat", "--cached"]),       // 已暂存
    run(worktree, ["diff", "--no-renames", "--numstat"]),                   // 未暂存
    run(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ])
  return {
    againstBase: parseNumstat(againstBase),
    committed: parseNumstat(committed),
    staged: parseNumstat(staged),
    unstaged: parseNumstat(unstaged),
    untracked: untrackedRaw.split("\0").filter((s) => s !== ""),
  }
}

export const listFiles = (worktree: string): Promise<string[]> =>
  run(worktree, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .then((out) => out.split("\0").filter((s) => s !== ""))

export type DiffSection = "againstBase" | "committed" | "staged" | "unstaged"
export interface FileDiff { path: string; section: DiffSection; unified: string; binary: boolean }

/** Build one-file read-only diff arguments. `--` terminates options before the pathspec. */
export const sectionDiffArgs = (section: DiffSection, baseRef: string, filePath: string): string[] => {
  const unified = "--unified=3"
  switch (section) {
    case "againstBase": return ["diff", "--no-renames", unified, baseRef, "--", filePath]
    case "committed": return ["diff", "--no-renames", unified, baseRef, "HEAD", "--", filePath]
    case "staged": return ["diff", "--no-renames", unified, "--cached", "--", filePath]
    case "unstaged": return ["diff", "--no-renames", unified, "--", filePath]
  }
}

const DIFF_SECTIONS: ReadonlySet<string> = new Set(["againstBase", "committed", "staged", "unstaged"])
export const isDiffSection = (value: string): value is DiffSection => DIFF_SECTIONS.has(value)

/** Reject absolute, traversal, platform-ambiguous, NUL, and option-shaped pathspecs. */
export const isSafeRelPath = (filePath: string): boolean => {
  if (filePath === "" || filePath.startsWith("/") || filePath.startsWith("-") ||
      filePath.includes("\\") || filePath.includes("\0")) return false
  return !filePath.split("/").some((segment) => segment === "..")
}

export const fileDiff = async (
  worktree: string,
  baseRef: string,
  section: DiffSection,
  filePath: string,
): Promise<FileDiff> => {
  const unified = await run(worktree, sectionDiffArgs(section, baseRef, filePath))
  const binary = /^Binary files .* differ$/m.test(unified) || unified.includes("GIT binary patch")
  return { path: filePath, section, unified, binary }
}

export interface GitReadOps {
  diffstat(worktree: string, baseRef: string): Promise<DiffStat>
  changes(worktree: string, baseRef: string): Promise<ChangesReport>
  files(worktree: string): Promise<string[]>
  diff(worktree: string, baseRef: string, section: DiffSection, path: string): Promise<FileDiff>
}
export const realGitRead: GitReadOps = { diffstat: diffShortstat, changes: collectChanges, files: listFiles, diff: fileDiff }
