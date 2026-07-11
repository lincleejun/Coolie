import { describe, it, expect } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import {
  injectInfoExclude, readWorktreeIncludePatterns, copyIncludedFiles, DEFAULT_INCLUDE_PATTERNS,
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
})
