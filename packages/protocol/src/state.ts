import { Schema } from "effect"
import {
  Project,
  QueuedPromptDto,
  Tab,
  Workspace,
  decodeProject,
  decodeTab,
  decodeWorkspace,
} from "./domain.js"

/** Attention episode surfaced in current-state snapshots (FR-7.1). */
export const AttentionKind = Schema.Literal(
  "turn-finished",
  "permission",
  "elicitation",
  "rate-limit",
  "error",
  "inferred",
)
export type AttentionKind = typeof AttentionKind.Type

export const AttentionSource = Schema.Literal("hook", "notify", "transcript-poller")
export type AttentionSource = typeof AttentionSource.Type

export const AttentionState = Schema.Literal("open", "acknowledged")
export type AttentionState = typeof AttentionState.Type

export const AttentionSnapshotItem = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  tabId: Schema.String,
  kind: AttentionKind,
  source: AttentionSource,
  sourceEventSeq: Schema.Number,
  sessionTurnId: Schema.NullOr(Schema.String),
  summary: Schema.String,
  state: AttentionState,
  createdAt: Schema.Number,
  acknowledgedAt: Schema.NullOr(Schema.Number),
})
export type AttentionSnapshotItem = typeof AttentionSnapshotItem.Type

/** Named run script instance included in current-state snapshots (FR-4.2 / FR-8.1). */
export const RunScriptType = Schema.Literal("setup", "run", "archive")
export type RunScriptType = typeof RunScriptType.Type

export const RunSnapshotStatus = Schema.Literal("running", "exited", "error")
export type RunSnapshotStatus = typeof RunSnapshotStatus.Type

export const RunSnapshotItem = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  runId: Schema.String,
  scriptType: RunScriptType,
  status: RunSnapshotStatus,
  startedAt: Schema.Number,
  exitedAt: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
})
export type RunSnapshotItem = typeof RunSnapshotItem.Type

export const StateSnapshotScope = Schema.Struct({
  workspaceId: Schema.String,
})
export type StateSnapshotScope = typeof StateSnapshotScope.Type

/** Canonical current-state snapshot returned by GET /state (FR-8.1). */
export const CoolieStateSnapshot = Schema.Struct({
  asOfSeq: Schema.Number,
  generatedAt: Schema.Number,
  scope: Schema.NullOr(StateSnapshotScope),
  projects: Schema.Array(Project),
  workspaces: Schema.Array(Workspace),
  tabs: Schema.Array(Tab),
  openAttention: Schema.Array(AttentionSnapshotItem),
  queuedPrompts: Schema.Array(QueuedPromptDto),
  activeRuns: Schema.Array(RunSnapshotItem),
})
export type CoolieStateSnapshot = typeof CoolieStateSnapshot.Type

const decodeAttentionSnapshotItem = Schema.decodeUnknownSync(AttentionSnapshotItem)
const decodeRunSnapshotItem = Schema.decodeUnknownSync(RunSnapshotItem)
const decodeQueuedPromptDto = Schema.decodeUnknownSync(QueuedPromptDto)

const assertAttentionTimestamps = (item: AttentionSnapshotItem): void => {
  if (item.state === "open" && item.acknowledgedAt !== null)
    throw new Error("open attention item must not carry acknowledgedAt")
  if (item.state === "acknowledged" && item.acknowledgedAt === null)
    throw new Error("acknowledged attention item requires acknowledgedAt")
}

const assertRunLifecycle = (run: RunSnapshotItem): void => {
  if (run.status === "running") {
    if (run.exitedAt !== null || run.exitCode !== null)
      throw new Error("running run must not carry exit metadata")
    return
  }
  if (run.exitedAt === null)
    throw new Error("non-running run requires exitedAt")
}

/** Reject malformed or inconsistent current-state payloads before handlers consume them. */
export const decodeCoolieStateSnapshot = (input: unknown): CoolieStateSnapshot => {
  const snapshot = Schema.decodeUnknownSync(CoolieStateSnapshot)(input)
  if (!Number.isInteger(snapshot.asOfSeq) || snapshot.asOfSeq < 0)
    throw new Error("asOfSeq must be a non-negative integer")
  if (!Number.isFinite(snapshot.generatedAt) || snapshot.generatedAt <= 0)
    throw new Error("generatedAt must be a positive timestamp")
  for (const item of snapshot.openAttention) {
    decodeAttentionSnapshotItem(item)
    assertAttentionTimestamps(item)
  }
  for (const run of snapshot.activeRuns) {
    decodeRunSnapshotItem(run)
    assertRunLifecycle(run)
  }
  for (const project of snapshot.projects) decodeProject(project)
  for (const workspace of snapshot.workspaces) decodeWorkspace(workspace)
  for (const tab of snapshot.tabs) decodeTab(tab)
  for (const prompt of snapshot.queuedPrompts) decodeQueuedPromptDto(prompt)
  return snapshot
}

/** Empty snapshot baseline for greenfield databases (Task 1.2). */
export const emptyCoolieStateSnapshot = (asOfSeq = 0, generatedAt = Date.now()): CoolieStateSnapshot =>
  decodeCoolieStateSnapshot({
    asOfSeq,
    generatedAt,
    scope: null,
    projects: [],
    workspaces: [],
    tabs: [],
    openAttention: [],
    queuedPrompts: [],
    activeRuns: [],
  })
