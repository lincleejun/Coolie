import { describe, it, expect, beforeEach } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { Effect, Exit, Cause, Option } from "effect"
import { GitService, GitServiceLive, parseWorktreeList } from "../src/git/service.js"

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" })

const mkRepo = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-git-")))
  sh(dir, "init", "-b", "main")
  sh(dir, "config", "user.email", "t@t"); sh(dir, "config", "user.name", "t")
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n")
  sh(dir, "add", "-A"); sh(dir, "commit", "-m", "init")
  return dir
}

const run = <A, E>(eff: Effect.Effect<A, E, GitService>) =>
  Effect.runPromiseExit(Effect.provide(eff, GitServiceLive))
const git = Effect.gen(function* () { return yield* GitService })
const failTag = (exit: Exit.Exit<any, any>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const f = Cause.failureOption(exit.cause)
  return Option.isSome(f) ? (f.value as any)._tag : undefined
}

let repo: string
beforeEach(() => { repo = mkRepo() })

describe("parseWorktreeList (pure)", () => {
  it("parses main + linked + detached blocks", () => {
    const out = [
      "worktree /r", "HEAD " + "a".repeat(40), "branch refs/heads/main", "",
      "worktree /r-wt", "HEAD " + "b".repeat(40), "branch refs/heads/coolie/x", "",
      "worktree /r-det", "HEAD " + "c".repeat(40), "detached", "",
    ].join("\n")
    const wts = parseWorktreeList(out)
    expect(wts).toHaveLength(3)
    expect(wts[1]).toEqual({ path: "/r-wt", head: "b".repeat(40), branch: "refs/heads/coolie/x", bare: false })
    expect(wts[2]!.branch).toBeNull()
  })
})

describe("GitService (real git)", () => {
  it("revParse / refExists", async () => {
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      const sha = yield* g.revParse(repo, "main")
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      expect(yield* g.refExists(repo, "refs/heads/main")).toBe(true)
      expect(yield* g.refExists(repo, "refs/heads/nope")).toBe(false)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
  it("mergeBase uses safe argv and returns the common commit", async () => {
    sh(repo, "branch", "feature", "main")
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      return yield* g.mergeBase(repo, "feature", "main")
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(sh(repo, "rev-parse", "main").trim())
  })
  it("worktreeAdd -b + list + setBranchBase", async () => {
    const wt = path.join(path.dirname(repo), path.basename(repo) + "-wt")
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      yield* g.worktreeAdd(repo, wt, "coolie/t1", "main")
      const wts = yield* g.worktreeList(repo)
      expect(wts.some((w) => w.path === wt && w.branch === "refs/heads/coolie/t1")).toBe(true)
      yield* g.setBranchBase(repo, "coolie/t1", "origin/main")
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true)
    expect(sh(repo, "config", "branch.coolie/t1.base").trim()).toBe("origin/main")
  })
  it("dirty worktree: remove refuses without force, succeeds with force", async () => {
    const wt = path.join(path.dirname(repo), path.basename(repo) + "-dirty")
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      yield* g.worktreeAdd(repo, wt, "coolie/t2", "main")
      expect(yield* g.isDirty(wt)).toBe(false)
      fs.writeFileSync(path.join(wt, "junk.txt"), "x")
      expect(yield* g.isDirty(wt)).toBe(true)
      return yield* g.worktreeRemove(repo, wt, { force: false })
    }))
    expect(failTag(exit)).toBe("GitError")
    const exit2 = await run(Effect.gen(function* () {
      const g = yield* git
      yield* g.worktreeRemove(repo, wt, { force: true })
      yield* g.worktreePrune(repo)
      return yield* g.worktreeList(repo)
    }))
    expect(Exit.isSuccess(exit2)).toBe(true)
    if (Exit.isSuccess(exit2)) expect(exit2.value.some((w) => w.path === wt)).toBe(false)
    expect(fs.existsSync(wt)).toBe(false)
    // branch 保留（纪律：删除只动 worktree，永不动 branch）
    expect(sh(repo, "rev-parse", "--verify", "refs/heads/coolie/t2").trim()).toMatch(/^[0-9a-f]{40}$/)
  })
  it("worktreeAddExisting checks out an existing branch", async () => {
    const wt = path.join(path.dirname(repo), path.basename(repo) + "-again")
    sh(repo, "branch", "coolie/t3", "main")
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      yield* g.worktreeAddExisting(repo, wt, "coolie/t3")
      return yield* g.worktreeList(repo)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.some((w) => w.branch === "refs/heads/coolie/t3")).toBe(true)
  })
  it("remoteExists / fetchOrigin against a local clone", async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clone-")))
    const clone = path.join(parent, "clone")
    execFileSync("git", ["clone", repo, clone], { encoding: "utf8" })
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      expect(yield* g.remoteExists(repo, "origin")).toBe(false)
      expect(yield* g.remoteExists(clone, "origin")).toBe(true)
      yield* g.fetchOrigin(clone)
      expect(yield* g.refExists(clone, "refs/remotes/origin/main")).toBe(true)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
  it("listIgnoredMatching finds gitignored files at root and nested", async () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env*\n")
    sh(repo, "add", ".gitignore"); sh(repo, "commit", "-m", "ignore")
    fs.writeFileSync(path.join(repo, ".env"), "A=1\n")
    fs.mkdirSync(path.join(repo, "config"), { recursive: true })
    fs.writeFileSync(path.join(repo, "config", ".env.local"), "B=2\n")
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      return yield* g.listIgnoredMatching(repo, [".env*"])
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toContain(".env")
      expect(exit.value).toContain("config/.env.local")
    }
  })
  it("failure carries op/exitCode/stderr", async () => {
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      return yield* g.revParse(repo, "no-such-ref")
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause)
      const e = Option.isSome(f) ? (f.value as any) : {}
      expect(e._tag).toBe("GitError")
      expect(e.op).toBe("rev-parse")
      expect(typeof e.exitCode === "number" || e.exitCode === null).toBe(true)
    }
  })
})
