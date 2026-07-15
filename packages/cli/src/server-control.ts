import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { probeAlive, readServerInfo } from "@coolie/server"

export interface ResetResult {
  readonly daemonStopped: boolean
  readonly removed: readonly string[]
  readonly tmuxStopped: boolean
}

export interface StopDaemonDeps {
  readonly readInfo?: typeof readServerInfo
  readonly probe?: typeof probeAlive
  readonly pidAlive?: (pid: number) => boolean
  readonly fetcher?: typeof fetch
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
}

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true }
  catch { return false }
}

const registeredDaemonAlive = async (
  info: NonNullable<ReturnType<typeof readServerInfo>>,
  deps: StopDaemonDeps,
): Promise<boolean> => {
  const healthy = await (deps.probe ?? probeAlive)(info)
  return healthy || (deps.pidAlive ?? processAlive)(info.pid)
}

export const stopDaemon = async (home: string, deps: StopDaemonDeps = {}): Promise<boolean> => {
  const readInfo = deps.readInfo ?? readServerInfo
  const fetcher = deps.fetcher ?? fetch
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const info = readInfo(path.join(home, "server.json"))
  if (!info || !(await registeredDaemonAlive(info, deps))) return false
  try {
    await fetcher(`http://127.0.0.1:${info.port}/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2_000),
    })
  } catch { /* shutdown can close the connection after accepting it */ }
  const deadline = now() + (deps.timeoutMs ?? 2_000)
  while (now() < deadline) {
    if (!(await registeredDaemonAlive(info, deps))) return true
    await sleep(50)
  }
  if (await registeredDaemonAlive(info, deps))
    throw new Error(`Coolie daemon pid=${info.pid} is still alive; reset aborted without cleanup`)
  return true
}

export const resetRuntime = async (
  home: string,
  tmuxSocket: string,
  run = spawnSync,
  stopDeps: StopDaemonDeps = {},
): Promise<ResetResult> => {
  if (tmuxSocket === "" || tmuxSocket.includes("\0")) throw new Error("invalid Coolie tmux socket")
  const daemonStopped = await stopDaemon(home, stopDeps)
  const current = (stopDeps.readInfo ?? readServerInfo)(path.join(home, "server.json"))
  if (current && await registeredDaemonAlive(current, stopDeps))
    throw new Error(`Coolie daemon pid=${current.pid} became live during reset; aborted without cleanup`)
  const removed: string[] = []
  for (const name of ["server.json", "coolie.sock"]) {
    const target = path.join(home, name)
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true })
      removed.push(name)
    }
  }
  const result = run("tmux", ["-L", tmuxSocket, "kill-server"], { stdio: "ignore" })
  return { daemonStopped, removed, tmuxStopped: result.status === 0 }
}
