import type { IncomingMessage, ServerResponse } from "node:http"
import type { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Exit, Cause, Option } from "effect"
import type { ApiErrorBody } from "@coolie/protocol"
import type { ClientRegistry } from "../daemon/clients.js"
import type { ClientRole } from "@coolie/protocol"
import { ProjectsRepo } from "../repo/projects.js"
import { EventsRepo } from "../repo/events.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { WorkspaceLifecycle } from "../workspace/lifecycle.js"
import { TabsRepo } from "../repo/tabs.js"
import { EngineRegistry } from "../engine/registry.js"
import { ConflictError, NotFoundError } from "../repo/errors.js"
import { tmuxSessionName } from "@coolie/protocol"
import type { ComposerOps, InputMode } from "../tmux/ops.js"
import type { GitReadOps } from "../git/inspect.js"
import { scanSlashCommands } from "../engine/claude/commands.js"
import { SessionEnsurer } from "../workspace/heal.js"
import { tokenEquals } from "./token.js"
import { handleEventsStream } from "./sse.js"
export { newToken } from "./token.js"

// `runtime` runs an AppServices-dependent Effect to completion and hands
// back its `Exit` (never rejects). We deliberately avoid `Effect.runPromise` here:
// its rejection is a FiberFailure wrapper, and probing `e?._tag`/`e?.error?._tag`
// on it is not a reliable way to recover the original TaggedError. Running via
// `Effect.runPromiseExit` and unwrapping with `Exit.match` + `Cause.failureOption`
// (mirrors the pattern already used in test/projects-repo.test.ts) is robust.
export type AppServices = ProjectsRepo | EventsRepo | WorkspacesRepo | WorkspaceLifecycle | TabsRepo | EngineRegistry | SessionEnsurer
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
  /** 只读 git 观察面（GUI）；未提供时相关路由 501 */
  readonly gitRead?: GitReadOps
  /** GET /config 下发的 client 引导信息 */
  readonly config?: { readonly tmuxSocket: string }
  /** role 化 refcount（Plan 4）；未提供时 /clients 500、SSE role 参数忽略（测试友好） */
  readonly clients?: ClientRegistry
  /** composer 投递 / shell tab 动作（tmux 门面）；未提供时相关路由 501 */
  readonly composerOps?: ComposerOps
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

