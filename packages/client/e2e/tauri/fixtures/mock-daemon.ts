import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { WebSocketServer, WebSocket } from "ws"
import type { AddressInfo } from "node:net"
import type { CoolieEvent } from "@coolie/protocol"

export type MockEmitEvent = Omit<CoolieEvent, "seq" | "ts"> & { seq?: number; ts?: number }

export interface MockDaemonControl {
  readonly port: number
  readonly token: string
  readonly baseUrl: string
  readonly serverInfo: string
  readonly emitEvent: (event: MockEmitEvent) => CoolieEvent
  readonly disconnectSseClients: () => void
  readonly restoreSse: () => void
  readonly requestLog: () => readonly { method: string; path: string; at: number }[]
  readonly reset: () => void
  readonly close: () => Promise<void>
}

interface SseClient {
  readonly res: ServerResponse
  readonly workspaceId?: string
  lastSent: number
}

interface TerminalSession {
  readonly ws: WebSocket
  cols: number
  rows: number
}

const emptySnapshot = (asOfSeq: number) => ({
  asOfSeq,
  generatedAt: Date.now(),
  scope: null,
  projects: [],
  workspaces: [],
  tabs: [],
  openAttention: [],
  queuedPrompts: [],
  activeRuns: [],
})

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

const sendSseEvent = (client: SseClient, event: CoolieEvent): void => {
  if (client.res.destroyed || client.res.writableEnded) return
  if (event.seq <= client.lastSent) return
  if (client.workspaceId && event.workspaceId !== client.workspaceId) return
  client.res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
  client.lastSent = event.seq
}

