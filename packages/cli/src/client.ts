import { spawn } from "node:child_process"
import * as http from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"; import * as path from "node:path"
import { createRequire } from "node:module"
import { readServerInfo, probeAlive, type ServerInfo } from "@coolie/server"

const require_ = createRequire(import.meta.url)
export const home = () => process.env.COOLIE_HOME ?? path.join(os.homedir(), ".coolie")
const infoPath = () => path.join(home(), "server.json")

const spawnServer = (): void => {
  // @coolie/server's package.json only exports "." (-> src/index.ts); there's no
  // "./src/main.ts" subpath, so require.resolve("@coolie/server/src/main.ts")
  // throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the package root instead and
  // reach main.ts as a sibling of index.ts — avoids touching @coolie/server's
  // public exports map just to spawn its CLI entry.
  const serverMain = path.join(path.dirname(require_.resolve("@coolie/server")), "main.ts")
  const tsx = path.resolve(path.dirname(require_.resolve("tsx/package.json")), "../.bin/tsx")
  const child = spawn(tsx, [serverMain, "start"], { detached: true, stdio: "ignore", env: process.env })
  // Without an 'error' listener, a missing/unexecutable tsx binary emits an
  // unhandled 'error' event that crashes the CLI with an uncaught exception
  // instead of the graceful 10s-timeout message below. Swallow it here — the
  // ensureServer poll loop below already handles the failure-to-start case.
  child.on("error", () => {})
  child.unref()
}

export const ensureServer = async (): Promise<ServerInfo> => {
  const existing = readServerInfo(infoPath())
  if (existing && (await probeAlive(existing))) return existing
  spawnServer()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const info = readServerInfo(infoPath())
    if (info && (await probeAlive(info))) return info
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error("无法启动 coolie-server（10s 超时）")
}

interface RawResponse { status: number; text: string }

/** unix socket 优先（设计文档 §2.1：本地零端口依赖）；sock 缺席/失联回退 TCP。token 两路一致。 */
const rawRequest = (
  info: ServerInfo, method: string, p: string, body: string | undefined, forceTcp: boolean,
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const viaSock = !forceTcp && info.sock !== undefined && fs.existsSync(info.sock)
    const base = viaSock ? { socketPath: info.sock! } : { host: "127.0.0.1", port: info.port }
    const req = http.request({
      ...base, path: p, method,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${info.token}`,
        ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", (c) => { buf += c })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: buf }))
    })
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })

export const api = async (method: string, p: string, body?: unknown): Promise<any> => {
  const info = await ensureServer()
  const payload = body === undefined ? undefined : JSON.stringify(body)
  let r: RawResponse
  try {
    r = await rawRequest(info, method, p, payload, false)
  } catch {
    r = await rawRequest(info, method, p, payload, true) // 陈旧 sock → TCP 重试一次
  }
  if (r.status === 204) return undefined
  let json: any = {}
  try { json = r.text ? JSON.parse(r.text) : {} } catch { /* 非 JSON 保持 {} */ }
  if (r.status < 200 || r.status >= 300) throw new Error(`${json.code ?? r.status}: ${json.message ?? "request failed"}`)
  return json
}
