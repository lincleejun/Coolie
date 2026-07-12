import { describe, it, expect } from "vitest"
import { SseParser, backoffDelay } from "../src/api/sse.js"

describe("SseParser", () => {
  it("解析完整事件", () => {
    const p = new SseParser()
    const evs = p.feed('id: 7\ndata: {"seq":7,"type":"tab.status.changed","workspaceId":"W","payload":{},"ts":1}\n\n')
    expect(evs).toHaveLength(1)
    expect(evs[0]!.seq).toBe(7)
    expect(evs[0]!.type).toBe("tab.status.changed")
  })
  it("跨 chunk 拼接：半个事件不吐、补齐后吐", () => {
    const p = new SseParser()
    expect(p.feed('id: 1\ndata: {"seq":1,')).toHaveLength(0)
    const evs = p.feed('"type":"x","workspaceId":null,"payload":{},"ts":0}\n\n')
    expect(evs).toHaveLength(1)
  })
  it("心跳/注释块（:hb、:ok）与坏 JSON 跳过不抛", () => {
    const p = new SseParser()
    expect(p.feed(":ok\n\n:hb\n\n")).toHaveLength(0)
    expect(p.feed("data: {broken\n\n")).toHaveLength(0)
  })
  it("一个 chunk 多事件", () => {
    const p = new SseParser()
    const two = 'data: {"seq":1,"type":"a","workspaceId":null,"payload":{},"ts":0}\n\n' +
      'data: {"seq":2,"type":"b","workspaceId":null,"payload":{},"ts":0}\n\n'
    expect(p.feed(two).map((e) => e.seq)).toEqual([1, 2])
  })
})

describe("backoffDelay", () => {
  it("500 → 1000 → 2000 → … 封顶 8000", () => {
    expect(backoffDelay(0)).toBe(500)
    expect(backoffDelay(1)).toBe(1000)
    expect(backoffDelay(4)).toBe(8000)
    expect(backoffDelay(10)).toBe(8000)
  })
})
