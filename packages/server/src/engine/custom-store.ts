import { execFile } from "node:child_process"
import * as fs from "node:fs"
import { Context, Data, Effect, Layer } from "effect"
import type { CustomEngineDefinition, EngineAvailability } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"

export class CustomEngineValidationError extends Data.TaggedError("ValidationError")<{ readonly message: string }> {}
export class CustomEngineNotFoundError extends Data.TaggedError("NotFoundError")<{ readonly message: string }> {}

const ID = /^[a-z][a-z0-9-]{1,47}$/
const VARIABLES = new Set(["sessionId", "model", "effort", "cwd", "home", "workspaceId"])
const validateTemplate = (value: string): boolean => {
  for (const match of value.matchAll(/\{([^}]+)\}/g)) if (!VARIABLES.has(match[1]!)) return false
  return true
}

export const validateCustomEngine = (input: unknown): CustomEngineDefinition => {
  const value = input as Partial<CustomEngineDefinition>
  if (!value || typeof value !== "object") throw new CustomEngineValidationError({ message: "engine definition 必须是对象" })
  if (typeof value.id !== "string" || !ID.test(value.id) || value.id === "claude" || value.id === "codex")
    throw new CustomEngineValidationError({ message: "id 必须为 2-48 位小写字母/数字/连字符，且不能覆盖内置 engine" })
  if (typeof value.displayName !== "string" || value.displayName.trim() === "")
    throw new CustomEngineValidationError({ message: "displayName 不能为空" })
  if (!Array.isArray(value.command) || value.command.length === 0 || !value.command.every((v) => typeof v === "string" && v !== "" && validateTemplate(v)))
    throw new CustomEngineValidationError({ message: "command 必须是非空 argv template；仅支持已知 {variable}" })
  const executable = value.command[0]!
  if (executable.trim() === "" || executable.startsWith("-") || /\{[^}]+\}/.test(executable))
    throw new CustomEngineValidationError({ message: "command executable 必须是固定、非空且非 template 的 argv[0]" })
  const caps = value.capabilities
  if (!caps || ["nativeQueue", "midSessionModelSwitch", "resume", "hooks", "effort"].some((key) => typeof (caps as any)[key] !== "boolean"))
    throw new CustomEngineValidationError({ message: "capabilities 不完整" })
  if (!["none", "jsonl-path"].includes(value.transcriptStrategy as string))
    throw new CustomEngineValidationError({ message: "transcriptStrategy 非法" })
  if (value.transcriptStrategy === "jsonl-path" && (!value.transcriptPathTemplate || !validateTemplate(value.transcriptPathTemplate)))
    throw new CustomEngineValidationError({ message: "jsonl-path 需要合法 transcriptPathTemplate" })
  if (!["none", "resume-args"].includes(value.historyStrategy as string))
    throw new CustomEngineValidationError({ message: "historyStrategy 非法" })
  if (!["none", "hooks", "terminal-title"].includes(value.turnDetection as string))
    throw new CustomEngineValidationError({ message: "turnDetection 非法" })
  for (const field of ["models", "efforts", "resumeArgs", "accountDetectionCommand"] as const) {
    const list = value[field]
    if (list !== undefined && (!Array.isArray(list) || !list.every((v) => typeof v === "string" && v !== "" && validateTemplate(v))))
      throw new CustomEngineValidationError({ message: `${field} 必须是字符串数组` })
  }
  return {
    id: value.id, displayName: value.displayName.trim(), enabled: value.enabled !== false,
    command: [...value.command], capabilities: caps,
    transcriptStrategy: value.transcriptStrategy!, historyStrategy: value.historyStrategy!,
    turnDetection: value.turnDetection!,
    ...(value.models ? { models: [...value.models] } : {}),
    ...(value.efforts ? { efforts: [...value.efforts] } : {}),
    ...(value.transcriptPathTemplate ? { transcriptPathTemplate: value.transcriptPathTemplate } : {}),
    ...(value.resumeArgs ? { resumeArgs: [...value.resumeArgs] } : {}),
    ...(value.accountDetectionCommand ? { accountDetectionCommand: [...value.accountDetectionCommand] } : {}),
    ...(value.accountDetectionPath ? { accountDetectionPath: value.accountDetectionPath } : {}),
    ...(value.presetId ? { presetId: value.presetId } : {}),
  }
}

