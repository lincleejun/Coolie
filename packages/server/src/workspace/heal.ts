import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
import { tmuxSessionName, type HealOutcome } from "@coolie/protocol"
import { CoolieConfig } from "../config.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { ProjectsRepo } from "../repo/projects.js"
import { TabsRepo } from "../repo/tabs.js"
import { EventsRepo } from "../repo/events.js"
import { TmuxService, TmuxError } from "../tmux/service.js"
import { EngineRegistry, EngineError, getEngine } from "../engine/registry.js"
import { NotFoundError, ConflictError } from "../repo/errors.js"
import { startEngineSession } from "../engine/session.js"

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

    const transcriptExists = (engine: { transcriptPath: (o: { home: string; cwd: string; sessionId: string }) => string },
      cwd: string, sessionId: string | null): boolean =>
      sessionId !== null && fs.existsSync(engine.transcriptPath({ home: cfg.claudeHome, cwd, sessionId }))

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
        yield* events.append({
          workspaceId: ws.id, type: "workspace.tmux.healed",
          payload: { sessionName, resumed: plan.resume, sessionId: plan.sessionId, tabId },
        })
        return { action: "recreated", resumed: plan.resume, sessionName, tabId, sessionId: plan.sessionId } satisfies HealOutcome
      })

    return { ensure }
  }),
)
