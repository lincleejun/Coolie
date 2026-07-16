import { Schema } from "effect"

export const TRANSCRIPT_DEFAULT_MAX_ENTRIES = 50
export const TRANSCRIPT_DEFAULT_MAX_BYTES = 262_144

export const TranscriptRole = Schema.Literal("user", "assistant", "system", "unknown")
export type TranscriptRole = typeof TranscriptRole.Type

export const TranscriptBlockText = Schema.Struct({
  kind: Schema.Literal("text"),
  text: Schema.String,
})
export type TranscriptBlockText = typeof TranscriptBlockText.Type

export const TranscriptBlockThinking = Schema.Struct({
  kind: Schema.Literal("thinking"),
  text: Schema.String,
})
export type TranscriptBlockThinking = typeof TranscriptBlockThinking.Type

export const TranscriptBlockToolCall = Schema.Struct({
  kind: Schema.Literal("tool-call"),
  name: Schema.String,
  callId: Schema.optional(Schema.String),
  argumentsJson: Schema.optional(Schema.String),
})
export type TranscriptBlockToolCall = typeof TranscriptBlockToolCall.Type

export const TranscriptBlockToolResult = Schema.Struct({
  kind: Schema.Literal("tool-result"),
  callId: Schema.optional(Schema.String),
  output: Schema.String,
})
export type TranscriptBlockToolResult = typeof TranscriptBlockToolResult.Type

export const TranscriptBlockImage = Schema.Struct({
  kind: Schema.Literal("image"),
  mimeType: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
})
export type TranscriptBlockImage = typeof TranscriptBlockImage.Type

export const TranscriptBlockUnknown = Schema.Struct({
  kind: Schema.Literal("unknown"),
  rawType: Schema.String,
  preview: Schema.optional(Schema.String),
})
export type TranscriptBlockUnknown = typeof TranscriptBlockUnknown.Type

export const TranscriptBlock = Schema.Union(
  TranscriptBlockText,
  TranscriptBlockThinking,
  TranscriptBlockToolCall,
  TranscriptBlockToolResult,
  TranscriptBlockImage,
  TranscriptBlockUnknown,
)
export type TranscriptBlock = typeof TranscriptBlock.Type

export const TranscriptEntry = Schema.Struct({
  id: Schema.String,
  role: TranscriptRole,
  timestamp: Schema.optional(Schema.Number),
  turnId: Schema.optional(Schema.String),
  rawType: Schema.String,
  blocks: Schema.Array(TranscriptBlock),
})
export type TranscriptEntry = typeof TranscriptEntry.Type

export const TranscriptCapability = Schema.Literal("available", "unavailable")
export type TranscriptCapability = typeof TranscriptCapability.Type

export const TranscriptPage = Schema.Struct({
  capability: TranscriptCapability,
  reset: Schema.Boolean,
  entries: Schema.Array(TranscriptEntry),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
})
export type TranscriptPage = typeof TranscriptPage.Type

export interface DecodedTranscriptCursor {
  readonly identity: string
  readonly byteOffset: number
  readonly sessionId: string
}

export const buildTranscriptIdentity = (
  stat: { readonly size: number; readonly mtimeMs: number },
  sessionId: string,
): string => `${sessionId}:${stat.size}:${Math.floor(stat.mtimeMs)}`

export const encodeTranscriptCursor = (cursor: DecodedTranscriptCursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url")

export const decodeTranscriptCursor = (
  raw: string,
  sessionId: string,
): DecodedTranscriptCursor | "invalid" | "tampered" => {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<DecodedTranscriptCursor>
    if (typeof parsed.identity !== "string" || parsed.identity === "") return "invalid"
    if (typeof parsed.byteOffset !== "number" || !Number.isInteger(parsed.byteOffset) || parsed.byteOffset < 0)
      return "invalid"
    if (parsed.sessionId !== sessionId) return "tampered"
    return { identity: parsed.identity, byteOffset: parsed.byteOffset, sessionId }
  } catch {
    return "invalid"
  }
}

export const decodeTranscriptPage = (input: unknown): TranscriptPage => {
  const page = Schema.decodeUnknownSync(TranscriptPage)(input)
  for (const entry of page.entries) Schema.decodeUnknownSync(TranscriptEntry)(entry)
  return page
}

export const unavailableTranscriptPage = (): TranscriptPage => ({
  capability: "unavailable",
  reset: false,
  entries: [],
  cursor: null,
  truncated: false,
})

/** Engine-owned incremental transcript reader (Task 2A.7). */
export interface TranscriptReader {
  readonly engineId: string
  readonly capability: TranscriptCapability
  read(opts: {
    readonly home: string
    readonly cwd: string
    readonly sessionId: string
    readonly filePath: string
    readonly cursor?: string | null
    readonly maxEntries?: number
    readonly maxBytes?: number
  }): TranscriptPage
}
