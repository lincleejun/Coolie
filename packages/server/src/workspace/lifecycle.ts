import { Cause, Context, Data, Effect, Exit, Layer, Option } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { Workspace, tmuxSessionName, type HealOutcome, type TaskStatus } from "@coolie/protocol"
import { CoolieConfig } from "../config.js"
import { ProjectsRepo } from "../repo/projects.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { EventsRepo } from "../repo/events.js"
import { ValidationError, ConflictError, NotFoundError } from "../repo/errors.js"
import { GitService, GitError } from "../git/service.js"
import {
  SetupRunner, SetupScriptError, composeInitialPrompt, makeSetupPane, markInitComplete,
  resolveInitContract, resolveSetupScripts,
} from "./setup.js"
import { customNamePool, getNamePool, pickName, sanitizeSlug } from "./names.js"
import { allocatePortBase, portEnv } from "./ports.js"
import { injectInfoExclude, readWorktreeIncludePatterns, copyIncludedFiles } from "./include.js"
import { TmuxService, type TmuxError } from "../tmux/service.js"
import { TabsRepo } from "../repo/tabs.js"
import { QueueRepo } from "../repo/queue.js"
import { SessionEnsurer, type EnsureError } from "./heal.js"
import { labelTmuxWindow, makeTmuxLayout } from "../tmux/layout.js"

/** Plan 3 插拔点落地：tmux session / engine 启动 / 首条 prompt 投递以 hook 形式挂进 create 流水线末尾。 */
export class HookError extends Data.TaggedError("HookError")<{ readonly message: string }> {}
export class ArchiveError extends Data.TaggedError("ArchiveError")<{
  readonly stage: "kill-session" | "tab-cleanup" | "dirty-check" | "worktree-remove" | "runtime-recovery" | "commit"
  readonly message: string
}> {}
export interface PostCreateContext {
  readonly initialPrompt?: string
  readonly engineId?: string
  readonly model?: string
  readonly effort?: string
  readonly fanoutGroup?: string
}
export type PostCreateHook = (ws: Workspace, ctx: PostCreateContext) => Effect.Effect<void, HookError>
export class PostCreateHooks extends Context.Tag("PostCreateHooks")<PostCreateHooks, ReadonlyArray<PostCreateHook>>() {}
export const PostCreateHooksEmpty = Layer.succeed(PostCreateHooks, [])

export type CreateError = ValidationError | NotFoundError | ConflictError | GitError | SetupScriptError | HookError
export type RetryError = CreateError | EnsureError
export type LifecycleError = NotFoundError | ConflictError | GitError | TmuxError | ArchiveError

export interface WorkspaceLifecycleShape {
  readonly createIntent: (opts: {
    projectId: string; branchSlug?: string; baseBranch?: string; name?: string; initialPrompt?: string; engineId?: string
    model?: string; effort?: string; fanoutGroup?: string; namePool?: string; customNames?: readonly string[]
  }) => Effect.Effect<Workspace, CreateError>
  readonly create: (opts: {
    projectId: string; branchSlug?: string; baseBranch?: string; name?: string; initialPrompt?: string; engineId?: string
    model?: string; effort?: string; fanoutGroup?: string; namePool?: string; customNames?: readonly string[]
  }) => Effect.Effect<Workspace, RetryError>
  readonly retry: (id: string) => Effect.Effect<Workspace, RetryError>
  readonly ensure: (id: string) => Effect.Effect<HealOutcome, RetryError>
  readonly rename: (id: string, name: string) => Effect.Effect<Workspace, LifecycleError | ValidationError>
  readonly setTaskStatus: (id: string, status: TaskStatus) => Effect.Effect<Workspace, NotFoundError>
  readonly renameBranch: (id: string, branch: string) => Effect.Effect<Workspace, LifecycleError | ValidationError>
  readonly reorder: (projectId: string, workspaceIds: readonly string[]) => Effect.Effect<Workspace[], NotFoundError | ConflictError>
  readonly archive: (id: string, opts?: { force?: boolean }) => Effect.Effect<Workspace, LifecycleError>
  readonly reconcileArchives: () => Effect.Effect<void>
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
    const queueOpt = yield* Effect.serviceOption(QueueRepo)
    const ensurerOpt = yield* Effect.serviceOption(SessionEnsurer)
    const workspaceLocks = new Map<string, Promise<void>>()

