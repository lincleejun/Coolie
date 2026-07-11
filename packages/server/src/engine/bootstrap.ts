import { Effect, Layer } from "effect"
import { PostCreateHooks, HookError, type PostCreateHook } from "../workspace/lifecycle.js"
import { TmuxService } from "../tmux/service.js"
import { TabsRepo } from "../repo/tabs.js"
import { EventsRepo } from "../repo/events.js"
import { ProjectsRepo } from "../repo/projects.js"
import { EngineRegistry } from "./registry.js"
import { CoolieConfig } from "../config.js"
import { deliverPrompt } from "../tmux/delivery.js"
import { portEnv } from "../workspace/ports.js"
import { injectInfoExclude } from "../workspace/include.js"
import { ensureHookScript, injectClaudeHooks, hooksDisabled } from "./claude/hooks.js"
import { tmuxSessionName } from "@coolie/protocol"

/** 命名唯一真源在 protocol（tmuxSessionName）；此别名只为 server 侧调用点可读性。 */
export const sessionNameFor = tmuxSessionName

/**
 * PostCreateHook 落地（设计文档 §四 create 流水线末段）：
 * 建 tmux session（window 0 = engine，M1 直跑 engine，keep-alive 包装 Plan 4）→
 * hooks 注入（幂等、可 opt-out）→ tabs 行 + engine.started → 首条 prompt（若有）。
 * 失败自动 killSession 清半成品，经 HookError 走 lifecycle 的既有回滚（status=error 可 retry）。
 */
export const EngineBootstrapHookLive = Layer.effect(
  PostCreateHooks,
  Effect.gen(function* () {
    const tmux = yield* TmuxService
    const tabs = yield* TabsRepo
    const events = yield* EventsRepo
    const registry = yield* EngineRegistry
    const projects = yield* ProjectsRepo
    const cfg = yield* CoolieConfig

    const hook: PostCreateHook = (ws, ctx) =>
      Effect.gen(function* () {
        const engine = registry.get("claude")
        if (!engine) return yield* new HookError({ message: "claude engine 未注册" })
        const project = yield* projects.get(ws.projectId).pipe(
          Effect.mapError((e) => new HookError({ message: e.message })),
        )
        const session = sessionNameFor(ws.id)
        const sessionId = engine.newSessionId()

        if (engine.capabilities.hooks && !hooksDisabled()) {
          yield* Effect.try({
            try: () => {
              const scriptPath = ensureHookScript(cfg.home)
              injectClaudeHooks({ worktreePath: ws.path, workspaceId: ws.id, scriptPath })
              // settings.local.json 是我们写进 worktree 的：必须排除，否则 isDirty 守卫误伤 archive/delete
              injectInfoExclude(project.repoRoot, ".claude/settings.local.json")
            },
            catch: (e) => new HookError({ message: `hooks 注入失败：${String(e)}` }),
          })
        }

        const command = engine.launchCommand({ sessionId })
        yield* tmux.newSession({
          name: session, cwd: ws.path, windowName: "engine", command,
          env: { COOLIE_ROOT: project.repoRoot, COOLIE_WORKSPACE: ws.id, ...portEnv(ws.portBase) },
        }).pipe(Effect.mapError((e) => new HookError({ message: `tmux session 创建失败：${e.message}` })))
        yield* events.append({ workspaceId: ws.id, type: "workspace.tmux.created", payload: { sessionName: session } })

        const tab = yield* tabs.insert({
          workspaceId: ws.id, kind: "engine", engineId: engine.id, engineSessionId: sessionId, tmuxWindow: 0,
        })
        yield* events.append({
          workspaceId: ws.id, type: "engine.started",
          payload: { tabId: tab.id, engineId: engine.id, sessionId, command },
        })

        if (ctx.initialPrompt !== undefined && ctx.initialPrompt.trim() !== "") {
          yield* deliverPrompt(tmux, `${session}:0`, ctx.initialPrompt).pipe(
            Effect.mapError((e) => new HookError({ message: `首条 prompt 投递失败：${e.message}` })),
          )
          yield* events.append({
            workspaceId: ws.id, type: "prompt.delivered",
            payload: { workspaceId: ws.id, tabId: tab.id, chars: ctx.initialPrompt.length },
          })
        }
      }).pipe(
        // 不留孤儿 session：hook 内任何一步失败都拆掉刚建的 session（tabs 行由 rollback 前的事务保证一致）
        Effect.tapError(() => tmux.killSession(sessionNameFor(ws.id)).pipe(Effect.ignore)),
        Effect.tapError(() => tabs.removeByWorkspace(ws.id).pipe(Effect.ignore)),
      )

    return [hook]
  }),
)
