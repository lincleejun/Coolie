import { Schema } from "effect"

/** Attention episode kind (FR-7.1). */
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

/** Durable attention inbox item persisted in SQLite (Task 2A.1). */
export const AttentionItem = Schema.Struct({
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
export type AttentionItem = typeof AttentionItem.Type

/** Snapshot projection uses the same shape as persisted items. */
export const AttentionSnapshotItem = AttentionItem
export type AttentionSnapshotItem = AttentionItem

export const decodeAttentionItem = Schema.decodeUnknownSync(AttentionItem)

const assertAttentionTimestamps = (item: AttentionItem): void => {
  if (item.state === "open" && item.acknowledgedAt !== null)
    throw new Error("open attention item must not carry acknowledgedAt")
  if (item.state === "acknowledged" && item.acknowledgedAt === null)
    throw new Error("acknowledged attention item requires acknowledgedAt")
}

/** Decode and validate lifecycle timestamps for attention rows. */
export const decodeAttentionItemStrict = (input: unknown): AttentionItem => {
  const item = decodeAttentionItem(input)
  assertAttentionTimestamps(item)
  if (!Number.isInteger(item.sourceEventSeq) || item.sourceEventSeq <= 0)
    throw new Error("sourceEventSeq must be a positive integer")
  if (!Number.isFinite(item.createdAt) || item.createdAt <= 0)
    throw new Error("createdAt must be a positive timestamp")
  if (item.acknowledgedAt !== null && (!Number.isFinite(item.acknowledgedAt) || item.acknowledgedAt <= 0))
    throw new Error("acknowledgedAt must be a positive timestamp when present")
  return item
}
