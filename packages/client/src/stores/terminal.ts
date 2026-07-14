import { create } from "zustand"
import type { TerminalId } from "../terminal/terminals.js"

const K_APP = "coolie.terminalApp"
const K_TEMPLATE = "coolie.terminalCustomArgv"
const K_EXTERNAL = "coolie.externalTermByWs"
const SAFE_ID = /^[A-Za-z0-9._-]+$/
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"])
const TERMINAL_IDS: readonly TerminalId[] = ["iterm2", "terminal", "custom"]

const storage = (): Storage | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage }
  catch { return null }
}
const read = (key: string): string | null => {
  try { return storage()?.getItem(key) ?? null } catch { return null }
}
const write = (key: string, value: string): void => {
  try { storage()?.setItem(key, value) } catch { /* unavailable/quota: retain in-memory state */ }
}

export const coerceTerminalId = (value: unknown): TerminalId =>
  typeof value === "string" && (TERMINAL_IDS as readonly string[]).includes(value)
    ? value as TerminalId
    : "iterm2"

export const parseExternalByWs = (raw: string | null): Record<string, boolean> => {
  if (raw === null) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || Array.isArray(value) || typeof value !== "object") return {}
    const entries = Object.entries(value)
    if (!entries.every(([key, flag]) =>
      SAFE_ID.test(key) && !FORBIDDEN_OBJECT_KEYS.has(key) && flag !== undefined && typeof flag === "boolean"))
      return {}
    return Object.fromEntries(entries) as Record<string, boolean>
  } catch {
    return {}
  }
}

let disposeExternalSessions: (wsId: string) => void = () => {}
/** Terminal.tsx installs the real registry disposer; tests can inject a spy without importing xterm/DOM. */
export const setExternalModeDisposer = (dispose: (wsId: string) => void): void => {
  disposeExternalSessions = dispose
}

interface TerminalState {
  readonly terminalApp: TerminalId
  readonly customTemplate: string
  readonly externalByWs: Record<string, boolean>
  readonly setTerminalApp: (id: TerminalId) => void
  readonly setCustomTemplate: (template: string) => void
  readonly setExternal: (wsId: string, external: boolean) => void
  readonly toggleExternal: (wsId: string) => void
  readonly isExternal: (wsId: string) => boolean
}

export const useTerminal = create<TerminalState>((set, get) => ({
  terminalApp: coerceTerminalId(read(K_APP)),
  customTemplate: read(K_TEMPLATE) ?? "",
  externalByWs: parseExternalByWs(read(K_EXTERNAL)),
  setTerminalApp: (id) => {
    const safe = coerceTerminalId(id)
    write(K_APP, safe)
    set({ terminalApp: safe })
  },
  setCustomTemplate: (customTemplate) => {
    write(K_TEMPLATE, customTemplate)
    set({ customTemplate })
  },
  setExternal: (wsId, external) => {
    if (!SAFE_ID.test(wsId)) return
    const wasExternal = get().externalByWs[wsId] === true
    const next = { ...get().externalByWs, [wsId]: external }
    write(K_EXTERNAL, JSON.stringify(next))
    set({ externalByWs: next })
    if (external && !wasExternal) disposeExternalSessions(wsId)
  },
  toggleExternal: (wsId) => get().setExternal(wsId, !get().isExternal(wsId)),
  isExternal: (wsId) => get().externalByWs[wsId] === true,
}))
