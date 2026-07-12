import { describe, it, expect, beforeEach } from "vitest"
import {
  sessionKey,
  getOrCreateSession,
  disposeSession,
  disposeWorkspaceSessions,
  type TermSession,
} from "../src/terminal/session.js"

// 纯注册表逻辑（无真实 DOM/canvas）：用假 TermSession 工厂验证保活/复用/按 ws 回收。
const makeFake = (): TermSession & { disposed: boolean } => {
  const s: TermSession & { disposed: boolean } = {
    el: null as unknown as HTMLDivElement,
    term: null as unknown as TermSession["term"],
    state: "connecting",
    exitCode: null,
    disposed: false,
    mount() {},
    unmount() {},
    focus() {},
    reconnect() {},
    dispose() { s.disposed = true },
  }
  return s
}

// 每个测试用独立 key 前缀，注册表模块级单例不跨测串扰。
let n = 0
const freshWs = () => `ws-${++n}`

describe("terminal session registry", () => {
  it("sessionKey 拼接 wsId 与 window 索引", () => {
    expect(sessionKey("abc", 0)).toBe("abc:0")
    expect(sessionKey("abc", 3)).toBe("abc:3")
  })

  it("getOrCreateSession 首次调用 make，命中后复用同一实例（保活）", () => {
    const ws = freshWs()
    const key = sessionKey(ws, 0)
    let calls = 0
    const first = getOrCreateSession(key, () => { calls++; return makeFake() })
    const second = getOrCreateSession(key, () => { calls++; return makeFake() })
    expect(calls).toBe(1)
    expect(second).toBe(first)
    disposeSession(key)
  })

  it("disposeSession 调用 dispose 并从注册表移除（之后重建）", () => {
    const ws = freshWs()
    const key = sessionKey(ws, 0)
    const s = getOrCreateSession(key, makeFake) as ReturnType<typeof makeFake>
    disposeSession(key)
    expect(s.disposed).toBe(true)
    let remade = false
    getOrCreateSession(key, () => { remade = true; return makeFake() })
    expect(remade).toBe(true)
    disposeSession(key)
  })

  it("disposeWorkspaceSessions 只回收前缀匹配的会话，其它 ws 不受影响", () => {
    const wsA = freshWs()
    const wsB = freshWs()
    const a0 = getOrCreateSession(sessionKey(wsA, 0), makeFake) as ReturnType<typeof makeFake>
    const a1 = getOrCreateSession(sessionKey(wsA, 1), makeFake) as ReturnType<typeof makeFake>
    const b0 = getOrCreateSession(sessionKey(wsB, 0), makeFake) as ReturnType<typeof makeFake>

    disposeWorkspaceSessions(wsA)
    expect(a0.disposed).toBe(true)
    expect(a1.disposed).toBe(true)
    expect(b0.disposed).toBe(false)

    // wsA 全部移除：重新 get 会重建；wsB 仍复用原实例
    let rebuiltA = false
    getOrCreateSession(sessionKey(wsA, 0), () => { rebuiltA = true; return makeFake() })
    expect(rebuiltA).toBe(true)
    expect(getOrCreateSession(sessionKey(wsB, 0), makeFake)).toBe(b0)

    disposeSession(sessionKey(wsA, 0))
    disposeSession(sessionKey(wsB, 0))
  })

  it("前缀匹配精确到 'wsId:'，不误伤前缀相近的其它 ws", () => {
    const s1 = getOrCreateSession(sessionKey("proj", 0), makeFake) as ReturnType<typeof makeFake>
    const s2 = getOrCreateSession(sessionKey("proj-2", 0), makeFake) as ReturnType<typeof makeFake>
    disposeWorkspaceSessions("proj")
    expect(s1.disposed).toBe(true)
    expect(s2.disposed).toBe(false) // "proj-2:0" 不以 "proj:" 开头
    disposeSession(sessionKey("proj-2", 0))
  })
})
