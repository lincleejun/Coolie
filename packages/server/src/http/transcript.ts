import { Effect } from "effect"
import { unavailableTranscriptPage } from "@coolie/protocol"
import { TabsRepo } from "../repo/tabs.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { EngineRegistry, engineHome } from "../engine/registry.js"
import { NotFoundError } from "../repo/errors.js"

export const readTabTranscript = (opts: {
  readonly workspaceId: string
  readonly tabId: string
  readonly cursor?: string | null
  readonly maxEntries?: number
  readonly maxBytes?: number
  readonly claudeHome: string
  readonly codexHome: string
}) =>
  Effect.gen(function* () {
    const tabs = yield* TabsRepo
    const workspaces = yield* WorkspacesRepo
    const registry = yield* EngineRegistry
    const ws = yield* workspaces.get(opts.workspaceId)
    const tab = yield* tabs.get(opts.tabId)
    if (tab.workspaceId !== opts.workspaceId)
      return yield* new NotFoundError({ message: `tab ${opts.tabId} 不属于 workspace ${opts.workspaceId}` })
    if (tab.kind !== "engine")
      return unavailableTranscriptPage()
    const engineId = tab.engineId
    const sessionId = tab.engineSessionId
    if (!engineId || !sessionId)
      return unavailableTranscriptPage()
    const engine = registry.get(engineId)
    if (!engine?.transcriptReader)
      return unavailableTranscriptPage()
    const home = engineHome(engineId, { claudeHome: opts.claudeHome, codexHome: opts.codexHome })
    const filePath = engine.transcriptPath({ home, cwd: ws.path, sessionId })
    return engine.transcriptReader.read({
      home,
      cwd: ws.path,
      sessionId,
      filePath,
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
      ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    })
  })
