import { describe, it, expect } from "vitest"
import { makeDrafts } from "../src/composer/drafts.js"

const memStorage = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe("makeDrafts", () => {
  it("per-workspace 隔离存取", () => {
    const d = makeDrafts(memStorage())
    d.save("A", "draft-a"); d.save("B", "draft-b")
    expect(d.load("A")).toBe("draft-a")
    expect(d.load("B")).toBe("draft-b")
  })
  it("外部追加后 load 取到最新（T14 右栏 @注入 → focusNonce 重载依赖此约定）", () => {
    const d = makeDrafts(memStorage())
    d.save("W", "看下 ")
    d.save("W", d.load("W") + "@src/api/client.ts ")
    expect(d.load("W")).toBe("看下 @src/api/client.ts ")
  })
  it("未存过 → 空串；clear 后 → 空串", () => {
    const d = makeDrafts(memStorage())
    expect(d.load("X")).toBe("")
    d.save("X", "temp"); d.clear("X")
    expect(d.load("X")).toBe("")
  })
})
