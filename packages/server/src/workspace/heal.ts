import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
import { tmuxSessionName, type HealOutcome } from "@coolie/protocol"
import { CoolieConfig } from "../config.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { ProjectsRepo } from "../repo/projects.js"
import { TabsRepo } from "../repo/tabs.js"
import { EventsRepo } from "../repo/events.js"
import { TmuxService, TmuxError } from "../tmux/service.js"
import { EngineRegistry, EngineError, getEngine, engineHome } from "../engine/registry.js"
import { NotFoundError, ConflictError } from "../repo/errors.js"
import { startEngineSession } from "../engine/session.js"
import { ensureKeepAliveScript, wrapEngineCommand } from "../engine/keepalive.js"
import { labelTmuxWindow, makeTmuxLayout } from "../tmux/layout.js"

/** observe→decide 的纯决策（设计文档 §十）：apply 之外可独立单测。 */
export type HealPlan =
  | { readonly kind: "none" }
  | { readonly kind: "recreate"; readonly resume: boolean; readonly sessionId: string; readonly needsTabRow: boolean }

export const decideHeal = (obs: {
  readonly hasSession: boolean
  readonly engineTab: { readonly id: string; readonly engineSessionId: string | null } | null
  readonly transcriptExists: boolean
  readonly freshSessionId: string
}): HealPlan => {
  if (obs.hasSession) return { kind: "none" }
  if (obs.engineTab !== null && obs.engineTab.engineSessionId !== null && obs.transcriptExists)
    return { kind: "recreate", resume: true, sessionId: obs.engineTab.engineSessionId, needsTabRow: false }
  return { kind: "recreate", resume: false, sessionId: obs.freshSessionId, needsTabRow: obs.engineTab === null }
}

export type EnsureError = NotFoundError | ConflictError | TmuxError | EngineError

export interface SessionEnsurerShape {
  /** ensure-or-heal：session 在则 no-op；丢失则重建（--resume 优先）。 */
  readonly ensure: (wsId: string) => Effect.Effect<HealOutcome, EnsureError>
  /** Resume 按钮语义：engine 已退出（pane=keep-alive 落回的 shell）→ respawn-window 原地重启 engine；
   * session 整个丢失 → 降级 ensure。 */
  readonly resumeTab: (wsId: string, tabId: string) => Effect.Effect<HealOutcome, EnsureError>
  /** Create an additional engine chat tab in the existing workspace session. */
  readonly createEngineTab: (wsId: string, engineId: string, opts?: {
    readonly model?: string; readonly effort?: string; readonly title?: string
  }) => Effect.Effect<HealOutcome, EnsureError>
  /** Replace only the existing engine window; sibling shell/run windows and worktree remain untouched. */
  readonly switchEngine: (wsId: string, tabId: string, engineId: string, opts?: {
    readonly model?: string; readonly effort?: string
  }) => Effect.Effect<HealOutcome, EnsureError>
}
export class SessionEnsurer extends Context.Tag("SessionEnsurer")<SessionEnsurer, SessionEnsurerShape>() {}

