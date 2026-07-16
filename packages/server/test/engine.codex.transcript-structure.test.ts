import { describe, expect, it, beforeEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  codexTranscriptPath,
  codexTranscriptParser,
  isSyntheticCodexUserText,
  parseCodexTranscriptLine,
} from "../src/engine/codex/transcript.js"
import { clearRolloutCache, rememberRolloutPath } from "../src/engine/codex/rollout-cache.js"
import { readIncrementalTranscript } from "../src/engine/transcript-reader.js"

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cx-structure-"))

describe("codex transcript structure (Task 2A.10)", () => {
  beforeEach(() => clearRolloutCache())

  it("filters synthetic user envelope rows", () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>cwd=/x</environment_context>" }],
      },
    })
    expect(parseCodexTranscriptLine(line, 0)).toBeNull()
    expect(isSyntheticCodexUserText("<user_instructions>hi</user_instructions>")).toBe(true)
  })

  it("maps function call/output pairs", () => {
    const call = parseCodexTranscriptLine(JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "Read", call_id: "c1", arguments: { path: "a.ts" } },
    }), 0)
    const output = parseCodexTranscriptLine(JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1", output: "ok" },
    }), 1)
    expect(call?.blocks[0]).toMatchObject({ kind: "tool-call", name: "Read", callId: "c1" })
    expect(output?.blocks[0]).toMatchObject({ kind: "tool-result", callId: "c1", output: "ok" })
  })

  it("uses bounded TTL cache for rollout path misses", () => {
    const home = mkTmp()
    const sid = "019f4fe0-2fea-73f0-9453-171807d42083"
    rememberRolloutPath(sid, path.join(home, "sessions", "cached.jsonl"))
    expect(codexTranscriptPath(home, sid)).toBe(path.join(home, "sessions", "cached.jsonl"))
    expect(codexTranscriptPath(home, "missing")).toBe(path.join(home, "sessions", "missing.missing"))
  })

  it("best-effort parses unknown rows without throwing", () => {
    const home = mkTmp()
    const file = path.join(home, "rollout.jsonl")
    fs.writeFileSync(file, [
      JSON.stringify({ type: "future_event", payload: { foo: 1 } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "input_text", text: "hello" }] },
      }),
      "not-json",
    ].join("\n") + "\n")
    const page = readIncrementalTranscript(codexTranscriptParser, {
      sessionId: "sid",
      filePath: file,
      maxEntries: 10,
    })
    expect(page.entries.some((entry) => entry.blocks.some((block) => block.kind === "text"))).toBe(true)
    expect(page.entries.some((entry) => entry.blocks.some((block) => block.kind === "unknown"))).toBe(true)
  })
})
