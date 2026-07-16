import * as path from "node:path"
import type { TranscriptBlock, TranscriptEntry, TranscriptRole } from "@coolie/protocol"
import { makeTranscriptReader } from "../transcript-reader.js"

/** claude 转录目录编码：cwd 每个非字母数字字符折叠为 '-'（本机实测：/a/b_c.d → -a-b-c-d）。 */
export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-")

export const transcriptPath = (home: string, cwd: string, sessionId: string): string =>
  path.join(home, "projects", encodeCwd(cwd), `${sessionId}.jsonl`)

const roleFromMessage = (message: any): TranscriptRole => {
  const role = message?.role
  if (role === "user" || role === "assistant" || role === "system") return role
  return "unknown"
}

const blocksFromContent = (content: unknown): TranscriptBlock[] => {
  if (typeof content === "string") return content.trim() === "" ? [] : [{ kind: "text", text: content }]
  if (!Array.isArray(content)) return [{ kind: "unknown", rawType: "content", preview: String(content ?? "") }]
  const blocks: TranscriptBlock[] = []
  for (const block of content) {
    const type = (block as any)?.type
    if (type === "text") {
      const text = String((block as any)?.text ?? "")
      if (text !== "") blocks.push({ kind: "text", text })
      continue
    }
    if (type === "thinking") {
      blocks.push({ kind: "thinking", text: String((block as any)?.thinking ?? (block as any)?.text ?? "") })
      continue
    }
    if (type === "tool_use") {
      blocks.push({
        kind: "tool-call",
        name: String((block as any)?.name ?? "tool"),
        callId: typeof (block as any)?.id === "string" ? (block as any).id : undefined,
        argumentsJson: JSON.stringify((block as any)?.input ?? {}),
      })
      continue
    }
    if (type === "tool_result") {
      const output = typeof (block as any)?.content === "string"
        ? (block as any).content
        : JSON.stringify((block as any)?.content ?? "")
      blocks.push({
        kind: "tool-result",
        callId: typeof (block as any)?.tool_use_id === "string" ? (block as any).tool_use_id : undefined,
        output,
      })
      continue
    }
    if (type === "image") {
      blocks.push({
        kind: "image",
        mimeType: typeof (block as any)?.source?.media_type === "string" ? (block as any).source.media_type : undefined,
        description: typeof (block as any)?.source?.data === "string" ? "image" : undefined,
      })
      continue
    }
    blocks.push({ kind: "unknown", rawType: String(type ?? "block"), preview: JSON.stringify(block).slice(0, 120) })
  }
  return blocks
}

/** Parse one Claude JSONL row into a structured transcript entry (Task 2A.8). */
export const parseClaudeTranscriptLine = (line: string, index: number): TranscriptEntry | null => {
  let row: any
  try { row = JSON.parse(line) } catch { return null }
  const rawType = typeof row?.type === "string" ? row.type : "unknown"
  if (rawType === "queue-operation") return null
  const message = row?.message
  if (!message || typeof message !== "object") {
    return {
      id: `claude-${index}`,
      role: "unknown",
      rawType,
      blocks: [{ kind: "unknown", rawType, preview: line.slice(0, 120) }],
    }
  }
  const blocks = blocksFromContent(message.content)
  if (blocks.length === 0) return null
  const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : undefined
  return {
    id: typeof row.uuid === "string" ? row.uuid : `claude-${index}`,
    role: roleFromMessage(message),
    ...(Number.isFinite(timestamp) ? { timestamp } : {}),
    ...(typeof row.sessionId === "string" ? { turnId: row.sessionId } : {}),
    rawType,
    blocks,
  }
}

export const claudeTranscriptParser = {
  parseLines: (lines: readonly string[], startIndex: number): TranscriptEntry[] =>
    lines.flatMap((line, offset) => {
      const parsed = parseClaudeTranscriptLine(line, startIndex + offset)
      return parsed ? [parsed] : []
    }),
}

export const claudeTranscriptReader = makeTranscriptReader("claude", claudeTranscriptParser)

/** 派生标题：首条 type=user 的 message.content（string 或 text blocks），剥 <tag>…</tag>，60 字截断。 */
export const deriveTitle = (jsonl: string): string | null => {
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type !== "user") continue
    const content = obj?.message?.content
    let text = ""
    if (typeof content === "string") text = content
    else if (Array.isArray(content)) text = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join(" ")
    text = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    if (text === "") continue
    return text.length > 60 ? text.slice(0, 60) : text
  }
  return null
}

export const resumeArgs = (sessionId: string): string[] => ["--resume", sessionId]
