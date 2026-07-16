import { Effect } from "effect"
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  type ApiErrorBody,
  type AttentionFilter,
  type AttentionKind,
  type AttentionState,
} from "@coolie/protocol"
import { AttentionInbox } from "../repo/attention.js"
import { EventsRepo } from "../repo/events.js"
import { ValidationError } from "../repo/errors.js"

const ATTENTION_KINDS = new Set<AttentionKind>([
  "turn-finished", "permission", "elicitation", "rate-limit", "error", "inferred",
])
const ATTENTION_STATES = new Set<AttentionState>(["open", "acknowledged"])

const parseAttentionFilter = (url: URL): Effect.Effect<AttentionFilter, ValidationError> => Effect.gen(function* () {
  const filter: {
    workspaceId?: string
    kind?: AttentionKind
    state?: AttentionState
    cursorCreatedAt?: number
    cursorId?: string
    limit?: number
  } = {}
  const workspaceId = url.searchParams.get("workspace")
  if (workspaceId !== null && workspaceId !== "") filter.workspaceId = workspaceId
  const kind = url.searchParams.get("kind")
  if (kind !== null && kind !== "") {
    if (!ATTENTION_KINDS.has(kind as AttentionKind))
      return yield* new ValidationError({ message: `kind must be one of ${[...ATTENTION_KINDS].join("|")}` })
    filter.kind = kind as AttentionKind
  }
  const state = url.searchParams.get("state")
  if (state !== null && state !== "") {
    if (!ATTENTION_STATES.has(state as AttentionState))
      return yield* new ValidationError({ message: `state must be one of ${[...ATTENTION_STATES].join("|")}` })
    filter.state = state as AttentionState
  }
  const cursorCreatedAt = url.searchParams.get("cursorCreatedAt")
  const cursorId = url.searchParams.get("cursorId")
  if (cursorCreatedAt !== null || cursorId !== null) {
    if (cursorCreatedAt === null || cursorId === null || cursorId === "")
      return yield* new ValidationError({ message: "cursorCreatedAt and cursorId must both be provided" })
    const createdAt = Number(cursorCreatedAt)
    if (!Number.isInteger(createdAt) || createdAt < 0)
      return yield* new ValidationError({ message: "cursorCreatedAt must be a non-negative integer" })
    filter.cursorCreatedAt = createdAt
    filter.cursorId = cursorId
  }
  const limitRaw = url.searchParams.get("limit")
  if (limitRaw !== null && limitRaw !== "") {
    const limit = Number(limitRaw)
    if (!Number.isInteger(limit) || limit <= 0)
      return yield* new ValidationError({ message: "limit must be a positive integer" })
    filter.limit = limit
  }
  return filter
})

export const listAttention = (url: URL) =>
  Effect.gen(function* () {
    const filter = yield* parseAttentionFilter(url)
    return yield* (yield* AttentionInbox).list(filter)
  })

export const getAttention = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* AttentionInbox).get(id)
  })

export const acknowledgeAttention = (id: string, expectedEpisode?: string | null) =>
  Effect.gen(function* () {
    const inbox = yield* AttentionInbox
    const events = yield* EventsRepo
    const before = yield* inbox.get(id)
    const item = yield* inbox.acknowledge(id, expectedEpisode)
    if (before.state === "open") {
      yield* events.append({
        workspaceId: item.workspaceId,
        type: "attention.acknowledged",
        payload: { id: item.id, tabId: item.tabId, kind: item.kind },
      })
    }
    return item
  })

export const handleAttentionAck = async (
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  readJson: (req: IncomingMessage) => Promise<unknown>,
  err: (res: ServerResponse, status: number, code: ApiErrorBody["code"], message: string) => void,
): Promise<{ expectedEpisode?: string | null } | "invalid"> => {
  const body = (await readJson(req)) as { expectedEpisode?: string | null }
  if (body?.expectedEpisode !== undefined && body.expectedEpisode !== null && typeof body.expectedEpisode !== "string") {
    err(res, 400, "Validation", "expectedEpisode must be a string or null")
    return "invalid"
  }
  return body?.expectedEpisode !== undefined
    ? { expectedEpisode: body.expectedEpisode }
    : {}
}
