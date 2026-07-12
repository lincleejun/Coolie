/** server 发现/拉起（Tauri 专用；语义 = CLI ensureServer：读 server.json → probe → spawn → 10s 轮询）。 */
import { invoke } from "@tauri-apps/api/core"
import { probeHealth, type ServerInfo } from "./client"

// ── DEV-ONLY 浏览器接缝（生产 Tauri 路径完全不变） ──────────────────────────
// tauri invoke 只在 Tauri webview 里可用；用普通浏览器打开（`bunx vite` + Chrome）做可视化自检时，
// window.__TAURI_INTERNALS__ 不存在。此时从 URL query `?server=<port>:<token>` 或 localStorage
// `coolie-dev-server` 读取一个已在跑的隔离 server 的连接信息，直接 probe 复用——绝不 spawn。
// 有 Tauri 时下面这条恒为 true 之外的分支永不进入，故对打包形态零影响。
const hasTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
const DEV_LS_KEY = "coolie-dev-server"
const devServerInfo = (): ServerInfo | null => {
  try {
    const q = new URLSearchParams(window.location.search).get("server")
    if (q) localStorage.setItem(DEV_LS_KEY, q) // reload 后 query 可能丢，落一份到 localStorage
    const raw = q ?? localStorage.getItem(DEV_LS_KEY)
    if (!raw) return null
    const i = raw.indexOf(":")
    if (i < 0) return null
    const port = Number(raw.slice(0, i))
    const token = raw.slice(i + 1)
    if (!Number.isInteger(port) || token === "") return null
    return { port, token, pid: 0 }
  } catch { return null }
}

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
  if (!hasTauri()) {
    // DEV 浏览器路径：只 probe 已给定的 server，不拉起
    const dev = devServerInfo()
    if (dev && (await probeHealth(dev))) return dev
    throw new Error("DEV 模式：未提供可用 server（用 ?server=<port>:<token> 或 localStorage coolie-dev-server）")
  }
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

export const tmuxOnPath = (): Promise<boolean> =>
  hasTauri() ? invoke<boolean>("binary_on_path", { name: "tmux" }) : Promise.resolve(true) // DEV：跳过 tmux 引导
