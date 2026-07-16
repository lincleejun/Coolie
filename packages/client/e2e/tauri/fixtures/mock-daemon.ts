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

interface MockProject {
  readonly id: string
  readonly name: string
  readonly repoRoot: string
  readonly defaultBaseBranch: string
  readonly createdAt: number
}

interface MockFinishResult {
  prUrl?: string
  mergedBack: boolean
  warnings: string[]
  finishedAt: number
  createPr: boolean
  mergeBack: boolean
}

interface MockWorkspace {
  readonly id: string
  readonly projectId: string
  readonly name: string
  readonly path: string
  readonly branch: string
  readonly baseBranch: string
  readonly baseRef: string
  status: "active" | "archived" | "archiving" | "error"
  readonly pinned: boolean
  readonly createdAt: number
  archivedAt: number | null
  finishResult: MockFinishResult | null
  taskStatus?: string
}

interface MockTab {
  readonly id: string
  readonly workspaceId: string
  readonly kind: "engine" | "shell" | "setup"
  readonly engineId: string | null
  readonly engineSessionId: string | null
  readonly tmuxWindow: number | null
  readonly title: string | null
  readonly status: string
}

interface MockAttentionItem {
  id: string
  workspaceId: string
  tabId: string
  kind: "turn-finished" | "permission" | "elicitation" | "rate-limit" | "error" | "inferred"
  source: "hook" | "notify" | "transcript-poller"
  sourceEventSeq: number
  sessionTurnId: string | null
  summary: string
  state: "open" | "acknowledged"
  createdAt: number
  acknowledgedAt: number | null
}

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

let idCounter = 0
const nextId = (prefix: string): string => `${prefix}-${++idCounter}`