export const SessionEnsurerLive = Layer.effect(
  SessionEnsurer,
  Effect.gen(function* () {
    const cfg = yield* CoolieConfig
    const repo = yield* WorkspacesRepo
    const projects = yield* ProjectsRepo
    const tabs = yield* TabsRepo
    const events = yield* EventsRepo
    const tmux = yield* TmuxService
    const registry = yield* EngineRegistry
    const layout = makeTmuxLayout(tmux, repo, tabs)

    const transcriptExists = (engine: { id: string; transcriptPath: (o: { home: string; cwd: string; sessionId: string }) => string },
      cwd: string, sessionId: string | null): boolean =>
      sessionId !== null && fs.existsSync(engine.transcriptPath({ home: engineHome(engine.id, cfg), cwd, sessionId }))

    const reconcileNonEngineTabs = (workspaceId: string, sessionName: string) =>
      Effect.gen(function* () {
        const live = new Set((yield* tmux.listWindows(sessionName)).map((w) => w.index))
        const stale = (yield* tabs.listByWorkspace(workspaceId)).filter(
          (t) => t.kind !== "engine" && (t.tmuxWindow === null || !live.has(t.tmuxWindow)),
        )
        for (const t of stale) yield* tabs.remove(t.id).pipe(Effect.ignore)
      })

    const ensure: SessionEnsurerShape["ensure"] = (wsId) =>
      Effect.gen(function* () {
        // ---- observe ----
        const ws = yield* repo.get(wsId)
        if (ws.status !== "active")
          return yield* new ConflictError({ message: `只能 ensure active 的 workspace（当前 ${ws.status}）` })
        const sessionName = tmuxSessionName(ws.id)
        const hasSession = yield* tmux.hasSession(sessionName)
        if (hasSession) yield* layout.reconcile(ws.id)
        const tab = yield* tabs.findEngineTab(wsId)
        const engine = yield* getEngine(registry, tab?.engineId ?? "claude")
        // ---- decide ----
        const plan = decideHeal({
          hasSession,
          engineTab: tab,
          transcriptExists: yield* Effect.sync(() => transcriptExists(engine, ws.path, tab?.engineSessionId ?? null)),
          freshSessionId: engine.newSessionId(),
        })
        if (plan.kind === "none") {
          yield* reconcileNonEngineTabs(ws.id, sessionName)
          const live = new Set((yield* tmux.listWindows(sessionName)).map((window) => window.index))
          for (const engineTab of yield* tabs.listEngineTabsByWorkspace(ws.id)) {
            if (engineTab.tmuxWindow === null || !live.has(engineTab.tmuxWindow))
              yield* resumeTab(ws.id, engineTab.id)
          }
          yield* layout.reconcile(ws.id)
          return { action: "none", resumed: false, sessionName, tabId: tab?.id ?? null, sessionId: tab?.engineSessionId ?? null } satisfies HealOutcome
        }
        // ---- apply ----
        const project = yield* projects.get(ws.projectId)
        const healingTab = plan.needsTabRow
          ? yield* tabs.insert({
              workspaceId: ws.id, kind: "engine", engineId: engine.id,
              engineSessionId: plan.sessionId, tmuxWindow: 0,
            })
          : tab
        yield* startEngineSession(tmux, {
          ws, repoRoot: project.repoRoot, engine, sessionId: plan.sessionId, resume: plan.resume, home: cfg.home,
          ...(healingTab !== null ? { tabId: healingTab.id, tmuxWindow: 0 } : {}),
        }).pipe(Effect.tapError(() =>
          plan.needsTabRow && healingTab !== null ? tabs.remove(healingTab.id).pipe(Effect.ignore) : Effect.void))
        const tabId = healingTab?.id ?? null
        if (!plan.needsTabRow && tab !== null && !plan.resume) {
          yield* tabs.setEngineSessionId(tab.id, plan.sessionId) // 换新会话：钥匙同步
        }
        if (tabId !== null) {
          yield* tabs.setTmuxWindow(tabId, 0)
          yield* tabs.setStatus(tabId, "idle", "heal").pipe(Effect.ignore)
        }
        // D3：recreate 后 session 只余 engine window——历史 shell/run tab 行仍指向已不存在的 window
        //（GUI 表现为「can't find window: N」死 tab，要手动重连才消失）。按真实 window 存在性 prune
        // 非 engine tab（每次 remove 与其 tab.closed 事件同事务；engine tab 由上面的重建流程自愈，保活）。
        yield* reconcileNonEngineTabs(ws.id, sessionName)
        for (const sibling of yield* tabs.listEngineTabsByWorkspace(ws.id)) {
          if (sibling.id !== tabId) yield* resumeTab(ws.id, sibling.id)
        }
        yield* layout.reconcile(ws.id)
        yield* events.append({
          workspaceId: ws.id, type: "workspace.tmux.healed",
          payload: { sessionName, resumed: plan.resume, sessionId: plan.sessionId, tabId },
        })
        return { action: "recreated", resumed: plan.resume, sessionName, tabId, sessionId: plan.sessionId } satisfies HealOutcome
      })

    const resumeTab: SessionEnsurerShape["resumeTab"] = (wsId, tabId) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(wsId)
        if (ws.status !== "active")
          return yield* new ConflictError({ message: `只能 resume active 的 workspace（当前 ${ws.status}）` })
        const tab = yield* tabs.get(tabId)
        if (tab.workspaceId !== wsId || tab.kind !== "engine")
          return yield* new ConflictError({ message: `tab ${tabId} 不是该 workspace 的 engine tab` })
        const sessionName = tmuxSessionName(ws.id)
        if (!(yield* tmux.hasSession(sessionName))) return yield* ensure(wsId) // session 整个没了 → heal
        yield* layout.reconcile(ws.id)
        const engine = yield* getEngine(registry, tab.engineId ?? "claude")
        const canResume = yield* Effect.sync(() => transcriptExists(engine, ws.path, tab.engineSessionId))
        const resume = canResume && tab.engineSessionId !== null
        const sessionId = resume ? tab.engineSessionId! : engine.newSessionId()
        const engineCommand = engine.launchCommand({
          sessionId, resume, cwd: ws.path, workspaceId: ws.id, tabId: tab.id,
          ...(tab.tmuxWindow !== null ? { tmuxWindow: tab.tmuxWindow } : {}),
          home: cfg.home,
        })
        yield* Effect.try({
          try: () => ensureKeepAliveScript(cfg.home),
          catch: (e) => new TmuxError({ op: "keepalive-script", message: `keep-alive 脚本写入失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        const live = new Set((yield* tmux.listWindows(sessionName)).map((window) => window.index))
        let tmuxWindow = tab.tmuxWindow
        if (tmuxWindow !== null && live.has(tmuxWindow)) {
          yield* tmux.respawnWindow({
            session: sessionName, window: tmuxWindow, cwd: ws.path,
            command: wrapEngineCommand(cfg.home, ws.id, engineCommand, { tabId: tab.id, tmuxWindow }),
          })
        } else {
          tmuxWindow = yield* tmux.newWindow({
            session: sessionName, name: "engine", cwd: ws.path,
            command: wrapEngineCommand(cfg.home, ws.id, engineCommand, { tabId: tab.id }),
          })
          yield* tabs.setTmuxWindow(tab.id, tmuxWindow)
        }
        if (!resume) yield* tabs.setEngineSessionId(tab.id, sessionId)
        yield* labelTmuxWindow(tmux, sessionName, tmuxWindow, {
          role: "engine", workspaceId: ws.id, tabId: tab.id,
        })
        yield* tabs.setStatus(tab.id, "idle", "heal").pipe(Effect.ignore)
        yield* events.append({ workspaceId: ws.id, type: "engine.resumed", payload: { tabId: tab.id, sessionId, resumed: resume } })
        return { action: "respawned", resumed: resume, sessionName, tabId: tab.id, sessionId } satisfies HealOutcome
      })

    const validateEngineOptions = (engineId: string, opts: { readonly model?: string; readonly effort?: string }) =>
      Effect.gen(function* () {
        const engine = yield* getEngine(registry, engineId)
        if (opts.model !== undefined && !(engine.models ?? []).includes(opts.model))
          return yield* new ConflictError({ message: `engine ${engineId} 不支持 model ${opts.model}` })
        if (opts.effort !== undefined && (!engine.capabilities.effort || !(engine.efforts ?? []).includes(opts.effort)))
          return yield* new ConflictError({ message: `engine ${engineId} 不支持 effort ${opts.effort}` })
        return engine
      })

    const createEngineTab: SessionEnsurerShape["createEngineTab"] = (wsId, engineId, opts = {}) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(wsId)
        if (ws.kind === "main") return yield* new ConflictError({ message: "main workspace 不支持 engine chat tab" })
        if (!ws.materialized) return yield* new ConflictError({ message: "未 materialize 的 task 不支持 engine chat tab" })
        if (ws.status !== "active") return yield* new ConflictError({ message: `只能在 active task 创建 engine tab（当前 ${ws.status}）` })
        const engine = yield* validateEngineOptions(engineId, opts)
        const sessionName = tmuxSessionName(ws.id)
        if (!(yield* tmux.hasSession(sessionName))) yield* ensure(wsId)
        const sessionId = engine.serverGeneratedId === true ? null : engine.newSessionId()
        const tab = yield* tabs.insert({
          workspaceId: ws.id, kind: "engine", engineId: engine.id, engineSessionId: sessionId,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
        })
        const command = engine.launchCommand({
          sessionId: sessionId ?? "", resume: false, cwd: ws.path, workspaceId: ws.id, tabId: tab.id, home: cfg.home,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        })
        const tmuxWindow = yield* tmux.newWindow({
          session: sessionName, name: "engine", cwd: ws.path,
          command: wrapEngineCommand(cfg.home, ws.id, command, { tabId: tab.id }),
        }).pipe(Effect.tapError(() => tabs.remove(tab.id).pipe(Effect.ignore)))
        yield* tabs.setTmuxWindow(tab.id, tmuxWindow)
        yield* labelTmuxWindow(tmux, sessionName, tmuxWindow, {
          role: "engine", workspaceId: ws.id, tabId: tab.id,
        })
        yield* events.append({
          workspaceId: ws.id, type: "engine.started",
          payload: { tabId: tab.id, engineId: engine.id, sessionId, tmuxWindow },
        })
        return { action: "respawned", resumed: false, sessionName, tabId: tab.id, sessionId } satisfies HealOutcome
      })

    const switchEngine: SessionEnsurerShape["switchEngine"] = (wsId, tabId, engineId, opts = {}) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(wsId)
        if (ws.kind === "main") return yield* new ConflictError({ message: "main workspace 不支持切换 engine" })
        if (!ws.materialized) return yield* new ConflictError({ message: "未 materialize 的 task 不支持切换 engine" })
        if (ws.status !== "active") return yield* new ConflictError({ message: `只能切换 active task（当前 ${ws.status}）` })
        const tab = yield* tabs.get(tabId)
        if (tab.workspaceId !== wsId || tab.kind !== "engine")
          return yield* new ConflictError({ message: `tab ${tabId} 不是该 workspace 的 engine tab` })
        if (!tab || tab.tmuxWindow === null) return yield* new ConflictError({ message: "task 没有可切换的 engine tab" })
        const engine = yield* validateEngineOptions(engineId, opts)
        const sessionName = tmuxSessionName(ws.id)
        if (!(yield* tmux.hasSession(sessionName)))
          return yield* new ConflictError({ message: "tmux session 不存在；请先 ensure task" })
        yield* layout.reconcile(ws.id)
        const sessionId = engine.serverGeneratedId === true ? null : engine.newSessionId()
        const engineCommand = engine.launchCommand({
          sessionId: sessionId ?? "", resume: false, workspaceId: ws.id, tabId: tab.id,
          tmuxWindow: tab.tmuxWindow, home: cfg.home, cwd: ws.path,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        })
        yield* Effect.try({
          try: () => ensureKeepAliveScript(cfg.home),
          catch: (e) => new TmuxError({ op: "keepalive-script", message: String(e), exitCode: null, stderr: "" }),
        })
        yield* tmux.respawnWindow({
          session: sessionName, window: tab.tmuxWindow, cwd: ws.path,
          command: wrapEngineCommand(cfg.home, ws.id, engineCommand, { tabId: tab.id, tmuxWindow: tab.tmuxWindow }),
        })
        yield* tabs.switchEngine(tab.id, engine.id, sessionId)
        yield* labelTmuxWindow(tmux, sessionName, tab.tmuxWindow, {
          role: "engine", workspaceId: ws.id, tabId: tab.id,
        })
        return { action: "respawned", resumed: false, sessionName, tabId: tab.id, sessionId } satisfies HealOutcome
      })

    return { ensure, resumeTab, createEngineTab, switchEngine }
  }),
)
