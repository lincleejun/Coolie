import { Effect } from "effect"
import { GitError, type GitServiceShape, type WorktreeInfo } from "../../src/git/service.js"

export interface FakeGitState {
  /** 每次调用记录：[方法名, ...参数字符串] */
  readonly calls: string[][]
  /** ref 名 → 假 sha。默认含 main / origin/main / refs/remotes/origin/main */
  readonly refs: Map<string, string>
  /** worktree path → branch 名 */
  readonly worktrees: Map<string, string>
  /** 视为脏的 worktree path */
  readonly dirty: Set<string>
  /** branch → 写入的 base（setBranchBase 记录） */
  readonly branchBases: Map<string, string>
  /** listIgnoredMatching 返回值（可变） */
  ignoredFiles: string[]
  /** 命中即 fail 的方法名集合（可变） */
  readonly failOps: Set<string>
  hasOrigin: boolean
}

export const FAKE_SHA = "a".repeat(40)

export const makeFakeGit = (init?: {
  refs?: Record<string, string>
  hasOrigin?: boolean
  ignoredFiles?: string[]
}): { git: GitServiceShape; state: FakeGitState } => {
  const defaultRefs = { main: FAKE_SHA, "origin/main": FAKE_SHA, "refs/remotes/origin/main": FAKE_SHA }
  const state: FakeGitState = {
    calls: [],
    refs: new Map(Object.entries(init?.refs ?? defaultRefs)),
    worktrees: new Map(),
    dirty: new Set(),
    branchBases: new Map(),
    ignoredFiles: init?.ignoredFiles ?? [],
    failOps: new Set(),
    hasOrigin: init?.hasOrigin ?? true,
  }
  const rec = (...call: string[]): void => { state.calls.push(call) }
  const gitErr = (op: string, message: string): GitError =>
    new GitError({ op, message, exitCode: 128, stderr: "" })
  const guard = <A>(op: string, a: () => A): Effect.Effect<A, GitError> =>
    state.failOps.has(op) ? Effect.fail(gitErr(op, `fake git failure: ${op}`)) : Effect.sync(a)

  const git: GitServiceShape = {
    remoteExists: (repoRoot, name) => {
      rec("remoteExists", repoRoot, name)
      return guard("remoteExists", () => name === "origin" && state.hasOrigin)
    },
    fetchOrigin: (repoRoot) => { rec("fetchOrigin", repoRoot); return guard("fetchOrigin", () => undefined) },
    refExists: (repoRoot, ref) => { rec("refExists", repoRoot, ref); return guard("refExists", () => state.refs.has(ref)) },
    revParse: (repoRoot, ref) => {
      rec("revParse", repoRoot, ref)
      if (state.failOps.has("revParse")) return Effect.fail(gitErr("revParse", "fake git failure: revParse"))
      const sha = state.refs.get(ref)
      return sha ? Effect.succeed(sha) : Effect.fail(gitErr("rev-parse", `unknown ref ${ref}`))
    },
    mergeBase: (repoRoot, a, b) => {
      rec("mergeBase", repoRoot, a, b)
      return guard("mergeBase", () => state.refs.get(b) ?? state.refs.get(a) ?? FAKE_SHA)
    },
    worktreeAdd: (repoRoot, p, branch, startPoint) => {
      rec("worktreeAdd", repoRoot, p, branch, startPoint)
      return guard("worktreeAdd", () => {
        const sha = state.refs.get(startPoint) ?? FAKE_SHA
        state.refs.set(`refs/heads/${branch}`, sha)
        state.worktrees.set(p, branch)
      })
    },
    worktreeAddExisting: (repoRoot, p, branch) => {
      rec("worktreeAddExisting", repoRoot, p, branch)
      // 真实 git 对已注册路径拒绝 add（"already exists"）——不这样做会掩盖 unarchive 的半成品重试 bug
      if (state.worktrees.has(p)) return Effect.fail(gitErr("worktree add", `'${p}' already exists`))
      return guard("worktreeAddExisting", () => { state.worktrees.set(p, branch) })
    },
    worktreeRemove: (repoRoot, p, opts) => {
      rec("worktreeRemove", repoRoot, p, String(opts.force))
      if (state.failOps.has("worktreeRemove")) return Effect.fail(gitErr("worktreeRemove", "fake git failure: worktreeRemove"))
      if (!state.worktrees.has(p)) return Effect.fail(gitErr("worktree remove", `not a working tree: ${p}`))
      if (state.dirty.has(p) && !opts.force) return Effect.fail(gitErr("worktree remove", "contains modified or untracked files"))
      return Effect.sync(() => { state.worktrees.delete(p); state.dirty.delete(p) })
    },
    worktreePrune: (repoRoot) => { rec("worktreePrune", repoRoot); return guard("worktreePrune", () => undefined) },
    worktreeList: (repoRoot) => {
      rec("worktreeList", repoRoot)
      return guard("worktreeList", (): WorktreeInfo[] =>
        [...state.worktrees.entries()].map(([p, b]) => ({ path: p, head: FAKE_SHA, branch: `refs/heads/${b}`, bare: false })))
    },
    isDirty: (p) => { rec("isDirty", p); return guard("isDirty", () => state.dirty.has(p)) },
    setBranchBase: (repoRoot, branch, base) => {
      rec("setBranchBase", repoRoot, branch, base)
      return guard("setBranchBase", () => { state.branchBases.set(branch, base) })
    },
    listIgnoredMatching: (repoRoot, patterns) => {
      rec("listIgnoredMatching", repoRoot, ...patterns)
      return guard("listIgnoredMatching", () => [...state.ignoredFiles])
    },
  }
  return { git, state }
}
