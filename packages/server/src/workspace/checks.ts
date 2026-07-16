/**
 * Local Checks projection: git / runs / PR / CI / comments (Task 3.7).
 * `gh` unavailable must not break the rest of the projection.
 */
import { execFile } from "node:child_process"
import type {
  CheckItem,
  CheckStatus,
  WorkspaceChecksSnapshot,
} from "@coolie/protocol"
import type { PullRequestSnapshot } from "../collector/background.js"
import type { RunInstanceRecord } from "@coolie/protocol"

export type GitPorcelainClass =
  | { readonly kind: "clean" }
  | { readonly kind: "dirty"; readonly paths: number }
  | { readonly kind: "conflict"; readonly paths: number }
  | { readonly kind: "rebase" }
  | { readonly kind: "unavailable"; readonly message: string }

/** Classify `git status --porcelain=v1 -z` (+ optional rebase HEAD presence). */
export const classifyGitPorcelain = (
  porcelainZ: string,
  opts?: { readonly rebaseInProgress?: boolean },
): GitPorcelainClass => {
  if (opts?.rebaseInProgress) return { kind: "rebase" }
  const entries = porcelainZ.split("\0").filter((s) => s !== "")
  if (entries.length === 0) return { kind: "clean" }
  let conflicts = 0
  for (const entry of entries) {
    const xy = entry.slice(0, 2)
    if (xy.includes("U") || xy === "AA" || xy === "DD") conflicts += 1
  }
  if (conflicts > 0) return { kind: "conflict", paths: conflicts }
  return { kind: "dirty", paths: entries.length }
}

export const classifyGhFailure = (error: unknown): { status: CheckStatus; detail: string } => {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (
    lower.includes("not found") ||
    lower.includes("enoent") ||
    lower.includes("spawn gh") ||
    lower.includes("no such file") ||
    lower.includes("command not found")
  ) {
    return { status: "unavailable", detail: "gh CLI unavailable" }
  }
  if (lower.includes("not logged") || lower.includes("auth") || lower.includes("401")) {
    return { status: "unavailable", detail: "gh not authenticated" }
  }
  return { status: "unavailable", detail: message.slice(0, 240) }
}

export interface ChecksProjectionInput {
  readonly workspaceId: string
  readonly status: string
  readonly branch: string
  readonly baseBranch: string
  readonly baseRef: string
  readonly collectedAt?: number
  readonly git: GitPorcelainClass
  readonly runs: readonly RunInstanceRecord[]
  readonly pullRequest: PullRequestSnapshot | null
  readonly ci?: { readonly status: CheckStatus; readonly detail?: string; readonly updatedAt?: number } | null
  readonly unsentComments: number
}

export const projectWorkspaceChecks = (input: ChecksProjectionInput): WorkspaceChecksSnapshot => {
  const now = input.collectedAt ?? Date.now()
  const items: CheckItem[] = []

  if (input.status === "archived" || input.status === "archiving") {
    return {
      workspaceId: input.workspaceId,
      collectedAt: now,
      degraded: false,
      items: [{
        id: "workspace-archived",
        category: "git",
        status: "skipped",
        label: "Workspace archived",
        detail: "Checks are not refreshed for archived workspaces",
        updatedAt: now,
      }],
    }
  }

  // git
  if (input.git.kind === "clean") {
    items.push({
      id: "git-clean", category: "git", status: "pass",
      label: "Working tree clean", updatedAt: now,
      action: { kind: "none", label: "OK" },
    })
  } else if (input.git.kind === "dirty") {
    items.push({
      id: "git-dirty", category: "git", status: "warn",
      label: "Working tree dirty",
      detail: `${input.git.paths} path(s) changed`,
      updatedAt: now,
      action: { kind: "view-diff", label: "View changes" },
    })
  } else if (input.git.kind === "conflict") {
    items.push({
      id: "git-conflict", category: "git", status: "fail",
      label: "Merge conflicts",
      detail: `${input.git.paths} conflicted path(s)`,
      updatedAt: now,
      action: { kind: "fix-with-agent", label: "Ask agent to fix" },
    })
  } else if (input.git.kind === "rebase") {
    items.push({
      id: "git-rebase", category: "git", status: "fail",
      label: "Rebase in progress", updatedAt: now,
      action: { kind: "fix-with-agent", label: "Ask agent to fix" },
    })
  } else {
    items.push({
      id: "git-unavailable", category: "git", status: "unavailable",
      label: "Git status unavailable",
      detail: input.git.message,
      updatedAt: now,
    })
  }

  // branch
  items.push({
    id: "branch-head",
    category: "branch",
    status: "pass",
    label: `${input.branch} ← ${input.baseBranch}`,
    detail: `baseRef ${input.baseRef.slice(0, 12)}`,
    updatedAt: now,
  })

  // runs
  for (const run of input.runs) {
    const status: CheckStatus =
      run.status === "running" ? "pending"
        : run.status === "error" ? "fail"
          : run.status === "exited" && run.exitCode === 0 ? "pass"
            : "fail"
    items.push({
      id: `run-${run.runId}`,
      category: "run",
      status,
      label: `Run ${run.runId}`,
      detail: run.status === "running"
        ? "in progress"
        : `exit ${run.exitCode ?? "?"}`,
      updatedAt: run.exitedAt ?? run.startedAt,
      action: run.status === "running"
        ? { kind: "none", label: "Running" }
        : { kind: "run-script", label: "Re-run", runId: run.runId },
    })
  }

  // PR
  if (input.pullRequest) {
    items.push({
      id: "pr",
      category: "pr",
      status: input.pullRequest.state === "MERGED" ? "pass"
        : input.pullRequest.state === "CLOSED" ? "warn" : "pending",
      label: `PR #${input.pullRequest.number}: ${input.pullRequest.title}`,
      detail: input.pullRequest.url,
      updatedAt: now,
      action: { kind: "open-pr", label: "Open PR" },
    })
  } else {
    items.push({
      id: "pr-missing",
      category: "pr",
      status: "pending",
      label: "No pull request",
      updatedAt: now,
      action: { kind: "open-pr", label: "Create PR" },
    })
  }

  // CI
  if (input.ci) {
    items.push({
      id: "ci",
      category: "ci",
      status: input.ci.status,
      label: "GitHub checks",
      ...(input.ci.detail ? { detail: input.ci.detail } : {}),
      updatedAt: input.ci.updatedAt ?? now,
      action: input.ci.status === "fail"
        ? { kind: "fix-with-agent", label: "Fix failing checks" }
        : { kind: "none", label: "CI" },
    })
  } else {
    items.push({
      id: "ci",
      category: "ci",
      status: "unavailable",
      label: "GitHub checks",
      detail: "gh unavailable or no PR",
      updatedAt: now,
    })
  }

  // unsent comments
  items.push({
    id: "comments",
    category: "comments",
    status: input.unsentComments > 0 ? "warn" : "pass",
    label: input.unsentComments > 0
      ? `${input.unsentComments} unsent diff comment(s)`
      : "No unsent diff comments",
    updatedAt: now,
    action: input.unsentComments > 0
      ? { kind: "fix-with-agent", label: "Send to agent" }
      : { kind: "none", label: "OK" },
  })

  return {
    workspaceId: input.workspaceId,
    collectedAt: now,
    items,
    degraded: items.some((i) => i.status === "unavailable"),
  }
}

