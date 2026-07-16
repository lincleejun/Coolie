import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { Db } from "../db/sqlite.js"
import { ProjectsRepo } from "../repo/projects.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { EventsRepo } from "../repo/events.js"
import { GitService, GitError } from "../git/service.js"
import {
  applyCopyPlan,
  buildCopyPlan,
  CopyError,
  type CopyPlan,
  type CopyResult,
} from "./environment.js"
import { NotFoundError } from "../repo/errors.js"

export type WorktreeEnvironmentMode = "provision" | "explicit-recopy"

export interface WorktreeEnvironmentShape {
  readonly preview: (
    projectId: string,
    opts?: { projectPatterns?: readonly string[] },
  ) => Effect.Effect<CopyPlan, NotFoundError | CopyError>
  readonly apply: (
    workspaceId: string,
    mode: WorktreeEnvironmentMode,
    opts?: { force?: boolean },
  ) => Effect.Effect<CopyResult, NotFoundError | CopyError>
}

export class WorktreeEnvironment extends Context.Tag("WorktreeEnvironment")<
  WorktreeEnvironment,
  WorktreeEnvironmentShape
>() {}

const filterNoOverwrite = (
  worktreePath: string,
  plan: CopyPlan,
): CopyPlan => {
  const entries = plan.entries.filter((entry) => !fs.existsSync(path.resolve(worktreePath, entry.relativePath)))
  return {
    ...plan,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  }
}

const mapWorktreeEnvError = <A, E>(eff: Effect.Effect<A, E, never>): Effect.Effect<A, NotFoundError | CopyError, never> =>
  eff.pipe(Effect.mapError((e) => {
    if (e instanceof CopyError || e instanceof NotFoundError) return e
    if (e instanceof GitError) return new CopyError({ code: "apply-failed", message: e.message })
    return new CopyError({ code: "apply-failed", message: String(e) })
  }))

export const WorktreeEnvironmentLive = Layer.effect(
  WorktreeEnvironment,
  Effect.gen(function* () {
    const db = yield* Db
    const projects = yield* ProjectsRepo
    const workspaces = yield* WorkspacesRepo
    const events = yield* EventsRepo
    const git = yield* GitService

    return {
      preview: (projectId, opts) => mapWorktreeEnvError(Effect.gen(function* () {
        const project = yield* projects.get(projectId)
        const candidates = yield* git.listIgnoredUntracked(project.repoRoot)
        return buildCopyPlan(project.repoRoot, candidates, opts?.projectPatterns)
      })),

      apply: (workspaceId, mode, opts) => mapWorktreeEnvError(Effect.gen(function* () {
        const workspace = yield* workspaces.get(workspaceId)
        const project = yield* projects.get(workspace.projectId)
        const candidates = yield* git.listIgnoredUntracked(project.repoRoot)
        let plan = buildCopyPlan(project.repoRoot, candidates)
        if (mode === "explicit-recopy" && !opts?.force) plan = filterNoOverwrite(workspace.path, plan)

        const result = applyCopyPlan(project.repoRoot, workspace.path, plan, {
          workspaceId,
          db,
          now: Date.now(),
        })

        yield* events.append({
          workspaceId,
          type: "workspace.environment.copied",
          payload: {
            mode,
            copied: result.copied,
            totalBytes: result.totalBytes,
            fileCount: result.copied.length,
            force: opts?.force === true,
          },
        })

        return result
      })),
    }
  }),
)
