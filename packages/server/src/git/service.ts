import { Context, Data, Effect, Layer } from "effect"
import { execFile } from "node:child_process"

export class GitError extends Data.TaggedError("GitError")<{
  readonly op: string
  readonly message: string
  readonly exitCode: number | null
  readonly stderr: string
}> {}

export interface WorktreeInfo {
  readonly path: string
  readonly head: string
  /** 全 ref 名（refs/heads/x）；detached 时为 null */
  readonly branch: string | null
  readonly bare: boolean
}

export interface GitServiceShape {
  readonly remoteExists: (repoRoot: string, name: string) => Effect.Effect<boolean, GitError>
  readonly fetchOrigin: (repoRoot: string) => Effect.Effect<void, GitError>
  readonly refExists: (repoRoot: string, ref: string) => Effect.Effect<boolean, GitError>
  readonly revParse: (repoRoot: string, ref: string) => Effect.Effect<string, GitError>
  /** git merge-base <a> <b>；所有参数均经 execFile argv 传递。 */
  readonly mergeBase: (repoRoot: string, a: string, b: string) => Effect.Effect<string, GitError>
  /** git worktree add --no-track -b <branch> <path> <startPoint> */
  readonly worktreeAdd: (repoRoot: string, path: string, branch: string, startPoint: string) => Effect.Effect<void, GitError>
  /** git worktree add <path> <branch>（unarchive/retry：branch 已存在） */
  readonly worktreeAddExisting: (repoRoot: string, path: string, branch: string) => Effect.Effect<void, GitError>
  /** 唯一的删除入口；脏树时 git 自动拒绝，force 必须显式传（绝不裸 rm） */
  readonly worktreeRemove: (repoRoot: string, path: string, opts: { force: boolean }) => Effect.Effect<void, GitError>
  readonly worktreePrune: (repoRoot: string) => Effect.Effect<void, GitError>
  readonly worktreeList: (repoRoot: string) => Effect.Effect<WorktreeInfo[], GitError>
  /** git status --porcelain 非空（含 untracked；ignored 不算——与 worktree remove 的判定一致） */
  readonly isDirty: (worktreePath: string) => Effect.Effect<boolean, GitError>
  /** git config branch.<branch>.base <base>（Conductor 惯例，供 diff 基点用） */
  readonly setBranchBase: (repoRoot: string, branch: string, base: string) => Effect.Effect<void, GitError>
  /** Rename a checked-out branch from its worktree, preserving worktree registration. */
  readonly renameBranch: (worktreePath: string, oldBranch: string, newBranch: string) => Effect.Effect<void, GitError>
  /** git ls-files --others --ignored --exclude-standard -- <pathspecs>：用 git 自己做 gitignore 匹配 */
  readonly listIgnoredMatching: (repoRoot: string, patterns: readonly string[]) => Effect.Effect<string[], GitError>
  /** All ignored, untracked files under repo root (copy eligibility candidates). */
  readonly listIgnoredUntracked: (repoRoot: string) => Effect.Effect<string[], GitError>
}
export class GitService extends Context.Tag("GitService")<GitService, GitServiceShape>() {}

const runGit = (op: string, args: readonly string[], cwd: string): Effect.Effect<string, GitError> =>
  Effect.async<string, GitError>((resume) => {
    execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout, stderr) => {
      if (error) {
        resume(Effect.fail(new GitError({
          op,
          message: `git ${op} 失败：${String(stderr || error.message).trim()}`,
          exitCode: typeof error.code === "number" ? error.code : null,
          stderr: String(stderr ?? ""),
        })))
      } else {
        resume(Effect.succeed(stdout))
      }
    })
  })

export const parseWorktreeList = (porcelain: string): WorktreeInfo[] =>
  porcelain.trim().split("\n\n").filter((b) => b.trim() !== "").map((block) => {
    let p = "", head = "", bare = false
    let branch: string | null = null
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) p = line.slice("worktree ".length)
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length)
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length)
      else if (line === "bare") bare = true
    }
    return { path: p, head, branch, bare }
  })

export const GitServiceLive = Layer.succeed(GitService, {
  remoteExists: (repoRoot, name) =>
    runGit("remote", ["remote"], repoRoot).pipe(
      Effect.map((out) => out.split("\n").map((l) => l.trim()).includes(name))),
  fetchOrigin: (repoRoot) =>
    runGit("fetch", ["fetch", "origin"], repoRoot).pipe(Effect.asVoid),
  refExists: (repoRoot, ref) =>
    runGit("rev-parse", ["rev-parse", "--verify", "--quiet", ref], repoRoot).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)), // 不存在与仓库级错误统一视为 false（M1 足够）
    ),
  revParse: (repoRoot, ref) =>
    runGit("rev-parse", ["rev-parse", "--verify", ref], repoRoot).pipe(Effect.map((s) => s.trim())),
  mergeBase: (repoRoot, a, b) =>
    runGit("merge-base", ["merge-base", "--", a, b], repoRoot).pipe(Effect.map((s) => s.trim())),
  worktreeAdd: (repoRoot, p, branch, startPoint) =>
    runGit("worktree add", ["worktree", "add", "--no-track", "-b", branch, p, startPoint], repoRoot).pipe(Effect.asVoid),
  worktreeAddExisting: (repoRoot, p, branch) =>
    runGit("worktree add", ["worktree", "add", p, branch], repoRoot).pipe(Effect.asVoid),
  worktreeRemove: (repoRoot, p, opts) =>
    runGit("worktree remove",
      opts.force ? ["worktree", "remove", "--force", p] : ["worktree", "remove", p],
      repoRoot).pipe(Effect.asVoid),
  worktreePrune: (repoRoot) =>
    runGit("worktree prune", ["worktree", "prune"], repoRoot).pipe(Effect.asVoid),
  worktreeList: (repoRoot) =>
    runGit("worktree list", ["worktree", "list", "--porcelain"], repoRoot).pipe(Effect.map(parseWorktreeList)),
  isDirty: (worktreePath) =>
    runGit("status", ["status", "--porcelain"], worktreePath).pipe(Effect.map((out) => out.trim() !== "")),
  setBranchBase: (repoRoot, branch, base) =>
    runGit("config", ["config", `branch.${branch}.base`, base], repoRoot).pipe(Effect.asVoid),
  renameBranch: (worktreePath, oldBranch, newBranch) =>
    runGit("branch -m", ["branch", "-m", oldBranch, newBranch], worktreePath).pipe(Effect.asVoid),
  listIgnoredMatching: (repoRoot, patterns) => {
    if (patterns.length === 0) return Effect.succeed([])
    // 无 '/' 的 pattern 视为任意层级（gitignore 直觉）：加 **/ 前缀；带 '/' 的按原样根相对匹配
    const pathspecs = patterns.map((p) => (p.includes("/") ? `:(glob)${p}` : `:(glob)**/${p}`))
    return runGit("ls-files",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...pathspecs],
      repoRoot).pipe(Effect.map((out) => out.split("\0").filter((s) => s !== "")))
  },
  listIgnoredUntracked: (repoRoot) =>
    runGit("ls-files",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--"],
      repoRoot).pipe(Effect.map((out) => out.split("\0").filter((s) => s !== ""))),
} satisfies GitServiceShape)