export const startMockDaemon = async (opts?: { token?: string; port?: number }): Promise<MockDaemonControl> => {
  const token = opts?.token ?? "mock-token"
  let seq = 0
  let sseBlocked = false
  const events: CoolieEvent[] = []
  const requests: Array<{ method: string; path: string; at: number }> = []
  const sseClients = new Set<SseClient>()
  const terminals = new Map<string, TerminalSession>()
  const projects: MockProject[] = []
  const workspaces: MockWorkspace[] = []
  const tabsByWs = new Map<string, MockTab[]>()
  const attentionItems: MockAttentionItem[] = []
  const defaultEngines = () => ([
    {
      id: "claude",
      displayName: "Claude",
      models: ["default"],
      enabled: true,
      custom: false,
      availability: { available: true, accountHint: "ok", error: null },
    },
    {
      id: "copilot",
      displayName: "GitHub Copilot",
      models: [],
      enabled: true,
      custom: false,
      capabilities: {
        nativeQueue: false,
        midSessionModelSwitch: false,
        resume: false,
        hooks: false,
        effort: false,
      },
      availability: {
        available: false,
        accountHint: null,
        error: "not logged in. Run `gh auth login` to authenticate GitHub Copilot",
      },
    },
  ])
  let engines = defaultEngines()

  const snapshot = () => ({
    asOfSeq: seq,
    generatedAt: Date.now(),
    scope: null,
    projects,
    workspaces,
    tabs: [...tabsByWs.values()].flat(),
    openAttention: attentionItems.filter((item) => item.state === "open"),
    queuedPrompts: [],
    activeRuns: [],
  })

  const append = (event: Omit<CoolieEvent, "seq" | "ts"> & { seq?: number; ts?: number }): CoolieEvent => {
    const stored: CoolieEvent = {
      seq: event.seq ?? ++seq,
      workspaceId: event.workspaceId ?? null,
      type: event.type,
      payload: event.payload,
      ts: event.ts ?? Date.now(),
    }
    if (stored.seq > seq) seq = stored.seq
    events.push(stored)
    for (const client of sseClients) sendSseEvent(client, stored)
    return stored
  }

  const logRequest = (req: IncomingMessage): void => {
    const url = new URL(req.url ?? "/", "http://local")
    if (url.pathname.startsWith("/__test__")) return
    requests.push({ method: req.method ?? "GET", path: url.pathname, at: Date.now() })
  }

  const server = createServer(async (req, res) => {
    logRequest(req)
    const url = new URL(req.url ?? "/", "http://local")
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "")
    const needsAuth = !url.pathname.startsWith("/__test__") && url.pathname !== "/health"
    if (needsAuth && auth !== token) return json(res, 401, { error: "unauthorized" })

    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true })
    if (req.method === "GET" && url.pathname === "/config") {
      return json(res, 200, {
        tmuxSocket: "coolie-mock",
        engines,
        namePools: { national_parks: { id: "national_parks", label: "National Parks" } },
      })
    }
    if (req.method === "GET" && url.pathname === "/state") return json(res, 200, snapshot())
    if (req.method === "GET" && url.pathname === "/projects") return json(res, 200, projects)
    if (req.method === "GET" && url.pathname === "/workspaces") return json(res, 200, workspaces)

    if (req.method === "GET" && url.pathname.startsWith("/attention")) {
      const workspace = url.searchParams.get("workspace")
      const state = url.searchParams.get("state") ?? "open"
      const items = attentionItems.filter((item) =>
        (state === "" || item.state === state)
        && (workspace === null || item.workspaceId === workspace))
      return json(res, 200, items)
    }

    const ackMatch = url.pathname.match(/^\/attention\/([^/]+)\/ack$/)
    if (req.method === "POST" && ackMatch) {
      const item = attentionItems.find((entry) => entry.id === ackMatch[1])
      if (!item) return json(res, 404, { error: "not found" })
      item.state = "acknowledged"
      item.acknowledgedAt = Date.now()
      append({
        type: "attention.acknowledged",
        workspaceId: item.workspaceId,
        payload: { id: item.id, tabId: item.tabId, kind: item.kind },
      })
      return json(res, 200, item)
    }

    const wsTabs = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs$/)
    if (req.method === "GET" && wsTabs)
      return json(res, 200, tabsByWs.get(wsTabs[1]!) ?? [])

    const projectBranches = url.pathname.match(/^\/projects\/([^/]+)\/branches$/)
    if (req.method === "GET" && projectBranches) {
      const project = projects.find((item) => item.id === projectBranches[1])
      if (!project) return json(res, 404, { error: "not found" })
      return json(res, 200, { branches: [project.defaultBaseBranch, "develop"] })
    }

    if (req.method === "POST" && url.pathname === "/projects") {
      const body = JSON.parse(await readBody(req)) as { repoRoot?: string }
      const project: MockProject = {
        id: nextId("p"),
        name: "demo-repo",
        repoRoot: body.repoRoot ?? "/tmp/demo",
        defaultBaseBranch: "main",
        createdAt: Date.now(),
      }
      projects.push(project)
      append({ type: "project.added", workspaceId: null, payload: project })
      return json(res, 201, project)
    }

    if (req.method === "POST" && url.pathname === "/workspaces") {
      const body = JSON.parse(await readBody(req)) as { projectId?: string; initialPrompt?: string }
      const project = projects.find((item) => item.id === body.projectId)
      if (!project) return json(res, 404, { error: "project not found" })
      const ws: MockWorkspace = {
        id: nextId("w"),
        projectId: project.id,
        name: "yosemite",
        path: `/tmp/${project.name}/yosemite`,
        branch: "coolie/yosemite",
        baseBranch: project.defaultBaseBranch,
        baseRef: "abc123",
        status: "active",
        pinned: false,
        createdAt: Date.now(),
        archivedAt: null,
        finishResult: null,
      }
      workspaces.push(ws)
      tabsByWs.set(ws.id, [{
        id: nextId("t"),
        workspaceId: ws.id,
        kind: "engine",
        engineId: "claude",
        engineSessionId: "sess-1",
        tmuxWindow: 0,
        title: "Claude",
        status: "idle",
      }])
      append({ type: "workspace.intent.created", workspaceId: ws.id, payload: { id: ws.id } })
      append({ type: "workspace.created", workspaceId: ws.id, payload: { id: ws.id, branch: ws.branch, path: ws.path } })
      return json(res, 201, ws)
    }

    const wsEnsure = url.pathname.match(/^\/workspaces\/([^/]+)\/ensure$/)
    if (req.method === "POST" && wsEnsure)
      return json(res, 200, { healed: true, sessionCreated: false })

    const wsFinish = url.pathname.match(/^\/workspaces\/([^/]+)\/finish$/)
    if (req.method === "POST" && wsFinish) {
      const ws = workspaces.find((item) => item.id === wsFinish[1])
      if (!ws) return json(res, 404, { error: "not found" })
      if (ws.status !== "active") return json(res, 409, { code: "Conflict", message: "not active" })
      const body = JSON.parse(await readBody(req) || "{}") as {
        createPr?: boolean; mergeBack?: boolean; title?: string; failGh?: boolean
      }
      if (body.failGh || (globalThis as { __coolieMockFinishFailGh?: boolean }).__coolieMockFinishFailGh) {
        return json(res, 409, { code: "Conflict", message: "gh CLI unavailable" })
      }
      const createPr = body.createPr === true
      const mergeBack = body.mergeBack === true
      ws.finishResult = {
        ...(createPr ? { prUrl: "https://example.test/pr/42" } : {}),
        mergedBack: mergeBack,
        warnings: [],
        finishedAt: Date.now(),
        createPr,
        mergeBack,
      }
      if (mergeBack) ws.taskStatus = "done"
      else if (createPr) ws.taskStatus = "in_review"
      append({ type: "workspace.finished", workspaceId: ws.id, payload: ws.finishResult })
      return json(res, 200, {
        ...(ws.finishResult.prUrl ? { prUrl: ws.finishResult.prUrl } : {}),
        mergedBack: ws.finishResult.mergedBack,
        warnings: ws.finishResult.warnings,
      })
    }

    const wsFinishResult = url.pathname.match(/^\/workspaces\/([^/]+)\/finish-result$/)
    if (req.method === "DELETE" && wsFinishResult) {
      const ws = workspaces.find((item) => item.id === wsFinishResult[1])
      if (!ws) return json(res, 404, { error: "not found" })
      ws.finishResult = null
      append({ type: "workspace.updated", workspaceId: ws.id, payload: { id: ws.id } })
      return json(res, 200, ws)
    }

    const wsArchive = url.pathname.match(/^\/workspaces\/([^/]+)\/archive$/)
    if (req.method === "POST" && wsArchive) {
      const ws = workspaces.find((item) => item.id === wsArchive[1])
      if (!ws) return json(res, 404, { error: "not found" })
      const body = JSON.parse(await readBody(req) || "{}") as { force?: boolean; fail?: boolean }
      if (body.fail || (globalThis as { __coolieMockArchiveFail?: boolean }).__coolieMockArchiveFail) {
        return json(res, 409, { code: "Conflict", message: "worktree dirty" })
      }
      ws.status = "archived"
      ws.archivedAt = Date.now()
      ws.finishResult = null
      append({ type: "workspace.archived", workspaceId: ws.id, payload: { id: ws.id } })
      return json(res, 200, ws)
    }

    const wsUnarchive = url.pathname.match(/^\/workspaces\/([^/]+)\/unarchive$/)
    if (req.method === "POST" && wsUnarchive) {
      const ws = workspaces.find((item) => item.id === wsUnarchive[1])
      if (!ws) return json(res, 404, { error: "not found" })
      ws.status = "active"
      ws.archivedAt = null
      append({ type: "workspace.unarchived", workspaceId: ws.id, payload: { id: ws.id } })
      return json(res, 200, ws)
    }

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
      return json(res, 200, append(body))
    }
    if (req.method === "POST" && url.pathname === "/__test__/seed/project") {
      const body = JSON.parse(await readBody(req)) as Partial<MockProject>
      const project: MockProject = {
        id: body.id ?? nextId("p"),
        name: body.name ?? "demo-repo",
        repoRoot: body.repoRoot ?? "/tmp/demo",
        defaultBaseBranch: body.defaultBaseBranch ?? "main",
        createdAt: body.createdAt ?? Date.now(),
      }
      projects.push(project)
      append({ type: "project.added", workspaceId: null, payload: project })
      return json(res, 200, project)
    }
    if (req.method === "POST" && url.pathname === "/__test__/seed/workspace") {
      const body = JSON.parse(await readBody(req)) as Partial<MockWorkspace> & { projectId: string }
      const ws: MockWorkspace = {
        id: body.id ?? nextId("w"),
        projectId: body.projectId,
        name: body.name ?? "yosemite",
        path: body.path ?? `/tmp/${body.name ?? "yosemite"}`,
        branch: body.branch ?? "coolie/yosemite",
        baseBranch: body.baseBranch ?? "main",
        baseRef: body.baseRef ?? "abc123",
        status: body.status ?? "active",
        pinned: body.pinned ?? false,
        createdAt: body.createdAt ?? Date.now(),
        archivedAt: body.archivedAt ?? null,
        finishResult: body.finishResult ?? null,
      }
      workspaces.push(ws)
      tabsByWs.set(ws.id, body.id ? (tabsByWs.get(ws.id) ?? []) : [{
        id: nextId("t"),
        workspaceId: ws.id,
        kind: "engine",
        engineId: "claude",
        engineSessionId: "sess-1",
        tmuxWindow: 0,
        title: "Claude",
        status: "idle",
      }])
      append({ type: "workspace.created", workspaceId: ws.id, payload: { id: ws.id } })
      return json(res, 200, ws)
    }
    if (req.method === "POST" && url.pathname === "/__test__/seed/attention") {
      const body = JSON.parse(await readBody(req)) as Partial<MockAttentionItem> & {
        workspaceId: string
        tabId: string
        summary: string
      }
      const event = append({
        type: "attention.recorded",
        workspaceId: body.workspaceId,
        payload: { tabId: body.tabId, summary: body.summary },
      })
      const item: MockAttentionItem = {
        id: body.id ?? nextId("att"),
        workspaceId: body.workspaceId,
        tabId: body.tabId,
        kind: body.kind ?? "turn-finished",
        source: body.source ?? "hook",
        sourceEventSeq: body.sourceEventSeq ?? event.seq,
        sessionTurnId: body.sessionTurnId ?? null,
        summary: body.summary,
        state: "open",
        createdAt: body.createdAt ?? Date.now(),
        acknowledgedAt: null,
      }
      attentionItems.push(item)
      return json(res, 200, item)
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
    const wsDiffstat = url.pathname.match(/^\/workspaces\/([^/]+)\/git\/diffstat$/)
    if (req.method === "GET" && wsDiffstat) {
      return json(res, 200, { filesChanged: 1, insertions: 3, deletions: 1 })
    }
    const wsChanges = url.pathname.match(/^\/workspaces\/([^/]+)\/git\/changes$/)
    if (req.method === "GET" && wsChanges) {
      return json(res, 200, {
        againstBase: [{ path: "src/app.ts", insertions: 3, deletions: 1 }],
        committed: [],
        staged: [],
        unstaged: [{ path: "src/app.ts", insertions: 3, deletions: 1 }],
        untracked: [],
      })
    }
    const wsDiff = url.pathname.match(/^\/workspaces\/([^/]+)\/git\/diff$/)
    if (req.method === "GET" && wsDiff) {
      return json(res, 200, {
        path: url.searchParams.get("path") ?? "src/app.ts",
        section: url.searchParams.get("section") ?? "againstBase",
        unified: "@@ -1 +1 @@\n-old\n+new\n",
        binary: false,
      })
    }
    const wsRuns = url.pathname.match(/^\/workspaces\/([^/]+)\/runs$/)
    if (req.method === "GET" && wsRuns) {
      return json(res, 200, [{
        id: `runinst-${wsRuns[1]}`,
        workspaceId: wsRuns[1],
        runId: "test",
        scriptType: "run",
        status: "exited",
        startedAt: Date.now() - 1000,
        exitedAt: Date.now(),
        exitCode: 0,
      }])
    }
    const wsRunStart = url.pathname.match(/^\/workspaces\/([^/]+)\/runs\/([^/]+)\/start$/)
    if (req.method === "POST" && wsRunStart) {
      return json(res, 200, {
        id: `runinst-${wsRunStart[1]}`,
        workspaceId: wsRunStart[1],
        runId: wsRunStart[2],
        scriptType: "run",
        status: "running",
        startedAt: Date.now(),
        exitedAt: null,
        exitCode: null,
      })
    }
    const wsChecks = url.pathname.match(/^\/workspaces\/([^/]+)\/checks$/)
    if (req.method === "GET" && wsChecks) {
      return json(res, 200, {
        workspaceId: wsChecks[1],
        collectedAt: Date.now(),
        degraded: true,
        items: [
          {
            id: "git-dirty",
            category: "git",
            status: "warn",
            label: "Working tree dirty",
            detail: "1 path(s) changed",
            updatedAt: Date.now(),
            action: { kind: "view-diff", label: "View changes" },
          },
          {
            id: "run-test",
            category: "run",
            status: "pass",
            label: "Run test",
            detail: "exit 0",
            updatedAt: Date.now(),
            action: { kind: "run-script", label: "Re-run", runId: "test" },
          },
          {
            id: "ci",
            category: "ci",
            status: "unavailable",
            label: "GitHub checks",
            detail: "gh CLI unavailable",
            updatedAt: Date.now(),
          },
        ],
      })
    }
    const wsReview = url.pathname.match(/^\/workspaces\/([^/]+)\/review$/)
    if (req.method === "POST" && wsReview) {
      const workspaceId = wsReview[1]!
      const tabs = tabsByWs.get(workspaceId) ?? []
      const reviewTab = {
        id: nextId("t-review"),
        workspaceId,
        kind: "engine" as const,
        engineId: "claude",
        engineSessionId: "review-sess",
        tmuxWindow: tabs.length,
        title: "Review",
        status: "working",
      }
      tabs.push(reviewTab)
      tabsByWs.set(workspaceId, tabs)
      append({
        type: "workspace.tabs.changed",
        workspaceId,
        payload: { tabId: reviewTab.id, title: reviewTab.title },
      })
      return json(res, 200, {
        tabId: reviewTab.id,
        title: "Review",
        queued: true,
        promptSource: "project",
        engineId: "claude",
      })
    }
    const wsTranscript = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/transcript$/)
    if (req.method === "GET" && wsTranscript) {
      return json(res, 200, {
        capability: "available",
        reset: true,
        cursor: null,
        truncated: false,
        entries: [{
          id: "e1",
          role: "assistant",
          rawType: "message",
          timestamp: Date.now(),
          blocks: [{ kind: "text", text: "Mock transcript entry for daily flow" }],
        }],
      })
    }

    if (req.method === "GET" && url.pathname === "/__test__/requests")
      return json(res, 200, requests)
    if (req.method === "POST" && url.pathname === "/__test__/set-config") {
      const body = JSON.parse(await readBody(req) || "{}") as { engines?: typeof engines }
      if (Array.isArray(body.engines)) engines = body.engines
      return json(res, 200, { engines })
    }
    if (req.method === "POST" && url.pathname === "/__test__/reset") {
      events.length = 0
      requests.length = 0
      projects.length = 0
      workspaces.length = 0
      tabsByWs.clear()
      attentionItems.length = 0
      engines = defaultEngines()
      seq = 0
      sseBlocked = false
      idCounter = 0
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
        if (isBinary) { ws.send(data, { binary: true }); return }
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

  await new Promise<void>((resolve, reject) => {
    const onListen = (): void => resolve()
    if (opts?.port) server.listen(opts.port, "127.0.0.1", onListen)
    else server.listen(0, "127.0.0.1", onListen)
    server.on("error", reject)
  })
  const port = (server.address() as AddressInfo).port

  return {
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    serverInfo: JSON.stringify({ port, token, pid: process.pid }),
    emitEvent: (event) => append(event),
    disconnectSseClients: () => {
      for (const client of sseClients) client.res.end()
      sseClients.clear()
    },
    restoreSse: () => { sseBlocked = false },
    requestLog: () => requests,
    reset: () => {
      events.length = 0
      requests.length = 0
      projects.length = 0
      workspaces.length = 0
      tabsByWs.clear()
      attentionItems.length = 0
      seq = 0
      sseBlocked = false
      idCounter = 0
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

export const MOCK_E2E_PORT = 45_123
export const MOCK_E2E_TOKEN = "mock-e2e"
