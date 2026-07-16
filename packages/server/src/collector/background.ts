import { execFile } from "node:child_process"
import type { DiffStat } from "../git/inspect.js"

export interface CollectWorkspace {
  readonly id: string
  readonly path: string
  readonly branch: string
  readonly baseRef: string
  readonly status: string
  readonly taskStatus: string
}

export interface PullRequestSnapshot {
  readonly number: number
  readonly state: string
  readonly url: string
  readonly title: string
}

export interface TranscriptSnapshot {
  readonly active: boolean
  readonly updatedAt: number | null
  readonly title: string | null
}

export interface WorkspaceSnapshot {
  readonly workspaceId: string
  readonly collectedAt: number
  readonly runtime: { readonly running: boolean; readonly status: string; readonly taskStatus: string }
  readonly diffstat: DiffStat | null
  readonly pullRequest: PullRequestSnapshot | null
  readonly transcript: TranscriptSnapshot
  readonly errors: readonly string[]
}

export interface CollectorDeps {
  readonly listWorkspaces: () => Promise<readonly CollectWorkspace[]>
  readonly diffstat: (workspace: CollectWorkspace) => Promise<DiffStat>
  readonly pullRequest: (workspace: CollectWorkspace) => Promise<PullRequestSnapshot | null>
  readonly transcript: (workspace: CollectWorkspace) => Promise<TranscriptSnapshot>
  readonly appendEvent: (workspaceId: string, type: string, payload: unknown) => Promise<void>
  readonly now?: () => number
  readonly concurrency?: number
  readonly timeoutMs?: number
}

const settled = async <T>(
  label: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<[T | null, string | null]> => {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      timer.unref()
    })
    return [await Promise.race([operation(), timeout]), null]
  }
  catch (error) { return [null, `${label}: ${error instanceof Error ? error.message : String(error)}`] }
  finally { if (timer) clearTimeout(timer) }
}

const comparable = (snapshot: WorkspaceSnapshot): string => JSON.stringify({
  runtime: snapshot.runtime,
  diffstat: snapshot.diffstat,
  pullRequest: snapshot.pullRequest,
  transcript: snapshot.transcript,
  errors: snapshot.errors,
})

const isArchivedStatus = (status: string): boolean =>
  status === "archived" || status === "archiving"

export class BackgroundCollector {
  readonly #snapshots = new Map<string, WorkspaceSnapshot>()
  readonly #fingerprints = new Map<string, string>()
  readonly #inflight = new Map<string, Promise<WorkspaceSnapshot[]>>()
  readonly #deps: CollectorDeps
  #timer: NodeJS.Timeout | undefined

  constructor(deps: CollectorDeps) { this.#deps = deps }

  snapshots(): WorkspaceSnapshot[] {
    return [...this.#snapshots.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
  }

  /** Overlapping ticks for the same key share one in-flight promise (Task 3.7). */
  async collect(workspaceId?: string): Promise<WorkspaceSnapshot[]> {
    const key = workspaceId ?? "*"
    const existing = this.#inflight.get(key)
    if (existing) return existing
    const promise = this.#collectInner(workspaceId).finally(() => {
      if (this.#inflight.get(key) === promise) this.#inflight.delete(key)
    })
    this.#inflight.set(key, promise)
    return promise
  }

  async #collectInner(workspaceId?: string): Promise<WorkspaceSnapshot[]> {
    const listed = await this.#deps.listWorkspaces()
    if (workspaceId === undefined) {
      const liveIds = new Set(listed.map((workspace) => workspace.id))
      for (const id of this.#snapshots.keys()) {
        if (!liveIds.has(id)) {
          this.#snapshots.delete(id)
          this.#fingerprints.delete(id)
        }
      }
    }
    const workspaces = listed
      .filter((workspace) => workspaceId === undefined || workspace.id === workspaceId)
      .sort((a, b) => a.id.localeCompare(b.id))
    const output: WorkspaceSnapshot[] = []
    const concurrency = Math.max(1, Math.min(this.#deps.concurrency ?? 4, 16))
    const timeoutMs = Math.max(100, Math.min(this.#deps.timeoutMs ?? 5_000, 60_000))
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(concurrency, workspaces.length) }, async () => {
      while (cursor < workspaces.length) {
        const workspace = workspaces[cursor++]!
        // Archived workspaces keep a quiet snapshot — no git/gh probes, no recurring errors.
        if (isArchivedStatus(workspace.status)) {
          const snapshot: WorkspaceSnapshot = {
            workspaceId: workspace.id,
            collectedAt: (this.#deps.now ?? Date.now)(),
            runtime: {
              running: false,
              status: workspace.status,
              taskStatus: workspace.taskStatus,
            },
            diffstat: null,
            pullRequest: null,
            transcript: { active: false, updatedAt: null, title: null },
            errors: [],
          }
          this.#snapshots.set(workspace.id, snapshot)
          output.push(snapshot)
          const fingerprint = comparable(snapshot)
          if (this.#fingerprints.get(workspace.id) !== fingerprint) {
            this.#fingerprints.set(workspace.id, fingerprint)
            await this.#deps.appendEvent(workspace.id, "collector.snapshot.changed", snapshot)
          }
          continue
        }
        const [diff, pr, transcript] = await Promise.all([
          settled("diffstat", () => this.#deps.diffstat(workspace), timeoutMs),
          settled("pull request", () => this.#deps.pullRequest(workspace), timeoutMs),
          settled("transcript", () => this.#deps.transcript(workspace), timeoutMs),
        ])
        const snapshot: WorkspaceSnapshot = {
          workspaceId: workspace.id,
          collectedAt: (this.#deps.now ?? Date.now)(),
          runtime: {
            running: workspace.status === "active",
            status: workspace.status,
            taskStatus: workspace.taskStatus,
          },
          diffstat: diff[0],
          pullRequest: pr[0],
          transcript: transcript[0] ?? { active: false, updatedAt: null, title: null },
          errors: [diff[1], pr[1], transcript[1]].filter((error): error is string => error !== null),
        }
        this.#snapshots.set(workspace.id, snapshot)
        output.push(snapshot)
        const fingerprint = comparable(snapshot)
        if (this.#fingerprints.get(workspace.id) !== fingerprint) {
          this.#fingerprints.set(workspace.id, fingerprint)
          await this.#deps.appendEvent(workspace.id, "collector.snapshot.changed", snapshot)
        }
      }
    }))
    return output.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
  }

  start(intervalMs = 30_000): () => void {
    if (this.#timer) return () => this.stop()
    const tick = () => { void this.collect().catch(() => {}) }
    tick()
    this.#timer = setInterval(tick, Math.max(1_000, intervalMs))
    this.#timer.unref()
    return () => this.stop()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }
}

export type ArgvRunner = (file: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<string>

export const execArgv: ArgvRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)
    })
  })

export const collectPullRequest = async (
  workspace: CollectWorkspace,
  run: ArgvRunner = execArgv,
  timeoutMs = 5_000,
): Promise<PullRequestSnapshot | null> => {
  const output = await run("gh", [
    "pr", "list", "--head", workspace.branch, "--state", "all", "--limit", "1",
    "--json", "number,state,url,title",
  ], { cwd: workspace.path, timeoutMs })
  const rows = JSON.parse(output) as PullRequestSnapshot[]
  return rows[0] ?? null
}
