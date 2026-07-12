import { Context, Data, Effect, Layer, Option } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { Workspace, tmuxSessionName } from "@coolie/protocol"
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
import { TmuxService } from "../tmux/service.js"
import { TabsRepo } from "../repo/tabs.js"
import { SessionEnsurer } from "./heal.js"

/** Plan 3 插拔点落地：tmux session / engine 启动 / 首条 prompt 投递以 hook 形式挂进 create 流水线末尾。 */
export class HookError extends Data.TaggedError("HookError")<{ readonly message: string }> {}
export interface PostCreateContext { readonly initialPrompt?: string; readonly engineId?: string }
export type PostCreateHook = (ws: Workspace, ctx: PostCreateContext) => Effect.Effect<void, HookError>
export class PostCreateHooks extends Context.Tag("PostCreateHooks")<PostCreateHooks, ReadonlyArray<PostCreateHook>>() {}
export const PostCreateHooksEmpty = Layer.succeed(PostCreateHooks, [])

export type CreateError = ValidationError | NotFoundError | ConflictError | GitError | SetupScriptError | HookError
export type LifecycleError = NotFoundError | ConflictError | GitError

export interface WorkspaceLifecycleShape {
  readonly create: (opts: {
    projectId: string; branchSlug?: string; name?: string; initialPrompt?: string; engineId?: string
  }) => Effect.Effect<Workspace, CreateError>
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
    // 运行时拆除依赖：可选注入（生产 main.ts 提供；单测不提供时 teardown 自动 no-op）
    const tmuxOpt = yield* Effect.serviceOption(TmuxService)
    const tabsOpt = yield* Effect.serviceOption(TabsRepo)
    const ensurerOpt = yield* Effect.serviceOption(SessionEnsurer)

    const emit = (workspaceId: string | null, type: string, payload: unknown) =>
      events.append({ workspaceId, type, payload })