export const createApp = ({ runtime, token, onShutdown, onError, bus, sseHeartbeatMs, claudeHome, gitRead, config, clients, composerOps }: AppDeps) =>
  (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://local")
      const route = `${req.method} ${url.pathname}`
      // CORS：webview/vite-dev 是跨源 origin；token 是唯一安全边界，这里只放行浏览器（agent-deck 姿势）
      // 安全前提见下方 F7 note：* 只在 127.0.0.1 bind + 非 cookie 的 Bearer 认证下成立。
      //
      // F7（安全前提，勿删）：`access-control-allow-origin: *` 之所以安全，仅因为两条前提同时成立：
      // (1) server 绑定 127.0.0.1（非 0.0.0.0），跨机根本连不上；
      // (2) 认证是 Bearer token（非 cookie/session）——`*` 通配下浏览器禁止携带凭据 cookie，
      //     且我们本就不用 cookie，token 由 JS 显式塞进 Authorization 头，CORS 通配不会让第三方站点拿到它。
      // 一旦 bind 从 loopback 放宽（哪怕临时调试），这套 CORS 必须重新设计
      //（收窄 origin 白名单 + 复核 token 暴露面），否则任意网页都能打这个端口。
      res.setHeader("access-control-allow-origin", "*")
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
        }).end()
        return
      }
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
        if (route === "GET /clients") {
          if (!clients) return err(res, 500, "Internal", "client registry unavailable")
          return send(res, 200, {
            clients: clients.list(),
            guiHolders: clients.guiCount(),
            lingerMs: clients.graceMs,
            idleExitArmed: clients.idleExitArmed(),
          })
        }
        if (route === "GET /events/stream") {
          if (!bus) return err(res, 500, "Internal", "event bus unavailable")
          const after = intParam(url, "after", 0)
          if (after === null) return err(res, 400, "Validation", "after must be a non-negative integer")
          const roleRaw = url.searchParams.get("role")
          if (roleRaw !== null && !["gui", "terminal", "cli"].includes(roleRaw))
            return err(res, 400, "Validation", "role must be gui|terminal|cli")
          if (clients && roleRaw !== null) {
            // lease 与连接同生共死：GUI 崩溃 = 连接断 = 自动释放（绝不做显式 unregister API）
            const lease = clients.register(roleRaw as ClientRole, url.searchParams.get("label") ?? undefined)
            req.on("close", () => clients.release(lease.id))
          }
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
              // --resume 会 fork 新 session id：以 hook 上报为真源同步，否则 mtime 轮询/标题派生盯旧转录
              const hookSid = typeof (body as any)?.session_id === "string" && (body as any).session_id !== ""
                ? (body as any).session_id as string : null
              const sid = hookSid ?? tab.engineSessionId
              if (hookSid !== null && tab.engineSessionId !== null && hookSid !== tab.engineSessionId)
                yield* tabs.setEngineSessionId(tab.id, hookSid)
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
                yield* (yield* EventsRepo).append({ workspaceId: wsId, type: evType, payload: { tabId: tab.id, sessionId: sid } })
              // historyReader 兜底：首个 turn 完成且尚无标题 → 从转录派生
              if (evtName === "Stop" && tab.title === null && sid !== null && claudeHome !== undefined) {
                const ws = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
                if (Option.isSome(ws)) {
                  const tp = engine.transcriptPath({ home: claudeHome, cwd: ws.value.path, sessionId: sid })
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
        if (route === "POST /hooks/engine-exit") {
          const wsId = url.searchParams.get("workspace")
          if (!wsId) return err(res, 400, "Validation", "workspace query param required")
          const body = await readJson(req)
          if (!Number.isInteger(body.exitCode)) return err(res, 400, "Validation", "exitCode must be an integer")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const tabs = yield* TabsRepo
              const tab = yield* tabs.findEngineTab(wsId)
              if (!tab) return { ok: true } // 已归档/删除的竞态回报：与 /hooks/claude 同款静默
              yield* tabs.setStatus(tab.id, body.exitCode === 0 ? "idle" : "error", "wrapper")
              yield* (yield* EventsRepo).append({
                workspaceId: wsId, type: "engine.exited",
                payload: { tabId: tab.id, sessionId: tab.engineSessionId, exitCode: body.exitCode },
              })
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
          if (body.engineId !== undefined && typeof body.engineId !== "string")
            return err(res, 400, "Validation", "engineId must be a string")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspaceLifecycle).create({
                projectId: body.projectId,
                ...(body.branchSlug ? { branchSlug: body.branchSlug } : {}),
                ...(body.name ? { name: body.name } : {}),
                ...(typeof body.initialPrompt === "string" && body.initialPrompt !== "" ? { initialPrompt: body.initialPrompt } : {}),
                ...(body.engineId ? { engineId: body.engineId } : {}),
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
        const wsEnsure = url.pathname.match(/^\/workspaces\/([^/]+)\/ensure$/)
        if (req.method === "POST" && wsEnsure) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* SessionEnsurer).ensure(wsEnsure[1]!) }),
            (out) => send(res, 200, out),
            onError,
          )
        }
        const tabResume = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/resume$/)
        if (req.method === "POST" && tabResume) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* SessionEnsurer).resumeTab(tabResume[1]!, tabResume[2]!) }),
            (out) => send(res, 200, out),
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
        if (route === "GET /config") {
          if (!config) return err(res, 500, "Internal", "config unavailable")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const registry = yield* EngineRegistry
              const engines = [...registry.values()].map((e) => ({
                id: e.id,
                displayName: e.displayName,
                capabilities: e.capabilities,
                models: e.models ?? [], // F4：models 可选，缺省下发空数组（fake 引擎无 models）
                ...(e.efforts !== undefined ? { efforts: e.efforts } : {}),
              }))
              return { tmuxSocket: config.tmuxSocket, engines }
            }),
            (body) => send(res, 200, body),
            onError,
          )
        }
        const gitRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/(git\/diffstat|git\/changes|files|commands)$/)
        if (req.method === "GET" && gitRoute) {
          const wsId = gitRoute[1]!
          const kind = gitRoute[2]!
          if (kind !== "commands" && !gitRead) return err(res, 501, "Internal", "gitRead unavailable")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(wsId)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              return ws
            }),
            async (ws) => {
              try {
                if (kind === "git/diffstat") return send(res, 200, await gitRead!.diffstat(ws.path, ws.baseRef))
                if (kind === "git/changes") return send(res, 200, await gitRead!.changes(ws.path, ws.baseRef))
                if (kind === "files") return send(res, 200, { files: await gitRead!.files(ws.path) })
                return send(res, 200, { commands: claudeHome !== undefined ? scanSlashCommands(ws.path, claudeHome) : scanSlashCommands(ws.path, "") })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "GitError", e?.message ?? String(e))
              }
            },
            onError,
          )
        }
        const tabsCreate = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs$/)
        if (req.method === "POST" && tabsCreate) {
          if (!composerOps) return err(res, 501, "Internal", "composerOps unavailable")
          const body = await readJson(req)
          if (body.kind !== "shell") return err(res, 400, "Validation", "只支持 kind=shell")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(tabsCreate[1]!)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              return ws
            }),
            async (ws) => {
              try {
                const idx = await composerOps.newShellWindow(tmuxSessionName(ws.id), ws.path)
                const exit = await runtime(Effect.gen(function* () {
                  return yield* (yield* TabsRepo).insert({ workspaceId: ws.id, kind: "shell", tmuxWindow: idx })
                }))
                Exit.match(exit, {
                  onSuccess: (tab) => send(res, 201, tab),
                  onFailure: (cause) => { const { status, body } = errorFromCause(cause, onError); send(res, status, body) },
                })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
            onError,
          )
        }
        const tabDel = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)$/)
        if (req.method === "DELETE" && tabDel) {
          if (!composerOps) return err(res, 501, "Internal", "composerOps unavailable")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const tab = yield* (yield* TabsRepo).get(tabDel[2]!)
              if (tab.workspaceId !== tabDel[1]!) return yield* new NotFoundError({ message: "tab 不属于该 workspace" })
              if (tab.kind !== "shell")
                return yield* new ConflictError({ message: `只能关 shell tab（当前 ${tab.kind}）` })
              return tab
            }),
            async (tab) => {
              try {
                if (tab.tmuxWindow !== null) await composerOps.killWindow(tmuxSessionName(tab.workspaceId), tab.tmuxWindow)
                await runtime(Effect.gen(function* () { yield* (yield* TabsRepo).remove(tab.id) }))
                send(res, 204)
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
            onError,
          )
        }
        const inputRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/input$/)
        if (req.method === "POST" && inputRoute) {
          if (!composerOps) return err(res, 501, "Internal", "composerOps unavailable")
          const body = await readJson(req)
          const mode = body.mode as InputMode
          if (!["send", "interrupt-send", "insert", "interrupt"].includes(mode))
            return err(res, 400, "Validation", "mode 必须是 send|interrupt-send|insert|interrupt")
          if (typeof body.text !== "string") return err(res, 400, "Validation", "text 必须是 string")
          if (mode !== "interrupt" && body.text.trim() === "")
            return err(res, 400, "Validation", "非 interrupt 模式 text 不能为空")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(inputRoute[1]!)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              const tab = yield* (yield* TabsRepo).findEngineTab(ws.id)
              if (!tab) return yield* new NotFoundError({ message: "无 engine tab" })
              return { ws, tab }
            }),
            async ({ ws, tab }) => {
              try {
                const target = `${tmuxSessionName(ws.id)}:${tab.tmuxWindow ?? 0}`
                await composerOps.input(target, { text: body.text, mode, skipStable: body.skipStable === true })
                await runtime(Effect.gen(function* () {
                  yield* (yield* EventsRepo).append({
                    workspaceId: ws.id, type: "composer.delivered",
                    payload: { mode, tabId: tab.id, chars: body.text.length },
                  })
                }))
                send(res, 200, { ok: true })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
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
