import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { initTempGitRepo } from "./git-repo.js"
import { fakeEngineProcessEnv } from "./fake-engine.js"
import { cleanupRuntimeTarget, type RuntimeCleanupTarget } from "./cleanup.js"

const fixtureDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(fixtureDir, "../../../../..")
const serverMain = path.join(repoRoot, "packages/server/src/main.ts")
const tsx = path.join(repoRoot, "node_modules/.bin/tsx")

export interface RealDaemonFixture extends RuntimeCleanupTarget {
  readonly repo: string
  readonly workspacesRoot: string
  readonly port: number
  readonly token: string
  readonly baseUrl: string
  readonly child: ChildProcess
  readonly daemonEnv: NodeJS.ProcessEnv
  restart(): Promise<void>
  close(): Promise<void>
}

const waitForHealth = async (port: number, deadlineMs = 20_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`real daemon did not become healthy on port ${port}`)
}

const spawnDaemonChild = (env: NodeJS.ProcessEnv): ChildProcess => {
  const child = spawn(tsx, [serverMain, "start"], {
    env,
    stdio: "pipe",
    detached: true,
  })
  child.on("error", () => {})
  return child
}

const killChild = (child: ChildProcess): void => {
  if (!child.pid) return
  try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
}

export const startRealDaemon = async (): Promise<RealDaemonFixture> => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/coolie-real-daemon-"))
  const home = path.join(root, "home")
  const tmp = path.join(root, "tmp")
  const workspacesRoot = path.join(root, "workspaces")
  const reposRoot = path.join(root, "repos")
  for (const dir of [home, tmp, workspacesRoot, reposRoot]) fs.mkdirSync(dir, { recursive: true })

  const nonce = path.basename(root).replace(/[^a-zA-Z0-9]/g, "").slice(-8)
  const tmuxSocket = `coolie-real-${process.pid}-${nonce}`
  const portBase = 46_000 + (process.pid % 900) * 10
  const repo = path.join(reposRoot, "demo")
  fs.mkdirSync(repo, { recursive: true })
  initTempGitRepo(repo, { envFile: "SECRET=42\n", withSetup: true })

  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: tmp,
    COOLIE_HOME: path.join(home, ".coolie"),
    COOLIE_WORKSPACES_ROOT: workspacesRoot,
    COOLIE_REPOS_ROOT: reposRoot,
    COOLIE_TMUX_SOCKET: tmuxSocket,
    COOLIE_TEST_PORT_BASE: String(portBase),
    COOLIE_PORT: String(portBase),
    ...fakeEngineProcessEnv(home),
  }

  const child = spawnDaemonChild(env)

  const serverInfoPath = path.join(home, ".coolie", "server.json")
  let info: { port: number; token: string } | null = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      info = JSON.parse(fs.readFileSync(serverInfoPath, "utf8")) as { port: number; token: string }
      break
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!info) {
    try { process.kill(-child.pid!, "SIGKILL") } catch { child.kill("SIGKILL") }
    throw new Error("real daemon failed to write server.json")
  }

  await waitForHealth(info.port)

  let activeChild = child
  const target: RealDaemonFixture = {
    root,
    home,
    tmuxSocket,
    repo,
    workspacesRoot,
    port: info.port,
    token: info.token,
    baseUrl: `http://127.0.0.1:${info.port}`,
    get child() { return activeChild },
    daemonEnv: env,
    restart: async () => {
      try {
        await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
          method: "POST",
          headers: { Authorization: `Bearer ${info.token}` },
        })
      } catch { /* best effort */ }
      killChild(activeChild)
      await new Promise((resolve) => setTimeout(resolve, 500))
      activeChild = spawnDaemonChild(env)
      await waitForHealth(info.port, 30_000)
    },
    close: async () => {
      try {
        await fetch(`${target.baseUrl}/shutdown`, {
          method: "POST",
          headers: { Authorization: `Bearer ${target.token}` },
        })
      } catch { /* best effort */ }
      killChild(activeChild)
      await cleanupRuntimeTarget(target)
    },
  }
  return target
}
