import {
  MOCK_E2E_PORT,
  MOCK_E2E_TOKEN,
  startMockDaemon,
  type MockDaemonControl,
} from "./mock-daemon.js"

let sharedDaemon: MockDaemonControl | null = null
let ownsDaemon = false

/** Attach to an already-listening mock (launcher onPrepare) without rebinding the port. */
const attachMockDaemon = (port: number, token: string): MockDaemonControl => ({
  port,
  token,
  baseUrl: `http://127.0.0.1:${port}`,
  serverInfo: JSON.stringify({ port, token, pid: process.pid }),
  emitEvent: () => {
    throw new Error("attach-only mock cannot emitEvent; use HTTP __test__ helpers")
  },
  disconnectSseClients: () => {},
  restoreSse: () => {},
  requestLog: () => [],
  reset: () => {
    void fetch(`http://127.0.0.1:${port}/__test__/reset`, { method: "POST" })
  },
  close: async () => {},
})

const probeMock = async (): Promise<boolean> => {
  try {
    const health = await fetch(`http://127.0.0.1:${MOCK_E2E_PORT}/health`, {
      headers: { Authorization: `Bearer ${MOCK_E2E_TOKEN}` },
    })
    return health.ok
  } catch {
    return false
  }
}

export const ensureMockHarness = async (): Promise<MockDaemonControl> => {
  if (sharedDaemon) return sharedDaemon
  if (await probeMock()) {
    sharedDaemon = attachMockDaemon(MOCK_E2E_PORT, MOCK_E2E_TOKEN)
    ownsDaemon = false
    return sharedDaemon
  }
  try {
    sharedDaemon = await startMockDaemon({ port: MOCK_E2E_PORT, token: MOCK_E2E_TOKEN })
    ownsDaemon = true
    return sharedDaemon
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("EADDRINUSE") || (error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
      // Launcher onPrepare likely owns the listener; attach over HTTP.
      sharedDaemon = attachMockDaemon(MOCK_E2E_PORT, MOCK_E2E_TOKEN)
      ownsDaemon = false
      return sharedDaemon
    }
    throw error
  }
}

export const resetMockHarness = async (): Promise<void> => {
  const daemon = await ensureMockHarness()
  await fetch(`${daemon.baseUrl}/__test__/reset`, { method: "POST" })
}

export const seedMockProject = async (overrides?: Record<string, unknown>): Promise<{ id: string }> => {
  const daemon = await ensureMockHarness()
  const response = await fetch(`${daemon.baseUrl}/__test__/seed/project`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(overrides ?? {}),
  })
  if (!response.ok) throw new Error(`seed project failed: ${response.status}`)
  return response.json() as Promise<{ id: string }>
}

export const seedMockWorkspace = async (
  projectId: string,
  overrides?: Record<string, unknown>,
): Promise<{ id: string; name: string }> => {
  const daemon = await ensureMockHarness()
  const response = await fetch(`${daemon.baseUrl}/__test__/seed/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, ...overrides }),
  })
  if (!response.ok) throw new Error(`seed workspace failed: ${response.status}`)
  return response.json() as Promise<{ id: string; name: string }>
}

export const seedMockAttention = async (
  input: Record<string, unknown> & { workspaceId: string; tabId: string; summary: string },
): Promise<{ id: string }> => {
  const daemon = await ensureMockHarness()
  const response = await fetch(`${daemon.baseUrl}/__test__/seed/attention`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`seed attention failed: ${response.status}`)
  return response.json() as Promise<{ id: string }>
}

export const mockRequestLog = async (): Promise<Array<{ method: string; path: string }>> => {
  const daemon = await ensureMockHarness()
  const response = await fetch(`${daemon.baseUrl}/__test__/requests`)
  return response.json() as Promise<Array<{ method: string; path: string }>>
}

export const setMockConfig = async (body: Record<string, unknown>): Promise<void> => {
  const daemon = await ensureMockHarness()
  const response = await fetch(`${daemon.baseUrl}/__test__/set-config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`set-config failed: ${response.status}`)
}

export const closeMockHarness = async (): Promise<void> => {
  if (ownsDaemon) await sharedDaemon?.close()
  sharedDaemon = null
  ownsDaemon = false
}
