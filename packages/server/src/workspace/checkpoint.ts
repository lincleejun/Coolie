import { Context, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ulid } from "ulid"
import { EventsRepo } from "../repo/events.js"
import { ProjectsRepo } from "../repo/projects.js"
import { ConflictError, NotFoundError, ValidationError } from "../repo/errors.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { GitError } from "../git/service.js"

export const CHECKPOINT_REF_ROOT = "refs/coolie-checkpoints"
export const MAX_CHECKPOINT_LABEL_LENGTH = 120
const SAFE_REF_COMPONENT = /^[A-Za-z0-9_-]+$/

export interface Checkpoint {
  readonly checkpointId: string
  readonly workspaceId: string
  readonly ref: string
  readonly oid: string
  readonly label: string | null
  readonly createdAt: number
}

class CheckpointNotFoundError extends Error {}

const validateComponent = (name: "workspaceId" | "checkpointId", value: string): void => {
  if (!SAFE_REF_COMPONENT.test(value)) throw new Error(`${name} 含不安全字符`)
}

export const normalizeCheckpointLabel = (label: string | undefined): string | undefined => {
  if (label === undefined) return undefined
  if (label.length > MAX_CHECKPOINT_LABEL_LENGTH) throw new Error(`label 最长 ${MAX_CHECKPOINT_LABEL_LENGTH} 字符`)
  if (/[\x00-\x1f\x7f]/.test(label)) throw new Error("label 不能包含控制字符")
  const trimmed = label.trim()
  return trimmed === "" ? undefined : trimmed
}

const checkpointRef = (workspaceId: string, checkpointId: string): string => {
  validateComponent("workspaceId", workspaceId)
  validateComponent("checkpointId", checkpointId)
  return `${CHECKPOINT_REF_ROOT}/${workspaceId}/${checkpointId}`
}

const runGit = (
  cwd: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", [...args], {
      cwd,
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()))
      else resolve(stdout)
    })
  })

const initializeTemporaryIndex = async (worktreePath: string, temporaryIndex: string): Promise<void> => {
  const rawIndexPath = (await runGit(worktreePath, ["rev-parse", "--git-path", "index"])).trim()
  const realIndex = path.isAbsolute(rawIndexPath) ? rawIndexPath : path.resolve(worktreePath, rawIndexPath)
  try {
    if (fs.statSync(realIndex).size > 0) fs.copyFileSync(realIndex, temporaryIndex)
  } catch { /* absent/empty index is initialized from HEAD below */ }

  const env = { GIT_INDEX_FILE: temporaryIndex }
  if (fs.existsSync(temporaryIndex)) {
    try {
      await runGit(worktreePath, ["ls-files"], env)
      return
    } catch {
      fs.rmSync(temporaryIndex, { force: true })
    }
  }
  await runGit(worktreePath, ["read-tree", "HEAD"], env)
}

const parseMessageLabel = (contents: string, checkpointId: string): string | null => {
  const expected = `Coolie checkpoint ${checkpointId}`
  const lines = contents.replace(/\r\n/g, "\n").trimEnd().split("\n")
  if (lines[0] !== expected) return null
  const line = lines.find((candidate) => candidate.startsWith("Label: "))
  return line ? line.slice("Label: ".length) : null
}

export interface CheckpointGitOps {
  create(worktreePath: string, workspaceId: string, checkpointId: string, label?: string): Promise<Checkpoint>
  list(repoPath: string, workspaceId: string): Promise<Checkpoint[]>
  delete(repoPath: string, workspaceId: string, checkpointId: string): Promise<void>
}

