import { describe, it, expect } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { execSync } from "node:child_process"
import {
  injectInfoExclude, readWorktreeIncludePatterns, copyIncludedFiles, DEFAULT_INCLUDE_PATTERNS,
  resolveFilesToCopyRules, selectIncludedPaths, isIncludedByRules,
} from "../src/workspace/include.js"

const mkdir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

describe("injectInfoExclude", () => {
  it("appends .coolie/ once, idempotently", () => {
    const repo = mkdir("coolie-inc-")
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true })
    injectInfoExclude(repo)
    injectInfoExclude(repo)
    const text = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")
    expect(text.split("\n").filter((l) => l.trim() === ".coolie/")).toHaveLength(1)
  })
  it("preserves existing exclude content", () => {
    const repo = mkdir("coolie-inc2-")
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true })
    fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), "node_modules/\n")
    injectInfoExclude(repo)
    const text = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")
    expect(text).toContain("node_modules/")
    expect(text).toContain(".coolie/")
  })
  it("resolves real worktree gitdir (git worktree add scenario)", () => {
    const repo = mkdir("coolie-inc-wt-repo-")
    const wt = mkdir("coolie-inc-wt-")
    // Initialize as a real git repo
    execSync("git init", { cwd: repo, stdio: "ignore" })
    execSync("git config user.email test@test.com && git config user.name Test", { cwd: repo, stdio: "ignore" })
    // Create initial commit
    fs.writeFileSync(path.join(repo, "README.md"), "test\n")
    execSync("git add README.md && git commit -m initial", { cwd: repo, stdio: "ignore" })
    // Create a real worktree
    execSync(`git worktree add ${wt} -b wt-branch`, { cwd: repo, stdio: "ignore" })
    // Call injectInfoExclude on the worktree path (has .git FILE, not dir)
    injectInfoExclude(wt)
    // Verify git actually ignores .coolie/ from the worktree (RED test: this currently fails)
    const checkIgnore = execSync("git check-ignore .coolie/", { cwd: wt, stdio: "pipe" }).toString()
    expect(checkIgnore).toBeTruthy() // Should output the matched pattern
    // Also verify from main repo that it's ignored
    const checkIgnoreRepo = execSync("git check-ignore .coolie/", { cwd: repo, stdio: "pipe" }).toString()
    expect(checkIgnoreRepo).toBeTruthy()
  })

  it("hops to commondir when present (worktree gitdir has commondir)", () => {
    // This test verifies that when a worktree's gitdir points to .git/worktrees/<name>,
    // and that directory has a commondir file, we read it and write exclude there
    const repo = mkdir("coolie-inc-wt-repo2-")
    const wt = mkdir("coolie-inc-wt2-")
    // Initialize as a real git repo
    execSync("git init", { cwd: repo, stdio: "ignore" })
    execSync("git config user.email test@test.com && git config user.name Test", { cwd: repo, stdio: "ignore" })
    // Create initial commit
    fs.writeFileSync(path.join(repo, "README.md"), "test\n")
    execSync("git add README.md && git commit -m initial", { cwd: repo, stdio: "ignore" })
    // Create a real worktree
    execSync(`git worktree add ${wt} -b wt-branch2`, { cwd: repo, stdio: "ignore" })
    // Call injectInfoExclude on the worktree
    injectInfoExclude(wt)
    // Verify exclude was written to the common dir, not per-worktree dir
    const gitFileContent = fs.readFileSync(path.join(wt, ".git"), "utf8")
    const m = gitFileContent.match(/^gitdir:\s*(.+?)\s*$/m)
    expect(m).toBeTruthy()
    const perWorktreeGitDir = path.resolve(wt, m![1]!)
    // Check that commondir file exists in per-worktree gitdir
    const commonDirFile = path.join(perWorktreeGitDir, "commondir")
    expect(fs.existsSync(commonDirFile)).toBe(true)
    // Read commondir and resolve to actual common dir
    const commonDirContent = fs.readFileSync(commonDirFile, "utf8").trim()
    const actualCommonDir = path.resolve(perWorktreeGitDir, commonDirContent)
    // Verify exclude was written to the common dir, not per-worktree dir
    const excludePath = path.join(actualCommonDir, "info", "exclude")
    expect(fs.existsSync(excludePath)).toBe(true)
    const text = fs.readFileSync(excludePath, "utf8")
    expect(text).toContain(".coolie/")
    // Verify per-worktree dir doesn't have the exclude file
    const perWorktreeExcludePath = path.join(perWorktreeGitDir, "info", "exclude")
    expect(fs.existsSync(perWorktreeExcludePath)).toBe(false)
  })
})

