import { Effect, Layer, Option, Deferred } from "effect"
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
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { tmuxSessionName, type CoolieEvent } from "@coolie/protocol"

/** 命名唯一真源在 protocol（tmuxSessionName）；此别名只为 server 侧调用点可读性。 */
export const sessionNameFor = tmuxSessionName

/** hooks 就绪信号超时兜底（cfg.promptReadyTimeoutMs 未注入时用这个）。 */
const DEFAULT_PROMPT_READY_TIMEOUT_MS = 20_000

/** hook 派生事件类型前缀：只有这些（/hooks/claude 转发出来的）才算「claude 活着」的证据——
 * "engine.started" 是 bootstrap 自己无条件写的，不能拿来当就绪信号，否则等于没等。 */
const isHookDerivedEngineEvent = (type: string): boolean => type.startsWith("engine.") && type !== "engine.started"

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
    // EventsBus 可选依赖（同 EventsRepoLive 的既有模式）：生产 main.ts 已提供；
    // 假 engine/裸测试没提供时 gateOnHooks 直接判 false，走强化 waitStable 兜底，行为不变。
    const bus = yield* Effect.serviceOption(EventsBus)

    const hook: PostCreateHook = (ws, ctx) => {
      // 提前声明，好让 Effect.ensuring 在任何退出路径（成功/失败/中断）都能拆掉监听器——
      // 避免长跑 server 上每次 create 泄漏一个 EventsBus 监听器。
      let onEvent: ((e: CoolieEvent) => void) | undefined
      const detachListener = Effect.sync(() => {
        if (onEvent !== undefined && Option.isSome(bus)) bus.value.off(EVENT_CHANNEL, onEvent)
        onEvent = undefined
      })

      return Effect.gen(function* () {
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

        const wantsPrompt = ctx.initialPrompt !== undefined && ctx.initialPrompt.trim() !== ""
        const gateOnHooks = wantsPrompt && engine.capabilities.hooks && !hooksDisabled() && Option.isSome(bus)

        // 必须在起 tmux session 之前订阅：claude 冷启动可能在几百 ms 内就打 SessionStart，
        // 若等到 deliverPrompt 前一刻才订阅，订阅本身的延迟就可能错过这条事件。
        let ready: Deferred.Deferred<void> | undefined
        if (gateOnHooks && Option.isSome(bus)) {
          ready = yield* Deferred.make<void>()
          const d = ready
          onEvent = (e) => {
            if (e.workspaceId === ws.id && isHookDerivedEngineEvent(e.type)) Effect.runSync(Deferred.succeed(d, undefined))
          }
          bus.value.on(EVENT_CHANNEL, onEvent)
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

        if (wantsPrompt) {
          let hookReady = false
          if (ready) {
            const timeoutMs = cfg.promptReadyTimeoutMs ?? DEFAULT_PROMPT_READY_TIMEOUT_MS
            hookReady = yield* ready.pipe(
              Effect.timeoutTo({ duration: timeoutMs, onTimeout: () => false, onSuccess: () => true }),
            )
          }
          yield* detachListener // 拿到（或超时放弃）就绪信号后立刻摘监听器，不再需要
          // hookReady：已确认 claude 真活着（hook 打过），waitStable 只需最低限度确认一次就行；
          // 否则（hooks 不可用/超时未到）落回强化默认（minElapsedMs 1500 / stableFrames 3）兜底。
          yield* deliverPrompt(
            tmux, `${session}:0`, ctx.initialPrompt!,
            hookReady ? { minElapsedMs: 0, stableFrames: 2 } : undefined,
          ).pipe(
            Effect.mapError((e) => new HookError({ message: `首条 prompt 投递失败：${e.message}` })),
          )
          yield* events.append({
            workspaceId: ws.id, type: "prompt.delivered",
            payload: { workspaceId: ws.id, tabId: tab.id, chars: ctx.initialPrompt!.length },
          })
        }
      }).pipe(
        Effect.ensuring(detachListener), // 保底：任何退出路径都不留 EventsBus 监听器
        // 不留孤儿 session：hook 内任何一步失败都拆掉刚建的 session（tabs 行由 rollback 前的事务保证一致）
        Effect.tapError(() => tmux.killSession(sessionNameFor(ws.id)).pipe(Effect.ignore)),
        Effect.tapError(() => tabs.removeByWorkspace(ws.id).pipe(Effect.ignore)),
      )
    }

    return [hook]
  }),
)
