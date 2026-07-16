import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export interface RuntimeCleanupTarget {
  readonly root: string
  readonly home: string
  readonly tmuxSocket: string
}

const pidIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
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

export const stopDaemonsInRoot = async (root: string): Promise<number[]> => {
  const pids = new Set<number>()
  for (const file of findServerInfoFiles(root)) {
    try {
      const pid = Number(JSON.parse(fs.readFileSync(file, "utf8")).pid)
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid)
    } catch { /* stale server info */ }
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

export const cleanupRuntimeTarget = async (target: RuntimeCleanupTarget): Promise<void> => {
  const daemonPids = await stopDaemonsInRoot(target.root)
  try {
    execFileSync("tmux", ["-L", target.tmuxSocket, "kill-server"], { stdio: "ignore" })
  } catch { /* no tmux server */ }

  await new Promise((resolve) => setTimeout(resolve, 100))
  const survivors = daemonPids.filter(pidIsAlive)
  const tmuxAlive = spawnSync("tmux", ["-L", target.tmuxSocket, "has-session"], { stdio: "ignore" }).status === 0
  fs.rmSync(target.root, { recursive: true, force: true })
  const rootAlive = fs.existsSync(target.root)
  if (survivors.length || tmuxAlive || rootAlive) {
    throw new Error([
      survivors.length ? `daemon pids still alive: ${survivors.join(", ")}` : "",
      tmuxAlive ? `tmux socket still has sessions: ${target.tmuxSocket}` : "",
      rootAlive ? `runtime temp root still exists: ${target.root}` : "",
    ].filter(Boolean).join("; "))
  }
}
