import * as fs from "node:fs"
import * as http from "node:http"
import type { CoolieStateSnapshot } from "@coolie/protocol"
import { decodeCoolieStateSnapshot } from "@coolie/protocol"
import type { ServerInfo } from "@coolie/server"
import { ensureServer } from "./client.js"

export type WaitFor = "attention" | "idle" | "error"

export const WAIT_EXIT = {
  matched: 0,
  timeout: 1,
  invalid: 2,
  error: 3,
  aborted: 130,
} as const

export class WaitValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WaitValidationError"
  }
}

const engineTabs = (snapshot: CoolieStateSnapshot, workspaceId: string) =>
  snapshot.tabs.filter((tab) => tab.workspaceId === workspaceId && tab.kind === "engine")

const openAttention = (snapshot: CoolieStateSnapshot, workspaceId: string) =>
  snapshot.openAttention.filter((item) => item.workspaceId === workspaceId && item.state === "open")

/** Parse `--timeout` values like `30s`, `5m`, or plain milliseconds. */
export const parseWaitTimeout = (raw: string): number => {
  const trimmed = raw.trim()
  if (!trimmed) throw new WaitValidationError("timeout is required")
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(trimmed)
  if (!match) throw new WaitValidationError(`invalid timeout: ${raw}`)
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) throw new WaitValidationError(`invalid timeout: ${raw}`)
  const unit = (match[2] ?? "ms").toLowerCase()
  const ms = unit === "s" ? amount * 1_000 : unit === "m" ? amount * 60_000 : amount
  if (!Number.isFinite(ms) || ms <= 0) throw new WaitValidationError(`invalid timeout: ${raw}`)
  return Math.floor(ms)
}

export const matchesWaitCondition = (
  snapshot: CoolieStateSnapshot,
  workspaceId: string,
  waitFor: WaitFor,
): boolean => {
  const tabs = engineTabs(snapshot, workspaceId)
  const attention = openAttention(snapshot, workspaceId)
  switch (waitFor) {
    case "attention":
      return attention.length > 0 || tabs.some((tab) => tab.status === "awaiting-input")
    case "idle":
      return tabs.length > 0 && tabs.every((tab) => tab.status === "idle")
    case "error":
      return tabs.some((tab) => tab.status === "error")
        || attention.some((item) => item.kind === "error")
  }
}

export interface WaitResult {
  ok: boolean
  for: WaitFor
  workspaceId: string
  asOfSeq: number
  generatedAt: number
  reason?: "timeout" | "aborted" | "error"
  message?: string
}

export interface WaitDeps {
  fetchSnapshot: (workspaceId: string) => Promise<CoolieStateSnapshot>
  streamAfter: (
    after: number,
    workspaceId: string,
    onActivity: () => void,
    signal: AbortSignal,
  ) => Promise<void>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  now: () => number
}

const sleepMs = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"))
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException("aborted", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

class SseParser {
  private buf = ""
  feed(chunk: string): number[] {
    this.buf += chunk
    const seqs: number[] = []
    for (;;) {
      const cut = this.buf.indexOf("\n\n")
      if (cut === -1) break
      const block = this.buf.slice(0, cut)
      this.buf = this.buf.slice(cut + 2)
      const dataLines = block.split("\n").filter((line) => line.startsWith("data:"))
      if (dataLines.length === 0) continue
      try {
        const event = JSON.parse(dataLines.map((line) => line.slice(5).trimStart()).join("\n"))
        if (typeof event?.seq === "number") seqs.push(event.seq)
      } catch { /* ignore malformed blocks */ }
    }
    return seqs
  }
}

const rawGet = (
  info: ServerInfo,
  path: string,
  forceTcp: boolean,
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const viaSock = !forceTcp && info.sock !== undefined && fs.existsSync(info.sock)
    const base = viaSock ? { socketPath: info.sock! } : { host: "127.0.0.1", port: info.port }
    const req = http.request({
      ...base,
      path,
      method: "GET",
      headers: { Authorization: `Bearer ${info.token}` },
    }, (res) => {
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { buf += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: buf }))
    })
    req.on("error", reject)
    req.end()
  })

const fetchStateSnapshot = async (workspaceId: string): Promise<CoolieStateSnapshot> => {
  const info = await ensureServer()
  let response: { status: number; text: string }
  try {
    response = await rawGet(info, `/state?workspace=${encodeURIComponent(workspaceId)}`, false)
  } catch {
    response = await rawGet(info, `/state?workspace=${encodeURIComponent(workspaceId)}`, true)
  }
  let json: unknown = {}
  try { json = response.text ? JSON.parse(response.text) : {} } catch { /* keep {} */ }
  if (response.status < 200 || response.status >= 300) {
    const message = typeof (json as { message?: unknown }).message === "string"
      ? (json as { message: string }).message
      : "request failed"
    throw new Error(`${(json as { code?: unknown }).code ?? response.status}: ${message}`)
  }
  return decodeCoolieStateSnapshot(json)
}

