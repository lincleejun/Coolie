import { Effect, Layer, Option, Deferred } from "effect"
import * as fs from "node:fs"
import { PostCreateHooks, HookError, type PostCreateHook } from "../workspace/lifecycle.js"
import { TmuxService } from "../tmux/service.js"
import { TabsRepo } from "../repo/tabs.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { EventsRepo } from "../repo/events.js"
import { ProjectsRepo } from "../repo/projects.js"
import { EngineRegistry } from "./registry.js"
import { CoolieConfig } from "../config.js"
import { deliverPrompt } from "../tmux/delivery.js"
import { startEngineSession } from "./session.js"
import { assertCopilotReadyToLaunch } from "./copilot/account.js"
import { injectInfoExclude } from "../workspace/include.js"
import { ensureHookScript, injectClaudeHooks, hooksDisabled } from "./claude/hooks.js"
import { injectCodexHooks } from "./codex/hooks.js"
import { ensureNotifyScript } from "./codex/notify.js"
import { engineHome } from "./registry.js"
import { scanNewestRollout, startRolloutBackfillWatcher, realRolloutFs } from "./codex/rollout.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { tmuxSessionName, type CoolieEvent } from "@coolie/protocol"
import { SessionReadiness, type SessionReadinessGate } from "./readiness.js"

/** 命名唯一真源在 protocol（tmuxSessionName）；此别名只为 server 侧调用点可读性。 */
export const sessionNameFor = tmuxSessionName

/** hooks 就绪信号超时兜底（cfg.promptReadyTimeoutMs 未注入时用这个）；
 * 与 config.ts 缺省对齐——90s 跑赢真实 claude 首启（claude-mem 播种 ~22.3s）。 */
const DEFAULT_PROMPT_READY_TIMEOUT_MS = 90_000

/** codex 无-hooks 通路的后台回填 watcher（RE-SMOKE 反转：TUI rollout 首 turn 才懒落盘，
 * 投递前门控 = 死锁，见 codex/rollout.ts 头注）：1s 一次轻量 fs 扫描；上限兜底防永久盯扫——
 * 首条 composer 输入可能在 create 数分钟后才来，上限给宽（30min），cfg.rolloutBackfillMaxMs 可覆写。 */
