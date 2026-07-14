/** Desktop discovers/spawns its daemon; web only connects to an explicitly supplied loopback server. */
import { probeHealth, type ServerInfo } from "./client"
import { capabilities } from "../platform"

export const WEB_SERVER_STORAGE_KEY = "coolie.web.server"

export const parseServerSpecifier = (raw: string): ServerInfo | null => {
  const separator = raw.indexOf(":")
  if (separator < 1) return null
  const portText = raw.slice(0, separator)
  if (!/^\d+$/.test(portText)) return null
  const port = Number(portText)
  const token = raw.slice(separator + 1)
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || token === "") return null
  return { port, token, pid: 0 }
}

export const resolveWebServerInfo = (
  search: string,
  storage: Pick<Storage, "getItem">,
): ServerInfo | null => {
  try {
    const query = new URLSearchParams(search).get("server")
    return parseServerSpecifier(query ?? storage.getItem(WEB_SERVER_STORAGE_KEY) ?? "")
  } catch {
    return null
  }
}

export const sanitizeServerUrl = (href: string): string => {
  const url = new URL(href)
  url.searchParams.delete("server")
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * Captures URL credentials exactly once. The returned resolver is safe to reuse
 * for reconnects and never consults location or writes credentials back to it.
 */
export const bootstrapWebServerInfo = (
  location: () => Pick<Location, "href" | "search">,
  storage: Pick<Storage, "getItem">,
  replaceUrl: (url: string) => void,
): (() => ServerInfo | null) => {
  let captured: ServerInfo | null = null
  try {
    const current = location()
    const params = new URLSearchParams(current.search)
    const hasServerParam = params.has("server")
    const query = params.get("server")
    // Treat every server parameter as credential-bearing, including malformed/truncated values.
    // Remove it before validation so secrets never remain in history, screenshots, or Referer.
    if (hasServerParam) replaceUrl(sanitizeServerUrl(current.href))
    const fromUrl = parseServerSpecifier(query ?? "")
    if (fromUrl) {
      captured = fromUrl
    } else {
      captured = parseServerSpecifier(storage.getItem(WEB_SERVER_STORAGE_KEY) ?? "")
    }
  } catch {
    captured = null
  }
  return () => captured
}

export const saveStoredWebServer = (
  raw: string,
  storage: Pick<Storage, "setItem"> = localStorage,
): boolean => {
  if (parseServerSpecifier(raw) === null) return false
  try {
    storage.setItem(WEB_SERVER_STORAGE_KEY, raw)
    return true
  } catch {
    return false
  }
}

export const clearStoredWebServer = (
  storage: Pick<Storage, "removeItem"> = localStorage,
): void => {
  try { storage.removeItem(WEB_SERVER_STORAGE_KEY) } catch { /* unavailable storage is equivalent to cleared */ }
}

export const hasStoredWebServer = (
  storage: Pick<Storage, "getItem"> = localStorage,
): boolean => {
  try { return storage.getItem(WEB_SERVER_STORAGE_KEY) !== null } catch { return false }
}

const initialWebServerInfo = typeof window === "undefined" || typeof localStorage === "undefined"
  ? (): ServerInfo | null => null
  : bootstrapWebServerInfo(
    () => window.location,
    localStorage,
    (url) => window.history.replaceState(window.history.state, "", url),
  )
let sessionWebServerInfo = initialWebServerInfo()

export const setSessionWebServer = (raw: string): boolean => {
  const parsed = parseServerSpecifier(raw)
  if (!parsed) return false
  sessionWebServerInfo = parsed
  return true
}

const webServerInfo = (): ServerInfo | null => sessionWebServerInfo

const readInfo = async (): Promise<ServerInfo | null> => {
  if (!capabilities.daemonDiscovery) return null
  const { invoke } = await import("@tauri-apps/api/core")
  const raw = await invoke<string | null>("read_server_info")
  if (!raw) return null
  try {
    const j = JSON.parse(raw)
    if (typeof j.port === "number" && typeof j.token === "string" && typeof j.pid === "number") return j
    return null
  } catch { return null }
}

export const spawnDaemon = async (): Promise<void> => {
  if (!capabilities.daemonDiscovery || __COOLIE_SERVER_CMD__ === "")
    throw new Error("Web 模式禁止启动 daemon")
  const { invoke } = await import("@tauri-apps/api/core")
  const [program, ...args] = __COOLIE_SERVER_CMD__.split(" ")
  await invoke("spawn_detached", { program, args })
}

export const ensureServer = async (): Promise<ServerInfo> => {
  if (!capabilities.daemonDiscovery) {
    const configured = webServerInfo()
    if (configured && (await probeHealth(configured))) return configured
    throw new Error("Web 模式未配置可用的 loopback server")
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
  capabilities.daemonDiscovery
    ? import("@tauri-apps/api/core").then(({ invoke }) => invoke<boolean>("binary_on_path", { name: "tmux" }))
    : Promise.resolve(true)
