import { describe, it, expect, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import {
  parseShortstat, parseNumstat, diffShortstat, collectChanges, listFiles,
  parseBranches, sectionDiffArgs, fileDiff, isSafeRelPath, UNTRACKED_DIFF_MAX_BYTES,
} from "../src/git/inspect.js"

describe("parsers", () => {
  it("parseShortstat: 完整行", () => {
    expect(parseShortstat(" 3 files changed, 42 insertions(+), 7 deletions(-)\n"))
      .toEqual({ filesChanged: 3, insertions: 42, deletions: 7 })
  })
  it("parseShortstat: 只有 insertions / 空输出", () => {
    expect(parseShortstat(" 1 file changed, 2 insertions(+)\n"))
      .toEqual({ filesChanged: 1, insertions: 2, deletions: 0 })
    expect(parseShortstat("")).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
  })
  it("parseNumstat: 普通/二进制（- → 0）", () => {
    expect(parseNumstat("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n")).toEqual([
      { path: "src/a.ts", insertions: 12, deletions: 3 },
      { path: "logo.png", insertions: 0, deletions: 0 },
    ])
  })
  it("parseBranches: includes local and all remotes, deduplicating origin", () => {
    expect(parseBranches([
      "main",
      "origin",
      "origin/HEAD",
      "origin/main",
      "origin/release",
      "upstream/feature",
      "remotes/fork/topic",
    ].join("\n"))).toEqual(["fork/topic", "main", "release", "upstream/feature"])
  })
})

describe("against real repo", () => {
  let repo: string, base: string
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-inspect-"))
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" })
    git("init", "-b", "main")
    git("config", "user.email", "t@t"); git("config", "user.name", "t")
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n")
    git("add", "."); git("commit", "-m", "base")
    base = git("rev-parse", "HEAD").trim()
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n")       // unstaged 改动
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n")            // untracked
  })
  it("diffShortstat 统计 vs base（含未提交）", async () => {
    const s = await diffShortstat(repo, base)
    expect(s.filesChanged).toBe(1)
    expect(s.insertions).toBe(1)
  })
  it("collectChanges 四分区 + untracked", async () => {
    const c = await collectChanges(repo, base)
    expect(c.unstaged.map((f) => f.path)).toContain("a.txt")
    expect(c.untracked).toContain("b.txt")
    expect(c.staged).toEqual([])
    expect(c.committed).toEqual([])
  })
  it("main checkout can use HEAD for diffstat and changes", async () => {
    const stat = await diffShortstat(repo, "HEAD")
    const changes = await collectChanges(repo, "HEAD")
    expect(stat).toMatchObject({ filesChanged: 1, insertions: 1 })
    expect(changes.againstBase.map((file) => file.path)).toContain("a.txt")
    expect(changes.unstaged.map((file) => file.path)).toContain("a.txt")
    expect(changes.committed).toEqual([])
  })
  it("listFiles: tracked + untracked、不含 ignored", async () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n")
    fs.writeFileSync(path.join(repo, "ignored.txt"), "x\n")
    const files = await listFiles(repo)
    expect(files).toContain("a.txt")
    expect(files).toContain("b.txt")
    expect(files).not.toContain("ignored.txt")
  })
})

describe("sectionDiffArgs", () => {
  it("maps every section and places the pathspec after --", () => {
    expect(sectionDiffArgs("againstBase", "BASE", "src/a.ts")).toEqual(["diff", "--no-renames", "--unified=3", "BASE", "--", "src/a.ts"])
    expect(sectionDiffArgs("committed", "BASE", "src/a.ts")).toEqual(["diff", "--no-renames", "--unified=3", "BASE", "HEAD", "--", "src/a.ts"])
    expect(sectionDiffArgs("staged", "BASE", "src/a.ts")).toEqual(["diff", "--no-renames", "--unified=3", "--cached", "--", "src/a.ts"])
    expect(sectionDiffArgs("unstaged", "BASE", "src/a.ts")).toEqual(["diff", "--no-renames", "--unified=3", "--", "src/a.ts"])
    expect(sectionDiffArgs("untracked", "BASE", "new.txt")).toEqual([
      "diff", "--no-index", "--no-renames", "--unified=3", "--", "/dev/null", "new.txt",
    ])
  })
})

