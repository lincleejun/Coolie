import { execFile } from "node:child_process"
import type { EngineAvailability } from "@coolie/protocol"
import { discoverCopilotBinary } from "./binary.js"

/** Split availability probes — binary / version / auth are independent. */
export type CopilotBinaryProbe = {
  readonly available: boolean
  readonly path: string | null
  readonly error: string | null
}

export type CopilotVersionProbe = {
  readonly ok: boolean
  readonly version: string | null
  readonly error: string | null
}

export type CopilotAuthProbe = {
  readonly ok: boolean
  readonly accountHint: string | null
  readonly error: string | null
}

export type CopilotProbeResult = {
  readonly binary: CopilotBinaryProbe
  readonly version: CopilotVersionProbe
  readonly auth: CopilotAuthProbe
}

export type CopilotExec = (argv: readonly string[]) => Promise<string>

const defaultExec: CopilotExec = (argv) => new Promise((resolve, reject) => {
  execFile(argv[0]!, argv.slice(1), { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).trim()))
    else resolve(String(stdout || stderr).trim())
  })
})

export const probeCopilotBinary = (opts?: {
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: (p: string) => boolean
  readonly which?: () => string | null
}): CopilotBinaryProbe => {
  const path = discoverCopilotBinary(opts)
  if (path) return { available: true, path, error: null }
  return { available: false, path: null, error: "copilot binary not found" }
}

export const probeCopilotVersion = async (opts?: {
  readonly binaryPath?: string | null
  readonly exec?: CopilotExec
}): Promise<CopilotVersionProbe> => {
  const bin = opts?.binaryPath ?? discoverCopilotBinary() ?? "copilot"
  const exec = opts?.exec ?? defaultExec
  try {
    const output = await exec([bin, "--version"])
    const version = output.split(/\r?\n/).find(Boolean)?.slice(0, 240) ?? null
    return { ok: true, version, error: null }
  } catch (error) {
    return {
      ok: false,
      version: null,
      error: error instanceof Error ? error.message.slice(0, 240) : String(error),
    }
  }
}

export const probeCopilotAuth = async (opts?: {
  readonly ghArgv?: readonly string[]
  readonly exec?: CopilotExec
}): Promise<CopilotAuthProbe> => {
  const argv = opts?.ghArgv ?? ["gh", "auth", "status"]
  const exec = opts?.exec ?? defaultExec
  try {
    const output = await exec(argv)
    const accountHint = output.split(/\r?\n/).find(Boolean)?.slice(0, 240) ?? null
    return { ok: true, accountHint, error: null }
  } catch (error) {
    return {
      ok: false,
      accountHint: null,
      error: error instanceof Error ? error.message.slice(0, 240) : String(error),
    }
  }
}

/**
 * Probe binary, version, and auth independently.
 * Success never flips Engine capabilities — those stay false/none until verified separately.
 */
export const probeCopilot = async (opts?: {
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: (p: string) => boolean
  readonly which?: () => string | null
  readonly exec?: CopilotExec
  readonly ghArgv?: readonly string[]
}): Promise<CopilotProbeResult> => {
  const binary = probeCopilotBinary(opts)
  const version = binary.available
    ? await probeCopilotVersion({
        binaryPath: binary.path,
        ...(opts?.exec ? { exec: opts.exec } : {}),
      })
    : { ok: false, version: null, error: binary.error }
  const auth = await probeCopilotAuth({
    ...(opts?.ghArgv ? { ghArgv: opts.ghArgv } : {}),
    ...(opts?.exec ? { exec: opts.exec } : {}),
  })
  return { binary, version, auth }
}

/** Flat EngineAvailability for GET /config and UI/CLI product surfaces. */
export const COPILOT_LOGIN_HINT = "Run `gh auth login` to authenticate GitHub Copilot"

export const copilotToEngineAvailability = (
  probe: CopilotProbeResult,
): EngineAvailability => {
  if (!probe.binary.available) {
    return {
      available: false,
      accountHint: null,
      error: probe.binary.error ?? "copilot binary not found",
    }
  }
  if (!probe.version.ok) {
    return {
      available: false,
      accountHint: null,
      error: probe.version.error ?? "copilot version check failed",
    }
  }
  if (!probe.auth.ok) {
    const detail = probe.auth.error ?? "not authenticated"
    return {
      available: false,
      accountHint: null,
      error: detail.includes("gh auth login") ? detail : `${detail}. ${COPILOT_LOGIN_HINT}`,
    }
  }
  return {
    available: true,
    accountHint: probe.auth.accountHint,
    error: null,
  }
}

/** Throw when Copilot must not start a tmux engine session (no auth / missing binary). */
export const assertCopilotReadyToLaunch = async (opts?: {
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: (p: string) => boolean
  readonly which?: () => string | null
  readonly exec?: CopilotExec
  readonly ghArgv?: readonly string[]
}): Promise<void> => {
  const availability = copilotToEngineAvailability(await probeCopilot(opts))
  if (!availability.available) {
    throw new Error(availability.error ?? "Copilot unavailable")
  }
}