export type ArgvRunner = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<string>

export const execArgv: ArgvRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], {
      cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)
    })
  })

export const readGitPorcelain = async (
  cwd: string,
  run: ArgvRunner = execArgv,
  timeoutMs = 5_000,
): Promise<GitPorcelainClass> => {
  try {
    const [porcelain, rebaseMarker] = await Promise.all([
      run("git", ["status", "--porcelain=v1", "-z"], { cwd, timeoutMs }),
      run("git", ["rev-parse", "--verify", "REBASE_HEAD"], { cwd, timeoutMs })
        .then(() => true)
        .catch(() => false),
    ])
    return classifyGitPorcelain(porcelain, { rebaseInProgress: rebaseMarker })
  } catch (error) {
    return {
      kind: "unavailable",
      message: error instanceof Error ? error.message.slice(0, 240) : String(error),
    }
  }
}

export const collectCiStatus = async (
  cwd: string,
  prNumber: number | null,
  run: ArgvRunner = execArgv,
  timeoutMs = 5_000,
): Promise<{ status: CheckStatus; detail?: string; updatedAt: number }> => {
  const updatedAt = Date.now()
  if (prNumber === null) return { status: "unavailable", detail: "no PR", updatedAt }
  try {
    const output = await run("gh", [
      "pr", "checks", String(prNumber), "--json", "name,state,bucket",
    ], { cwd, timeoutMs })
    const rows = JSON.parse(output) as Array<{ name: string; state: string; bucket?: string }>
    if (!Array.isArray(rows) || rows.length === 0)
      return { status: "pending", detail: "no checks reported", updatedAt }
    const failed = rows.filter((r) =>
      /fail/i.test(r.state) || r.bucket === "fail")
    const pending = rows.filter((r) =>
      /pend|queued|progress/i.test(r.state) || r.bucket === "pending")
    if (failed.length > 0)
      return { status: "fail", detail: `${failed.length}/${rows.length} failing`, updatedAt }
    if (pending.length > 0)
      return { status: "pending", detail: `${pending.length}/${rows.length} pending`, updatedAt }
    return { status: "pass", detail: `${rows.length} checks`, updatedAt }
  } catch (error) {
    const classified = classifyGhFailure(error)
    return { status: classified.status, detail: classified.detail, updatedAt }
  }
}

/** In-flight dedupe for overlapping collect ticks. */
export class ChecksCollector {
  readonly #inflight = new Map<string, Promise<WorkspaceChecksSnapshot>>()
  readonly #latest = new Map<string, WorkspaceChecksSnapshot>()

  constructor(
    private readonly collectOne: (workspaceId: string) => Promise<WorkspaceChecksSnapshot>,
  ) {}

  latest(workspaceId: string): WorkspaceChecksSnapshot | null {
    return this.#latest.get(workspaceId) ?? null
  }

  async collect(workspaceId: string): Promise<WorkspaceChecksSnapshot> {
    const existing = this.#inflight.get(workspaceId)
    if (existing) return existing
    const promise = this.collectOne(workspaceId)
      .then((snapshot) => {
        this.#latest.set(workspaceId, snapshot)
        return snapshot
      })
      .finally(() => {
        if (this.#inflight.get(workspaceId) === promise) this.#inflight.delete(workspaceId)
      })
    this.#inflight.set(workspaceId, promise)
    return promise
  }
}