describe("isSafeRelPath", () => {
  it("accepts repository-relative paths", () => {
    expect(isSafeRelPath("a.txt")).toBe(true)
    expect(isSafeRelPath("src/a/b.ts")).toBe(true)
  })

  it.each(["", "/etc/passwd", "../../etc/passwd", "src/../../../x", "a\\b", "--output=x", "a\0b"])(
    "rejects unsafe path %j",
    (unsafe) => expect(isSafeRelPath(unsafe)).toBe(false),
  )
})

describe("fileDiff against real repo", () => {
  it("returns a textual unified diff for one changed file", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-fd-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
    try {
      git("init", "-q")
      git("config", "user.email", "t@t")
      git("config", "user.name", "t")
      fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n")
      git("add", ".")
      git("commit", "-qm", "init")
      const base = git("rev-parse", "HEAD").trim()
      fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\n")

      const result = await fileDiff(repo, base, "unstaged", "a.txt")
      expect(result).toMatchObject({ path: "a.txt", section: "unstaged", binary: false })
      expect(result.unified).toContain("@@")
      expect(result.unified).toContain("-two")
      expect(result.unified).toContain("+TWO")
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it("uses literal old/new paths for a committed rename", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-rename-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
    try {
      git("init", "-q")
      git("config", "user.email", "t@t")
      git("config", "user.name", "t")
      fs.writeFileSync(path.join(repo, "old name.txt"), "same contents\n")
      git("add", ".")
      git("commit", "-qm", "base")
      const base = git("rev-parse", "HEAD").trim()
      git("mv", "old name.txt", "new name.txt")
      git("commit", "-qm", "rename")

      const changes = await collectChanges(repo, base)
      expect(changes.committed).toEqual([
        { path: "new name.txt", insertions: 1, deletions: 0 },
        { path: "old name.txt", insertions: 0, deletions: 1 },
      ])
      expect((await fileDiff(repo, base, "committed", "new name.txt")).unified).toContain("+++ b/new name.txt")
      expect((await fileDiff(repo, base, "committed", "old name.txt")).unified).toContain("--- a/old name.txt")
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it("reviews untracked text content via --no-index", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-untracked-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
    try {
      git("init", "-q")
      git("config", "user.email", "t@t")
      git("config", "user.name", "t")
      fs.writeFileSync(path.join(repo, "tracked.txt"), "keep\n")
      git("add", ".")
      git("commit", "-qm", "init")
      const base = git("rev-parse", "HEAD").trim()
      fs.writeFileSync(path.join(repo, "fresh.txt"), "hello\nworld\n")

      const result = await fileDiff(repo, base, "untracked", "fresh.txt")
      expect(result).toMatchObject({ path: "fresh.txt", section: "untracked", binary: false })
      expect(result.unified).toContain("+++ b/fresh.txt")
      expect(result.unified).toContain("+hello")
      expect(result.unified).toContain("+world")
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it("degrades binary and oversized untracked files without dumping contents", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-untracked-bin-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
    try {
      git("init", "-q")
      git("config", "user.email", "t@t")
      git("config", "user.name", "t")
      fs.writeFileSync(path.join(repo, "t.txt"), "x\n")
      git("add", ".")
      git("commit", "-qm", "init")
      const base = git("rev-parse", "HEAD").trim()
      fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]))
      const big = path.join(repo, "huge.txt")
      fs.writeFileSync(big, Buffer.alloc(UNTRACKED_DIFF_MAX_BYTES + 1, 0x61))

      const binary = await fileDiff(repo, base, "untracked", "blob.bin")
      expect(binary).toEqual({ path: "blob.bin", section: "untracked", unified: "", binary: true })

      const large = await fileDiff(repo, base, "untracked", "huge.txt")
      expect(large).toEqual({ path: "huge.txt", section: "untracked", unified: "", binary: true })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
