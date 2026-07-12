import { describe, it, expect, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { parseShortstat, parseNumstat, diffShortstat, collectChanges, listFiles } from "../src/git/inspect.js"

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
  it("listFiles: tracked + untracked、不含 ignored", async () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n")
    fs.writeFileSync(path.join(repo, "ignored.txt"), "x\n")
    const files = await listFiles(repo)
    expect(files).toContain("a.txt")
    expect(files).toContain("b.txt")
    expect(files).not.toContain("ignored.txt")
  })
})
