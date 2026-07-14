import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeCheckpointGitOps } from "../src/workspace/checkpoint.js"

const roots: string[] = []
const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const repo = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-checkpoint-"))
  roots.push(root)
  git(root, ["init", "-b", "main"])
  git(root, ["config", "user.name", "Coolie Test"])
  git(root, ["config", "user.email", "coolie@example.test"])
  fs.writeFileSync(path.join(root, "staged.txt"), "base\n")
  fs.writeFileSync(path.join(root, "unstaged.txt"), "base\n")
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n")
  git(root, ["add", "."])
  git(root, ["commit", "-m", "base"])
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("checkpoint git refs", () => {
  it("captures staged, unstaged and untracked without changing index or worktree", async () => {
    const root = repo()
    fs.writeFileSync(path.join(root, "staged.txt"), "staged\n")
    git(root, ["add", "staged.txt"])
    fs.writeFileSync(path.join(root, "unstaged.txt"), "unstaged\n")
    fs.writeFileSync(path.join(root, "untracked.txt"), "untracked\n")
    fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n")
    const index = path.resolve(root, git(root, ["rev-parse", "--git-path", "index"]))
    const indexBefore = fs.readFileSync(index)
    const statusBefore = git(root, ["status", "--porcelain=v1", "-uall"])

    const ops = makeCheckpointGitOps()
    const checkpoint = await ops.create(root, "WS_1", "CP-1", "before refactor")

    expect(fs.readFileSync(index).equals(indexBefore)).toBe(true)
    expect(git(root, ["status", "--porcelain=v1", "-uall"])).toBe(statusBefore)
    expect(git(root, ["show", `${checkpoint.oid}:staged.txt`])).toBe("staged")
    expect(git(root, ["show", `${checkpoint.oid}:unstaged.txt`])).toBe("unstaged")
    expect(git(root, ["show", `${checkpoint.oid}:untracked.txt`])).toBe("untracked")
    expect(() => git(root, ["show", `${checkpoint.oid}:ignored.txt`])).toThrow()
    expect(checkpoint.ref).toBe("refs/coolie-checkpoints/WS_1/CP-1")
    expect(git(root, ["rev-parse", "main"])).toBe(git(root, ["rev-parse", "HEAD"]))
  })

  it("recovers from an empty worktree index using HEAD as the temporary baseline", async () => {
    const root = repo()
    const index = path.resolve(root, git(root, ["rev-parse", "--git-path", "index"]))
    fs.writeFileSync(index, "")
    fs.writeFileSync(path.join(root, "unstaged.txt"), "from-worktree\n")
    const before = fs.readFileSync(index)

    const checkpoint = await makeCheckpointGitOps().create(root, "ws", "cp", undefined)

    expect(fs.readFileSync(index).equals(before)).toBe(true)
    expect(git(root, ["show", `${checkpoint.oid}:unstaged.txt`])).toBe("from-worktree")
  })

  it("recovers from a damaged index without rewriting it", async () => {
    const root = repo()
    const index = path.resolve(root, git(root, ["rev-parse", "--git-path", "index"]))
    const damaged = Buffer.from("not-a-git-index")
    fs.writeFileSync(index, damaged)
    fs.writeFileSync(path.join(root, "untracked.txt"), "still captured\n")

    const checkpoint = await makeCheckpointGitOps().create(root, "ws", "damaged", undefined)

    expect(fs.readFileSync(index).equals(damaged)).toBe(true)
    expect(git(root, ["show", `${checkpoint.oid}:untracked.txt`])).toBe("still captured")
  })

  it("lists newest first and deletes only the private checkpoint ref", async () => {
    const root = repo()
    const ops = makeCheckpointGitOps()
    const first = await ops.create(root, "ws", "first", "first label")
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await ops.create(root, "ws", "second", "second label")
    const branchBefore = git(root, ["rev-parse", "refs/heads/main"])

    expect((await ops.list(root, "ws")).map((item) => item.checkpointId)).toEqual(["second", "first"])
    expect((await ops.list(root, "ws")).map((item) => item.label)).toEqual(["second label", "first label"])
    await ops.delete(root, "ws", first.checkpointId)

    expect(git(root, ["rev-parse", "refs/heads/main"])).toBe(branchBefore)
    expect(await ops.list(root, "ws")).toEqual([expect.objectContaining({ oid: second.oid })])
  })

  it("rejects unsafe ref components and labels with controls", async () => {
    const root = repo()
    const ops = makeCheckpointGitOps()
    await expect(ops.create(root, "../other", "cp", undefined)).rejects.toThrow(/workspaceId/)
    await expect(ops.create(root, "ws", "bad/name", undefined)).rejects.toThrow(/checkpointId/)
    await expect(ops.create(root, "ws", "cp", "bad\nlabel")).rejects.toThrow(/label/)
    await expect(ops.delete(root, "ws", "../cp")).rejects.toThrow(/checkpointId/)
  })
})
