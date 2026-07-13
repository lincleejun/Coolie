import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useData } from "../src/stores/data.js"

const fakeApi = (queue: any[]) => ({
  info: { port: 1, token: "t", pid: 1 },
  req: vi.fn(async (method: string, path: string) => {
    if (method === "GET" && path.endsWith("/queue")) return { queue }
    return {}
  }),
  wsTerminalUrl: () => "",
})

describe("data store server prompt queue", () => {
  beforeEach(() => useData.setState({ queuedByWs: {} } as any))
  afterEach(() => vi.unstubAllGlobals())

  it("refreshes the real server queue", async () => {
    const api = fakeApi([{ id: 3, text: "一", position: 1 }])
    useData.getState().setApi(api as any)
    await useData.getState().refreshQueue("w1")
    expect(useData.getState().queuedByWs["w1"]).toEqual([{ id: 3, text: "一", position: 1 }])
  })

  it("refreshes on all durable queue mutation events", async () => {
    const api = fakeApi([])
    useData.getState().setApi(api as any)
    for (const type of ["prompt.queued", "prompt.delivered", "prompt.withdrawn"])
      useData.getState().applyEvent({ seq: 1, workspaceId: "w1", type, payload: {}, ts: 1 } as any)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.req.mock.calls.filter(([method, path]) => method === "GET" && path.endsWith("/queue"))).toHaveLength(3)
  })

  it("withdraws through DELETE and refreshes", async () => {
    const api = fakeApi([])
    useData.getState().setApi(api as any)
    await useData.getState().withdrawQueued("w1", 5)
    expect(api.req).toHaveBeenCalledWith("DELETE", "/workspaces/w1/queue/5")
    expect(api.req).toHaveBeenCalledWith("GET", "/workspaces/w1/queue")
  })

  it("treats HTTP 202 enqueue as a successful send", async () => {
    const api = fakeApi([])
    useData.getState().setApi(api as any)
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ queued: true, id: 8, position: 1 }),
      { status: 202, headers: { "content-type": "application/json" } },
    )))
    await expect(useData.getState().sendInput("w1", { text: "排队", mode: "send", skipStable: false })).resolves.toBeUndefined()
    expect(useData.getState().pendingSends).toHaveLength(0)
  })
})
