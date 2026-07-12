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

    const transcriptExists = (engine: { id: string; transcriptPath: (o: { home: string; cwd: string; sessionId: string }) => string },
      cwd: string, sessionId: string | null): boolean =>
      sessionId !== null && fs.existsSync(engine.transcriptPath({ home: engineHome(engine.id, cfg), cwd, sessionId }))

    const ensure: SessionEnsurerShape["ensure"] = (wsId) =>
      Effect.gen(function* () {
        // ---- observe ----
        const ws = yield* repo.get(wsId)
        if (ws.status !== "active")
          return yield* new ConflictError({ message: `只能 ensure active 的 workspace（当前 ${ws.status}）` })
        const sessionName = tmuxSessionName(ws.id)
        const hasSession = yield* tmux.hasSession(sessionName)
        const tab = yield* tabs.findEngineTab(wsId)
        const engine = yield* getEngine(registry, tab?.engineId ?? "claude")
        // ---- decide ----
        const plan = decideHeal({
          hasSession,
          engineTab: tab,
          transcriptExists: yield* Effect.sync(() => transcriptExists(engine, ws.path, tab?.engineSessionId ?? null)),
          freshSessionId: engine.newSessionId(),
        })
        if (plan.kind === "none")
          return { action: "none", resumed: false, sessionName, tabId: tab?.id ?? null, sessionId: tab?.engineSessionId ?? null } satisfies HealOutcome
        // ---- apply ----
        const project = yield* projects.get(ws.projectId)
        yield* startEngineSession(tmux, {
          ws, repoRoot: project.repoRoot, engine, sessionId: plan.sessionId, resume: plan.resume, home: cfg.home,
        })
        let tabId = tab?.id ?? null
        if (plan.needsTabRow) {
          const t = yield* tabs.insert({ workspaceId: ws.id, kind: "engine", engineId: engine.id, engineSessionId: plan.sessionId, tmuxWindow: 0 })
          tabId = t.id
        } else if (tab !== null && !plan.resume) {
          yield* tabs.setEngineSessionId(tab.id, plan.sessionId) // 换新会话：钥匙同步
        }
        if (tabId !== null) yield* tabs.setStatus(tabId, "idle", "heal").pipe(Effect.ignore)
        // D3：recreate 后 session 只余 engine window——历史 shell/run tab 行仍指向已不存在的 window
        //（GUI 表现为「can't find window: N」死 tab，要手动重连才消失）。按真实 window 存在性 prune
        // 非 engine tab（每次 remove 与其 tab.closed 事件同事务；engine tab 由上面的重建流程自愈，保活）。
        const liveWindows = new Set((yield* tmux.listWindows(sessionName)).map((w) => w.index))
        const staleTabs = (yield* tabs.listByWorkspace(ws.id)).filter(
          (t) => t.id !== tabId && (t.tmuxWindow === null || !liveWindows.has(t.tmuxWindow)),
        )
        for (const t of staleTabs) yield* tabs.remove(t.id).pipe(Effect.ignore)
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
        const engine = yield* getEngine(registry, tab.engineId ?? "claude")
        const canResume = yield* Effect.sync(() => transcriptExists(engine, ws.path, tab.engineSessionId))
        const resume = canResume && tab.engineSessionId !== null
        const sessionId = resume ? tab.engineSessionId! : engine.newSessionId()
        const engineCommand = engine.launchCommand({ sessionId, resume })
        yield* Effect.try({
          try: () => ensureKeepAliveScript(cfg.home),
          catch: (e) => new TmuxError({ op: "keepalive-script", message: `keep-alive 脚本写入失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        yield* tmux.respawnWindow({
          session: sessionName, window: tab.tmuxWindow ?? 0, cwd: ws.path,
          command: wrapEngineCommand(cfg.home, ws.id, engineCommand),
        })
        if (!resume) yield* tabs.setEngineSessionId(tab.id, sessionId)
        yield* tabs.setStatus(tab.id, "idle", "heal").pipe(Effect.ignore)
        yield* events.append({ workspaceId: ws.id, type: "engine.resumed", payload: { tabId: tab.id, sessionId, resumed: resume } })
        return { action: "respawned", resumed: resume, sessionName, tabId: tab.id, sessionId } satisfies HealOutcome
      })

    return { ensure, resumeTab }
  }),
)
