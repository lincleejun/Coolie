import {
  startRealDaemon,
  type RealDaemonFixture,
} from "./real-daemon.js"

let sharedDaemon: RealDaemonFixture | null = null

export const ensureRealHarness = async (): Promise<RealDaemonFixture> => {
  if (sharedDaemon) return sharedDaemon
  sharedDaemon = await startRealDaemon()
  return sharedDaemon
}

export const closeRealHarness = async (): Promise<void> => {
  await sharedDaemon?.close()
  sharedDaemon = null
}

export const registerRealProject = async (): Promise<{ id: string; repoRoot: string }> => {
  const daemon = await ensureRealHarness()
  const response = await fetch(`${daemon.baseUrl}/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ repoRoot: daemon.repo }),
  })
  if (!response.ok) throw new Error(`register project failed: ${response.status}`)
  const project = await response.json() as { id: string }
  return { id: project.id, repoRoot: daemon.repo }
}

export const createRealWorkspace = async (
  projectId: string,
  opts?: { branchSlug?: string; name?: string },
): Promise<{ id: string; name: string }> => {
  const daemon = await ensureRealHarness()
  const response = await fetch(`${daemon.baseUrl}/workspaces`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ projectId, branchSlug: opts?.branchSlug ?? "e2e-real", ...opts }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`create workspace failed: ${response.status} ${body}`)
  }
  return response.json() as Promise<{ id: string; name: string }>
}

export const fetchRealWorkspace = async (workspaceId: string): Promise<any> => {
  const daemon = await ensureRealHarness()
  const response = await fetch(`${daemon.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  })
  if (!response.ok) throw new Error(`fetch workspace failed: ${response.status}`)
  return response.json()
}

export const restartRealDaemonInPlace = async (): Promise<RealDaemonFixture> => {
  const daemon = await ensureRealHarness()
  await daemon.restart()
  return daemon
}
