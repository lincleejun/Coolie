import * as fs from "node:fs"
import * as path from "node:path"
import type { TranscriptBlock, TranscriptEntry, TranscriptRole } from "@coolie/protocol"
import { makeTranscriptReader } from "../transcript-reader.js"
import { cachedRolloutPath, rememberRolloutPath } from "./rollout-cache.js"

/** 在 <home>/sessions/<YYYY>/<MM>/<DD>/rollout-*-<sessionId>.jsonl 日期树里 newest-first 反查
 * （codex.md §3：文件名内嵌 UUIDv7 即 session id，无法直接拼路径）。找不到 → 返回确定的
 * .missing 路径，让 mtime 轮询的 statMtimeMs 拿到 null 而安全跳过（绝不抛）。 */
export const codexTranscriptPath = (home: string, sessionId: string): string => {
  const cached = cachedRolloutPath(sessionId)
  if (cached) return cached
  const root = path.join(home, "sessions")
  const missing = path.join(root, `${sessionId}.missing`)
  const listDesc = (dir: string): string[] => {
    try { return fs.readdirSync(dir).sort((a, b) => b.localeCompare(a)) } catch { return [] }
  }
  for (const y of listDesc(root)) {
    const yd = path.join(root, y)
    for (const m of listDesc(yd)) {
      const md = path.join(yd, m)
      for (const d of listDesc(md)) {
        const dd = path.join(md, d)
        for (const f of listDesc(dd)) {
          if (f.startsWith("rollout-") && f.includes(sessionId) && f.endsWith(".jsonl")) {
            const resolved = path.join(dd, f)
            rememberRolloutPath(sessionId, resolved)
            return resolved
          }
        }
      }
    }
  }
  return missing
}

/** 合成 user 行（codex.md §3 kobe isSyntheticCodexUserRow）：repo instructions / environment
 * envelope 以 role:"user" 持久化但 live 流不重放，标题派生必须滤除。 */
const SYNTHETIC_MARKERS = ["<environment_context>", "<user_instructions>", "AGENTS.md", "<project_doc>"]
export const isSyntheticCodexUserText = (text: string): boolean =>
  SYNTHETIC_MARKERS.some((m) => text.includes(m))

const firstText = (content: unknown): string | null => {
  if (!Array.isArray(content)) return null
  for (const c of content) {
    const t = (c as any)?.text
    if (typeof t === "string" && t.trim() !== "") return t.trim()
  }
  return null
}

const roleFromPayload = (payload: any): TranscriptRole => {
  const role = payload?.role
  if (role === "user" || role === "assistant" || role === "system") return role
  return "unknown"
}

const blocksFromCodexPayload = (payload: any): TranscriptBlock[] => {
  if (!payload || typeof payload !== "object") {
    return [{ kind: "unknown", rawType: "payload", preview: JSON.stringify(payload).slice(0, 120) }]
  }
  if (payload.type === "message") {
    const text = firstText(payload.content)
    if (text !== null && !isSyntheticCodexUserText(text))
      return [{ kind: "text", text }]
    if (text !== null) return []
    return [{ kind: "unknown", rawType: "message", preview: JSON.stringify(payload).slice(0, 120) }]
  }
  if (payload.type === "function_call") {
    return [{
      kind: "tool-call",
      name: String(payload.name ?? "function"),
      callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
      argumentsJson: JSON.stringify(payload.arguments ?? {}),
    }]
  }
  if (payload.type === "function_call_output") {
    return [{
      kind: "tool-result",
      callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
      output: typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? ""),
    }]
  }
  return [{ kind: "unknown", rawType: String(payload.type ?? "item"), preview: JSON.stringify(payload).slice(0, 120) }]
}

/** Parse one Codex rollout JSONL row into a structured transcript entry (Task 2A.10). */
export const parseCodexTranscriptLine = (line: string, index: number): TranscriptEntry | null => {
  let row: any
  try { row = JSON.parse(line) } catch { return null }
  const rawType = typeof row?.type === "string" ? row.type : "unknown"
  if (rawType === "session_meta") return null
  if (rawType !== "response_item") {
    return {
      id: `codex-${index}`,
      role: "unknown",
      rawType,
      blocks: [{ kind: "unknown", rawType, preview: line.slice(0, 120) }],
    }
  }
  const payload = row?.payload
  const blocks = blocksFromCodexPayload(payload)
  if (blocks.length === 0) return null
  return {
    id: typeof payload?.id === "string" ? payload.id : `codex-${index}`,
    role: roleFromPayload(payload),
    rawType,
    blocks,
  }
}

export const codexTranscriptParser = {
  parseLines: (lines: readonly string[], startIndex: number): TranscriptEntry[] =>
    lines.flatMap((line, offset) => {
      const parsed = parseCodexTranscriptLine(line, startIndex + offset)
      return parsed ? [parsed] : []
    }),
}

export const codexTranscriptReader = makeTranscriptReader("codex", codexTranscriptParser)

/** 从 rollout JSONL 派生标题：session_meta.first_user_message 优先，否则首个非合成 user 文本。
 * 逐行 best-effort（codex.md §3：schema 无版本号，坏行跳过）。 */
export const codexDeriveTitle = (jsonl: string): string | null => {
  let fallback: string | null = null
  for (const line of jsonl.split("\n")) {
    const s = line.trim()
    if (s === "") continue
    let row: any
    try { row = JSON.parse(s) } catch { continue }
    const p = row?.payload
    if (row?.type === "session_meta" && typeof p?.first_user_message === "string" && p.first_user_message.trim() !== "")
      return p.first_user_message.trim()
    if (fallback === null && row?.type === "response_item" && p?.type === "message" && p?.role === "user") {
      const text = firstText(p.content)
      if (text !== null && !isSyntheticCodexUserText(text)) fallback = text
    }
  }
  return fallback
}
