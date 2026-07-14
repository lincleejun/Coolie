/** Pure unified-diff parser used by the browser UI and node tests. */
export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta"
export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const isMetadata = (line: string): boolean =>
  line.startsWith("diff ") ||
  line.startsWith("index ") ||
  line.startsWith("--- ") ||
  line.startsWith("+++ ") ||
  line.startsWith("new file") ||
  line.startsWith("deleted file") ||
  line.startsWith("old mode") ||
  line.startsWith("new mode") ||
  line.startsWith("similarity ") ||
  line.startsWith("dissimilarity ") ||
  line.startsWith("rename ") ||
  line.startsWith("copy ") ||
  line.startsWith("Binary files") ||
  line.startsWith("GIT binary patch")

export const parseUnifiedDiff = (unified: string): DiffLine[] => {
  if (unified === "") return []
  const lines = unified.endsWith("\n") ? unified.slice(0, -1).split("\n") : unified.split("\n")
  const parsed: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false

  for (const raw of lines) {
    const hunk = HUNK_RE.exec(raw)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      parsed.push({ kind: "hunk", text: raw, oldNo: null, newNo: null })
      continue
    }
    if (!inHunk || isMetadata(raw) || raw.startsWith("\\")) {
      parsed.push({ kind: "meta", text: raw, oldNo: null, newNo: null })
      continue
    }
    if (raw.startsWith("+")) {
      parsed.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo })
      newNo++
    } else if (raw.startsWith("-")) {
      parsed.push({ kind: "del", text: raw.slice(1), oldNo, newNo: null })
      oldNo++
    } else {
      parsed.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo, newNo })
      oldNo++
      newNo++
    }
  }
  return parsed
}
