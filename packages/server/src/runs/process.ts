import { spawn, type ChildProcess } from "node:child_process"

export interface SpawnedRunProcess {
  readonly pid: number
  readonly child: ChildProcess
}

export const spawnRunProcess = (opts: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}): SpawnedRunProcess => {
  const child = spawn(opts.command, [...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  child.on("error", () => {})
  if (!child.pid) throw new Error("failed to spawn run process")
  return { pid: child.pid, child }
}

export const signalProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  try { process.kill(-pid, signal) } catch { /* group already gone */ }
}

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const waitMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