    /** archive/delete 共用：杀 tmux session（engine 归 tmux，拆除是唯一合法杀点）。
     * tabs 行是 engine 会话记忆（engineSessionId → unarchive 后 --resume 复活的钥匙，设计文档 §十）：
     * archive 保留，仅 delete 删除。全程容错。 */
    const teardownRuntime = (ws: Workspace, reason: "archive" | "delete"): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (Option.isSome(tmuxOpt)) {
          yield* tmuxOpt.value.killSession(tmuxSessionName(ws.id)).pipe(Effect.ignore)
          yield* emit(ws.id, "workspace.tmux.killed", { sessionName: tmuxSessionName(ws.id), reason }).pipe(Effect.ignore)
        }
        if (reason === "delete" && Option.isSome(tabsOpt)) yield* tabsOpt.value.removeByWorkspace(ws.id).pipe(Effect.ignore)
      })

    /**
     * create/retry 共用的置备流水线（设计文档 §四，本计划裁掉 tmux/engine 段）：
     * fetch → prune → 解析 startPoint/baseRef → worktree add（或复用既有 branch）→
     * branch.<name>.base → info/exclude 注入 → .worktreeinclude 复制 → 三层 setup → hooks → active
     */
    const provision = (ws: Workspace, repoRoot: string, ctx: PostCreateContext): Effect.Effect<Workspace, CreateError> =>
      Effect.gen(function* () {
        if (yield* git.remoteExists(repoRoot, "origin")) yield* git.fetchOrigin(repoRoot)
        yield* git.worktreePrune(repoRoot)
        const startPoint = (yield* git.refExists(repoRoot, `refs/remotes/origin/${ws.baseBranch}`))
          ? `origin/${ws.baseBranch}`
          : ws.baseBranch
        const baseRef = yield* git.revParse(repoRoot, startPoint)
        // fs 步骤也走 typed error（GitError 的 op 标注来源）——否则 defect 会绕过 catchAll 回滚
        yield* Effect.try({
          try: () => fs.mkdirSync(path.dirname(ws.path), { recursive: true }),
          catch: (e) => new GitError({ op: "mkdir", message: `创建 worktree 父目录失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        const branchAlreadyExists = yield* git.refExists(repoRoot, `refs/heads/${ws.branch}`)
        // diff 基点：默认是这次新鲜算出的 baseRef；仅当下面判定“branch 自失败尝试后未被动过”时才改记 branch 实际所在位置
        let effectiveBaseRef = baseRef
        if (branchAlreadyExists) {
          // branch 已存在（error 重试 / 删除后同 slug 重建）：只允许下列两种情况之一才复用——branch 永不删除的配套语义
          const cur = yield* git.revParse(repoRoot, `refs/heads/${ws.branch}`)
          if (cur !== baseRef) {
            // base 前进了（origin/<base> 有新提交合入）。若 branch 自上次失败尝试起完全没被动过
            // （仍指向那次写入 row 的旧 baseRef），说明它是安全可复用的半成品，不是真的独立历史——
            // 在其当前位置继续，diff base 记为它实际所在的提交，而非已经前进的新 base。
            // 首次创建 ws.baseRef 恒为 ""，故这条放宽路径在首次创建时永远不会触发。
            if (ws.baseRef !== "" && cur === ws.baseRef) {
              effectiveBaseRef = cur
            } else {
              return yield* new ConflictError({ message: `branch ${ws.branch} 已存在且有独立历史；换一个 --slug 或手动处理该 branch` })
            }
          }
          yield* repo.setBaseRef(ws.id, effectiveBaseRef)
          yield* git.worktreeAddExisting(repoRoot, ws.path, ws.branch)
        } else {
          yield* repo.setBaseRef(ws.id, effectiveBaseRef)
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
        // hooks 必须看到 provision 内已写入 baseRef 之后的最新行——ws 参数是 create/retry 调用前的快照
        // （create 上 baseRef=""，retry 上是上次失败尝试记的旧值），直接传它会让 hook 读到假 baseRef。
        // create/retry 走的是同一条 provision 流水线，这一次重读对两条路径统一生效。
        const fresh = yield* repo.get(ws.id)
        for (const hook of hooks) yield* hook(fresh, ctx)
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
        const existing = yield* repo.list({}) // 跨项目全量：同名项目共享路径名字空间，name 必须全局唯一（ledger carry-over）
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
        return yield* provision(ws, project.repoRoot, {
          ...(opts.initialPrompt !== undefined ? { initialPrompt: opts.initialPrompt } : {}),
          ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
        }).pipe(
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
        return yield* provision(ws, project.repoRoot, {}).pipe(
          Effect.catchAll((e) => rollbackToError(ws, project.repoRoot, e)),
        )
      })

    /** worktree 是否仍在（以 git worktree list 为真源，而非 fs——目录可能被外力挪走） */
    const worktreePresent = (repoRoot: string, wsPath: string) =>
      git.worktreeList(repoRoot).pipe(
        Effect.map((wts) => wts.some((w) => path.resolve(w.path) === path.resolve(wsPath))),
      )

    /** 脏树守卫（不删任何东西）：worktree 在且脏且未 force → 409 */
    const guardClean = (
      repoRoot: string, ws: Workspace, force: boolean, action: string,
    ): Effect.Effect<void, ConflictError | GitError> =>
      Effect.gen(function* () {
        if (!(yield* worktreePresent(repoRoot, ws.path))) return
        if (!force && (yield* git.isDirty(ws.path)))
          return yield* new ConflictError({ message: `worktree 有未提交改动，拒绝${action}；确认丢弃请带 force 重试` })
      })

    /** archive/delete 共用：唯一删除入口（git worktree remove）+ prune。不存在则只 prune。 */
    const removeWorktreeGuarded = (
      repoRoot: string, ws: Workspace, force: boolean, action: string,
    ): Effect.Effect<void, ConflictError | GitError> =>
      Effect.gen(function* () {
        if (!(yield* worktreePresent(repoRoot, ws.path))) {
          yield* git.worktreePrune(repoRoot)
          return
        }
        yield* guardClean(repoRoot, ws, force, action)
        yield* git.worktreeRemove(repoRoot, ws.path, { force })
        yield* git.worktreePrune(repoRoot)
      })

    const archive: WorkspaceLifecycleShape["archive"] = (id, opts) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(id)
        if (ws.status !== "active")
          return yield* new ConflictError({ message: `只能归档 active 的 workspace（当前 ${ws.status}）` })
        const project = yield* projects.get(ws.projectId)
        const force = opts?.force === true
        // 顺序：先守卫（脏树 409 时 session 不能已被杀）→ 拆 tmux/tabs → 删 worktree。
        // 守卫与删除之间 engine 理论上可再写文件——窗口极小，且 removeWorktreeGuarded 内层守卫兜底（二次 409 可重试）。
        yield* guardClean(project.repoRoot, ws, force, "归档")
        yield* teardownRuntime(ws, "archive")
        yield* removeWorktreeGuarded(project.repoRoot, ws, force, "归档")
        const out = yield* repo.setStatus(id, "archived")
        yield* emit(id, "workspace.archived", { id, force })
        return out
      })

    const unarchive: WorkspaceLifecycleShape["unarchive"] = (id) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(id)
        if (ws.status !== "archived")
          return yield* new ConflictError({ message: `只能恢复 archived 的 workspace（当前 ${ws.status}）` })
        const project = yield* projects.get(ws.projectId)
        if (!(yield* git.refExists(project.repoRoot, `refs/heads/${ws.branch}`)))
          return yield* new ConflictError({ message: `branch ${ws.branch} 已不存在，无法恢复` })
        // resume path for partial unarchive：worktree 若已在（上次 worktreeAddExisting 成功但紧接着的
        // setStatus("active") 崩溃/DB 错误导致 row 卡在 archived），跳过 mkdir/prune/add，直接前进到 active——
        // 否则重试会再调一次 worktreeAddExisting，真实 git 因路径已注册而报 already exists，永久卡死。
        // 与 removeWorktreeGuarded 对称的存在性检查（同以 worktreeList 为真源）。
        if (!(yield* worktreePresent(project.repoRoot, ws.path))) {
          // 与 provision 同款：fs 步骤走 typed error，失败留在可恢复的 archived 态而非 defect
          yield* Effect.try({
            try: () => fs.mkdirSync(path.dirname(ws.path), { recursive: true }),
            catch: (e) => new GitError({ op: "mkdir", message: `创建 worktree 父目录失败：${String(e)}`, exitCode: null, stderr: "" }),
          })
          yield* git.worktreePrune(project.repoRoot)
          yield* git.worktreeAddExisting(project.repoRoot, ws.path, ws.branch).pipe(
            // 失败清半成品（同回滚纪律），状态留 archived 可再试
            Effect.tapError(() => Effect.all([
              git.worktreeRemove(project.repoRoot, ws.path, { force: true }).pipe(Effect.ignore),
              git.worktreePrune(project.repoRoot).pipe(Effect.ignore),
            ])),
          )
        }
        const out = yield* repo.setStatus(id, "active")
        // ensure-or-heal（设计文档 §十）：worktree 已恢复，session best-effort 重建——
        // 失败不阻塞 unarchive（enter/GUI attach 会再触发 ensure），只记事件供排查
        if (Option.isSome(ensurerOpt))
          yield* ensurerOpt.value.ensure(id).pipe(
            Effect.tapError((e) => emit(id, "workspace.heal.failed", { id, error: { tag: e._tag, message: e.message } }).pipe(Effect.ignore)),
            Effect.ignore,
          )
        yield* emit(id, "workspace.unarchived", { id })
        return out
      })

    const del: WorkspaceLifecycleShape["delete"] = (id, opts) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(id)
        const project = yield* projects.get(ws.projectId)
        const force = opts?.force === true
        yield* guardClean(project.repoRoot, ws, force, "删除")
        yield* teardownRuntime(ws, "delete")
        yield* removeWorktreeGuarded(project.repoRoot, ws, force, "删除")
        yield* repo.remove(id)
        yield* emit(id, "workspace.deleted", { id, branch: ws.branch }) // branch 保留，事件记下名字便于追溯
      })

    return { create, retry, archive, unarchive, delete: del }
  }),
)
