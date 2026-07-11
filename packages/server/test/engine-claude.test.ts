import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { claudeEngine } from "../src/engine/claude/adapter.js"
import { discoverClaudeBinary } from "../src/engine/claude/binary.js"
import { encodeCwd, transcriptPath, deriveTitle, resumeArgs } from "../src/engine/claude/transcript.js"
import { EngineRegistryLive, EngineRegistry } from "../src/engine/registry.js"
import { Effect } from "effect"

afterEach(() => { delete process.env.COOLIE_CLAUDE_CMD; delete process.env.COOLIE_CLAUDE_BIN })

describe("claude identity/capabilities", () => {
  it("registry holds claude with expected capability bits", async () => {
    const reg = await Effect.runPromise(EngineRegistry.pipe(Effect.provide(EngineRegistryLive)))
    const e = reg.get("claude")!
    expect(e.displayName).toBe("Claude Code")
    expect(e.capabilities).toEqual({ nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: true, effort: false })
    expect(e.terminalTitle).toBe("engine-owned") // claude 自己管 OSC title（kobe: ownsStatus）
  })
  it("newSessionId is a fresh uuid each time", () => {
    const a = claudeEngine.newSessionId(); const b = claudeEngine.newSessionId()
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})

describe("launchCommand pipeline", () => {
  it("default: [bin, --session-id, id] (+ --model)", () => {
    const cmd = claudeEngine.launchCommand({ sessionId: "abc-123", model: "opus" })
    expect(cmd[0]!.endsWith("claude")).toBe(true)
    expect(cmd).toContain("--session-id")
    expect(cmd[cmd.indexOf("--session-id") + 1]).toBe("abc-123")
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("opus")
  })
  it("COOLIE_CLAUDE_CMD override is verbatim (no flags appended)", () => {
    process.env.COOLIE_CLAUDE_CMD = "cat"
    expect(claudeEngine.launchCommand({ sessionId: "abc" })).toEqual(["cat"])
  })
})

describe("binary discovery（opcode 路线，注入探针）", () => {
  it("COOLIE_CLAUDE_BIN wins when executable", () => {
    expect(discoverClaudeBinary({
      env: { COOLIE_CLAUDE_BIN: "/custom/claude" },
      probe: (p) => p === "/custom/claude",
      which: () => null,
    })).toBe("/custom/claude")
  })
  it("falls back which → standard candidates → null", () => {
    expect(discoverClaudeBinary({ env: {}, probe: () => false, which: () => "/from/which/claude" })).toBeNull()
    expect(discoverClaudeBinary({ env: {}, probe: (p) => p === "/from/which/claude", which: () => "/from/which/claude" }))
      .toBe("/from/which/claude")
    const local = path.join(os.homedir(), ".local", "bin", "claude")
    expect(discoverClaudeBinary({ env: {}, probe: (p) => p === local, which: () => null })).toBe(local)
  })
})

describe("historyReader（转录）", () => {
  it("encodeCwd folds every non-alphanumeric to '-'（实测 claude 编码）", () => {
    expect(encodeCwd("/Users/x/personal_ai/Coolie")).toBe("-Users-x-personal-ai-Coolie")
    expect(encodeCwd("/tmp/a.b")).toBe("-tmp-a-b")
  })
  it("transcriptPath = <home>/projects/<encoded>/<sessionId>.jsonl", () => {
    expect(transcriptPath("/h/.claude", "/tmp/ws", "s-1")).toBe("/h/.claude/projects/-tmp-ws/s-1.jsonl")
  })
  it("deriveTitle: first user message, string content", () => {
    const jsonl = [
      JSON.stringify({ type: "queue-operation", sessionId: "s" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Fix the login bug please" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "second message" } }),
    ].join("\n")
    expect(deriveTitle(jsonl)).toBe("Fix the login bug please")
  })
  it("deriveTitle: block-array content + command-tag stripping + 60-char cap", () => {
    const long = "x".repeat(80)
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `<command-name>/go</command-name> ${long}` }] } }),
    ].join("\n")
    const t = deriveTitle(jsonl)!
    expect(t.startsWith("x")).toBe(true)
    expect(t.length).toBe(60)
  })
  it("deriveTitle: empty/corrupt → null", () => {
    expect(deriveTitle("")).toBeNull()
    expect(deriveTitle("not-json\n{\"type\":\"summary\"}")).toBeNull()
  })
  it("resumeArgs", () => {
    expect(resumeArgs("s-9")).toEqual(["--resume", "s-9"])
  })
})

describe("turnDetector hook mapping（结构化状态唯一来源）", () => {
  it.each([
    ["UserPromptSubmit", "working"],
    ["PreToolUse", "working"],
    ["PostToolUse", "working"],
    ["Stop", "awaiting-input"],
    ["Notification", "awaiting-input"],
    ["SessionEnd", "idle"],
  ] as const)("%s → %s", (name, status) => {
    expect(claudeEngine.statusFromHookEvent({ hook_event_name: name })).toBe(status)
  })
  it("unknown/malformed → null", () => {
    expect(claudeEngine.statusFromHookEvent({ hook_event_name: "SubagentStop" })).toBeNull()
    expect(claudeEngine.statusFromHookEvent({})).toBeNull()
    expect(claudeEngine.statusFromHookEvent("garbage")).toBeNull()
  })
})
