import { Schema } from "effect"

export const WorkspaceStatus = Schema.Literal("creating", "active", "archived", "error")
export type WorkspaceStatus = typeof WorkspaceStatus.Type

export class Project extends Schema.Class<Project>("Project")({
  id: Schema.String,
  name: Schema.String,
  repoRoot: Schema.String,
  defaultBaseBranch: Schema.String,
  createdAt: Schema.Number,
}) {}
export const decodeProject = Schema.decodeUnknownSync(Project)

export const ApiErrorCode = Schema.Literal(
  "GitError", "TmuxError", "EngineError", "SetupScriptError",
  "NotFound", "Conflict", "Validation", "Internal",
)
export const ApiErrorBody = Schema.Struct({ code: ApiErrorCode, message: Schema.String })
export type ApiErrorBody = typeof ApiErrorBody.Type

export const CoolieEvent = Schema.Struct({
  seq: Schema.Number,
  workspaceId: Schema.NullOr(Schema.String),
  type: Schema.String,
  payload: Schema.Unknown,
  ts: Schema.Number,
})
export type CoolieEvent = typeof CoolieEvent.Type
export const decodeCoolieEvent = Schema.decodeUnknownSync(CoolieEvent)
