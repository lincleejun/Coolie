import { describe, expect, it } from "vitest"
import { createAsyncLifecycle } from "../src/async-lifecycle"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("createAsyncLifecycle", () => {
  it("lets the StrictMode remount own final resources and stops every generation once", async () => {
    const first = deferred<() => void>()
    const second = deferred<() => void>()
    const stops = [0, 0]
    let starts = 0
    const lifecycle = createAsyncLifecycle(async (owner) => {
      const index = starts++
      const stop = await (index === 0 ? first.promise : second.promise)
      owner.own(stop)
    })

    const cleanupFirst = lifecycle.start()
    cleanupFirst()
    cleanupFirst()
    const cleanupSecond = lifecycle.start()

    first.resolve(() => { stops[0]! += 1 })
    await first.promise
    await Promise.resolve()
    expect(stops).toEqual([1, 0])

    second.resolve(() => { stops[1]! += 1 })
    await second.promise
    await Promise.resolve()
    expect(stops).toEqual([1, 0])

    cleanupSecond()
    cleanupSecond()
    expect(stops).toEqual([1, 1])
    expect(starts).toBe(2)
  })
})
