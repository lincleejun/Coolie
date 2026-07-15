import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import type { Workspace } from "@coolie/protocol"
import { GitService, type WorktreeInfo } from "../git/service.js"
import { ProjectsRepo } from "../repo/projects.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { ConflictError, ValidationError } from "../repo/errors.js"
import { allocatePortBase } from "./ports.js"
import { pickName, sanitizeSlug } from "./names.js"
import { SessionEnsurer } from "./heal.js"

export interface AdoptableWorktree {
  readonly path: string
  readonly branch: string
  readonly head: string
}

export interface WorkspaceAdopterShape {
  readonly list: (projectId: string) => Effect.Effect<AdoptableWorktree[], unknown>
  readonly adopt: (opts: { projectId: string; path: string; name?: string }) => Effect.Effect<Workspace, unknown>
}

export class WorkspaceAdopter extends Context.Tag("WorkspaceAdopter")<WorkspaceAdopter, WorkspaceAdopterShape>() {}

const canonicalPath = (value: string): string => {
  try { return fs.realpathSync(value) } catch { return path.resolve(value) }
}

const usable = (repoRoot: string, registered: ReadonlySet<string>, wt: WorktreeInfo): wt is WorktreeInfo & { branch: string } =>
  !wt.bare && wt.path !== "" && wt.branch !== null && wt.head !== "" &&
  canonicalPath(wt.path) !== canonicalPath(repoRoot) && !registered.has(canonicalPath(wt.path))

export const WorkspaceAdopterLive = Layer.effect(
  WorkspaceAdopter,
  Effect.gen(function* () {
    const projects = yield* ProjectsRepo
    const workspaces = yield* WorkspacesRepo
    const git = yield* GitService
    const ensurer = yield* SessionEnsurer

    const list: WorkspaceAdopterShape["list"] = (projectId) => Effect.gen(function* () {
      const project = yield* projects.get(projectId)
      const registered = new Set((yield* workspaces.list({})).map((ws) => canonicalPath(ws.path)))
      return (yield* git.worktreeList(project.repoRoot))
        .filter((wt) => usable(project.repoRoot, registered, wt))
        .map((wt) => ({ path: wt.path, branch: wt.branch.slice("refs/heads/".length), head: wt.head }))
    })

    const adopt: WorkspaceAdopterShape["adopt"] = (opts) => Effect.gen(function* () {
      const project = yield* projects.get(opts.projectId)
      if (!path.isAbsolute(opts.path))
        return yield* new ValidationError({ message: "path 必须是 git worktree list 返回的绝对路径" })
      const all = yield* workspaces.list({})
      const samePath = all.find((ws) => canonicalPath(ws.path) === canonicalPath(opts.path))
      if (samePath) {
        if (samePath.projectId === project.id) return samePath
        return yield* new ConflictError({ message: `该 worktree 已登记到其他项目：${samePath.id}` })
      }
      const exact = (yield* git.worktreeList(project.repoRoot)).find((wt) => wt.path === opts.path)
      if (!exact || exact.bare || exact.path === "" || exact.branch === null || exact.head === "" ||
          path.resolve(exact.path) === path.resolve(project.repoRoot))
        return yield* new ConflictError({ message: "path 必须精确匹配该项目 git worktree list 中的 branch worktree（主 checkout/detached/bare 不可采用）" })

      const branch = exact.branch.replace(/^refs\/heads\//, "")
      if (branch === exact.branch)
        return yield* new ConflictError({ message: "仅可采用 refs/heads/* 本地 branch worktree" })
      const taken = new Set(all.map((ws) => ws.name))
      const name = opts.name === undefined ? pickName(taken) : sanitizeSlug(opts.name)
      if (name === "") return yield* new ValidationError({ message: "name 消毒后为空" })
      const baseRef = yield* git.mergeBase(project.repoRoot, exact.head, project.defaultBaseBranch)
      const ws = yield* workspaces.insertAdopted({
        projectId: project.id,
        name,
        path: exact.path,
        branch,
        baseBranch: project.defaultBaseBranch,
        baseRef,
        portBase: allocatePortBase(yield* workspaces.usedPortBases()),
      })
      return yield* ensurer.ensure(ws.id).pipe(
        Effect.as(ws),
        Effect.tapError((error: any) => Effect.gen(function* () {
          yield* workspaces.setLastError(ws.id, { tag: error?._tag ?? "AdoptEnsureError", message: error?.message ?? String(error) }).pipe(Effect.ignore)
          yield* workspaces.setStatus(ws.id, "error").pipe(Effect.ignore)
          yield* workspaces.setTaskStatus(ws.id, "error").pipe(Effect.ignore)
        })),
      )
    })

    return { list, adopt }
  }),
)
