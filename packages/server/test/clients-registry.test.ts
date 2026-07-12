import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeClientRegistry } from "../src/daemon/clients.js"

describe("ClientRegistry（role 化 refcount 惰性退出）", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("最后一个 gui 断开 → 布防；grace 届满触发 onIdleExpired 恰好一次", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 1000, onIdleExpired: fired })
    const a = reg.register("gui")
    expect(reg.guiCount()).toBe(1)
    expect(reg.idleExitArmed()).toBe(false)
    reg.release(a.id)
    expect(reg.idleExitArmed()).toBe(true)
    vi.advanceTimersByTime(999)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledTimes(1)
    expect(reg.idleExitArmed()).toBe(false)
  })

  it("宽限期内 gui 回归 → 取消退出", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 1000, onIdleExpired: fired })
    reg.release(reg.register("gui").id)
    expect(reg.idleExitArmed()).toBe(true)
    reg.register("gui") // 回来了
    expect(reg.idleExitArmed()).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(fired).not.toHaveBeenCalled()
  })

  it("terminal/cli 不持有：注册与断开都不布防", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 100, onIdleExpired: fired })
    reg.release(reg.register("terminal").id)
    reg.release(reg.register("cli").id)
    expect(reg.idleExitArmed()).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(fired).not.toHaveBeenCalled()
  })

  it("从未有过 gui 持有者 → 永不布防（CLI 拉起的 server 驻留到显式 stop）", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 100, onIdleExpired: fired })
    vi.advanceTimersByTime(60_000)
    expect(fired).not.toHaveBeenCalled()
    expect(reg.idleExitArmed()).toBe(false)
  })

  it("多个 gui：只有最后一个断开才布防", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 1000, onIdleExpired: fired })
    const a = reg.register("gui"); const b = reg.register("gui")
    reg.release(a.id)
    expect(reg.idleExitArmed()).toBe(false) // 还剩 b
    reg.release(b.id)
    expect(reg.idleExitArmed()).toBe(true)
  })

  it("已触发过一次后不再重复触发（shutdown 已在路上）", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 100, onIdleExpired: fired })
    reg.release(reg.register("gui").id)
    vi.advanceTimersByTime(100)
    reg.release(reg.register("gui").id) // 触发后又来了一轮
    vi.advanceTimersByTime(1000)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it("release 未知 id 为 no-op；list/guiCount 反映当前连接；graceMs 暴露", () => {
    const reg = makeClientRegistry({ graceMs: 777, onIdleExpired: () => {} })
    reg.release("nope")
    const g = reg.register("gui", "tauri-main")
    const t = reg.register("terminal")
    expect(reg.list().map((c) => c.role).sort()).toEqual(["gui", "terminal"])
    expect(reg.list().find((c) => c.id === g.id)?.label).toBe("tauri-main")
    expect(reg.list().find((c) => c.id === t.id)?.label).toBe(null)
    expect(reg.guiCount()).toBe(1)
    expect(reg.graceMs).toBe(777)
  })
})
