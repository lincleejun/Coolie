import { describe, it, expect, vi, afterEach } from "vitest"
import { startEventStream } from "../src/api/sse.js"

afterEach(() => { vi.restoreAllMocks() })

describe("startEventStream role", () => {
  it("GUI 连接 URL 带 &role=gui（持 Plan-4 server lease）", async () => {
    const urls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url)
      throw new Error("stop") // 立刻断开：只关心 URL 构造
    })
    vi.stubGlobal("fetch", fetchMock)
    const stop = startEventStream({
      after: 0,
      role: "gui",
      getInfo: async () => ({ port: 7777, token: "T" }),
      onEvent: () => {},
      onStatus: () => {},
    })
    await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0))
    stop()
    expect(urls[0]).toContain("/events/stream?after=0")
    expect(urls[0]).toContain("role=gui")
  })
})
