import { Effect, Layer, Option, Deferred } from "effect"
import { PostCreateHooks, HookError, type PostCreateHook } from "../workspace/lifecycle.js"
import { TmuxService } from "../tmux/service.js"
import { TabsRepo } from "../repo/tabs.js"
import { EventsRepo } from "../repo/events.js"
import { ProjectsRepo } from "../repo/projects.js"
import { EngineRegistry } from "./registry.js"
import { CoolieConfig } from "../config.js"
import { deliverPrompt } from "../tmux/delivery.js"
import { startEngineSession } from "./session.js"
import { injectInfoExclude } from "../workspace/include.js"
import { ensureHookScript, injectClaudeHooks, hooksDisabled } from "./claude/hooks.js"
import { injectCodexHooks } from "./codex/hooks.js"
import { engineHome } from "./registry.js"
import { scanNewestRollout, awaitRollout, realRolloutFs } from "./codex/rollout.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { tmuxSessionName, type CoolieEvent } from "@coolie/protocol"

/** 命名唯一真源在 protocol（tmuxSessionName）；此别名只为 server 侧调用点可读性。 */
export const sessionNameFor = tmuxSessionName

/** hooks 就绪信号超时兜底（cfg.promptReadyTimeoutMs 未注入时用这个）；
 * 与 config.ts 缺省对齐——90s 跑赢真实 claude 首启（claude-mem 播种 ~22.3s）。 */
const DEFAULT_PROMPT_READY_TIMEOUT_MS = 90_000

/** codex 无-hooks 通路的 rollout 就绪门控兜底（cfg.rolloutReadyTimeoutMs 未注入时用）；
 * rollout 文件会话起始即落地，给足慢机余量，超时降级走强化 waitStable。 */
const DEFAULT_ROLLOUT_READY_TIMEOUT_MS = 15_000
/** rollout 轮询步长（≤500ms，brief）：文件几百 ms 内出现，不引入可感延迟。 */
const ROLLOUT_POLL_INTERVAL_MS = 250

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

        if (engine.capabilities.hooks && !hooksDisabled()) {
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
        const gateOnHooks = wantsPrompt && engine.capabilities.hooks && !hooksDisabled() && Option.isSome(bus)
        // codex 无-hooks 通路（0.139 实测 hooks 四断点，见 task-12-report）：hooks 能力关但服务端造 id →
        // 就绪信号改用「本 workspace 的 rollout 文件出现」而非 EventsBus hook 事件。能力驱动：未来 codex≥0.144
        // 验证 hooks 后 capabilities.hooks 转 true，gateOnHooks 优先，本路径自动让位、无需改调用点。
        const gateOnRollout = wantsPrompt && !gateOnHooks && engine.serverGeneratedId === true

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

        // rollout 就绪门控的下界：只认「起 session 之后」创建的 rollout（排除旧会话/别 tab 的残留，防误回填旧 id）。
        const rolloutSinceMs = Date.now()
        const { engineCommand } = yield* startEngineSession(tmux, {
          ws, repoRoot: project.repoRoot, engine, sessionId, resume: false, home: cfg.home,
        }).pipe(Effect.mapError((e) => new HookError({ message: `tmux session 创建失败：${e.message}` })))
        yield* events.append({ workspaceId: ws.id, type: "workspace.tmux.created", payload: { sessionName: session } })

        const tab = yield* tabs.insert({
          workspaceId: ws.id, kind: "engine", engineId: engine.id, engineSessionId: sessionId, tmuxWindow: 0,
        })
        yield* events.append({
          workspaceId: ws.id, type: "engine.started",
          payload: { tabId: tab.id, engineId: engine.id, sessionId, command: engineCommand, wrapped: true },
        })

        if (wantsPrompt) {
          let engineReady = false
          if (ready) {
            const timeoutMs = cfg.promptReadyTimeoutMs ?? DEFAULT_PROMPT_READY_TIMEOUT_MS
            engineReady = yield* ready.pipe(
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
          } else if (gateOnRollout) {
            // codex 无-hooks 就绪门控：轮询本 workspace 的 rollout 文件出现（≤250ms 步长），命中即
            // ① 回填 engineSessionId（→ tab.session.changed；resume/标题派生/mtime 状态轮询自此解锁）
            // ② 追加 engine.session.started（同 hooks 词汇——下游 C4/状态迁移/标题派生保持统一，不知情有无 hooks）
            // 再投 prompt：一举干掉 90s 结构性降级 + 永-null-id 两个断点。超时未见 → 记 rollout-timeout 降级、走兜底。
            const home = engineHome(engine.id, { claudeHome: cfg.claudeHome, codexHome: cfg.codexHome })
            const timeoutMs = cfg.rolloutReadyTimeoutMs ?? DEFAULT_ROLLOUT_READY_TIMEOUT_MS
            const found = yield* Effect.promise(() => awaitRollout(
              {
                scan: () => scanNewestRollout(realRolloutFs, { home, cwd: ws.path, sinceMs: rolloutSinceMs }),
                now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              },
              { timeoutMs, intervalMs: ROLLOUT_POLL_INTERVAL_MS },
            ))
            if (found !== null) {
              engineReady = true
              yield* tabs.setEngineSessionId(tab.id, found.sessionId).pipe(
                Effect.mapError((e) => new HookError({ message: `engineSessionId 回填失败：${e.message}` })),
              )
              yield* events.append({
                workspaceId: ws.id, type: "engine.session.started",
                payload: { tabId: tab.id, sessionId: found.sessionId },
              })
            } else {
              yield* events.append({
                workspaceId: ws.id, type: "prompt.delivery.degraded",
                payload: { reason: "rollout-timeout", timeoutMs },
              })
            }
          }
          yield* detachListener // 拿到（或超时放弃）就绪信号后立刻摘监听器，不再需要
          // engineReady：已确认 engine 真活着（hook 打过 / rollout 已落地），waitStable 只需最低限度确认一次；
          // 否则（就绪信号不可用/超时未到）落回强化默认（minElapsedMs 1500 / stableFrames 3）兜底。
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
