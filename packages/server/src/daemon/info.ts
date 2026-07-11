import * as fs from "node:fs"
import * as path from "node:path"

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

export const probeAlive = async (info: ServerInfo): Promise<boolean> => {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(500) })
    return r.ok
  } catch { return false }
}
