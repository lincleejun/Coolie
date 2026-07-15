import * as fs from "node:fs"
import * as path from "node:path"

export interface UpdateResult {
  readonly status: "disabled" | "current" | "available" | "offline"
  readonly current: string
  readonly latest?: string
  readonly message: string
}

const compare = (left: string, right: string): number => {
  const a = left.replace(/^v/, "").split(".").map(Number)
  const b = right.replace(/^v/, "").split(".").map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export const updateCheckDisabled = (home: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  if (["1", "true", "yes"].includes((env.COOLIE_DISABLE_UPDATE_CHECK ?? "").toLowerCase())) return true
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"))
    return config.updateCheck === false
  } catch { return false }
}

export const checkForUpdate = async (options: {
  current: string
  home: string
  endpoint?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
}): Promise<UpdateResult> => {
  if (updateCheckDisabled(options.home, options.env))
    return { status: "disabled", current: options.current, message: "update check disabled" }
  const endpoint = options.endpoint ?? "https://registry.npmjs.org/@coolie%2fcli/latest"
  try {
    const response = await (options.fetcher ?? fetch)(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(Math.max(100, Math.min(options.timeoutMs ?? 2_000, 10_000))),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as { version?: unknown }
    if (typeof body.version !== "string") throw new Error("missing version")
    const available = compare(options.current, body.version) < 0
    return {
      status: available ? "available" : "current",
      current: options.current,
      latest: body.version,
      message: available ? `update available: ${options.current} -> ${body.version}` : `up to date: ${options.current}`,
    }
  } catch (error) {
    return {
      status: "offline",
      current: options.current,
      message: `update check unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
