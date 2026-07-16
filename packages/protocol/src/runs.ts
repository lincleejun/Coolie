import { Schema } from "effect"

export const ProjectScriptType = Schema.Literal("setup", "run", "archive")
export type ProjectScriptType = typeof ProjectScriptType.Type

export const ProjectScriptScope = Schema.Literal("project", "workspace")
export type ProjectScriptScope = typeof ProjectScriptScope.Type

export const RunInstanceStatus = Schema.Literal("running", "exited", "error")
export type RunInstanceStatus = typeof RunInstanceStatus.Type

const RUN_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
const MAX_ARGS = 32
const MAX_ARG_LEN = 512
const MAX_COMMAND_LEN = 512

export const ProjectScriptDefinition = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  runId: Schema.String,
  scriptType: ProjectScriptType,
  scope: ProjectScriptScope,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type ProjectScriptDefinition = typeof ProjectScriptDefinition.Type

export const RunInstanceRecord = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  runId: Schema.String,
  scriptType: ProjectScriptType,
  status: RunInstanceStatus,
  startedAt: Schema.Number,
  exitedAt: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
})
export type RunInstanceRecord = typeof RunInstanceRecord.Type

export const RunLogMetadata = Schema.Struct({
  id: Schema.String,
  runInstanceId: Schema.String,
  workspaceId: Schema.String,
  scriptType: ProjectScriptType,
  bytes: Schema.Number,
  truncated: Schema.Boolean,
  updatedAt: Schema.Number,
})
export type RunLogMetadata = typeof RunLogMetadata.Type

export const ProjectScriptUpsert = Schema.Struct({
  runId: Schema.String,
  scriptType: ProjectScriptType,
  scope: ProjectScriptScope,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
})
export type ProjectScriptUpsert = typeof ProjectScriptUpsert.Type

const assertRunLifecycle = (run: RunInstanceRecord): void => {
  if (run.status === "running") {
    if (run.exitedAt !== null || run.exitCode !== null)
      throw new Error("running run must not carry exit metadata")
    return
  }
  if (run.exitedAt === null)
    throw new Error("non-running run requires exitedAt")
}

const assertScriptScope = (script: ProjectScriptDefinition): void => {
  if (script.scriptType === "run" && script.scope !== "workspace")
    throw new Error("run scripts must use workspace scope")
  if ((script.scriptType === "setup" || script.scriptType === "archive") && script.scope !== "project")
    throw new Error("setup/archive scripts must use project scope")
}

export const validateRunId = (runId: string): void => {
  if (!RUN_ID_PATTERN.test(runId))
    throw new Error("runId must start with a letter and use letters, digits, _ or -")
}

export const validateProjectScriptInput = (input: ProjectScriptUpsert): ProjectScriptUpsert => {
  const decoded = Schema.decodeUnknownSync(ProjectScriptUpsert)(input)
  validateRunId(decoded.runId)
  const command = decoded.command.trim()
  if (command === "" || command.length > MAX_COMMAND_LEN)
    throw new Error("command must be non-empty and bounded")
  const args = decoded.args ?? []
  if (args.length > MAX_ARGS)
    throw new Error("too many args")
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length > MAX_ARG_LEN)
      throw new Error("args must be bounded strings")
  }
  return { ...decoded, command, args }
}

export const decodeProjectScriptDefinition = (input: unknown): ProjectScriptDefinition => {
  const script = Schema.decodeUnknownSync(ProjectScriptDefinition)(input)
  validateRunId(script.runId)
  assertScriptScope(script)
  if (!Number.isFinite(script.createdAt) || script.createdAt <= 0)
    throw new Error("createdAt must be positive")
  if (!Number.isFinite(script.updatedAt) || script.updatedAt <= 0)
    throw new Error("updatedAt must be positive")
  if (script.command.trim() === "")
    throw new Error("command must be non-empty")
  return script
}

export const decodeRunInstanceRecord = (input: unknown): RunInstanceRecord => {
  const run = Schema.decodeUnknownSync(RunInstanceRecord)(input)
  validateRunId(run.runId)
  assertRunLifecycle(run)
  if (!Number.isFinite(run.startedAt) || run.startedAt <= 0)
    throw new Error("startedAt must be positive")
  return run
}

export const decodeRunLogMetadata = (input: unknown): RunLogMetadata => {
  const meta = Schema.decodeUnknownSync(RunLogMetadata)(input)
  if (!Number.isFinite(meta.bytes) || meta.bytes < 0)
    throw new Error("bytes must be non-negative")
  if (!Number.isFinite(meta.updatedAt) || meta.updatedAt <= 0)
    throw new Error("updatedAt must be positive")
  return meta
}
