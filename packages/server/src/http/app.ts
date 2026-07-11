import type { IncomingMessage, ServerResponse } from "node:http"
import * as path from "node:path"
import { Effect, Exit, Cause, Option } from "effect"
import type { ApiErrorBody } from "@coolie/protocol"
import { ProjectsRepo } from "../repo/projects.js"
import { EventsRepo } from "../repo/events.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { WorkspaceLifecycle } from "../workspace/lifecycle.js"
import { tokenEquals } from "./token.js"
export { newToken } from "./token.js"

// `runtime` runs an AppServices-dependent Effect to completion and hands
// back its `Exit` (never rejects). We deliberately avoid `Effect.runPromise` here:
// its rejection is a FiberFailure wrapper, and probing `e?._tag`/`e?.error?._tag`
// on it is not a reliable way to recover the original TaggedError. Running via
// `Effect.runPromiseExit` and unwrapping with `Exit.match` + `Cause.failureOption`
// (mirrors the pattern already used in test/projects-repo.test.ts) is robust.
export type AppServices = ProjectsRepo | EventsRepo | WorkspacesRepo | WorkspaceLifecycle
export type Runtime = <A, E>(eff: Effect.Effect<A, E, AppServices>) => Promise<Exit.Exit<A, E>>
export interface AppDeps {
  readonly runtime: Runtime
  readonly token: string
  readonly onShutdown: () => void
  /** optional diagnostic hook: called once per HTTP 500 fallback path (defect / unexpected exception). */
  readonly onError?: (e: unknown) => void
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

const readJson = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    let buf = ""
    req.on("data", (c) => { buf += c })
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}) }
      catch (e) { reject(new BadJsonError(e instanceof Error ? e.message : String(e))) }
    })
    req.on("error", reject)
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

// Fire-and-await an event append, then decide how to respond. We deliberately
// emit *before* sending the route's own success response (never after) so a
// response is never sent twice: if the append effect defects (it has no typed
// error channel — `append`'s Effect.Effect<number> can only fail via an
// unexpected defect), that defect goes through the same errorFromCause 500
// mapping as every other route failure, and the original success response
// (e.g. the created Project) is never written. Only once emit succeeds do we
// call `onEmitted` to send the route's real success response.
const emit = (runtime: Runtime, workspaceId: string | null, type: string, payload: unknown) =>
  runtime(Effect.gen(function* () { return yield* (yield* EventsRepo).append({ workspaceId, type, payload }) }))

const emitThenRespond = async (
  res: ServerResponse,
  runtime: Runtime,
  workspaceId: string | null,
  type: string,
  payload: unknown,
  onEmitted: () => void,
  onError?: (e: unknown) => void,
): Promise<void> => {
  const exit = await emit(runtime, workspaceId, type, payload)
  Exit.match(exit, {
    onSuccess: onEmitted,
    onFailure: (cause) => {
      const { status, body } = errorFromCause(cause, onError)
      send(res, status, body)
    },
  })
}

export const createApp = ({ runtime, token, onShutdown, onError }: AppDeps) =>
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
        if (route === "GET /events") {
          const after = Number(url.searchParams.get("after") ?? "0")
          const limit = Number(url.searchParams.get("limit") ?? "200")
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
            (p) => emitThenRespond(res, runtime, null, "project.added", { id: p.id, repoRoot: p.repoRoot }, () => send(res, 201, p), onError),
            onError,
          )
        }
        const del = url.pathname.match(/^\/projects\/([^/]+)$/)
        if (req.method === "DELETE" && del) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { yield* (yield* ProjectsRepo).remove(del[1]!) }),
            () => emitThenRespond(res, runtime, null, "project.removed", { id: del[1] }, () => send(res, 204), onError),
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
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspaceLifecycle).create({
                projectId: body.projectId,
                ...(body.branchSlug ? { branchSlug: body.branchSlug } : {}),
                ...(body.name ? { name: body.name } : {}),
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
        if (e instanceof BadJsonError) return err(res, 400, "Validation", e.message)
        onError?.(e)
        return err(res, 500, "Internal", e?.message ?? String(e))
      }
    })().catch(() => { /* last-resort: never let a rejection escape as an unhandled rejection */ })
  }