export const makeCheckpointGitOps = (): CheckpointGitOps => ({
  create: async (worktreePath, workspaceId, checkpointId, rawLabel) => {
    const ref = checkpointRef(workspaceId, checkpointId)
    const label = normalizeCheckpointLabel(rawLabel)
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-checkpoint-index-"))
    const temporaryIndex = path.join(temporaryDir, "index")
    try {
      await initializeTemporaryIndex(worktreePath, temporaryIndex)
      const env = { GIT_INDEX_FILE: temporaryIndex }
      await runGit(worktreePath, ["add", "-A"], env)
      const tree = (await runGit(worktreePath, ["write-tree"], env)).trim()
      const parent = (await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"])).trim()
      const message = `Coolie checkpoint ${checkpointId}${label === undefined ? "" : `\n\nLabel: ${label}`}`
      const oid = (await runGit(worktreePath, ["commit-tree", tree, "-p", parent, "-m", message], {
        ...env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Coolie Checkpoint",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "checkpoint@coolie.local",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Coolie Checkpoint",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "checkpoint@coolie.local",
      })).trim()
      await runGit(worktreePath, ["update-ref", ref, oid])
      const createdAt = Number((await runGit(worktreePath, ["show", "-s", "--format=%ct", oid])).trim()) * 1000
      return { checkpointId, workspaceId, ref, oid, label: label ?? null, createdAt }
    } finally {
      fs.rmSync(temporaryDir, { recursive: true, force: true })
    }
  },

  list: async (repoPath, workspaceId) => {
    validateComponent("workspaceId", workspaceId)
    const prefix = `${CHECKPOINT_REF_ROOT}/${workspaceId}/`
    const refs = (await runGit(repoPath, ["for-each-ref", "--format=%(refname)", prefix]))
      .split("\n")
      .filter((ref) => ref !== "")
      .filter((ref) => ref.startsWith(prefix))
    const checkpoints: Checkpoint[] = []
    for (const ref of refs) {
      const checkpointId = ref.slice(prefix.length)
      if (!SAFE_REF_COMPONENT.test(checkpointId)) continue
      const output = await runGit(repoPath, ["show", "-s", "--format=%H%x00%ct%x00%B", ref])
      const [oid = "", seconds = "0", ...messageParts] = output.split("\0")
      checkpoints.push({
        checkpointId,
        workspaceId,
        ref,
        oid,
        label: parseMessageLabel(messageParts.join("\0"), checkpointId),
        createdAt: Number(seconds) * 1000,
      })
    }
    return checkpoints.sort((a, b) => b.createdAt - a.createdAt || b.checkpointId.localeCompare(a.checkpointId))
  },

  delete: async (repoPath, workspaceId, checkpointId) => {
    const ref = checkpointRef(workspaceId, checkpointId)
    const checkpoint = (await makeCheckpointGitOps().list(repoPath, workspaceId))
      .find((item) => item.ref === ref)
    if (!checkpoint) throw new CheckpointNotFoundError(`checkpoint 不存在：${checkpointId}`)
    await runGit(repoPath, ["update-ref", "-d", ref, checkpoint.oid])
  },
})

export interface WorkspaceCheckpointsShape {
  readonly create: (workspaceId: string, label?: string) => Effect.Effect<Checkpoint, ValidationError | ConflictError | NotFoundError | GitError>
  readonly list: (workspaceId: string) => Effect.Effect<Checkpoint[], ValidationError | ConflictError | NotFoundError | GitError>
  readonly delete: (workspaceId: string, checkpointId: string) => Effect.Effect<void, ValidationError | ConflictError | NotFoundError | GitError>
}
export class WorkspaceCheckpoints extends Context.Tag("WorkspaceCheckpoints")<WorkspaceCheckpoints, WorkspaceCheckpointsShape>() {}

const gitFailure = (op: string, error: unknown): GitError =>
  new GitError({ op, message: error instanceof Error ? error.message : String(error), exitCode: null, stderr: "" })

export const WorkspaceCheckpointsLive = Layer.effect(
  WorkspaceCheckpoints,
  Effect.gen(function* () {
    const workspaces = yield* WorkspacesRepo
    const projects = yield* ProjectsRepo
    const events = yield* EventsRepo
    const git = makeCheckpointGitOps()
    const resolve = (workspaceId: string, allowed: readonly string[]) =>
      Effect.gen(function* () {
        try { validateComponent("workspaceId", workspaceId) }
        catch (error) { return yield* new ValidationError({ message: String((error as Error).message) }) }
        const workspace = yield* workspaces.get(workspaceId)
        if (!allowed.includes(workspace.status))
          return yield* new ConflictError({ message: `workspace 状态 ${workspace.status} 不允许 checkpoint 操作` })
        const project = yield* projects.get(workspace.projectId)
        return { workspace, project }
      })
    return {
      create: (workspaceId, rawLabel) => Effect.gen(function* () {
        let label: string | undefined
        try { label = normalizeCheckpointLabel(rawLabel) }
        catch (error) { return yield* new ValidationError({ message: String((error as Error).message) }) }
        const { workspace } = yield* resolve(workspaceId, ["active"])
        const checkpointId = ulid()
        const checkpoint = yield* Effect.tryPromise({
          try: () => git.create(workspace.path, workspace.id, checkpointId, label),
          catch: (error) => gitFailure("checkpoint create", error),
        })
        yield* events.append({
          workspaceId,
          type: "checkpoint.created",
          payload: { checkpointId, ref: checkpoint.ref, oid: checkpoint.oid, label: checkpoint.label },
        })
        return checkpoint
      }),
      list: (workspaceId) => Effect.gen(function* () {
        const { project } = yield* resolve(workspaceId, ["active", "archived"])
        return yield* Effect.tryPromise({
          try: () => git.list(project.repoRoot, workspaceId),
          catch: (error) => gitFailure("checkpoint list", error),
        })
      }),
      delete: (workspaceId, checkpointId) => Effect.gen(function* () {
        try { validateComponent("checkpointId", checkpointId) }
        catch (error) { return yield* new ValidationError({ message: String((error as Error).message) }) }
        const { project } = yield* resolve(workspaceId, ["active", "archived"])
        yield* Effect.tryPromise({
          try: () => git.delete(project.repoRoot, workspaceId, checkpointId),
          catch: (error) => error instanceof CheckpointNotFoundError
            ? new NotFoundError({ message: error.message })
            : gitFailure("checkpoint delete", error),
        })
        yield* events.append({ workspaceId, type: "checkpoint.deleted", payload: { checkpointId } })
      }),
    }
  }),
)
