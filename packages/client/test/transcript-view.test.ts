import { describe, expect, it } from "vitest"
import type { TranscriptPage } from "@coolie/protocol"
import { mergeTranscriptPage, shouldOfferTranscript } from "../src/stores/transcript.js"
import { renderTranscriptBlock } from "../src/transcript/TranscriptEntry.js"

describe("transcript store (Task 2A.9)", () => {
  it("only offers transcript for engine tabs", () => {
    expect(shouldOfferTranscript("engine")).toBe(true)
    expect(shouldOfferTranscript("shell")).toBe(false)
    expect(shouldOfferTranscript("setup")).toBe(false)
  })

  it("merges incremental pages and resets on cursor replace", () => {
    const first: TranscriptPage = {
      capability: "available",
      reset: false,
      truncated: false,
      cursor: "c1",
      entries: [{ id: "e1", role: "user", rawType: "user", blocks: [{ kind: "text", text: "hi" }] }],
    }
    const merged = mergeTranscriptPage({
      entries: [],
      cursor: null,
      capability: "available",
      reset: false,
    }, first)
    expect(merged.entries).toHaveLength(1)
    const reset: TranscriptPage = {
      capability: "available",
      reset: true,
      truncated: false,
      cursor: null,
      entries: [{ id: "e2", role: "assistant", rawType: "assistant", blocks: [{ kind: "text", text: "ok" }] }],
    }
    expect(mergeTranscriptPage(merged, reset).entries.map((entry) => entry.id)).toEqual(["e2"])
  })

  it("escapes rendered transcript HTML", () => {
    const html = renderTranscriptBlock({ kind: "text", text: "<script>alert(1)</script>" })
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })
})
