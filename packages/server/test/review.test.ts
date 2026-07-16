import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  REVIEW_TAB_TITLE,
  assertSafeReviewTarget,
  buildReviewPrompt,
  planReviewTab,
  readReviewPrompt,
  DEFAULT_REVIEW_PROMPT,
} from "../src/workspace/review.js"

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-review-"))
  const worktree = path.join(root, "worktree")
  fs.mkdirSync(path.join(worktree, ".coolie"), { recursive: true })
  return { root, worktree }
}

describe("Agent Review prompt construction (Task 3.6)", () => {
  it("prefers project override, then repo file, then default", () => {
    const { worktree } = fixture()
    expect(readReviewPrompt(worktree)).toEqual({ content: DEFAULT_REVIEW_PROMPT, source: null })
    fs.writeFileSync(path.join(worktree, ".coolie", "review-prompt.md"), "  Repo review rules. \n")
    expect(readReviewPrompt(worktree)).toEqual({
      content: "Repo review rules.",
      source: ".coolie/review-prompt.md",
    })
    expect(readReviewPrompt(worktree, "Override please")).toEqual({
      content: "Override please",
      source: "project-override",
    })
  })

  it("builds a deterministic prompt with file list and focus diff", () => {
    const text = buildReviewPrompt({
      instructions: "Look carefully.",
      baseRef: "abc123",
      changes: {
        againstBase: [{ path: "src/a.ts", insertions: 2, deletions: 1 }],
        committed: [],
        staged: [],
        unstaged: [],
        untracked: ["new.md"],
      },
      focus: { section: "againstBase", path: "src/a.ts" },
      focusDiff: {
        path: "src/a.ts",
        section: "againstBase",
        binary: false,
        unified: "@@ -1 +1 @@\n-old\n+new\n",
      },
    })
    expect(text).toContain("Look carefully.")
    expect(text).toContain("base: abc123")
    expect(text).toContain("- src/a.ts (+2/-1) [against-base]")
    expect(text).toContain("- new.md (+0/-0) [untracked]")
    expect(text).toContain("Path: src/a.ts")
    expect(text).toContain("+new")
  })
})

describe("Agent Review tab targeting (Task 3.6)", () => {
  it("reuses idle Review tab and never selects a busy implementation tab", () => {
    const tabs = [
      { id: "impl", kind: "engine", title: "Impl", status: "working", engineId: "claude" },
      { id: "rev", kind: "engine", title: REVIEW_TAB_TITLE, status: "idle", engineId: "claude" },
    ]
    const plan = planReviewTab(tabs)
    expect(plan).toEqual({ action: "reuse", tabId: "rev", engineId: "claude" })
    expect(() => assertSafeReviewTarget(plan, tabs)).not.toThrow()
  })

  it("queues onto a busy Review tab instead of the implementation tab", () => {
    const tabs = [
      { id: "impl", kind: "engine", title: null, status: "idle", engineId: "claude" },
      { id: "rev", kind: "engine", title: REVIEW_TAB_TITLE, status: "working", engineId: "codex" },
    ]
    expect(planReviewTab(tabs)).toEqual({ action: "reuse", tabId: "rev", engineId: "codex" })
  })

  it("plans create when no Review tab exists, even if impl is idle", () => {
    const tabs = [
      { id: "impl", kind: "engine", title: "Work", status: "idle", engineId: "claude" },
    ]
    expect(planReviewTab(tabs)).toEqual({ action: "create", engineId: "claude" })
  })

  it("rejects delivery to a non-Review tab id", () => {
    const tabs = [
      { id: "impl", kind: "engine", title: "Work", status: "working", engineId: "claude" },
    ]
    expect(() => assertSafeReviewTarget(
      { action: "reuse", tabId: "impl", engineId: "claude" },
      tabs,
    )).toThrow(/non-Review/)
  })
})
