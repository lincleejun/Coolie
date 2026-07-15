import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTerminalSocketController } from "../src/terminal/socket.js"

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = MockWebSocket.CONNECTING
  binaryType: BinaryType = "blob"
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  closeCalls = 0
  readonly sent: unknown[] = []

  constructor(url: string) {
    this.url = url
  }

  close(): void {
    this.closeCalls++
    this.readyState = MockWebSocket.CLOSING
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event("open"))
  }

  message(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  finishClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new Event("close") as CloseEvent)
  }
}

describe("terminal WebSocket reconnect", () => {
  const sockets: MockWebSocket[] = []

  beforeEach(() => {
    sockets.length = 0
    vi.stubGlobal("WebSocket", MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("waits for the old generation to close before creating a replacement", async () => {
    const controller = createTerminalSocketController(
      () => "ws://terminal",
      { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() },
      (url) => {
        const socket = new MockWebSocket(url)
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    )
    controller.connect()
    sockets[0]!.open()

    const reconnecting = controller.reconnect()
    expect(sockets[0]!.closeCalls).toBe(1)
    expect(sockets).toHaveLength(1)

    sockets[0]!.finishClose()
    await reconnecting

    expect(sockets).toHaveLength(2)
    expect(sockets.filter((socket) => socket.readyState !== MockWebSocket.CLOSED)).toHaveLength(1)
  })

  it("ignores late messages and close state from an isolated generation", async () => {
    const messages: unknown[] = []
    const states: string[] = []
    const controller = createTerminalSocketController(
      () => "ws://terminal",
      {
        onOpen: () => { states.push("open") },
        onMessage: (event) => { messages.push(event.data) },
        onClose: () => { states.push("dead") },
      },
      (url) => {
        const socket = new MockWebSocket(url)
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    )
    controller.connect()
    sockets[0]!.open()

    const reconnecting = controller.reconnect()
    sockets[0]!.message("stale-before-close")
    sockets[0]!.finishClose()
    await reconnecting
    sockets[0]!.message("stale-after-close")
    sockets[1]!.open()
    sockets[1]!.message("current")

    expect(messages).toEqual(["current"])
    expect(states).toEqual(["open", "open"])
  })

  it("coalesces repeated reconnect requests into one replacement", async () => {
    const controller = createTerminalSocketController(
      () => "ws://terminal",
      { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() },
      (url) => {
        const socket = new MockWebSocket(url)
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    )
    controller.connect()

    const first = controller.reconnect()
    const second = controller.reconnect()
    expect(second).toBe(first)
    expect(sockets[0]!.closeCalls).toBe(1)

    sockets[0]!.finishClose()
    await first
    expect(sockets).toHaveLength(2)
  })
})
