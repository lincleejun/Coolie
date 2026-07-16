import {
  MOCK_E2E_PORT,
  MOCK_E2E_TOKEN,
  startMockDaemon,
  type MockDaemonControl,
} from "./mock-daemon.js"

let sharedDaemon: MockDaemonControl | null = null

export const ensureMockHarness = async (): Promise<MockDaemonControl> => {
  if (sharedDaemon) return sharedDaemon
  sharedDaemon = await startMockDaemon({ port: MOCK_E2E_PORT, token: MOCK_E2E_TOKEN })
  return sharedDaemon
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

export const mockRequestLog = async (): Promise<Array<{ method: string; path: string }>> => {
  const daemon = await ensureMockHarness()
  const response = await fetch(`${daemon.baseUrl}/__test__/requests`)
  return response.json() as Promise<Array<{ method: string; path: string }>>
}

export const closeMockHarness = async (): Promise<void> => {
  await sharedDaemon?.close()
  sharedDaemon = null
}
