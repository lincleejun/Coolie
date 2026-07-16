import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import {
  applyCopyPlan,
  buildCopyPlan,
  COPY_MAX_FILE_BYTES,
  COPY_MAX_FILES,
  COPY_MAX_TOTAL_BYTES,
  inspectCopyCandidate,
  listWorktreeCopyManifest,
} from "../src/workspace/environment.js"
import { listCopyManifest } from "../src/repo/copy-manifest.js"

const mkdir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

describe("WorktreeEnvironment copy plan", () => {
  it("rejects symlink and escape paths", () => {
    const repo = mkdir("coolie-env-repo-")
    const outside = mkdir("coolie-env-out-")
    fs.writeFileSync(path.join(repo, ".env"), "A=1\n")
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "link.env"))
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n")

    expect(() => inspectCopyCandidate(repo, "link.env")).toThrowError(/symlink/)
    expect(() => inspectCopyCandidate(repo, "../outside.txt")).toThrowError(/invalid relative path/)

    const dirRepo = mkdir("coolie-env-dir-")
    fs.mkdirSync(path.join(dirRepo, "dir.env"))
    expect(() => inspectCopyCandidate(dirRepo, "dir.env")).toThrowError(/non-regular file/)
  })

  it("rejects limits with zero partial copy", () => {
    const repo = mkdir("coolie-env-limit-")
    const many = Array.from({ length: COPY_MAX_FILES + 1 }, (_, i) => `secret-${i}.txt`)
    for (const rel of many) fs.writeFileSync(path.join(repo, rel), "x\n")
    expect(() => buildCopyPlan(repo, many, many)).toThrowError(/copy limits exceeded/)

    const big = mkdir("coolie-env-big-")
    fs.writeFileSync(path.join(big, "big.env"), "x".repeat(COPY_MAX_FILE_BYTES + 1))
    expect(() => buildCopyPlan(big, ["big.env"], ["big.env"])).toThrowError(/file exceeds max size/)

    const total = mkdir("coolie-env-total-")
    const rels: string[] = []
    const chunk = Math.floor(COPY_MAX_FILE_BYTES / 2)
    const count = Math.ceil(COPY_MAX_TOTAL_BYTES / chunk) + 1
    for (let i = 0; i < count; i += 1) {
      const rel = `chunk-${i}.txt`
      rels.push(rel)
      fs.writeFileSync(path.join(total, rel), "x".repeat(chunk))
    }
    expect(() => buildCopyPlan(total, rels, rels)).toThrowError(/copy limits exceeded/)
  })

  it("applies atomically, preserves mode, and writes manifest without content", () => {
    const repo = mkdir("coolie-env-copy-repo-")
    const wt = mkdir("coolie-env-copy-wt-")
    fs.writeFileSync(path.join(repo, ".env"), "A=1\n", { mode: 0o600 })
    const plan = buildCopyPlan(repo, [".env"], [".env"])
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      INSERT INTO workspaces VALUES ('w1');
    `)

    const result = applyCopyPlan(repo, wt, plan, { workspaceId: "w1", db, now: 123 })
    expect(result.copied).toEqual([".env"])
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("A=1\n")
    expect(fs.statSync(path.join(wt, ".env")).mode & 0o777).toBe(0o600)

    const manifest = listWorktreeCopyManifest(db, "w1")
    expect(manifest).toEqual([{
      workspaceId: "w1",
      relativePath: ".env",
      size: 4,
      mtimeMs: expect.any(Number),
      mode: expect.any(Number),
      ruleSource: "project",
      copiedAt: 123,
    }])
    expect(JSON.stringify(manifest)).not.toMatch(/A=1/)
  })

  it("rolls back copied files when a later copy fails", () => {
    const repo = mkdir("coolie-env-rb-repo-")
    const wt = mkdir("coolie-env-rb-wt-")
    fs.writeFileSync(path.join(repo, "a.txt"), "A=1\n")
    const plan = buildCopyPlan(repo, ["a.txt"], ["a.txt"])
    const badPlan = {
      ...plan,
      entries: [
        ...plan.entries,
        { relativePath: "missing.txt", size: 1, mtimeMs: 1, mode: 0o644 },
      ],
      totalBytes: plan.totalBytes + 1,
    }
    expect(() => applyCopyPlan(repo, wt, badPlan, { workspaceId: "w1" })).toThrow()
    expect(fs.existsSync(path.join(wt, "a.txt"))).toBe(false)
  })

  it("stores manifest rows via copy-manifest repo", () => {
    const db = new Database(":memory:")
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('w1');")
    const repo = mkdir("coolie-env-manifest-")
    const wt = mkdir("coolie-env-manifest-wt-")
    fs.writeFileSync(path.join(repo, ".env"), "A=1\n")
    const plan = buildCopyPlan(repo, [".env"], [".env"])
    applyCopyPlan(repo, wt, plan, { workspaceId: "w1", db, now: 1 })
    expect(listCopyManifest(db, "w1")).toHaveLength(1)
  })
})
