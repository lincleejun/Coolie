import { describe, it, expect, beforeEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { codexTranscriptPath, codexDeriveTitle } from "../src/engine/codex/transcript.js"

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cx-"))

describe("codexTranscriptPath", () => {
  it("按 UUID 在日期树里反查 rollout 文件", () => {
    const home = mkTmp()
    const sid = "019f4fe0-2fea-73f0-9453-171807d42083"
    const dir = path.join(home, "sessions", "2026", "07", "12")
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `rollout-2026-07-12T00-00-00-${sid}.jsonl`)
    fs.writeFileSync(f, "{}\n")
    expect(codexTranscriptPath(home, sid)).toBe(f)
  })
  it("找不到 → 返回确定的 .missing 路径（不抛）", () => {
    const home = mkTmp()
    expect(codexTranscriptPath(home, "nope")).toBe(path.join(home, "sessions", "nope.missing"))
  })
})

describe("codexDeriveTitle", () => {
  it("取首个非合成 user 消息；滤除 environment/AGENTS envelope", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "x", first_user_message: "修好登录 bug" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd=/x</environment_context>" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "真正的第一句" }] } }),
    ].join("\n")
    expect(codexDeriveTitle(lines)).toBe("修好登录 bug") // session_meta.first_user_message 优先
  })
  it("无 first_user_message 时退回首个非合成 user 文本", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "第二句才是人说的" }] } }),
    ].join("\n")
    expect(codexDeriveTitle(lines)).toBe("第二句才是人说的")
  })
  it("坏行宽容跳过、空转录返回 null", () => {
    expect(codexDeriveTitle("not json\n{bad")).toBeNull()
    expect(codexDeriveTitle("")).toBeNull()
  })
})
