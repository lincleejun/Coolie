import { describe, it, expect } from "vitest"
import { buildTree } from "../src/rightpanel/RightPanel.js"

describe("buildTree", () => {
  it("扁平路径 → 嵌套树（目录优先、字母序）", () => {
    const t = buildTree(["b.txt", "src/a.ts", "src/api/x.ts", "src/api/y.ts"])
    expect(t.children.map((c) => c.name)).toEqual(["src", "b.txt"])
    const src = t.children[0]!
    expect(src.children.map((c) => c.name)).toEqual(["api", "a.ts"])
    expect(src.children[0]!.children.map((c) => c.name)).toEqual(["x.ts", "y.ts"])
  })
  it("叶子带完整相对路径", () => {
    const t = buildTree(["src/api/x.ts"])
    expect(t.children[0]!.children[0]!.children[0]!.path).toBe("src/api/x.ts")
  })
})
