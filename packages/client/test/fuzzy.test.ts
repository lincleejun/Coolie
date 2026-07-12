import { describe, it, expect } from "vitest"
import { fuzzyFilter, detectToken } from "../src/composer/fuzzy.js"

describe("fuzzyFilter", () => {
  const files = ["src/api/client.ts", "src/api/sse.ts", "packages/server/src/main.ts", "README.md"]
  it("subsequence 命中 + 连续匹配靠前", () => {
    const r = fuzzyFilter(files, "apicli")
    expect(r[0]).toBe("src/api/client.ts")
  })
  it("空 query 返回前 limit 条；无命中返回空", () => {
    expect(fuzzyFilter(files, "", 2)).toHaveLength(2)
    expect(fuzzyFilter(files, "zzzz")).toEqual([])
  })
  it("大小写不敏感", () => {
    expect(fuzzyFilter(files, "readme")).toContain("README.md")
  })
})

describe("detectToken", () => {
  it("@ 触发 file token（词起始处）", () => {
    expect(detectToken("看下 @src/ap", 10)).toEqual({ kind: "file", query: "src/ap", start: 3 })
  })
  it("行首 / 触发 command token；非行首 / 不触发", () => {
    expect(detectToken("/mod", 4)).toEqual({ kind: "command", query: "mod", start: 0 })
    expect(detectToken("a /mod", 6)).toBeNull()
  })
  it("token 中断（空格后）→ null；email 里的 @ 不触发", () => {
    expect(detectToken("@src ok", 7)).toBeNull()
    expect(detectToken("a@b", 3)).toBeNull()
  })
})