const ROLLOUT_BACKFILL_INTERVAL_MS = 1_000
const DEFAULT_ROLLOUT_BACKFILL_MAX_MS = 30 * 60_000

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
    const workspaces = yield* WorkspacesRepo
    const cfg = yield* CoolieConfig
    // EventsBus 可选依赖（同 EventsRepoLive 的既有模式）：生产 main.ts 已提供；
    // 假 engine/裸测试没提供时 gateOnHooks 直接判 false，走强化 waitStable 兜底，行为不变。
    const bus = yield* Effect.serviceOption(EventsBus)
    const readiness = yield* Effect.serviceOption(SessionReadiness)

    const hook: PostCreateHook = (ws, ctx) => {
      // 提前声明，好让 Effect.ensuring 在任何退出路径（成功/失败/中断）都能拆掉监听器——
      // 避免长跑 server 上每次 create 泄漏一个 EventsBus 监听器。
      let onEvent: ((e: CoolieEvent) => void) | undefined
      let readinessGate: SessionReadinessGate | undefined
      const detachListener = Effect.sync(() => {
        readinessGate?.close()
        readinessGate = undefined
        if (onEvent !== undefined && Option.isSome(bus)) bus.value.off(EVENT_CHANNEL, onEvent)
        onEvent = undefined
      })

      return Effect.gen(function* () {
        const engineId = ctx.engineId ?? "claude"
        const engine = registry.get(engineId)
        if (!engine) return yield* new HookError({ message: `engine 未注册：${engineId}` })
        const project = yield* projects.get(ws.projectId).pipe(
          Effect.mapError((e) => new HookError({ message: e.message })),
        )
        const session = sessionNameFor(ws.id)
        // 服务端造 id（codex）：起始 null，首个 SessionStart hook 经 /hooks/:engine 回填真 id（C4）。
        // F4：serverGeneratedId 可选 → 用 === true 判定（缺省/false 走客户端造 id，同 claude）。
        const sessionId: string | null = engine.serverGeneratedId === true ? null : engine.newSessionId()

        if (engine.capabilities.hooks && !hooksDisabled() && (engine.id === "claude" || engine.id === "codex")) {
          yield* Effect.try({
            try: () => {
              const scriptPath = ensureHookScript(cfg.home, engine.id)
              // per-engine hooks 产物：写进 worktree 的注入文件必须一并进 info/exclude，
              // 否则 isDirty 守卫误伤 archive/delete（M1 claude 手法，codex 同款——门 gate-review 绑定项）。
              if (engine.id === "codex") {
                injectCodexHooks({ worktreePath: ws.path, workspaceId: ws.id, scriptPath })
                injectInfoExclude(project.repoRoot, ".codex/hooks.json")
              } else {
                injectClaudeHooks({ worktreePath: ws.path, workspaceId: ws.id, scriptPath })
                injectInfoExclude(project.repoRoot, ".claude/settings.local.json")
              }
            },
            catch: (e) => new HookError({ message: `hooks 注入失败：${String(e)}` }),
          })
        }

        // 起 tmux session 之前预置文件夹信任（claude）：新 worktree 首启的 trust dialog 在回答前
        // 不触发 SessionStart，会死锁下方就绪门控。失败 = HookError → 走既有 lifecycle 回滚（此时尚未
        // 建 session/tab，下方 tapError 的 killSession/removeByWorkspace 均 ignore，无副作用）。
        if (engine.prepareWorkspace) {
          yield* Effect.try({
            try: () => engine.prepareWorkspace!({ cwd: ws.path, claudeConfigPath: cfg.claudeConfigPath, codexConfigPath: cfg.codexConfigPath }),
            catch: (e) => new HookError({ message: `workspace 预备失败：${String(e)}` }),
          })
        }

        const wantsPrompt = ctx.initialPrompt !== undefined && ctx.initialPrompt.trim() !== ""
        // Codex SessionStart is structurally tied to its first turn, so server-generated-id engines
        // cannot use it as a pre-prompt readiness gate. Their first prompt keeps the stable-pane path.
        const gateOnHooks = wantsPrompt && engine.capabilities.hooks && !hooksDisabled()
          && (Option.isSome(readiness) || Option.isSome(bus)) && engine.serverGeneratedId !== true
        // codex 无-hooks 通路（RE-SMOKE 反转）：投递**不**等 rollout（TUI 懒落盘 = 门控死锁），照常走强化
        // waitStable；id 回填交给投递外的后台 watcher（下方布防）。codex hooks lane 不布 watcher，
        // 仍走 waitStable 投首条 prompt，首 turn 的 hook 再经 /hooks/codex 回填 id。
        const armRolloutWatcher = engine.serverGeneratedId === true && !(engine.capabilities.hooks && !hooksDisabled())

        // 必须在起 tmux session 之前订阅：claude 冷启动可能在几百 ms 内就打 SessionStart，
        // 若等到 deliverPrompt 前一刻才订阅，订阅本身的延迟就可能错过这条事件。
        let ready: Deferred.Deferred<void> | undefined
        if (gateOnHooks && Option.isSome(readiness)) {
          readinessGate = readiness.value.arm(ws.id)
        } else if (gateOnHooks && Option.isSome(bus)) {
          ready = yield* Deferred.make<void>()
          const d = ready
          onEvent = (e) => {
            if (e.workspaceId === ws.id && isHookDerivedEngineEvent(e.type)) Effect.runSync(Deferred.succeed(d, undefined))
          }
          bus.value.on(EVENT_CHANNEL, onEvent)
        }

        // rollout watcher 的下界：只认「起 session 之后」创建的 rollout（排除旧会话/别 tab 的残留，防误回填旧 id）。
        const rolloutSinceMs = Date.now()
        // Codex hooks-off lane uses per-session `notify`; hooks-capable versions use the injected hook file above.
        if (engine.id === "codex" && !engine.capabilities.hooks && !hooksDisabled())
          yield* Effect.sync(() => ensureNotifyScript(cfg.home, engine.id))
        // Built-in Copilot: never start tmux without binary+auth (Task 3.3).
        if (engine.id === "copilot") {
          yield* Effect.tryPromise({
            try: () => assertCopilotReadyToLaunch(),
            catch: (e) => new HookError({
              message: e instanceof Error ? e.message : String(e),
            }),
          })
        }
        const tab = yield* tabs.insert({
          workspaceId: ws.id, kind: "engine", engineId: engine.id, engineSessionId: sessionId, tmuxWindow: 0,
        })
        const { engineCommand } = yield* startEngineSession(tmux, {
          ws, repoRoot: project.repoRoot, engine, sessionId, resume: false, home: cfg.home,
          tabId: tab.id, tmuxWindow: 0,
          ...(ctx.model !== undefined ? { model: ctx.model } : {}),
          ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
        }).pipe(Effect.mapError((e) => new HookError({ message: `tmux session 创建失败：${e.message}` })))
        yield* events.append({ workspaceId: ws.id, type: "workspace.tmux.created", payload: { sessionName: session } })

        yield* events.append({
          workspaceId: ws.id, type: "engine.started",
          payload: { tabId: tab.id, engineId: engine.id, sessionId, command: engineCommand, wrapped: true },
        })

        // codex 无-hooks 后台回填 watcher（无论有无 initialPrompt 都布防——首条 composer 输入可能在
        // create 数分钟后才来）：每 1s 扫 codexHome/sessions 找本 workspace（cwd realpath 匹配、
        // 起 session 之后创建）的 rollout，命中即回填 engineSessionId（→ tab.session.changed，解锁
        // resume/标题/mtime 状态轮询）+ 追加 engine.session.started（迟到到达，词汇与 hooks 通路统一，
        // C4/monitor/标题照常消费）后自停。teardown（tab 删）或已被回填 → shouldContinue=false 自停；
        // timer unref + 30min 上限，绝无泄漏。onFound 失败（NotFound 竞态等）由 watcher 吞掉重试。
        if (armRolloutWatcher) {
          const home = engineHome(engine.id, { claudeHome: cfg.claudeHome, codexHome: cfg.codexHome })
          const maxMs = cfg.rolloutBackfillMaxMs ?? DEFAULT_ROLLOUT_BACKFILL_MAX_MS
          yield* Effect.sync(() => {
            startRolloutBackfillWatcher(
              {
                scan: () => scanNewestRollout(realRolloutFs, { home, cwd: ws.path, sinceMs: rolloutSinceMs }),
                shouldContinue: () => Effect.runPromise(Effect.gen(function* () {
                  const currentTab = yield* tabs.get(tab.id).pipe(Effect.option)
                  if (Option.isNone(currentTab) || currentTab.value.engineSessionId !== null) return false
                  const currentWorkspace = yield* workspaces.get(ws.id).pipe(Effect.option)
                  // The watcher is armed inside the create hook, before lifecycle flips creating→active.
                  // Keep that short bootstrap phase alive, but stop on archive/error/deletion.
                  return Option.isSome(currentWorkspace)
                    && (currentWorkspace.value.status === "creating" || currentWorkspace.value.status === "active")
                }).pipe(Effect.catchAll(() => Effect.succeed(false)))),
                onFound: (hit) => Effect.runPromise(Effect.gen(function* () {
                  yield* tabs.setEngineSessionId(tab.id, hit.sessionId)
                  yield* events.append({
                    workspaceId: ws.id, type: "engine.session.started",
                    payload: { tabId: tab.id, sessionId: hit.sessionId },
                  })
                  // Hooks-off Codex never reaches the Stop title lane. The rollout hit already gives
                  // the exact transcript, so derive once during id backfill without overwriting a title.
                  const currentTab = yield* tabs.get(tab.id).pipe(Effect.option)
                  if (Option.isSome(currentTab) && currentTab.value.title === null) {
                    const title = yield* Effect.sync(() => {
                      try { return engine.deriveTitle(fs.readFileSync(hit.path, "utf8")) } catch { return null }
                    })
                    if (title !== null) yield* tabs.setTitle(tab.id, title)
                  }
                })),
              },
              { intervalMs: ROLLOUT_BACKFILL_INTERVAL_MS, maxMs },
            )
          })
        }

        if (wantsPrompt) {
          let engineReady = false
          const readyEffect = readinessGate?.wait ?? ready
          if (readyEffect) {
            const timeoutMs = cfg.promptReadyTimeoutMs ?? DEFAULT_PROMPT_READY_TIMEOUT_MS
            engineReady = yield* readyEffect.pipe(
              Effect.timeoutTo({ duration: timeoutMs, onTimeout: () => false, onSuccess: () => true }),
            )
            // gate 武装过（hooks 能力 + 有 prompt）却没等到 SessionStart 信号：即将降级走强化 waitStable
            // 兜底——真实 claude 首启慢于门控上限时这条路径会吞字（reader 尚未接管 stdin）。先记一条
            // 取证事件（kobe：prompt.delivered 早于 engine.session.started 即命中此降级），再照常降级投递。
            if (!engineReady) {
              yield* events.append({
                workspaceId: ws.id, type: "prompt.delivery.degraded",
                payload: { reason: "session-start-timeout", timeoutMs },
              })
            }
          }
          // 注意（RE-SMOKE 反转）：codex 无-hooks 流走到这里 engineReady 恒 false → 强化 waitStable 默认参数
          // （minElapsedMs 1500 / stableFrames 3，实测 TUI ~2s 稳定、composer 不吞字）。这是**设计通路**不是
          // 降级——不发 prompt.delivery.degraded（degraded 只保留给 hooks 门控超时与真正的 waitStable 失败）。
          yield* detachListener // 拿到（或超时放弃）就绪信号后立刻摘监听器，不再需要
          // engineReady：已确认 engine 真活着（hook 打过），waitStable 只需最低限度确认一次；
          // 否则落回强化默认兜底。
          yield* deliverPrompt(
            tmux, `${session}:0`, ctx.initialPrompt!,
            engineReady ? { minElapsedMs: 0, stableFrames: 2 } : undefined,
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
