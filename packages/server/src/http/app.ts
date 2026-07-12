import type { IncomingMessage, ServerResponse } from "node:http"
import type { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Exit, Cause, Option } from "effect"
import type { ApiErrorBody } from "@coolie/protocol"
import { ProjectsRepo } from "../repo/projects.js"
import { EventsRepo } from "../repo/events.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { WorkspaceLifecycle } from "../workspace/lifecycle.js"
import { TabsRepo } from "../repo/tabs.js"
import { EngineRegistry } from "../engine/registry.js"
import { tokenEquals } from "./token.js"
import { handleEventsStream } from "./sse.js"
export { newToken } from "./token.js"

// `runtime` runs an AppServices-dependent Effect to completion and hands
// back its `Exit` (never rejects). We deliberately avoid `Effect.runPromise` here:
// its rejection is a FiberFailure wrapper, and probing `e?._tag`/`e?.error?._tag`
// on it is not a reliable way to recover the original TaggedError. Running via
// `Effect.runPromiseExit` and unwrapping with `Exit.match` + `Cause.failureOption`
// (mirrors the pattern already used in test/projects-repo.test.ts) is robust.
export type AppServices = ProjectsRepo | EventsRepo | WorkspacesRepo | WorkspaceLifecycle | TabsRepo | EngineRegistry
export type Runtime = <A, E>(eff: Effect.Effect<A, E, AppServices>) => Promise<Exit.Exit<A, E>>
export interface AppDeps {
  readonly runtime: Runtime
  readonly token: string
  readonly onShutdown: () => void
  /** optional diagnostic hook: called once per HTTP 500 fallback path (defect / unexpected exception). */
  readonly onError?: (e: unknown) => void
  /** SSE live 推送用的进程内事件总线；未提供时 /events/stream 返回 500 */
  readonly bus?: EventEmitter
  /** SSE 心跳间隔（测试注入用），默认 15s */
  readonly sseHeartbeatMs?: number
  /** claude 转录根（标题派生用）；缺省跳过标题派生 */
  readonly claudeHome?: string
}

const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) { res.writeHead(status).end(); return }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}
const err = (res: ServerResponse, status: number, code: ApiErrorBody["code"], message: string) =>
  send(res, status, { code, message } satisfies ApiErrorBody)

// Marks "the request body isn't valid JSON" as a distinct, recoverable failure
// so the outer route catch can map exactly this to 400 Validation — and let
// every other (unexpected) exception fall through to 500 Internal instead of
// being lumped in as a client-input problem.
export class BadJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BadJsonError"
  }
}

export const MAX_BODY_BYTES = 1_048_576
export class BodyTooLargeError extends Error {
  constructor() { super(`request body exceeds ${MAX_BODY_BYTES} bytes`); this.name = "BodyTooLargeError" }
}

const readJson = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    req.setEncoding("utf8")
    let buf = ""
    let bytes = 0
    req.on("data", (c: string) => {
      bytes += Buffer.byteLength(c)
      if (bytes > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError())
        // T1：不能 req.destroy()——撕掉 socket 后 413 无处可写（客户端只见 ECONNRESET）。
        // 卸掉 data 监听并 resume 排空余量；之后 end 的 resolve 在已 reject 的 promise 上是 no-op。
        req.removeAllListeners("data")
        req.resume()
        return
      }
      buf += c
    })
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}) }
      catch (e) { reject(new BadJsonError(e instanceof Error ? e.message : String(e))) }
    })
    req.on("error", reject) // 传输层错误：已 reject 后的二次 reject 为 no-op
  })

const errorFromCause = (
  cause: Cause.Cause<unknown>,
  onError?: (e: unknown) => void,
): { status: number; body: ApiErrorBody } => {
  const failure = Cause.failureOption(cause)
  if (Option.isSome(failure)) {
    const e = failure.value as { _tag?: string; message?: string }
    const message = e.message ?? String(e)
    if (e._tag === "ValidationError") return { status: 400, body: { code: "Validation", message } }
    if (e._tag === "ConflictError") return { status: 409, body: { code: "Conflict", message } }
    if (e._tag === "NotFoundError") return { status: 404, body: { code: "NotFound", message } }
    if (e._tag === "GitError") return { status: 500, body: { code: "GitError", message } }
    if (e._tag === "SetupScriptError") return { status: 500, body: { code: "SetupScriptError", message } }
    if (e._tag === "HookError") return { status: 500, body: { code: "Internal", message } }
    if (e._tag === "TmuxError") return { status: 500, body: { code: "TmuxError", message } }
    if (e._tag === "EngineError") return { status: 500, body: { code: "EngineError", message } }
    return { status: 500, body: { code: "Internal", message } }
  }
  // defect / interruption: no typed failure to recover, fall back to a pretty cause dump
  onError?.(Cause.squash(cause))
  return { status: 500, body: { code: "Internal", message: Cause.pretty(cause) } }
}

