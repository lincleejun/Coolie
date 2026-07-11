export const toCsv = (columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string => {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n") + "\n"
}

export const toTable = (columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string => {
  const cell = (v: unknown): string => (v === null || v === undefined ? "" : String(v))
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)))
  const line = (vals: readonly string[]) =>
    vals.map((v, i) => (i === vals.length - 1 ? v : v.padEnd(widths[i]! + 2))).join("").trimEnd()
  return [line(columns), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join("\n") + "\n"
}
