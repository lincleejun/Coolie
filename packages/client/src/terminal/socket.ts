export interface TerminalSocketHandlers {
  readonly onOpen: () => void
  readonly onMessage: (event: MessageEvent) => void
  readonly onClose: () => void
}

export interface TerminalSocketController {
  connect(): void
  reconnect(): Promise<void>
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void
  dispose(): void
}

type SocketFactory = (url: string) => WebSocket

interface SocketGeneration {
  readonly socket: WebSocket
  readonly generation: number
  readonly closed: Promise<void>
  resolveClosed(): void
}

/**
 * Owns exactly one terminal WebSocket generation. Replacements first isolate and
 * close the old generation, then wait for its close event before opening the next.
 */
export const createTerminalSocketController = (
  getUrl: () => string,
  handlers: TerminalSocketHandlers,
  makeSocket: SocketFactory = (target) => new WebSocket(target),
): TerminalSocketController => {
  let current: SocketGeneration | null = null
  let generation = 0
  let reconnecting: Promise<void> | null = null
  let disposed = false

  const openSocket = (): void => {
    if (disposed || current) return

    const socket = makeSocket(getUrl())
    let resolveClosed!: () => void
    const record: SocketGeneration = {
      socket,
      generation: ++generation,
      closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
      resolveClosed,
    }
    current = record
    socket.binaryType = "arraybuffer"
    socket.onopen = () => {
      if (current === record && record.generation === generation) handlers.onOpen()
    }
    socket.onmessage = (event) => {
      if (current === record && record.generation === generation) handlers.onMessage(event)
    }
    socket.onclose = () => {
      record.resolveClosed()
      if (current !== record || record.generation !== generation) return
      current = null
      handlers.onClose()
    }
  }

  const closeGeneration = async (record: SocketGeneration): Promise<void> => {
    if (record.socket.readyState === WebSocket.CLOSED) {
      record.resolveClosed()
      return
    }
    try {
      record.socket.close()
    } catch {
      if (record.socket.readyState === WebSocket.CLOSED) record.resolveClosed()
      else throw new Error("failed to close terminal WebSocket")
    }
    await record.closed
  }

  const reconnect = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (reconnecting) return reconnecting

    const operation = (async () => {
      const previous = current
      if (previous) {
        current = null
        generation++
        await closeGeneration(previous)
      }
      if (!disposed) openSocket()
    })()
    reconnecting = operation.finally(() => { reconnecting = null })
    return reconnecting
  }

  return {
    connect: openSocket,
    reconnect,
    send(data) {
      if (current?.socket.readyState === WebSocket.OPEN) current.socket.send(data)
    },
    dispose() {
      disposed = true
      generation++
      const previous = current
      current = null
      if (previous) void closeGeneration(previous).catch(() => {})
    },
  }
}
