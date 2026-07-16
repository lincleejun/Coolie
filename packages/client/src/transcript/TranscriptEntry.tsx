import type { TranscriptBlock } from "@coolie/protocol"

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")

export const renderTranscriptBlock = (block: TranscriptBlock): string => {
  switch (block.kind) {
    case "text":
      return `<p class="transcript-text">${escapeHtml(block.text)}</p>`
    case "thinking":
      return `<pre class="transcript-thinking">${escapeHtml(block.text)}</pre>`
    case "tool-call":
      return `<div class="transcript-tool-call"><strong>${escapeHtml(block.name)}</strong><pre>${escapeHtml(block.argumentsJson ?? "{}")}</pre></div>`
    case "tool-result":
      return `<pre class="transcript-tool-result">${escapeHtml(block.output)}</pre>`
    case "image":
      return `<div class="transcript-image">${escapeHtml(block.description ?? block.mimeType ?? "image")}</div>`
    case "unknown":
      return `<div class="transcript-unknown">${escapeHtml(block.rawType)}${block.preview ? `: ${escapeHtml(block.preview)}` : ""}</div>`
    default:
      return ""
  }
}
