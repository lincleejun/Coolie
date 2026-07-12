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
 * post-listen 单实例收口（ledger carry-over：cmdStart 的 probe→write TOCTOU）：
 * 用 O_EXCL（flag "wx"）独占创建 server.json。EEXIST 时读出既有者——
 * 别人且活着 → 认输（绝不覆盖赢家）；陈旧/损坏/自己的残留 → 清掉重试一次。
 */
export const claimServerInfo = async (infoPath: string, info: ServerInfo): Promise<boolean> => {
  const payload = JSON.stringify(info, null, 2)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(infoPath), { recursive: true })
      fs.writeFileSync(infoPath, payload, { mode: 0o600, flag: "wx" })
      return true
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e
      const existing = readServerInfo(infoPath)
      if (existing && existing.pid !== info.pid && (await probeAlive(existing))) return false
      fs.rmSync(infoPath, { force: true }) // 陈旧/损坏 → 清掉进入下一轮独占写
    }
  }
  return false
}
