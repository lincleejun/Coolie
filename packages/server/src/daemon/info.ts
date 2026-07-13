import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

export interface ServerInfo { port: number; token: string; pid: number; sock?: string }

export const readServerInfo = (infoPath: string): ServerInfo | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(infoPath, "utf8"))
    if (typeof raw.port === "number" && typeof raw.token === "string" && typeof raw.pid === "number")
      return { port: raw.port, token: raw.token, pid: raw.pid, ...(typeof raw.sock === "string" ? { sock: raw.sock } : {}) }
    return null
  } catch { return null }
}

export const writeServerInfo = (infoPath: string, info: ServerInfo): void => {
  fs.mkdirSync(path.dirname(infoPath), { recursive: true })
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 })
}

/** pid 预检（ledger carry-over）：进程都不在了就别发 HTTP 了——也顺带挡住
 * 「server.json 陈旧 + 端口被无关进程复用」的假阳。pid 活着仍以 /health 为准。 */
export const probeAlive = async (info: ServerInfo): Promise<boolean> => {
  try { process.kill(info.pid, 0) } catch { return false }
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(500) })
    return r.ok
  } catch { return false }
}

/**
 * post-listen 单实例收口：所有 contender 先获取同目录 O_EXCL claim lock，把探测、陈旧清理和发布串行化。
 * lock 带 pid/token/时间戳，崩溃残留可恢复；发布仍使用同目录 tmp + hard link，且全程保持 0600。
 */
export const claimServerInfo = async (infoPath: string, info: ServerInfo): Promise<boolean> => {
  const payload = JSON.stringify(info, null, 2)
  const dir = path.dirname(infoPath)
  const lockPath = `${infoPath}.claim.lock`
  const lockToken = randomUUID()
  fs.mkdirSync(dir, { recursive: true })
  let locked = false
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ token: lockToken, pid: process.pid, createdAt: Date.now() }),
        { mode: 0o600, flag: "wx" })
      locked = true
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let stale = false
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown; createdAt?: unknown }
        if (typeof owner.pid !== "number") stale = true
        else {
          try { process.kill(owner.pid, 0) }
          catch { stale = true }
          if (typeof owner.createdAt === "number" && Date.now() - owner.createdAt > 10_000) stale = true
        }
      } catch { stale = true }
      if (stale) {
        fs.rmSync(lockPath, { force: true })
        continue
      }
      await sleep(20)
    }
  }
  if (!locked) return false
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${infoPath}.tmp.${process.pid}.${randomUUID()}`
      try {
        fs.writeFileSync(tmp, payload, { mode: 0o600, flag: "wx" })
        fs.linkSync(tmp, infoPath)
        return true
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e
        const existing = readServerInfo(infoPath)
        if (existing && existing.token !== info.token && (await probeAlive(existing))) return false
        fs.rmSync(infoPath, { force: true }) // 陈旧/损坏 → 清掉进入下一轮独占写
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    }
    return false
  } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown }
      if (owner.token === lockToken) fs.rmSync(lockPath)
    } catch { /* lock was already lost/recovered; never remove an unknown owner */ }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_READ_RETRIES = 10
const MAX_RETRY_DELAY_MS = 100

/** server.json 在陈旧文件删建短窗或外部半写残留中可能暂时不可读；短退避后有界重试。 */
export const readServerInfoWithRetry = async (
  infoPath: string,
  opts?: { retries?: number; delayMs?: number },
): Promise<ServerInfo | null> => {
  const requestedRetries = opts?.retries ?? 3
  const requestedDelayMs = opts?.delayMs ?? 20
  const retries = Number.isFinite(requestedRetries)
    ? Math.min(MAX_READ_RETRIES, Math.max(0, Math.floor(requestedRetries)))
    : 3
  const delayMs = Number.isFinite(requestedDelayMs)
    ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, requestedDelayMs))
    : 20
  for (let attempt = 0; attempt <= retries; attempt++) {
    const info = readServerInfo(infoPath)
    if (info) return info
    if (attempt < retries) await sleep(delayMs)
  }
  return null
}
