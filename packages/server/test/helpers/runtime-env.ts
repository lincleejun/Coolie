import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export interface RuntimeTestEnvironment {
  readonly root: string
  readonly home: string
  readonly tmp: string
  readonly workspacesRoot: string
  readonly reposRoot: string
  readonly tmuxSocket: string
  readonly portBase: number
}

const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is only available in the runtime test track`)
  return value
}

export const runtimeTmuxSocket = (): string => requireEnv("COOLIE_TMUX_SOCKET")

export const runtimeTmuxKillSessions = (): void => {
  try {
    execFileSync("tmux", ["-L", runtimeTmuxSocket(), "kill-server"], { stdio: "ignore" })
  } catch { /* no runtime tmux server was started */ }
}

export const runtimePort = (offset = 0): number => {
  if (!Number.isInteger(offset) || offset < 0 || offset > 9)
    throw new Error(`runtime port offset must be an integer from 0 to 9, got ${offset}`)
  return Number(requireEnv("COOLIE_TEST_PORT_BASE")) + offset
}

const findServerInfoFiles = (root: string): string[] => {
  const found: string[] = []
  if (!fs.existsSync(root)) return found
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...findServerInfoFiles(item))
    else if (entry.isFile() && entry.name === "server.json") found.push(item)
  }
  return found
}

const stopResidualDaemons = async (root: string): Promise<number[]> => {
  const pids = new Set<number>()
  for (const file of findServerInfoFiles(root)) {
    try {
      const pid = Number(JSON.parse(fs.readFileSync(file, "utf8")).pid)
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid)
    } catch { /* stale or partially-written server info */ }
  }
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM") } catch { /* already stopped */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL") } catch { /* already stopped */ }
  }
  return [...pids]
}

const pidIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

export const cleanupRuntimeEnvironment = async (env: RuntimeTestEnvironment): Promise<void> => {
  const daemonPids = await stopResidualDaemons(env.root)
  try {
    execFileSync("tmux", ["-L", env.tmuxSocket, "kill-server"], { stdio: "ignore" })
  } catch { /* no runtime tmux server was started */ }

  await new Promise((resolve) => setTimeout(resolve, 100))
  const survivors = daemonPids.filter(pidIsAlive)
  const tmuxAlive = spawnSync("tmux", ["-L", env.tmuxSocket, "has-session"], { stdio: "ignore" }).status === 0

  fs.rmSync(env.root, { recursive: true, force: true })
  const rootAlive = fs.existsSync(env.root)
  if (survivors.length || tmuxAlive || rootAlive) {
    throw new Error([
      survivors.length ? `daemon pids still alive: ${survivors.join(", ")}` : "",
      tmuxAlive ? `tmux socket still has sessions: ${env.tmuxSocket}` : "",
      rootAlive ? `runtime temp root still exists: ${env.root}` : "",
    ].filter(Boolean).join("; "))
  }
}

export default function setupRuntimeEnvironment(): () => Promise<void> {
  // Keep this root under /tmp: macOS' real temp path is long enough that nested
  // daemon fixtures can exceed the 104-byte AF_UNIX path limit.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/coolie-rt-"))
  const home = path.join(root, "home")
  const tmp = path.join(root, "tmp")
  const workspacesRoot = path.join(root, "workspaces")
  const reposRoot = path.join(root, "repos")
  for (const dir of [home, tmp, workspacesRoot, reposRoot]) fs.mkdirSync(dir, { recursive: true })

  const nonce = path.basename(root).replace(/[^a-zA-Z0-9]/g, "").slice(-8)
  const tmuxSocket = `coolie-test-${process.pid}-${nonce}`
  const portBase = 45_000 + (process.pid % 1_000) * 10
  const env: RuntimeTestEnvironment = { root, home, tmp, workspacesRoot, reposRoot, tmuxSocket, portBase }

  Object.assign(process.env, {
    HOME: home,
    TMPDIR: tmp,
    COOLIE_HOME: path.join(home, ".coolie"),
    COOLIE_WORKSPACES_ROOT: workspacesRoot,
    COOLIE_REPOS_ROOT: reposRoot,
    COOLIE_TMUX_SOCKET: tmuxSocket,
    COOLIE_CLAUDE_HOME: path.join(home, ".claude"),
    COOLIE_CODEX_HOME: path.join(home, ".codex"),
    COOLIE_CLAUDE_CONFIG: path.join(home, ".claude.json"),
    COOLIE_CODEX_CONFIG: path.join(home, ".codex", "config.toml"),
    COOLIE_TEST_PORT_BASE: String(portBase),
    COOLIE_PORT: String(portBase),
    ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`COOLIE_PORT_${index}`, String(portBase + index)])),
  })

  return () => cleanupRuntimeEnvironment(env)
}
