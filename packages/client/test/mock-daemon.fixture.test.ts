import { describe, it, expect, afterEach } from "vitest"
import { WebSocket } from "ws"
import {
  emptyStateScenario,
  offlineReplayScenario,
  parallelSafeScenario,
  runScenario,
} from "../e2e/tauri/fixtures/scenarios.js"
import { startMockDaemon } from "../e2e/tauri/fixtures/mock-daemon.js"

describe("mock daemon fixture", () => {
  let daemon: Awaited<ReturnType<typeof startMockDaemon>> | null = null

  afterEach(async () => {
    await daemon?.close()
    daemon = null
  })

  it("serves health/state and records requests", async () => {
    daemon = await startMockDaemon()
    const health = await fetch(`${daemon.baseUrl}/health`)
    expect(health.status).toBe(200)

    const state = await fetch(`${daemon.baseUrl}/state`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    })
    expect(state.status).toBe(200)

    const log = await fetch(`${daemon.baseUrl}/__test__/requests`)
    const body = await log.json() as Array<{ path: string }>
    expect(body.map((entry) => entry.path)).toEqual(["/health", "/state"])
  })

  it("emits SSE events and supports disconnect/restore", async () => {
    daemon = await startMockDaemon()
    const events: unknown[] = []
    const sse = await fetch(`${daemon.baseUrl}/events/stream?after=0`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    })
    expect(sse.status).toBe(200)
    const reader = sse.body!.getReader()
    const decoder = new TextDecoder()

    const readUntil = async (deadlineMs: number): Promise<void> => {
      const deadline = Date.now() + deadlineMs
      let buffer = ""
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: false }>((r) => setTimeout(() => r({ value: undefined, done: false }), 25)),
        ])
        if (done) break
        if (value) buffer += decoder.decode(value, { stream: true })
        for (const line of buffer.split("\n")) {
          if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)))
        }
        if (events.length > 0) return
      }
    }

    await readUntil(500)
    daemon.emitEvent({ type: "tab.created", workspaceId: "w1", payload: { tabId: "t1" } })
    await readUntil(500)
    expect(events).toHaveLength(1)

    daemon.disconnectSseClients()
    daemon.emitEvent({ type: "tab.status.changed", workspaceId: "w1", payload: { tabId: "t1", status: "idle" } })

    const replay = await fetch(`${daemon.baseUrl}/events/stream?after=1`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    })
    const replayReader = replay.body!.getReader()
    const replayEvents: unknown[] = []
    const { value } = await replayReader.read()
    if (value) {
      for (const line of decoder.decode(value).split("\n")) {
        if (line.startsWith("data: ")) replayEvents.push(JSON.parse(line.slice(6)))
      }
    }
    expect(replayEvents).toHaveLength(1)
    expect((replayEvents[0] as { type: string }).type).toBe("tab.status.changed")
  })

  it("blocks and restores SSE connections", async () => {
    daemon = await startMockDaemon()
    await fetch(`${daemon.baseUrl}/__test__/block-sse`, { method: "POST" })
    const blocked = await fetch(`${daemon.baseUrl}/events/stream?after=0`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    })
    expect(blocked.status).toBe(503)

    await fetch(`${daemon.baseUrl}/__test__/restore-sse`, { method: "POST" })
    const restored = await fetch(`${daemon.baseUrl}/events/stream?after=0`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    })
    expect(restored.status).toBe(200)
    restored.body?.cancel()
  })

  it("supports terminal text/binary/resize/exit over loopback WS", async () => {
    daemon = await startMockDaemon()
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${daemon!.baseUrl.replace("http", "ws")}/ws/terminal?workspace=w1&window=0&token=${daemon!.token}`)
      const messages: Array<{ binary: boolean; data: string }> = []
      ws.on("open", () => {
        ws.send("hello")
        ws.send(Buffer.from("bin", "latin1"))
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }))
      })
      ws.on("message", (data, isBinary) => {
        messages.push({ binary: isBinary, data: isBinary ? data.toString("latin1") : data.toString("utf8") })
        if (messages.length >= 3) {
          expect(messages[0]).toEqual({ binary: false, data: "echo:hello" })
          expect(messages[1]).toEqual({ binary: true, data: "bin" })
          expect(JSON.parse(messages[2]!.data)).toMatchObject({ type: "resize", cols: 80, rows: 24 })
          ws.close()
          resolve()
        }
      })
      ws.on("error", reject)
    })

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${daemon!.baseUrl.replace("http", "ws")}/ws/terminal?workspace=w1&window=1&token=${daemon!.token}`)
      ws.on("open", () => {
        void fetch(`${daemon!.baseUrl}/__test__/terminal/exit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace: "w1", window: 1, code: 42 }),
        })
      })
      ws.on("message", (data) => {
        expect(JSON.parse(data.toString("utf8"))).toEqual({ type: "exit", code: 42 })
        resolve()
      })
      ws.on("error", reject)
    })
  })

  it("runs scenarios in parallel without cross-talk", async () => {
    const a = await startMockDaemon({ token: "a" })
    const b = await startMockDaemon({ token: "b" })
    try {
      await runScenario(a, parallelSafeScenario("one"))
      await runScenario(b, parallelSafeScenario("two"))
      await runScenario(a, emptyStateScenario)
      await runScenario(b, offlineReplayScenario)
      expect(a.port).not.toBe(b.port)
      expect(a.requestLog()).toHaveLength(0)
      expect(b.requestLog()).toHaveLength(0)
    } finally {
      await a.close()
      await b.close()
    }
  })
})