describe("readWorktreeIncludePatterns", () => {
  it("defaults to .env* when no file", () => {
    expect(readWorktreeIncludePatterns(mkdir("coolie-inc3-"))).toEqual([...DEFAULT_INCLUDE_PATTERNS])
  })
  it("reads lines, skipping comments and blanks", () => {
    const repo = mkdir("coolie-inc4-")
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "# secrets\n.env*\n\nconfig/local.json\n")
    expect(readWorktreeIncludePatterns(repo)).toEqual([".env*", "config/local.json"])
  })
  it("empty .worktreeinclude copies zero files (authoritative, no default fallback)", () => {
    const repo = mkdir("coolie-inc-empty-")
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "# intentionally empty\n\n")
    expect(resolveFilesToCopyRules(repo)).toEqual({ source: "worktreeinclude", patterns: [] })
  })
})

describe("resolveFilesToCopyRules precedence", () => {
  it("prefers .worktreeinclude over project settings and defaults", () => {
    const repo = mkdir("coolie-inc-prec-")
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "secrets/\n")
    expect(resolveFilesToCopyRules(repo, [".env*"])).toEqual({ source: "worktreeinclude", patterns: ["secrets/"] })
  })
  it("uses project settings when .worktreeinclude is absent", () => {
    const repo = mkdir("coolie-inc-proj-")
    expect(resolveFilesToCopyRules(repo, ["config/local.json"])).toEqual({
      source: "project",
      patterns: ["config/local.json"],
    })
  })
})

describe("gitignore rule matching", () => {
  it("supports nested, directory, negation and last-match-wins", () => {
    const rules = [".env*", "config/", "!config/local.json", "config/local.json"]
    expect(isIncludedByRules(".env", rules)).toBe(true)
    expect(isIncludedByRules("config/local.json", rules)).toBe(true)
    expect(isIncludedByRules("config/other.json", rules)).toBe(true)
    expect(isIncludedByRules("src/.env", rules)).toBe(true)
    expect(isIncludedByRules("README.md", rules)).toBe(false)
  })

  it("selectIncludedPaths filters candidates", () => {
    const selected = selectIncludedPaths(
      [".env", "config/local.json", "node_modules/pkg/index.js", "tracked.txt"],
      [".env*", "config/"],
    )
    expect(selected).toEqual([".env", "config/local.json"])
  })
})

describe("files-to-copy with real git", () => {
  const sh = (cwd: string, ...args: string[]) =>
    execSync(["git", ...args].join(" "), { cwd, stdio: "ignore" })

  it("matches ignored untracked files and excludes tracked/unignored", () => {
    const repo = mkdir("coolie-inc-git-")
    execSync("git init", { cwd: repo, stdio: "ignore" })
    execSync("git config user.email test@test.com && git config user.name Test", { cwd: repo, stdio: "ignore" })
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env*\nnode_modules/\n")
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n")
    sh(repo, "add", ".gitignore", "README.md")
    sh(repo, "commit", "-m", "init")
    fs.writeFileSync(path.join(repo, ".env"), "A=1\n")
    fs.mkdirSync(path.join(repo, "config"), { recursive: true })
    fs.writeFileSync(path.join(repo, "config", ".env.local"), "B=2\n")
    fs.writeFileSync(path.join(repo, "plain.txt"), "visible\n")
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true })
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "x\n")

    const ignored = execSync("git ls-files --others --ignored --exclude-standard -z", { cwd: repo })
      .toString().split("\0").filter(Boolean)
    const selected = selectIncludedPaths(ignored, [".env*", "!config/.env.local"])
    expect(selected).toContain(".env")
    expect(selected).not.toContain("config/.env.local")
    expect(selected).not.toContain("plain.txt")
    expect(selected).not.toContain("node_modules/pkg/index.js")
  })
})

describe("copyIncludedFiles", () => {
  it("copies nested relative paths, skips missing", () => {
    const repo = mkdir("coolie-inc5-"); const wt = mkdir("coolie-inc6-")
    fs.writeFileSync(path.join(repo, ".env"), "A=1\n")
    fs.mkdirSync(path.join(repo, "config"), { recursive: true })
    fs.writeFileSync(path.join(repo, "config", ".env.local"), "B=2\n")
    const copied = copyIncludedFiles(repo, wt, [".env", "config/.env.local", "missing.txt"])
    expect(copied).toEqual([".env", "config/.env.local"])
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("A=1\n")
    expect(fs.readFileSync(path.join(wt, "config", ".env.local"), "utf8")).toBe("B=2\n")
  })
  it("rejects escape paths (../ traversal)", () => {
    const repo = mkdir("coolie-inc-escape-repo-")
    const wt = mkdir("coolie-inc-escape-wt-")
    const outside = mkdir("coolie-inc-escape-outside-")
    // Create a file outside the repo that could be accessed via ../
    fs.writeFileSync(path.join(outside, "escape.txt"), "escaped content\n")
    // Arrange relative path that points to ../escape.txt
    const relEscape = path.relative(repo, path.join(outside, "escape.txt"))
    // Call copyIncludedFiles with the escape path
    const copied = copyIncludedFiles(repo, wt, [relEscape])
    // Verify nothing was copied and return list is empty
    expect(copied).toEqual([])
    // Verify the worktree is still empty (no files copied)
    const wtFiles = fs.readdirSync(wt)
    expect(wtFiles).toEqual([])
  })
})