const backoffDelay = (attempt: number): number => Math.min(500 * 2 ** attempt, 8_000)

const streamEventsAfter = async (
  after: number,
  workspaceId: string,
  onActivity: () => void,
  signal: AbortSignal,
): Promise<void> => {
  let cursor = after
  let attempt = 0
  while (!signal.aborted) {
    const info = await ensureServer()
    const abort = new AbortController()
    const onParentAbort = (): void => abort.abort()
    signal.addEventListener("abort", onParentAbort, { once: true })
    try {
      let response: Response
      try {
        response = await fetch(
          `http://127.0.0.1:${info.port}/events/stream?after=${cursor}&workspace=${encodeURIComponent(workspaceId)}&role=cli`,
          { headers: { Authorization: `Bearer ${info.token}` }, signal: abort.signal },
        )
      } catch (error) {
        if (signal.aborted) throw error
        await sleepMs(backoffDelay(attempt++), signal)
        continue
      }
      if (!response.ok || !response.body) {
        await sleepMs(backoffDelay(attempt++), signal)
        continue
      }
      attempt = 0
      const parser = new SseParser()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const seq of parser.feed(decoder.decode(value, { stream: true }))) {
          cursor = Math.max(cursor, seq)
          onActivity()
        }
      }
      if (signal.aborted) return
      await sleepMs(backoffDelay(attempt++), signal)
    } finally {
      signal.removeEventListener("abort", onParentAbort)
      abort.abort()
    }
  }
}

export const defaultWaitDeps = (): WaitDeps => ({
  fetchSnapshot: fetchStateSnapshot,
  streamAfter: streamEventsAfter,
  sleep: sleepMs,
  now: () => Date.now(),
})

export const waitForWorkspace = async (options: {
  workspaceId: string
  waitFor: WaitFor
  timeoutMs: number
  signal?: AbortSignal
  deps?: WaitDeps
}): Promise<WaitResult> => {
  const deps = options.deps ?? defaultWaitDeps()
  const deadline = deps.now() + options.timeoutMs
  const parent = options.signal ?? new AbortController().signal
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  parent.addEventListener("abort", onAbort, { once: true })

  const base = {
    for: options.waitFor,
    workspaceId: options.workspaceId,
    asOfSeq: 0,
    generatedAt: 0,
  }

  try {
    let latest = await deps.fetchSnapshot(options.workspaceId)
    if (matchesWaitCondition(latest, options.workspaceId, options.waitFor)) {
      return { ok: true, ...base, asOfSeq: latest.asOfSeq, generatedAt: latest.generatedAt }
    }

    return await new Promise<WaitResult>((resolve) => {
      let finished = false
      let cursor = latest.asOfSeq
      if (parent.aborted) {
        resolve({
          ok: false,
          reason: "aborted",
          ...base,
          asOfSeq: latest.asOfSeq,
          generatedAt: latest.generatedAt,
        })
        return
      }
      const finish = (result: WaitResult): void => {
        if (finished) return
        finished = true
        controller.abort()
        resolve(result)
      }

      const checkSnapshot = (): void => {
        void deps.fetchSnapshot(options.workspaceId).then((snapshot) => {
          latest = snapshot
          cursor = Math.max(cursor, snapshot.asOfSeq)
          if (matchesWaitCondition(snapshot, options.workspaceId, options.waitFor)) {
            finish({ ok: true, ...base, asOfSeq: snapshot.asOfSeq, generatedAt: snapshot.generatedAt })
          }
        }).catch((error) => {
          finish({
            ok: false,
            reason: "error",
            message: error instanceof Error ? error.message : String(error),
            ...base,
            asOfSeq: latest.asOfSeq,
            generatedAt: latest.generatedAt,
          })
        })
      }

      const timer = setInterval(() => {
        if (finished) return
        if (deps.now() >= deadline) {
          finish({
            ok: false,
            reason: "timeout",
            ...base,
            asOfSeq: latest.asOfSeq,
            generatedAt: latest.generatedAt,
          })
        }
      }, 50)

      controller.signal.addEventListener("abort", () => {
        clearInterval(timer)
        if (!finished && parent.aborted) {
          finish({
            ok: false,
            reason: "aborted",
            ...base,
            asOfSeq: latest.asOfSeq,
            generatedAt: latest.generatedAt,
          })
        }
      }, { once: true })

      void deps.streamAfter(cursor, options.workspaceId, checkSnapshot, controller.signal)
        .catch((error) => {
          if (finished || (error instanceof DOMException && error.name === "AbortError")) return
          finish({
            ok: false,
            reason: "error",
            message: error instanceof Error ? error.message : String(error),
            ...base,
            asOfSeq: latest.asOfSeq,
            generatedAt: latest.generatedAt,
          })
        })
        .finally(() => clearInterval(timer))
    })
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      message: error instanceof Error ? error.message : String(error),
      ...base,
    }
  } finally {
    parent.removeEventListener("abort", onAbort)
  }
}
