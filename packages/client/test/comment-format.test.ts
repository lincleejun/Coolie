import { describe, expect, it } from "vitest"
import { formatLineComment } from "../src/rightpanel/comment.js"
import type { LineSelection } from "../src/rightpanel/DiffView.js"
import { t } from "../src/i18n/index.js"

const selection: LineSelection = {
  path: "src/a.ts",
  section: "unstaged",
  startIdx: 0,
  endIdx: 1,
  lines: [
    { kind: "del", text: "const x = 1", oldNo: 41, newNo: null },
    { kind: "add", text: "const x = 2", oldNo: null, newNo: 41 },
  ],
}

describe("formatLineComment", () => {
  it("includes file, section, line range, verbatim diff, and comment", () => {
    const output = formatLineComment(selection, "这里为什么改成 2？")
    expect(output).toContain("关于 `src/a.ts`")
    expect(output).toContain("未暂存")
    expect(output).toContain("第 41 行")
    expect(output).toContain("```diff")
    expect(output).toContain("-const x = 1")
    expect(output).toContain("+const x = 2")
    expect(output).toContain("这里为什么改成 2？")
  })

  it("formats a real multi-line range and allows an empty comment", () => {
    const ranged: LineSelection = {
      ...selection,
      lines: [
        { kind: "ctx", text: "a", oldNo: 10, newNo: 10 },
        { kind: "add", text: "b", oldNo: null, newNo: 11 },
      ],
    }
    expect(formatLineComment(ranged, "")).toContain("第 10–11 行")
    expect(formatLineComment(ranged, "")).toContain("```diff")
  })

  it("lengthens markdown fences around selected backticks", () => {
    const fenced: LineSelection = {
      path: "README.md",
      section: "againstBase",
      startIdx: 0,
      endIdx: 0,
      lines: [{ kind: "add", text: "```ts", oldNo: null, newNo: 7 }],
    }
    const output = formatLineComment(fenced, "看这里")
    expect(output.split("\n").find((line) => line.endsWith("diff"))).toBe("````diff")
    expect(output).toContain("\n````\n")
    expect(output).toContain("+```ts")
  })

  it("translates generated comment framing and line ranges", () => {
    const english = formatLineComment(selection, "Why?", (key) => t(key, "en"))
    const chinese = formatLineComment(selection, "为什么？", (key) => t(key, "zh"))
    expect(english).toContain("Regarding `src/a.ts` (unstaged) line 41:")
    expect(english).not.toMatch(/\p{Script=Han}/u)
    expect(chinese).toContain("关于 `src/a.ts`（未暂存）第 41 行：")
  })
})
