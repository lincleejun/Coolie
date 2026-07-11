import { Context, Data, Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { Workspace } from "@coolie/protocol"
import { CoolieConfig } from "../config.js"
import { ProjectsRepo } from "../repo/projects.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { EventsRepo } from "../repo/events.js"
import { ValidationError, ConflictError, NotFoundError } from "../repo/errors.js"
import { GitService, GitError } from "../git/service.js"
import { SetupRunner, SetupScriptError, resolveSetupScripts } from "./setup.js"
import { pickName, sanitizeSlug } from "./names.js"
import { allocatePortBase, portEnv } from "./ports.js"
import { injectInfoExclude, readWorktreeIncludePatterns, copyIncludedFiles } from "./include.js"

/** Plan 3 插拔点：tmux session / engine 启动 / 首条 prompt 投递以 hook 形式挂进 create 流水线末尾。 */
export class HookError extends Data.TaggedError("HookError")<{ readonly message: string }> {}
export type PostCreateHook = (ws: Workspace) => Effect.Effect<void, HookError>
export class PostCreateHooks extends Context.Tag("PostCreateHooks")<PostCreateHooks, ReadonlyArray<PostCreateHook>>() {}
export const PostCreateHooksEmpty = Layer.succeed(PostCreateHooks, [])

export type CreateError = ValidationError | NotFoundError | ConflictError | GitError | SetupScriptError | HookError
export type LifecycleError = NotFoundError | ConflictError | GitError

export interface WorkspaceLifecycleShape {
  readonly create: (opts: { projectId: string; branchSlug?: string; name?: string }) => Effect.Effect<Workspace, CreateError>
  readonly retry: (id: string) => Effect.Effect<Workspace, CreateError>
  readonly archive: (id: string, opts?: { force?: boolean }) => Effect.Effect<Workspace, LifecycleError>
  readonly unarchive: (id: string) => Effect.Effect<Workspace, LifecycleError>
  readonly delete: (id: string, opts?: { force?: boolean }) => Effect.Effect<void, LifecycleError>
}
export class WorkspaceLifecycle extends Context.Tag("WorkspaceLifecycle")<WorkspaceLifecycle, WorkspaceLifecycleShape>() {}

export const WorkspaceLifecycleLive = Layer.effect(
  WorkspaceLifecycle,
  Effect.gen(function* () {
    const cfg = yield* CoolieConfig
    const projects = yield* ProjectsRepo
    const repo = yield* WorkspacesRepo
    const events = yield* EventsRepo
    const git = yield* GitService
    const setup = yield* SetupRunner
    const hooks = yield* PostCreateHooks

    const emit = (workspaceId: string | null, type: string, payload: unknown) =>
      events.append({ workspaceId, type, payload })

    /**
     * create/retry 共用的置备流水线（设计文档 §四，本计划裁掉 tmux/engine 段）：
     * fetch → prune → 解析 startPoint/baseRef → worktree add（或复用既有 branch）→
     * branch.<name>.base → info/exclude 注入 → .worktreeinclude 复制 → 三层 setup → hooks → active
     */
    const provision = (ws: Workspace, repoRoot: string): Effect.Effect<Workspace, CreateError> =>
      Effect.gen(function* () {
        if (yield* git.remoteExists(repoRoot, "origin")) yield* git.fetchOrigin(repoRoot)
        yield* git.worktreePrune(repoRoot)
        const startPoint = (yield* git.refExists(repoRoot, `refs/remotes/origin/${ws.baseBranch}`))
          ? `origin/${ws.baseBranch}`
          : ws.baseBranch
        const baseRef = yield* git.revParse(repoRoot, startPoint)
        yield* repo.setBaseRef(ws.id, baseRef)
        // fs 步骤也走 typed error（GitError 的 op 标注来源）——否则 defect 会绕过 catchAll 回滚
        yield* Effect.try({
          try: () => fs.mkdirSync(path.dirname(ws.path), { recursive: true }),
          catch: (e) => new GitError({ op: "mkdir", message: `创建 worktree 父目录失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        if (yield* git.refExists(repoRoot, `refs/heads/${ws.branch}`)) {
          // branch 已存在（error 重试 / 删除后同 slug 重建）：只允许仍指向 baseRef 时复用——branch 永不删除的配套语义
          const cur = yield* git.revParse(repoRoot, `refs/heads/${ws.branch}`)
          if (cur !== baseRef)
            return yield* new ConflictError({ message: `branch ${ws.branch} 已存在且有独立历史；换一个 --slug 或手动处理该 branch` })
          yield* git.worktreeAddExisting(repoRoot, ws.path, ws.branch)
        } else {
          yield* git.worktreeAdd(repoRoot, ws.path, ws.branch, startPoint)
        }
        yield* git.setBranchBase(repoRoot, ws.branch, startPoint)
        yield* Effect.try({
          try: () => injectInfoExclude(repoRoot),
          catch: (e) => new GitError({ op: "info/exclude", message: `注入 .git/info/exclude 失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        const patterns = readWorktreeIncludePatterns(repoRoot)
        const ignored = yield* git.listIgnoredMatching(repoRoot, patterns)
        yield* Effect.try({
          try: () => copyIncludedFiles(repoRoot, ws.path, ignored),
          catch: (e) => new GitError({ op: "worktreeinclude", message: `复制 .worktreeinclude 文件失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        const scripts = resolveSetupScripts({ worktreePath: ws.path, repoRoot, projectId: ws.projectId, home: cfg.home })
        if (scripts.length > 0) {
          yield* emit(ws.id, "workspace.setup.started", { scripts })
          const results = yield* setup.run({
            worktreePath: ws.path,
            scripts,
            env: { COOLIE_ROOT: repoRoot, ...portEnv(ws.portBase) },
          })
          for (const r of results) yield* emit(ws.id, "workspace.setup.finished", r)
        }
        for (const hook of hooks) yield* hook(ws)
        const active = yield* repo.setStatus(ws.id, "active")
        yield* emit(ws.id, "workspace.created", { id: ws.id, branch: ws.branch, path: ws.path })
        return active
      })

    /** 失败回滚：删半成品 worktree（只走 git worktree remove --force + prune，绝不裸 rm；branch 保留）→ status=error */
    const rollbackToError = (ws: Workspace, repoRoot: string, cause: CreateError): Effect.Effect<never, CreateError> =>
      Effect.gen(function* () {
        yield* git.worktreeRemove(repoRoot, ws.path, { force: true }).pipe(Effect.ignore)
        yield* git.worktreePrune(repoRoot).pipe(Effect.ignore)
        yield* repo.setLastError(ws.id, { tag: cause._tag, message: cause.message }).pipe(Effect.ignore)
        yield* repo.setStatus(ws.id, "error").pipe(Effect.ignore)
        yield* emit(ws.id, "workspace.error", { id: ws.id, error: { tag: cause._tag, message: cause.message } }).pipe(Effect.ignore)
        return yield* Effect.fail(cause)
      })

    const create: WorkspaceLifecycleShape["create"] = (opts) =>
      Effect.gen(function* () {
        const project = yield* projects.get(opts.projectId)
        const existing = yield* repo.list({ projectId: project.id })
        const taken = new Set(existing.map((w) => w.name))
        const name = opts.name !== undefined ? sanitizeSlug(opts.name) : pickName(taken)
        if (name === "") return yield* new ValidationError({ message: "name 消毒后为空" })
        const slug = sanitizeSlug(opts.branchSlug ?? name)
        if (slug === "") return yield* new ValidationError({ message: "branchSlug 消毒后为空" })
        const branch = `coolie/${slug}`
        const wsPath = path.join(cfg.workspacesRoot, project.name, name)
        const portBase = allocatePortBase(yield* repo.usedPortBases())
        const ws = yield* repo.insertCreating({
          projectId: project.id, name, path: wsPath, branch,
          baseBranch: project.defaultBaseBranch, portBase,
        })
        yield* emit(ws.id, "workspace.creating", { id: ws.id, projectId: project.id, name, branch, path: wsPath, portBase })
        return yield* provision(ws, project.repoRoot).pipe(
          Effect.catchAll((e) => rollbackToError(ws, project.repoRoot, e)),
        )
      })

    const retry: WorkspaceLifecycleShape["retry"] = (id) =>
      Effect.gen(function* () {
        const ws0 = yield* repo.get(id)
        if (ws0.status !== "error")
          return yield* new ConflictError({ message: `只有 error 状态可重试（当前 ${ws0.status}）` })
        const project = yield* projects.get(ws0.projectId)
        const ws = yield* repo.setStatus(id, "creating")
        yield* emit(id, "workspace.creating", { id, retry: true, name: ws.name, branch: ws.branch, path: ws.path, portBase: ws.portBase })
        return yield* provision(ws, project.repoRoot).pipe(
          Effect.catchAll((e) => rollbackToError(ws, project.repoRoot, e)),
        )
      })

    return {
      create,
      retry,
      archive: () => Effect.die(new Error("archive 在 Task 8 实装")),
      unarchive: () => Effect.die(new Error("unarchive 在 Task 8 实装")),
      delete: () => Effect.die(new Error("delete 在 Task 8 实装")),
    }
  }),
)
