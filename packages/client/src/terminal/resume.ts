export type TerminalResumeAction = "respawned" | "recreated"

export interface TerminalResumeOutcome {
  readonly action: TerminalResumeAction
}

interface TerminalRecoveryDeps {
  readonly resume: () => Promise<unknown>
  readonly refreshTabs: () => Promise<void>
  readonly reconnect: () => void
}

export interface TerminalRecovery {
  readonly run: () => Promise<TerminalResumeOutcome>
  readonly pending: () => boolean
}

type TerminalKind = "engine" | "setup" | "run" | "shell"
type TerminalConnectionState = "connecting" | "open" | "exited" | "dead"
type TerminalTabStatus = "working" | "awaiting-input" | "error" | "idle"

export const planTerminalRecoveryUi = (
  kind: TerminalKind,
  state: TerminalConnectionState,
  tabStatus: TerminalTabStatus,
): { readonly interrupted: boolean; readonly showResume: boolean } => {
  const disconnected = state === "exited" || state === "dead"
  const interrupted = disconnected || (kind === "engine" && tabStatus === "error")
  return { interrupted, showResume: interrupted && kind === "engine" }
}

const decodeOutcome = (value: unknown): TerminalResumeOutcome => {
  const action = (value as { action?: unknown } | null)?.action
  if (action !== "respawned" && action !== "recreated")
    throw new Error("server 返回了未知的恢复结果")
  return { action }
}

/** Coordinates one engine Resume request without importing React, xterm, or DOM APIs. */
export const createTerminalRecovery = (deps: TerminalRecoveryDeps): TerminalRecovery => {
  let inFlight: Promise<TerminalResumeOutcome> | null = null

  const run = (): Promise<TerminalResumeOutcome> => {
    if (inFlight) return inFlight
    const operation = (async () => {
      const outcome = decodeOutcome(await deps.resume())
      try {
        await deps.refreshTabs()
      } finally {
        deps.reconnect()
      }
      return outcome
    })()
    inFlight = operation.finally(() => { inFlight = null })
    return inFlight
  }

  return { run, pending: () => inFlight !== null }
}

export const readableRecoveryError = (error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error)
  return `恢复失败：${detail || "未知错误"}`
}