export const startMockDaemon = async (opts?: { token?: string }): Promise<MockDaemonControl> => {
  const token = opts?.token ?? "mock-token"
  let seq = 0
  let sseBlocked = false
  const events: CoolieEvent[] = []
  const requests: Array<{ method: string; path: string; at: number }> = []
  const sseClients = new Set<SseClient>()
  const terminals = new Map<string, TerminalSession>()

  const logRequest = (req: IncomingMessage): void => {
    const url = new URL(req.url ?? "/", "http://local")
    if (url.pathname.startsWith("/__test__")) return
    requests.push({ method: req.method ?? "GET", path: url.pathname, at: Date.now() })
  }

  const broadcast = (event: CoolieEvent): void => {
    for (const client of sseClients) sendSseEvent(client, event)
  }

  const server = createServer(async (req, res) => {
    logRequest(req)
    const url = new URL(req.url ?? "/", "http://local")
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "")
    const needsAuth = !url.pathname.startsWith("/__test__") && url.pathname !== "/health"
    if (needsAuth && auth !== token) return json(res, 401, { error: "unauthorized" })

    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true })
    if (req.method === "GET" && url.pathname === "/config")
      return json(res, 200, { tmuxSocket: "coolie-mock", engines: [], namePools: {} })
    if (req.method === "GET" && url.pathname === "/state")
      return json(res, 200, emptySnapshot(seq))
    if (req.method === "GET" && url.pathname === "/events/stream") {
      if (sseBlocked) { res.writeHead(503).end(); return }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      res.write(":ok\n\n")
      const after = Number(url.searchParams.get("after") ?? "0")
      const client: SseClient = {
        res,
        lastSent: after,
        ...(url.searchParams.get("workspace") ? { workspaceId: url.searchParams.get("workspace")! } : {}),
      }
      sseClients.add(client)
      req.on("close", () => sseClients.delete(client))
      for (const event of events) {
        if (event.seq > after) sendSseEvent(client, event)
      }
      return
    }

    if (req.method === "POST" && url.pathname === "/__test__/emit") {
      const body = JSON.parse(await readBody(req)) as MockEmitEvent
      const event: CoolieEvent = {
        seq: body.seq ?? ++seq,
        workspaceId: body.workspaceId ?? null,
        type: body.type,
        payload: body.payload,
        ts: body.ts ?? Date.now(),
      }
      if (event.seq > seq) seq = event.seq
      events.push(event)
      broadcast(event)
      return json(res, 200, event)
    }
    if (req.method === "POST" && url.pathname === "/__test__/disconnect-sse") {
      for (const client of sseClients) client.res.end()
      sseClients.clear()
      return json(res, 204, null)
    }
    if (req.method === "POST" && url.pathname === "/__test__/restore-sse") {
      sseBlocked = false
      return json(res, 204, null)
    }
    if (req.method === "POST" && url.pathname === "/__test__/block-sse") {
      sseBlocked = true
      return json(res, 204, null)
    }
    if (req.method === "POST" && url.pathname === "/__test__/terminal/exit") {
      const body = JSON.parse(await readBody(req)) as { workspace?: string; window?: number; code?: number }
      const key = `${body.workspace ?? "unknown"}:${body.window ?? 0}`
      const session = terminals.get(key)
      if (session && session.ws.readyState === WebSocket.OPEN) {
        const code = body.code ?? 0
        session.ws.send(JSON.stringify({ type: "exit", code }))
        session.ws.close(1000, "mock exit")
      }
      return json(res, 204, null)
    }
    if (req.method === "GET" && url.pathname === "/__test__/requests")
      return json(res, 200, requests)
    if (req.method === "POST" && url.pathname === "/__test__/reset") {
      events.length = 0
      requests.length = 0
      seq = 0
      sseBlocked = false
      return json(res, 204, null)
    }

    json(res, 404, { error: "not found" })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://local")
    if (url.pathname !== "/ws/terminal") { socket.destroy(); return }
    const auth = url.searchParams.get("token") ?? ""
    if (auth !== token) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const key = `${url.searchParams.get("workspace") ?? "unknown"}:${url.searchParams.get("window") ?? "0"}`
      const session: TerminalSession = {
        ws,
        cols: Number(url.searchParams.get("cols") ?? "120"),
        rows: Number(url.searchParams.get("rows") ?? "32"),
      }
      terminals.set(key, session)

      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          ws.send(data, { binary: true })
          return
        }
        const text = data.toString("utf8")
        try {
          const msg = JSON.parse(text) as { type?: string; cols?: number; rows?: number }
          if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
            session.cols = msg.cols!
            session.rows = msg.rows!
            ws.send(JSON.stringify({ type: "resize", cols: session.cols, rows: session.rows }))
          }
        } catch {
          ws.send(Buffer.from(`echo:${text}`, "utf8"), { binary: false })
        }
      })

      ws.on("close", () => { terminals.delete(key) })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    serverInfo: JSON.stringify({ port, token, pid: process.pid }),
    emitEvent: (event) => {
      const stored: CoolieEvent = {
        seq: event.seq ?? ++seq,
        workspaceId: event.workspaceId ?? null,
        type: event.type,
        payload: event.payload,
        ts: event.ts ?? Date.now(),
      }
      if (stored.seq > seq) seq = stored.seq
      events.push(stored)
      broadcast(stored)
      return stored
    },
    disconnectSseClients: () => {
      for (const client of sseClients) client.res.end()
      sseClients.clear()
    },
    restoreSse: () => { sseBlocked = false },
    requestLog: () => requests,
    reset: () => {
      events.length = 0
      requests.length = 0
      seq = 0
      sseBlocked = false
    },
    close: () => new Promise((resolve, reject) => {
      for (const client of sseClients) client.res.end()
      sseClients.clear()
      for (const session of terminals.values()) session.ws.close()
      terminals.clear()
      server.close((err) => err ? reject(err) : resolve())
    }),
  }
}

export const parseMockServerSpecifier = (raw: string): { port: number; token: string } | null => {
  const separator = raw.indexOf(":")
  if (separator < 1) return null
  const port = Number(raw.slice(0, separator))
  const token = raw.slice(separator + 1)
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || token === "") return null
  return { port, token }
}
