import * as path from "node:path"
import { randomUUID } from "node:crypto"
import type { CustomEngineDefinition } from "@coolie/protocol"
import type { Engine } from "./types.js"
import { CustomEngineValidationError } from "./custom-store.js"

type Vars = Readonly<Record<string, string | undefined>>
const expand = (template: readonly string[], vars: Vars): string[] =>
  template.flatMap((arg) => {
    const names = [...arg.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!)
    if (names.some((name) => vars[name] === undefined)) return []
    return [arg.replace(/\{([^}]+)\}/g, (_match, name: string) => vars[name] ?? "")]
  })

export const makeCustomEngine = (definition: CustomEngineDefinition): Engine => ({
  id: definition.id,
  displayName: definition.displayName,
  capabilities: definition.capabilities,
  terminalTitle: definition.turnDetection === "terminal-title" ? "engine-owned" : "none",
  models: definition.models ?? [],
  ...(definition.efforts !== undefined ? { efforts: definition.efforts } : {}),
  newSessionId: randomUUID,
  launchCommand: ({ sessionId, model, effort, resume, workspaceId, home, cwd }) => {
    const vars = { sessionId, model, effort, workspaceId, home, cwd }
    const executable = expand(definition.command.slice(0, 1), vars)[0]
    if (executable === undefined)
      throw new CustomEngineValidationError({ message: "custom engine command expansion is missing argv[0]" })
    if (executable.trim() === "")
      throw new CustomEngineValidationError({ message: "custom engine command expansion produced an empty executable" })
    const command = [executable, ...expand(definition.command.slice(1), vars)]
    return resume && definition.historyStrategy === "resume-args"
      ? [...command, ...expand(definition.resumeArgs ?? [], vars)]
      : command
  },
  statusFromHookEvent: (event) => {
    if (definition.turnDetection !== "hooks" || !event || typeof event !== "object") return null
    const name = (event as any).hook_event_name ?? (event as any).event
    if (["Stop", "turn.finished", "idle"].includes(name)) return "awaiting-input"
    if (["UserPromptSubmit", "turn.started", "working"].includes(name)) return "working"
    if (["error", "SessionEnd"].includes(name)) return "error"
    return null
  },
  transcriptPath: ({ home, cwd, sessionId }) => {
    if (definition.transcriptStrategy !== "jsonl-path" || !definition.transcriptPathTemplate) return path.join(home, ".coolie-no-transcript")
    return expand([definition.transcriptPathTemplate], { home, cwd, sessionId })[0] ?? path.join(home, ".coolie-no-transcript")
  },
  deriveTitle: (jsonl) => {
    for (const line of jsonl.split("\n")) {
      try {
        const value = JSON.parse(line)
        const text = value?.message?.content ?? value?.content ?? value?.text
        if (typeof text === "string" && text.trim()) return text.trim().slice(0, 80)
      } catch { /* continue */ }
    }
    return null
  },
  resumeArgs: (sessionId) => expand(definition.resumeArgs ?? [], { sessionId }),
})