const runRoute = async <A, E>(
  res: ServerResponse,
  runtime: Runtime,
  eff: Effect.Effect<A, E, AppServices>,
  onSuccess: (value: A) => void | Promise<void>,
  onError?: (e: unknown) => void,
): Promise<void> => {
  const exit = await runtime(eff)
  await Exit.match(exit, {
    onSuccess,
    onFailure: (cause) => {
      const { status, body } = errorFromCause(cause, onError)
      send(res, status, body)
    },
  })
}

/** 非负整数 query param：缺省→默认值；非法→null（调用方 400）。ledger carry-over：NaN 曾直落 SQLite。 */
const intParam = (url: URL, name: string, dflt: number): number | null => {
  const raw = url.searchParams.get(name)
  if (raw === null) return dflt
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

export const createApp = ({ runtime, token, onShutdown, onError, bus, sseHeartbeatMs, claudeHome }: AppDeps) =>
  (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://local")
      const route = `${req.method} ${url.pathname}`
      if (route === "GET /health") return send(res, 200, { ok: true })

      const got = (req.headers.authorization ?? "").replace(/^Bearer /, "")
      if (!got || !tokenEquals(got, token)) return err(res, 401, "Validation", "missing or bad token")

      try {
        if (route === "POST /shutdown") {
          send(res, 202, { ok: true })
          // The 202 is already on the wire; a throwing onShutdown() must never
          // turn into a second (failing) response write. The daemon owns its
          // own shutdown-error handling — we just swallow it here.
          try { onShutdown() } catch { /* swallow: response already sent */ }
          return
        }
        if (route === "GET /events/stream") {
          if (!bus) return err(res, 500, "Internal", "event bus unavailable")
          const after = intParam(url, "after", 0)
          if (after === null) return err(res, 400, "Validation", "after must be a non-negative integer")
          const ws = url.searchParams.get("workspace")
          return await handleEventsStream(req, res,
            { runtime, bus, ...(sseHeartbeatMs !== undefined ? { heartbeatMs: sseHeartbeatMs } : {}) },
            { after, ...(ws ? { workspaceId: ws } : {}) })
        }
        if (route === "POST /hooks/claude") {
          const wsId = url.searchParams.get("workspace")
          if (!wsId) return err(res, 400, "Validation", "workspace query param required")
          const body = await readJson(req)
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const tabs = yield* TabsRepo
              const registry = yield* EngineRegistry
              const engine = registry.get("claude")
              const tab = engine ? yield* tabs.findEngineTab(wsId) : null
              if (!engine || !tab) return { ok: true } // hook 永远成功：无 tab（已归档/删除）静默吞掉
              yield* tabs.touchHookAt(tab.id, Date.now())
              const status = engine.statusFromHookEvent(body)
              if (status !== null) yield* tabs.setStatus(tab.id, status, "hook")
              const evtName = (body as any)?.hook_event_name
              const evType =
                evtName === "UserPromptSubmit" ? "engine.turn.started"
                : evtName === "Stop" ? "engine.turn.finished"
                : evtName === "Notification" ? "engine.notification"
                : evtName === "SessionEnd" ? "engine.session.ended"
                // SessionStart：Plan3 Task15——冷启动就绪信号，bootstrap 订阅 EventsBus 等它再投首条 prompt
                : evtName === "SessionStart" ? "engine.session.started" : null
              if (evType !== null)
                yield* (yield* EventsRepo).append({ workspaceId: wsId, type: evType, payload: { tabId: tab.id, sessionId: tab.engineSessionId } })
              // historyReader 兜底：首个 turn 完成且尚无标题 → 从转录派生
              if (evtName === "Stop" && tab.title === null && tab.engineSessionId !== null && claudeHome !== undefined) {
                const ws = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
                if (Option.isSome(ws)) {
                  const tp = engine.transcriptPath({ home: claudeHome, cwd: ws.value.path, sessionId: tab.engineSessionId })
                  const title = yield* Effect.sync(() => {
                    try { return engine.deriveTitle(fs.readFileSync(tp, "utf8")) } catch { return null }
                  })
                  if (title !== null) yield* tabs.setTitle(tab.id, title)
                }
              }
              return { ok: true }
            }),
            (r) => send(res, 200, r),
            onError,
          )
        }
        const tabsList = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs$/)
        if (req.method === "GET" && tabsList) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* TabsRepo).listByWorkspace(tabsList[1]!) }),
            (list) => send(res, 200, list),
            onError,
          )
        }
        if (route === "GET /events") {
          const after = intParam(url, "after", 0)
          const limitRaw = intParam(url, "limit", 200)
          if (after === null || limitRaw === null)
            return err(res, 400, "Validation", "after/limit must be non-negative integers")
          const limit = Math.min(limitRaw, 1000)
          const ws = url.searchParams.get("workspace")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* EventsRepo).listAfter({ after, limit, ...(ws ? { workspaceId: ws } : {}) })
            }),
            (events) => send(res, 200, events),
            onError,
          )
        }
        if (route === "GET /projects")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* ProjectsRepo).list() }),
            (list) => send(res, 200, list),
            onError,
          )
        if (route === "POST /projects") {
          const body = await readJson(req)
          if (typeof body.repoRoot !== "string") return err(res, 400, "Validation", "repoRoot required")
          // Never resolve a relative path against this process's own cwd (an
          // accident of wherever the daemon happened to be auto-spawned from)
          // — the client is responsible for sending an already-resolved path.
          if (!path.isAbsolute(body.repoRoot)) return err(res, 400, "Validation", "repoRoot must be absolute")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* ProjectsRepo).add(body.repoRoot) }),
            (p) => send(res, 201, p),
            onError,
          )
        }
        const del = url.pathname.match(/^\/projects\/([^/]+)$/)
        if (req.method === "DELETE" && del) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { yield* (yield* ProjectsRepo).remove(del[1]!) }),
            () => send(res, 204),
            onError,
          )
        }
        if (route === "GET /workspaces") {
          const project = url.searchParams.get("project")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspacesRepo).list(project ? { projectId: project } : {})
            }),
            (list) => send(res, 200, list),
            onError,
          )
        }
        if (route === "POST /workspaces") {
          const body = await readJson(req)
          if (typeof body.projectId !== "string") return err(res, 400, "Validation", "projectId required")
          if (body.branchSlug !== undefined && typeof body.branchSlug !== "string")
            return err(res, 400, "Validation", "branchSlug must be a string")
          if (body.name !== undefined && typeof body.name !== "string")
            return err(res, 400, "Validation", "name must be a string")
          if (body.initialPrompt !== undefined && typeof body.initialPrompt !== "string")
            return err(res, 400, "Validation", "initialPrompt must be a string")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspaceLifecycle).create({
                projectId: body.projectId,
                ...(body.branchSlug ? { branchSlug: body.branchSlug } : {}),
                ...(body.name ? { name: body.name } : {}),
                ...(typeof body.initialPrompt === "string" && body.initialPrompt !== "" ? { initialPrompt: body.initialPrompt } : {}),
              })
            }),
            (ws) => send(res, 201, ws),
            onError,
          )
        }
        const wsAction = url.pathname.match(/^\/workspaces\/([^/]+)\/(archive|unarchive|retry)$/)
        if (req.method === "POST" && wsAction) {
          const id = wsAction[1]!
          const action = wsAction[2]!
          const body = await readJson(req)
          const force = body.force === true
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const lc = yield* WorkspaceLifecycle
              if (action === "archive") return yield* lc.archive(id, { force })
              if (action === "unarchive") return yield* lc.unarchive(id)
              return yield* lc.retry(id)
            }),
            (ws) => send(res, 200, ws),
            onError,
          )
        }
        const wsDel = url.pathname.match(/^\/workspaces\/([^/]+)$/)
        if (req.method === "DELETE" && wsDel) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              yield* (yield* WorkspaceLifecycle).delete(wsDel[1]!, { force: url.searchParams.get("force") === "1" })
            }),
            () => send(res, 204),
            onError,
          )
        }
        return err(res, 404, "NotFound", `no route: ${route}`)
      } catch (e: any) {
        // Headers may already be sent (e.g. a defect surfacing after a prior
        // write in this route) — never attempt a second writeHead.
        if (res.headersSent) return
        if (e instanceof BodyTooLargeError) return err(res, 413, "Validation", e.message)
        if (e instanceof BadJsonError) return err(res, 400, "Validation", e.message)
        onError?.(e)
        return err(res, 500, "Internal", e?.message ?? String(e))
      }
    })().catch(() => { /* last-resort: never let a rejection escape as an unhandled rejection */ })
  }
