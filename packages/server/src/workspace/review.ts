/**
 * Agent Review: project review prompt + against-base diff context → dedicated Review tab (Task 3.6).
 */
import * as fs from "node:fs"
import * as path from "node:path"
import type { ChangesReport, DiffSection, FileDiff } from "../git/inspect.js"

export const REVIEW_TAB_TITLE = "Review"

const MAX_PROMPT_BYTES = 64 * 1024
const MAX_FOCUS_DIFF_CHARS = 12_000
const MAX_FILE_LIST = 80

const CANDIDATES = [
  [".coolie", "review-prompt.md"],
  [".coolie", "code-review.md"],
] as const

export const DEFAULT_REVIEW_PROMPT =
  "Review the against-base diff for bugs, regressions, missing tests, and risky edge cases. Be specific and actionable."

export interface ReviewPromptSource {
  readonly content: string
  readonly source: string | null
}

export const readReviewPrompt = (
  worktreePath: string,
  projectOverride?: string | null,
): ReviewPromptSource => {
  if (typeof projectOverride === "string" && projectOverride.trim() !== "") {
    return { content: projectOverride.trim().slice(0, MAX_PROMPT_BYTES), source: "project-override" }
  }
  const root = fs.realpathSync(worktreePath)
  for (const parts of CANDIDATES) {
    const candidate = path.join(root, ...parts)
    if (!fs.existsSync(candidate)) continue
    const real = fs.realpathSync(candidate)
    if (real !== root && !real.startsWith(`${root}${path.sep}`))
      throw new Error("Review prompt path escapes the workspace")
    const stat = fs.statSync(real)
    if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES)
      throw new Error("Review prompt must be a file smaller than 64 KiB")
    return { content: fs.readFileSync(real, "utf8").trim(), source: parts.join("/") }
  }
  return { content: DEFAULT_REVIEW_PROMPT, source: null }
}

export interface ReviewFocus {
  readonly section: DiffSection
  readonly path: string
}

export interface BuildReviewPromptInput {
  readonly instructions: string
  readonly changes: ChangesReport
  readonly baseRef: string
  readonly focus?: ReviewFocus | null
  readonly focusDiff?: FileDiff | null
}

const formatFileList = (changes: ChangesReport): string => {
  const rows = [
    ...changes.againstBase.map((f) => ({ path: f.path, ins: f.insertions, del: f.deletions, tag: "against-base" })),
  ]
  const seen = new Set(rows.map((r) => r.path))
  for (const p of changes.untracked) {
    if (seen.has(p)) continue
    rows.push({ path: p, ins: 0, del: 0, tag: "untracked" })
  }
  const limited = rows.slice(0, MAX_FILE_LIST)
  const lines = limited.map((r) => `- ${r.path} (+${r.ins}/-${r.del}) [${r.tag}]`)
  if (rows.length > MAX_FILE_LIST) lines.push(`- …and ${rows.length - MAX_FILE_LIST} more files`)
  return lines.length > 0 ? lines.join("\n") : "(no changes against base)"
}

/** Deterministic prompt for Agent Review delivery. */
export const buildReviewPrompt = (input: BuildReviewPromptInput): string => {
  const parts = [
    input.instructions.trim(),
    "",
    `## Against-base changes (base: ${input.baseRef})`,
    formatFileList(input.changes),
  ]
  if (input.focus) {
    parts.push("", `## User focus`, `Section: ${input.focus.section}`, `Path: ${input.focus.path}`)
  }
  if (input.focusDiff?.unified) {
    const unified = input.focusDiff.binary
      ? "(binary file — content omitted)"
      : input.focusDiff.unified.slice(0, MAX_FOCUS_DIFF_CHARS)
    parts.push("", "```diff", unified, "```")
    if (!input.focusDiff.binary && input.focusDiff.unified.length > MAX_FOCUS_DIFF_CHARS)
      parts.push("(diff truncated)")
  }
  return parts.join("\n").trim() + "\n"
}

export type ReviewTabLike = {
  readonly id: string
  readonly kind: string
  readonly title: string | null
  readonly status: string
  readonly engineId: string | null
}

export type ReviewTabPlan =
  | { readonly action: "reuse"; readonly tabId: string; readonly engineId: string }
  | { readonly action: "create"; readonly engineId: string }

/**
 * Never targets a busy implementation tab. Reuses an idle/awaiting Review tab,
 * queues onto a busy Review tab, or plans creation of a dedicated Review tab.
 */
export const planReviewTab = (
  tabs: readonly ReviewTabLike[],
  preferredEngineId = "claude",
): ReviewTabPlan => {
  const engineTabs = tabs.filter((t) => t.kind === "engine")
  const reviewTabs = engineTabs.filter((t) => t.title === REVIEW_TAB_TITLE)
  const idleReview = reviewTabs.find((t) => t.status === "idle" || t.status === "awaiting-input")
  if (idleReview)
    return { action: "reuse", tabId: idleReview.id, engineId: idleReview.engineId ?? preferredEngineId }
  const busyReview = reviewTabs.find((t) => t.status === "working" || t.status === "error")
  if (busyReview)
    return { action: "reuse", tabId: busyReview.id, engineId: busyReview.engineId ?? preferredEngineId }
  const fallbackEngine =
    engineTabs.find((t) => t.engineId)?.engineId ?? preferredEngineId
  return { action: "create", engineId: fallbackEngine }
}

/** Reject plans that would deliver onto a non-Review working tab. */
export const assertSafeReviewTarget = (
  plan: ReviewTabPlan,
  tabs: readonly ReviewTabLike[],
): void => {
  if (plan.action !== "reuse") return
  const tab = tabs.find((t) => t.id === plan.tabId)
  if (!tab) throw new Error("review tab disappeared")
  if (tab.title !== REVIEW_TAB_TITLE)
    throw new Error("refusing to deliver review to non-Review tab")
  if (tab.status === "working" && tab.title !== REVIEW_TAB_TITLE)
    throw new Error("refusing to deliver review to busy implementation tab")
}
