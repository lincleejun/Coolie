import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { composeInitialPrompt, markInitComplete, resolveInitContract } from "../src/workspace/setup.js"
import { readPrInstructions } from "../src/workspace/pr-instructions.js"

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-m6-"))
  const home = path.join(root, "home")
  const worktree = path.join(root, "worktree")
  fs.mkdirSync(path.join(worktree, ".coolie"), { recursive: true })
  return { home, worktree }
}

describe("milestone 6 repository contracts", () => {
  it("runs init once per worktree and composes prompts deterministically", () => {
    const { home, worktree } = fixture()
    fs.writeFileSync(path.join(worktree, ".coolie", "init.sh"), "#!/bin/sh\n")
    fs.writeFileSync(path.join(worktree, ".coolie", "init-prompt.md"), "  Read repository notes. \n")
    const first = resolveInitContract({ home, worktreePath: worktree })
    expect(first.scripts).toEqual([path.join(worktree, ".coolie", "init.sh")])
    expect(composeInitialPrompt(first.prompt, " Fix login. ")).toBe("Read repository notes.\n\nFix login.")
    markInitComplete(first.marker)
    expect(resolveInitContract({ home, worktreePath: worktree }).scripts).toEqual([])
  })

  it("prefers bounded repo PR instructions and falls back safely", () => {
    const { worktree } = fixture()
    expect(readPrInstructions(worktree).source).toBeNull()
    fs.writeFileSync(path.join(worktree, ".coolie", "pr-instructions.md"), "Use our PR template.")
    expect(readPrInstructions(worktree)).toEqual({
      content: "Use our PR template.",
      source: ".coolie/pr-instructions.md",
    })
  })
})
