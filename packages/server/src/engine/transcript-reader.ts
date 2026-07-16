import * as fs from "node:fs"
import {
  buildTranscriptIdentity,
  decodeTranscriptCursor,
  encodeTranscriptCursor,
  TRANSCRIPT_DEFAULT_MAX_BYTES,
  TRANSCRIPT_DEFAULT_MAX_ENTRIES,
  type DecodedTranscriptCursor,
  type TranscriptEntry,
  type TranscriptPage,
  type TranscriptReader,
} from "@coolie/protocol"

export interface IncrementalTranscriptParser {
  parseLines(lines: readonly string[], startIndex: number): TranscriptEntry[]
}

const pageBytes = (entries: readonly TranscriptEntry[]): number =>
  Buffer.byteLength(JSON.stringify(entries), "utf8")

export const readIncrementalTranscript = (
  parser: IncrementalTranscriptParser,
  opts: {
    readonly sessionId: string
    readonly filePath: string
    readonly cursor?: string | null
    readonly maxEntries?: number
    readonly maxBytes?: number
  },
): TranscriptPage => {
  const maxEntries = opts.maxEntries ?? TRANSCRIPT_DEFAULT_MAX_ENTRIES
  const maxBytes = opts.maxBytes ?? TRANSCRIPT_DEFAULT_MAX_BYTES
  let stat: fs.Stats
  try {
    stat = fs.statSync(opts.filePath)
  } catch {
    return { capability: "available", reset: false, entries: [], cursor: null, truncated: false }
  }

  const identity = buildTranscriptIdentity(stat, opts.sessionId)
  let byteOffset = 0
  if (opts.cursor) {
    const decoded = decodeTranscriptCursor(opts.cursor, opts.sessionId)
    if (decoded === "invalid" || decoded === "tampered") {
      return { capability: "available", reset: true, entries: [], cursor: null, truncated: false }
    }
    if (decoded.identity !== identity) {
      return { capability: "available", reset: true, entries: [], cursor: null, truncated: false }
    }
    byteOffset = decoded.byteOffset
    if (byteOffset > stat.size) {
      return { capability: "available", reset: true, entries: [], cursor: null, truncated: false }
    }
  }

  const fd = fs.openSync(opts.filePath, "r")
  try {
    const chunk = Buffer.alloc(Math.max(0, stat.size - byteOffset))
    if (chunk.length > 0) fs.readSync(fd, chunk, 0, chunk.length, byteOffset)
    const text = chunk.toString("utf8")
    const lines = text.split("\n")
    const entries: TranscriptEntry[] = []
    let consumedBytes = 0
    let truncated = false
    let lineIndex = 0
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, "utf8") + (lineIndex < lines.length - 1 ? 1 : 0)
      if (line.trim() === "") {
        consumedBytes += lineBytes
        lineIndex += 1
        continue
      }
      const parsed = parser.parseLines([line], lineIndex)
      if (parsed.length === 0) {
        consumedBytes += lineBytes
        lineIndex += 1
        continue
      }
      const next = [...entries, ...parsed]
      if (next.length > maxEntries || pageBytes(next) > maxBytes) {
        truncated = true
        break
      }
      entries.push(...parsed)
      consumedBytes += lineBytes
      lineIndex += 1
    }

    const nextOffset = byteOffset + consumedBytes
    const nextCursor: DecodedTranscriptCursor = { identity, byteOffset: nextOffset, sessionId: opts.sessionId }
    return {
      capability: "available",
      reset: false,
      entries,
      cursor: nextOffset >= stat.size ? null : encodeTranscriptCursor(nextCursor),
      truncated,
    }
  } finally {
    fs.closeSync(fd)
  }
}

export const makeTranscriptReader = (
  engineId: string,
  parser: IncrementalTranscriptParser,
): TranscriptReader => ({
  engineId,
  capability: "available",
  read: (opts) => readIncrementalTranscript(parser, {
    sessionId: opts.sessionId,
    filePath: opts.filePath,
    ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  }),
})
