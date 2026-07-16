const MAX_LOG_BYTES = 64_000
const REDACT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /COOLIE_[A-Z_]+=\S+/g,
]

export interface RunLogBuffer {
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
}

export const redactRunLog = (chunk: string): string =>
  REDACT_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted]"), chunk)

export const appendRunLog = (previous: string, chunk: string): RunLogBuffer => {
  const next = redactRunLog(previous + chunk)
  const bytes = Buffer.byteLength(next, "utf8")
  if (bytes <= MAX_LOG_BYTES) return { text: next, bytes, truncated: false }
  const trimmed = next.slice(-MAX_LOG_BYTES)
  return {
    text: trimmed,
    bytes: Buffer.byteLength(trimmed, "utf8"),
    truncated: true,
  }
}

export const emptyRunLog = (): RunLogBuffer => ({ text: "", bytes: 0, truncated: false })
