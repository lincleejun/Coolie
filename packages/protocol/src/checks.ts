import { Schema } from "effect"

export const CheckStatus = Schema.Literal(
  "pass",
  "fail",
  "warn",
  "pending",
  "unavailable",
  "skipped",
)
export type CheckStatus = typeof CheckStatus.Type

export const CheckCategory = Schema.Literal(
  "git",
  "branch",
  "run",
  "pr",
  "ci",
  "comments",
)
export type CheckCategory = typeof CheckCategory.Type

export const CheckActionKind = Schema.Literal(
  "none",
  "open-pr",
  "run-script",
  "fix-with-agent",
  "view-diff",
)
export type CheckActionKind = typeof CheckActionKind.Type

export const CheckAction = Schema.Struct({
  kind: CheckActionKind,
  label: Schema.String,
  runId: Schema.optional(Schema.String),
})
export type CheckAction = typeof CheckAction.Type

export const CheckItem = Schema.Struct({
  id: Schema.String,
  category: CheckCategory,
  status: CheckStatus,
  label: Schema.String,
  detail: Schema.optional(Schema.String),
  updatedAt: Schema.Number,
  action: Schema.optional(CheckAction),
})
export type CheckItem = typeof CheckItem.Type

export const WorkspaceChecksSnapshot = Schema.Struct({
  workspaceId: Schema.String,
  collectedAt: Schema.Number,
  items: Schema.Array(CheckItem),
  degraded: Schema.Boolean,
})
export type WorkspaceChecksSnapshot = typeof WorkspaceChecksSnapshot.Type
export const decodeWorkspaceChecksSnapshot = Schema.decodeUnknownSync(WorkspaceChecksSnapshot)