    const acquireWorkspaceLock = (id: string): Promise<() => void> => {
      const previous = workspaceLocks.get(id) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => { release = resolve })
      workspaceLocks.set(id, current)
      return previous.then(() => () => {
        release()
        if (workspaceLocks.get(id) === current) workspaceLocks.delete(id)
      })
    }

    const withWorkspaceLock = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Effect.promise(() => acquireWorkspaceLock(id)),
        () => effect,
        (release) => Effect.sync(release),
      )

    const emit = (workspaceId: string | null, type: string, payload: unknown) =>
      events.append({ workspaceId, type, payload })

    /** archive/delete 共用：杀 tmux session（engine 归 tmux，拆除是唯一合法杀点）。
     * tabs 行是 engine 会话记忆（engineSessionId → unarchive 后 --resume 复活的钥匙，设计文档 §十）：
     * archive 保留，仅 delete 删除。全程容错。 */
    const teardownRuntime = (ws: Workspace, reason: "archive" | "delete"): Effect.Effect<void, TmuxError | ArchiveError> =>
      Effect.gen(function* () {
        if (Option.isSome(tmuxOpt)) {
          if (reason === "archive") yield* tmuxOpt.value.killSession(tmuxSessionName(ws.id))
          else yield* tmuxOpt.value.killSession(tmuxSessionName(ws.id)).pipe(Effect.ignore)
          yield* emit(ws.id, "workspace.tmux.killed", { sessionName: tmuxSessionName(ws.id), reason }).pipe(Effect.ignore)
        }
        if (Option.isSome(tabsOpt)) {
          if (reason === "delete") yield* tabsOpt.value.removeByWorkspace(ws.id).pipe(Effect.ignore)
          else yield* tabsOpt.value.removeNonEngineByWorkspace(ws.id).pipe(
            Effect.catchAllDefect((defect) => Effect.fail(new ArchiveError({
              stage: "tab-cleanup", message: `archive tab cleanup failed: ${String(defect)}`,
            }))),
          )
        }
        if (reason === "delete" && Option.isSome(queueOpt)) yield* queueOpt.value.clearWorkspace(ws.id).pipe(Effect.ignore)
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
        const setupScripts = resolveSetupScripts({ worktreePath: ws.path, repoRoot, projectId: ws.projectId, home: cfg.home })
        const init = resolveInitContract({ worktreePath: ws.path, home: cfg.home })
        const scripts = [...setupScripts, ...init.scripts]
        if (scripts.length > 0) {
          yield* emit(ws.id, "workspace.setup.started", { scripts })
          let resultFile: string | undefined
          if (Option.isSome(tmuxOpt) && Option.isSome(tabsOpt)) {
            const pane = yield* Effect.try({
              try: () => makeSetupPane({
                home: cfg.home, workspaceId: ws.id, worktreePath: ws.path, scripts,
                ...(cfg.initTimeoutMs === undefined ? {} : { timeoutMs: cfg.initTimeoutMs }),
              }),
              catch: (e) => new SetupScriptError({ script: "", exitCode: null, message: `setup runner 准备失败：${String(e)}`, outputTail: "" }),
            })
            resultFile = pane.resultFile
            const session = tmuxSessionName(ws.id)
            yield* tmuxOpt.value.newSession({
              name: session,
              cwd: ws.path,
              windowName: "engine",
              command: ["/bin/sh", "-c", "while :; do sleep 3600; done"],
              env: { COOLIE_ROOT: repoRoot, COOLIE_WORKSPACE: ws.id, ...portEnv(ws.portBase) },
            }).pipe(Effect.mapError((e) => new SetupScriptError({
              script: "", exitCode: e.exitCode, message: `setup tmux session 创建失败：${e.message}`, outputTail: e.stderr,
            })))
            const setupWindow = yield* tmuxOpt.value.newWindow({
              session, name: "setup", cwd: ws.path, command: pane.command,
            }).pipe(Effect.mapError((e) => new SetupScriptError({
              script: "", exitCode: e.exitCode, message: `setup window 创建失败：${e.message}`, outputTail: e.stderr,
            })))
            if (setupWindow !== 1)
              return yield* new SetupScriptError({ script: "", exitCode: null, message: `setup window 必须是 1，实际 ${setupWindow}`, outputTail: "" })
            const setupTab = yield* tabsOpt.value.insert({
              workspaceId: ws.id, kind: "setup", tmuxWindow: setupWindow, title: "setup",
            }).pipe(Effect.catchAllDefect((defect) => Effect.fail(new SetupScriptError({
              script: "",
              exitCode: null,
              message: `setup tab 持久化失败：${String(defect)}`,
              outputTail: "",
            }))))
            yield* labelTmuxWindow(tmuxOpt.value, session, setupWindow, {
              role: "ops", workspaceId: ws.id, tabId: setupTab.id,
            }).pipe(Effect.mapError((e) => new SetupScriptError({
              script: "", exitCode: e.exitCode, message: `setup role 标记失败：${e.message}`, outputTail: e.stderr,
            })))
          }
          const results = yield* setup.run({
            worktreePath: ws.path,
            scripts,
            env: { COOLIE_ROOT: repoRoot, ...portEnv(ws.portBase) },
            ...(cfg.initTimeoutMs === undefined ? {} : { timeoutMs: cfg.initTimeoutMs }),
            ...(resultFile !== undefined ? { resultFile } : {}),
          })
          for (const r of results) yield* emit(ws.id, "workspace.setup.finished", r)
          if (init.scripts.length > 0) yield* Effect.try({
            try: () => markInitComplete(init.marker),
            catch: (error) => new SetupScriptError({
              script: init.scripts[0]!, exitCode: null,
              message: `init marker write failed: ${String(error)}`, outputTail: "",
            }),
          })
        }
        // hooks 必须看到 provision 内已写入 baseRef 之后的最新行——ws 参数是 create/retry 调用前的快照
        // （create 上 baseRef=""，retry 上是上次失败尝试记的旧值），直接传它会让 hook 读到假 baseRef。
        // create/retry 走的是同一条 provision 流水线，这一次重读对两条路径统一生效。
        const fresh = yield* repo.get(ws.id)
        if (Option.isSome(tmuxOpt) && Option.isSome(tabsOpt))
          yield* makeTmuxLayout(tmuxOpt.value, repo, tabsOpt.value).reconcile(ws.id).pipe(
            Effect.mapError((e) => new HookError({ message: `tmux layout reconcile 失败：${String(e)}` })),
          )
        const initialPrompt = composeInitialPrompt(init.prompt, ctx.initialPrompt)
        const finalCtx = { ...ctx, ...(initialPrompt === undefined ? {} : { initialPrompt }) }
        for (const hook of hooks) yield* hook(fresh, finalCtx)
        yield* repo.setMaterialized(ws.id, true)
        yield* repo.setTaskStatus(ws.id, "in_progress")
        const active = yield* repo.setStatus(ws.id, "active")
        yield* emit(ws.id, "workspace.created", { id: ws.id, branch: ws.branch, path: ws.path })
        return active
      })

    /** 失败回滚：删半成品 worktree（只走 git worktree remove --force + prune，绝不裸 rm；branch 保留）→ status=error */
    const rollbackToError = (ws: Workspace, repoRoot: string, cause: CreateError): Effect.Effect<never, CreateError> =>
      Effect.gen(function* () {
        if (Option.isSome(tmuxOpt)) yield* tmuxOpt.value.killSession(tmuxSessionName(ws.id)).pipe(Effect.ignore)
        if (Option.isSome(tabsOpt)) yield* tabsOpt.value.removeByWorkspace(ws.id).pipe(Effect.ignore)
        yield* git.worktreeRemove(repoRoot, ws.path, { force: true }).pipe(Effect.ignore)
        yield* git.worktreePrune(repoRoot).pipe(Effect.ignore)
        yield* repo.setLastError(ws.id, { tag: cause._tag, message: cause.message }).pipe(Effect.ignore)
        yield* repo.setStatus(ws.id, "error").pipe(Effect.ignore)
        yield* repo.setTaskStatus(ws.id, "error").pipe(Effect.ignore)
        yield* emit(ws.id, "workspace.error", { id: ws.id, error: { tag: cause._tag, message: cause.message } }).pipe(Effect.ignore)
        return yield* Effect.fail(cause)
      })

    const createIntent: WorkspaceLifecycleShape["createIntent"] = (opts) =>
      Effect.gen(function* () {
        const project = yield* projects.get(opts.projectId)
        const existing = yield* repo.list({}) // 跨项目全量：同名项目共享路径名字空间，name 必须全局唯一（ledger carry-over）
        const taken = new Set(existing.map((w) => w.name))
        const generatedName = (): Effect.Effect<string, ValidationError> =>
          Effect.try({
            try: () => pickName(
              taken,
              opts.namePool === "custom" ? customNamePool(opts.customNames ?? []) : getNamePool(opts.namePool),
            ),
            catch: (error) => new ValidationError({
              message: error instanceof Error ? error.message : String(error),
            }),
          })
        // Resolve a pool only when generation is needed. Explicit names therefore
        // remain authoritative even if stale pool preferences accompany a request.
        const name = opts.name !== undefined ? sanitizeSlug(opts.name) : yield* generatedName()
        if (name === "") return yield* new ValidationError({ message: "name 消毒后为空" })
        const slug = sanitizeSlug(opts.branchSlug ?? name)
        if (slug === "") return yield* new ValidationError({ message: "branchSlug 消毒后为空" })
        const baseBranch = opts.baseBranch?.trim() || project.defaultBaseBranch
        if (baseBranch.startsWith("-") || baseBranch.includes("..") || baseBranch.includes("@{") ||
            baseBranch.includes("\\") || baseBranch.endsWith("/") || baseBranch.endsWith(".") ||
            !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseBranch))
          return yield* new ValidationError({ message: "baseBranch 不是安全的 branch 名" })
        const branch = `coolie/${slug}`
        const wsPath = path.join(cfg.workspacesRoot, project.name, name)
        const portBase = allocatePortBase(yield* repo.usedPortBases())
        const ws = yield* repo.insertCreating({
          projectId: project.id, name, path: wsPath, branch,
          baseBranch, portBase,
        })
        // C2：把首条 prompt+引擎存进 data.createCtx，供 error 后 retry 补投（否则 retry 丢首条 prompt 和原引擎）
        yield* repo.setCreateCtx(ws.id, {
          ...(opts.initialPrompt !== undefined ? { initialPrompt: opts.initialPrompt } : {}),
          ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
          ...(opts.fanoutGroup !== undefined ? { fanoutGroup: opts.fanoutGroup } : {}),
        })
        yield* emit(ws.id, "workspace.intent.created", {
          id: ws.id, projectId: project.id, name, branch, path: wsPath, portBase,
        })
        return yield* repo.get(ws.id)
      })

    const retry: WorkspaceLifecycleShape["retry"] = (id) =>
      withWorkspaceLock(id, Effect.gen(function* () {
        const ws0 = yield* repo.get(id)
        if (ws0.status !== "error")
          return yield* new ConflictError({ message: `只有 error 状态可重试（当前 ${ws0.status}）` })
        const project = yield* projects.get(ws0.projectId)
        const ws = yield* repo.setStatus(id, "creating")
        yield* emit(id, "workspace.creating", { id, retry: true, name: ws.name, branch: ws.branch, path: ws.path, portBase: ws.portBase })
        if (ws.ownership === "adopted") {
          if (!Option.isSome(ensurerOpt))
            return yield* new ConflictError({ message: "adopted workspace runtime ensure 服务不可用" })
          const active = yield* repo.setStatus(id, "active")
          yield* repo.setTaskStatus(id, "in_progress")
          return yield* ensurerOpt.value.ensure(id).pipe(
            Effect.as(active),
            Effect.tapError((e) => Effect.gen(function* () {
              yield* repo.setLastError(id, { tag: e._tag, message: e.message }).pipe(Effect.ignore)
              yield* repo.setStatus(id, "error").pipe(Effect.ignore)
              yield* repo.setTaskStatus(id, "error").pipe(Effect.ignore)
              yield* emit(id, "workspace.error", { id, error: { tag: e._tag, message: e.message } }).pipe(Effect.ignore)
            })),
          )
        }
        // C2：回填 create 时存下的 ctx（首条 prompt + 原引擎），而非丢成 {}
        const ctx = yield* repo.getCreateCtx(id)
        return yield* provision(ws, project.repoRoot, ctx).pipe(
          Effect.catchAll((e) => rollbackToError(ws, project.repoRoot, e)),
        )
      }))

    const ensure: WorkspaceLifecycleShape["ensure"] = (id) =>
      withWorkspaceLock(id, Effect.gen(function* () {
        let ws = yield* repo.get(id)
        if (ws.kind === "task" && !ws.materialized) {
          if (ws.status === "error") {
            ws = yield* repo.setStatus(id, "creating")
          } else if (ws.status !== "creating") {
            return yield* new ConflictError({ message: `未物化 task 状态非法：${ws.status}` })
          }
          const project = yield* projects.get(ws.projectId)
          const ctx = yield* repo.getCreateCtx(id)
          ws = yield* provision(ws, project.repoRoot, ctx).pipe(
            Effect.catchAll((e) => rollbackToError(ws, project.repoRoot, e)),
          )
        }
        if (ws.status !== "active")
          return yield* new ConflictError({ message: `只能 ensure active task（当前 ${ws.status}）` })
        if (Option.isSome(ensurerOpt)) return yield* ensurerOpt.value.ensure(id)
        return {
          action: "none", resumed: false, sessionName: tmuxSessionName(id),
          tabId: null, sessionId: null,
        } satisfies HealOutcome
      }))

    const create: WorkspaceLifecycleShape["create"] = (opts) =>
      Effect.gen(function* () {
        const intent = yield* createIntent(opts)
        yield* ensure(intent.id)
        return yield* repo.get(intent.id)
      })

    const rename: WorkspaceLifecycleShape["rename"] = (id, rawName) =>
      Effect.gen(function* () {
        const name = rawName.trim()
        if (name === "") return yield* new ValidationError({ message: "name 不能为空" })
        const ws = yield* repo.get(id)
        if (ws.status === "archiving")
          return yield* new ConflictError({ message: "workspace 正在归档，不能重命名" })
        return yield* repo.rename(id, name)
      })

    const setTaskStatus: WorkspaceLifecycleShape["setTaskStatus"] = (id, status) =>
      repo.setTaskStatus(id, status)

    const renameBranch: WorkspaceLifecycleShape["renameBranch"] = (id, rawBranch) =>
      withWorkspaceLock(id, Effect.gen(function* () {
        const branch = rawBranch.trim()
        const invalidSegment = branch.split("/").some((segment) =>
          segment === "" || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock"))
        if (branch === "" || branch === "@" || branch.startsWith("-") || branch.endsWith("/") ||
          branch.includes("..") || branch.includes("@{") || invalidSegment || /[\x00-\x20\x7f~^:?*[\]\\]/.test(branch))
          return yield* new ValidationError({ message: "branch 名称非法" })
        const ws = yield* repo.get(id)
        if (ws.kind === "main") return yield* new ConflictError({ message: "main task 的默认分支不可在 Coolie 中改名" })
        if (ws.status === "archiving")
          return yield* new ConflictError({ message: "workspace 正在归档，不能修改 branch" })
        if (ws.branch === branch) return ws
        const project = yield* projects.get(ws.projectId)
        if (yield* git.refExists(project.repoRoot, `refs/heads/${branch}`))
          return yield* new ConflictError({ message: `branch 已存在：${branch}` })
        if (!ws.materialized) return yield* repo.setBranch(id, branch)
        const checkedOut = (yield* git.worktreeList(project.repoRoot))
          .some((worktree) => path.resolve(worktree.path) === path.resolve(ws.path))
        const gitCwd = checkedOut ? ws.path : project.repoRoot
        yield* git.renameBranch(gitCwd, ws.branch, branch)
        return yield* repo.setBranch(id, branch).pipe(
          Effect.tapError(() => git.renameBranch(gitCwd, branch, ws.branch).pipe(Effect.ignore)),
        )
      }))

    const reorder: WorkspaceLifecycleShape["reorder"] = (projectId, workspaceIds) =>
      repo.reorder(projectId, workspaceIds)

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
      withWorkspaceLock(id, Effect.gen(function* () {
        const before = yield* repo.get(id)
        let ws = before
        if (ws.kind === "main") return yield* new ConflictError({ message: "main task 不可归档" })
        if (ws.status !== "active" && ws.status !== "archiving")
          return yield* new ConflictError({ message: `只能归档 active/archiving 的 workspace（当前 ${ws.status}）` })
        const project = yield* projects.get(ws.projectId)
        const begun = yield* repo.beginArchive(id, opts?.force === true)
        ws = begun.workspace
        const force = begun.operation.force
        if (before.status === "active")
          yield* emit(id, "workspace.archiving", { id, force, ownership: ws.ownership })

        const archiveStage = (cause: LifecycleError): ArchiveError["stage"] => {
          if (cause._tag === "TmuxError") return "kill-session"
          if (cause._tag === "ArchiveError") return cause.stage
          if (cause._tag === "ConflictError") return "dirty-check"
          if (cause._tag === "GitError") return cause.op === "worktreeRemove" ? "worktree-remove" : "commit"
          return "commit"
        }

        const recordFailure = (cause: { _tag: string; message: string }, stage: ArchiveError["stage"]) =>
          repo.setArchiveError(id, { tag: cause._tag, stage, message: cause.message }).pipe(Effect.ignore)

        const compensateOrKeepRetryable = (cause: LifecycleError): Effect.Effect<never, LifecycleError> =>
          Effect.gen(function* () {
            const stage = archiveStage(cause)
            // An absent managed worktree means removal committed; keep archiving so retry/restart
            // can atomically finish archived. Never recreate a worktree merely to compensate.
            const canRestore = yield* worktreePresent(project.repoRoot, ws.path).pipe(
              Effect.orElseSucceed(() => false),
            )
            if (!canRestore) {
              yield* recordFailure(cause, stage)
              yield* emit(id, "workspace.archive.failed", {
                id, retryable: true, restoredActive: false, stage,
                error: { tag: cause._tag, message: cause.message },
              }).pipe(Effect.ignore)
              return yield* Effect.fail(cause)
            }

            if (Option.isNone(ensurerOpt)) {
              const recovery = new ArchiveError({
                stage: "runtime-recovery", message: `runtime recovery unavailable after ${cause._tag}: ${cause.message}`,
              })
              yield* recordFailure(recovery, recovery.stage)
              return yield* Effect.fail(recovery)
            }
            const recoveryExit = yield* Effect.exit(ensurerOpt.value.recoverArchive(id))
            if (Exit.isFailure(recoveryExit)) {
              const recovery = new ArchiveError({
                stage: "runtime-recovery",
                message: `runtime recovery failed after ${cause._tag}: ${Cause.pretty(recoveryExit.cause)}`,
              })
              yield* recordFailure(recovery, recovery.stage)
              yield* emit(id, "workspace.archive.failed", {
                id, retryable: true, restoredActive: false, stage: recovery.stage,
                error: { tag: recovery._tag, message: recovery.message },
              }).pipe(Effect.ignore)
              return yield* Effect.fail(recovery)
            }
            // Only a successful runtime recovery authorizes the durable state transition to active.
            yield* repo.cancelArchive(id)
            yield* emit(id, "workspace.archive.failed", {
              id, retryable: false, restoredActive: true, stage,
              error: { tag: cause._tag, message: cause.message },
            }).pipe(Effect.ignore)
            return yield* Effect.fail(cause)
          })

        return yield* Effect.gen(function* () {
          // status=archiving 先持久化，所有 active-only HTTP/queue 输入随即冻结。
          // session 停止后再做最终 dirty check，消除 engine 在 guard 后写入的竞态。
          yield* teardownRuntime(ws, "archive")
          if (ws.ownership === "managed")
            yield* removeWorktreeGuarded(project.repoRoot, ws, force, "归档")
          const out = yield* repo.completeArchive(id)
          yield* emit(id, "workspace.archived", { id, force, ownership: ws.ownership })
          return out
        }).pipe(Effect.catchAll(compensateOrKeepRetryable))
      }))

    const reconcileArchives: WorkspaceLifecycleShape["reconcileArchives"] = () =>
      Effect.gen(function* () {
        const pending = (yield* repo.list({})).filter((ws) => ws.status === "archiving")
        for (const ws of pending) {
          yield* Effect.gen(function* () {
            const operation = yield* repo.getArchiveOperation(ws.id)
            yield* emit(ws.id, "workspace.archive.reconciling", {
              id: ws.id,
              force: operation.force,
              startedAt: operation.startedAt,
              lastError: operation.lastError === null ? null : {
                tag: operation.lastError.tag,
                stage: operation.lastError.stage,
                at: operation.lastError.at,
              },
            }).pipe(Effect.ignore)
            yield* archive(ws.id)
          }).pipe(Effect.ignore)
        }
      })

    const unarchive: WorkspaceLifecycleShape["unarchive"] = (id) =>
      withWorkspaceLock(id, Effect.gen(function* () {
        const ws = yield* repo.get(id)
        if (ws.status !== "archived")
          return yield* new ConflictError({ message: `只能恢复 archived 的 workspace（当前 ${ws.status}）` })
        const project = yield* projects.get(ws.projectId)
        if (ws.ownership === "adopted" && !(yield* worktreePresent(project.repoRoot, ws.path)))
          return yield* new ConflictError({
            message: `外部 worktree 已不在 git worktree list 中，无法恢复 adopted workspace；请重新创建后再采用：${ws.path}`,
          })
        if (!(yield* git.refExists(project.repoRoot, `refs/heads/${ws.branch}`)))
          return yield* new ConflictError({ message: `branch ${ws.branch} 已不存在，无法恢复` })
        // resume path for partial unarchive：worktree 若已在（上次 worktreeAddExisting 成功但紧接着的
        // setStatus("active") 崩溃/DB 错误导致 row 卡在 archived），跳过 mkdir/prune/add，直接前进到 active——
        // 否则重试会再调一次 worktreeAddExisting，真实 git 因路径已注册而报 already exists，永久卡死。
        // 与 removeWorktreeGuarded 对称的存在性检查（同以 worktreeList 为真源）。
        if (ws.ownership === "managed" && !(yield* worktreePresent(project.repoRoot, ws.path))) {
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
        yield* repo.setTaskStatus(id, "in_progress")
        // ensure-or-heal（设计文档 §十）：worktree 已恢复，session best-effort 重建——
        // 失败不阻塞 unarchive（enter/GUI attach 会再触发 ensure），只记事件供排查
        if (Option.isSome(ensurerOpt))
          yield* ensurerOpt.value.ensure(id).pipe(
            Effect.tapError((e) => emit(id, "workspace.heal.failed", { id, error: { tag: e._tag, message: e.message } }).pipe(Effect.ignore)),
            Effect.ignore,
          )
        yield* emit(id, "workspace.unarchived", { id })
        return out
      }))

    const del: WorkspaceLifecycleShape["delete"] = (id, opts) =>
      withWorkspaceLock(id, Effect.gen(function* () {
        const ws = yield* repo.get(id)
        if (ws.kind === "main") return yield* new ConflictError({ message: "main task 不可删除" })
        if (ws.status === "archiving")
          return yield* new ConflictError({ message: "workspace 正在归档；请先重试归档或等待恢复，不能并发删除" })
        const project = yield* projects.get(ws.projectId)
        const force = opts?.force === true
        if (ws.ownership === "adopted") {
          yield* teardownRuntime(ws, "delete")
          yield* repo.remove(id)
          yield* Effect.sync(() => {
            try { fs.rmSync(path.join(cfg.home, "attachments", ws.id), { recursive: true, force: true }) }
            catch { /* best-effort */ }
          })
          yield* emit(id, "workspace.deleted", { id, branch: ws.branch, ownership: ws.ownership })
          return
        }
        yield* guardClean(project.repoRoot, ws, force, "删除")
        yield* teardownRuntime(ws, "delete")
        yield* removeWorktreeGuarded(project.repoRoot, ws, force, "删除")
        yield* repo.remove(id)
        // 附件随 workspace 永久删除；archive 必须保留以便 unarchive/resume。
        // 清理失败不回滚已经完成的 worktree/DB 删除，后续可由人工或维护任务回收。
        yield* Effect.sync(() => {
          try { fs.rmSync(path.join(cfg.home, "attachments", ws.id), { recursive: true, force: true }) }
          catch { /* best-effort: workspace delete remains successful */ }
        })
        yield* emit(id, "workspace.deleted", { id, branch: ws.branch }) // branch 保留，事件记下名字便于追溯
      }))

    return {
      createIntent, create, retry, ensure, rename, setTaskStatus, renameBranch, reorder,
      archive, reconcileArchives, unarchive, delete: del,
    }
  }),
)
