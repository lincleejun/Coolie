/** server 发现/拉起（Tauri 专用；语义 = CLI ensureServer：读 server.json → probe → spawn → 10s 轮询）。 */
import { invoke } from "@tauri-apps/api/core"
import { probeHealth, type ServerInfo } from "./client"

const readInfo = async (): Promise<ServerInfo | null> => {
  const raw = await invoke<string | null>("read_server_info")
  if (!raw) return null
  try {
    const j = JSON.parse(raw)
    if (typeof j.port === "number" && typeof j.token === "string" && typeof j.pid === "number") return j
    return null
  } catch { return null }
}

export const spawnDaemon = async (): Promise<void> => {
  const [program, ...args] = __COOLIE_SERVER_CMD__.split(" ")
  await invoke("spawn_detached", { program, args })
}

export const ensureServer = async (): Promise<ServerInfo> => {
  const existing = await readInfo()
  if (existing && (await probeHealth(existing))) return existing
  await spawnDaemon()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const info = await readInfo()
    if (info && (await probeHealth(info))) return info
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error("无法启动 coolie-server（10s 超时）")
}

export const tmuxOnPath = (): Promise<boolean> => invoke<boolean>("binary_on_path", { name: "tmux" })