export const copilotPreset = (id = "copilot"): CustomEngineDefinition => ({
  id, displayName: "GitHub Copilot", enabled: true,
  command: ["copilot", "--allow-all-tools"],
  models: [], efforts: [],
  capabilities: { nativeQueue: false, midSessionModelSwitch: false, resume: false, hooks: false, effort: false },
  transcriptStrategy: "none", historyStrategy: "none", turnDetection: "none",
  accountDetectionCommand: ["gh", "auth", "status"], presetId: "copilot",
})

export interface CustomEngineStoreShape {
  list(): Effect.Effect<CustomEngineDefinition[]>
  get(id: string): Effect.Effect<CustomEngineDefinition, CustomEngineNotFoundError>
  put(value: unknown): Effect.Effect<CustomEngineDefinition, CustomEngineValidationError>
  remove(id: string): Effect.Effect<void, CustomEngineNotFoundError>
}
export class CustomEngineStore extends Context.Tag("CustomEngineStore")<CustomEngineStore, CustomEngineStoreShape>() {}

export const CustomEngineStoreLive = Layer.effect(CustomEngineStore, Effect.gen(function* () {
  const db = yield* Db
  const read = (row: any): CustomEngineDefinition => JSON.parse(row.definition)
  return {
    list: () => Effect.sync(() => (db.prepare("SELECT definition FROM custom_engines ORDER BY display_name").all() as any[]).map(read)),
    get: (id) => Effect.gen(function* () {
      const row = db.prepare("SELECT definition FROM custom_engines WHERE id = ?").get(id)
      if (!row) return yield* new CustomEngineNotFoundError({ message: `custom engine 不存在：${id}` })
      return read(row)
    }),
    put: (input) => Effect.try({
      try: () => {
        const value = validateCustomEngine(input)
        const now = Date.now()
        db.prepare(`INSERT INTO custom_engines (id, display_name, enabled, definition, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, enabled=excluded.enabled,
            definition=excluded.definition, updated_at=excluded.updated_at`)
          .run(value.id, value.displayName, value.enabled ? 1 : 0, JSON.stringify(value), now, now)
        return value
      },
      catch: (error) => error instanceof CustomEngineValidationError
        ? error : new CustomEngineValidationError({ message: String(error) }),
    }),
    remove: (id) => Effect.gen(function* () {
      const result = db.prepare("DELETE FROM custom_engines WHERE id = ?").run(id)
      if (result.changes === 0) return yield* new CustomEngineNotFoundError({ message: `custom engine 不存在：${id}` })
    }),
  }
}))

const detectExec = (argv: readonly string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(argv[0]!, argv.slice(1), { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).trim()))
    else resolve(String(stdout || stderr).trim())
  })
})

export const detectArgvAvailability = async (
  argv: readonly string[], requiredPath?: string,
): Promise<EngineAvailability> => {
  try {
    if (requiredPath && !fs.existsSync(requiredPath))
      return { available: false, accountHint: null, error: `path not found: ${requiredPath}` }
    const output = await detectExec(argv)
    return { available: true, accountHint: output.split(/\r?\n/).find(Boolean)?.slice(0, 240) ?? null, error: null }
  } catch (error) {
    return { available: false, accountHint: null, error: error instanceof Error ? error.message.slice(0, 240) : String(error) }
  }
}

export const detectCustomEngine = async (definition: CustomEngineDefinition): Promise<EngineAvailability> => {
  return detectArgvAvailability(
    definition.accountDetectionCommand ?? [definition.command[0]!, "--version"],
    definition.accountDetectionPath,
  )
}
