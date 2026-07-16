import { describe, expect, it } from "vitest"
import {
  buildTranscriptIdentity,
  decodeTranscriptCursor,
  decodeTranscriptPage,
  encodeTranscriptCursor,
  unavailableTranscriptPage,
} from "../src/transcript.js"

describe("transcript protocol (Task 2A.7)", () => {
  it("decodes transcript page union blocks", () => {
    const page = decodeTranscriptPage({
      capability: "available",
      reset: false,
      entries: [{
        id: "e1",
        role: "assistant",
        rawType: "assistant",
        blocks: [
          { kind: "text", text: "hello" },
          { kind: "tool-call", name: "Read", callId: "c1", argumentsJson: "{}" },
          { kind: "unknown", rawType: "future", preview: "..." },
        ],
      }],
      cursor: null,
      truncated: false,
    })
    expect(page.entries[0]!.blocks).toHaveLength(3)
  })

  it("round-trips opaque byte cursor and detects tamper", () => {
    const encoded = encodeTranscriptCursor({ identity: "sid:10:100", byteOffset: 42, sessionId: "sid" })
    expect(decodeTranscriptCursor(encoded, "sid")).toEqual({
      identity: "sid:10:100",
      byteOffset: 42,
      sessionId: "sid",
    })
    expect(decodeTranscriptCursor(encoded, "other")).toBe("tampered")
    expect(decodeTranscriptCursor("not-base64", "sid")).toBe("invalid")
  })

  it("builds stable file identity from stat metadata", () => {
    expect(buildTranscriptIdentity({ size: 128, mtimeMs: 1000.9 }, "s-1")).toBe("s-1:128:1000")
  })

  it("returns capability unavailable baseline", () => {
    expect(unavailableTranscriptPage()).toEqual({
      capability: "unavailable",
      reset: false,
      entries: [],
      cursor: null,
      truncated: false,
    })
  })
})
