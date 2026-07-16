import type { IncomingMessage, ServerResponse } from "node:http"
import type { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Exit, Cause, Option } from "effect"
import {
  QUEUE_DELIVERY_GUARANTEE,
  type ApiErrorBody,
  type QueueAcceptedResponse,
  type QueueListResponse,
} from "@coolie/protocol"
import type { ClientRegistry } from "../daemon/clients.js"
import type { ClientRole, TaskStatus } from "@coolie/protocol"
import { ProjectsRepo } from "../repo/projects.js"
import { EventsRepo } from "../repo/events.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { WorkspaceLifecycle } from "../workspace/lifecycle.js"
import { TabsRepo } from "../repo/tabs.js"
import { QueueRepo } from "../repo/queue.js"
import { StateRepo } from "../repo/state.js"
import { EngineRegistry, engineHome } from "../engine/registry.js"
import { CustomEngineStore, detectArgvAvailability, detectCustomEngine, copilotPreset } from "../engine/custom-store.js"
import { makeCustomEngine } from "../engine/custom-adapter.js"
import { ConflictError, NotFoundError } from "../repo/errors.js"
import {
  InputReceiptsRepo,
  canonicalInputIdempotencyBody,
  hashInputBody,
  inputReceiptStatus,
} from "../repo/input-receipts.js"
import { tmuxSessionName } from "@coolie/protocol"
import type { ComposerOps, InputMode } from "../tmux/ops.js"
import type { TabsRepoShape } from "../repo/tabs.js"
import { isDiffSection, isSafeRelPath, type DiffSection, type GitReadOps } from "../git/inspect.js"
import type { WorkspaceSerial } from "../engine/queue-drain.js"
import { scanSlashCommands } from "../engine/claude/commands.js"
import { SessionEnsurer } from "../workspace/heal.js"
import { WorkspaceAdopter } from "../workspace/adopt.js"
import { WorkspaceFinisher } from "../workspace/finish.js"
import { MAX_CHECKPOINT_LABEL_LENGTH, WorkspaceCheckpoints } from "../workspace/checkpoint.js"
import { readPrInstructions } from "../workspace/pr-instructions.js"
import { CUSTOM_NAMES_MAX, NAME_MAX_LENGTH, NAME_POOLS } from "../workspace/names.js"
import { tokenEquals } from "./token.js"
import { handleEventsStream } from "./sse.js"
import { readStateSnapshot } from "./state.js"
import type { WorkspaceLayoutState } from "../tmux/layout.js"
import type { BackgroundCollector } from "../collector/background.js"
import type { SessionReadinessShape } from "../engine/readiness.js"
export { newToken } from "./token.js"

// `runtime` runs an AppServices-dependent Effect to completion and hands
// back its `Exit` (never rejects). We deliberately avoid `Effect.runPromise` here:
// its rejection is a FiberFailure wrapper, and probing `e?._tag`/`e?.error?._tag`
// on it is not a reliable way to recover the original TaggedError. Running via
// `Effect.runPromiseExit` and unwrapping with `Exit.match` + `Cause.failureOption`
// (mirrors the pattern already used in test/projects-repo.test.ts) is robust.
export type AppServices = ProjectsRepo | EventsRepo | WorkspacesRepo | WorkspaceLifecycle | TabsRepo | QueueRepo | StateRepo | InputReceiptsRepo | EngineRegistry | CustomEngineStore | SessionEnsurer | WorkspaceAdopter | WorkspaceFinisher | WorkspaceCheckpoints
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
  /** codex 转录根（标题派生用，per-engine）；缺省跳过 codex 标题派生 */
  readonly codexHome?: string
  /** 只读 git 观察面（GUI）；未提供时相关路由 501 */
  readonly gitRead?: GitReadOps
  /** GET /config 下发的 client 引导信息；reposRoot 供 POST /projects/clone 推导默认目标目录 */
  readonly config?: { readonly tmuxSocket: string; readonly reposRoot?: string }
  /** git clone 门面（B2 onboarding：clone repository → 落盘 → 注册为 project）；未提供时 /projects/clone 501。
   *  用注入而非 GitService：clone 是一次性 shell（execFile 数组参无注入面），主 main.ts 提供真实现，测试注入 fake。 */
  readonly cloneRepo?: (url: string, dest: string) => Promise<void>
  /** role 化 refcount（Plan 4）；未提供时 /clients 500、SSE role 参数忽略（测试友好） */
  readonly clients?: ClientRegistry
  /** composer 投递 / shell tab 动作（tmux 门面）；未提供时相关路由 501 */
  readonly composerOps?: ComposerOps
  readonly layoutOps?: {
    readonly reconcile: (workspaceId: string) => Promise<WorkspaceLayoutState>
    readonly setZen: (workspaceId: string, zen: boolean, focusedTabId?: string | null) => Promise<WorkspaceLayoutState>
  }
  /** Serializes queue decisions and delivery for one workspace without blocking others. */
  readonly workspaceSerial?: WorkspaceSerial
  /** Process-local SessionStart gate signaled before workspace serialization. */
  readonly sessionReadiness?: SessionReadinessShape
  /** 图片附件根目录；生产为 COOLIE_HOME/attachments，测试可注入临时目录。 */
  readonly attachmentsDir?: string
  /** Background aggregate collector; omitted in narrow HTTP unit tests. */
  readonly collector?: Pick<BackgroundCollector, "collect" | "snapshots">
}

const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) { res.writeHead(status).end(); return }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}
const err = (res: ServerResponse, status: number, code: ApiErrorBody["code"], message: string) =>
  send(res, status, { code, message } satisfies ApiErrorBody)
const optionalInteger = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isInteger(number) ? number : null
}

/** Exact routing wins. Legacy workspace-only signals are accepted only when one engine tab matches. */
const resolveEngineTabContext = (
  tabs: TabsRepoShape,
  workspaceId: string,
  engineId: string | null,
  context: { readonly tabId?: string | null; readonly sessionId?: string | null; readonly tmuxWindow?: number | null },
) => Effect.gen(function* () {
  const matches = (tab: { workspaceId: string; kind: string; engineId: string | null }): boolean =>
    tab.workspaceId === workspaceId && tab.kind === "engine" && (engineId === null || tab.engineId === engineId)
  if (context.tabId) {
    const candidate = yield* tabs.get(context.tabId).pipe(Effect.option)
    return Option.isSome(candidate) && matches(candidate.value) ? candidate.value : null
  }
  if (context.sessionId) {
    const candidate = yield* tabs.findEngineTabBySession(workspaceId, context.sessionId)
    if (candidate && matches(candidate)) return candidate
    // Resume may fork a new engine session id before the row is updated. A lone matching
    // legacy tab is still unambiguous; multiple siblings must degrade without mutation.
  }
  if (context.tmuxWindow !== null && context.tmuxWindow !== undefined) {
    const candidate = yield* tabs.findTabByWindow(workspaceId, context.tmuxWindow)
    return candidate && matches(candidate) ? candidate : null
  }
  const candidates = (yield* tabs.listEngineTabsByWorkspace(workspaceId)).filter(matches)
  return candidates.length === 1 ? candidates[0]! : null
})

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
  constructor(readonly limit = MAX_BODY_BYTES) {
    super(`request body exceeds ${limit} bytes`)
    this.name = "BodyTooLargeError"
  }
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENT_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 64 * 1024

const readJson = (req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<any> =>
  new Promise((resolve, reject) => {
    req.setEncoding("utf8")
    let buf = ""
    let bytes = 0
    req.on("data", (c: string) => {
      bytes += Buffer.byteLength(c)
      if (bytes > limit) {
        reject(new BodyTooLargeError(limit))
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

const IMAGE_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

const hasPrefix = (data: Buffer, prefix: readonly number[]): boolean =>
  data.length >= prefix.length && prefix.every((byte, index) => data[index] === byte)

export const imageMimeFromMagic = (data: Buffer): string | null => {
  if (hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (hasPrefix(data, [0xff, 0xd8, 0xff])) return "image/jpeg"
  const gif = data.subarray(0, 6).toString("ascii")
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif"
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp"
  return null
}

export const decodeAttachmentBase64 = (encoded: unknown): Buffer | null => {
  if (typeof encoded !== "string" || encoded === "" || encoded.length % 4 !== 0) return null
  // Avoid nested/repeated regexp groups here: multi-megabyte valid inputs can
  // overflow V8's regexp stack. Canonical re-encoding below enforces padding.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null
  const decoded = Buffer.from(encoded, "base64")
  return decoded.toString("base64") === encoded ? decoded : null
}

const writeAttachmentAtomic = (root: string, workspaceId: string, mime: string, data: Buffer): string => {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = path.join(root, workspaceId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("attachment workspace directory must not be a symlink")

  const id = randomUUID()
  const destination = path.join(dir, `${id}.${IMAGE_EXT[mime]}`)
  const temporary = path.join(dir, `.${id}.tmp`)
  let fd: number | undefined
  try {
    fd = fs.openSync(temporary, "wx", 0o600)
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, destination)
    return path.resolve(destination)
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* best-effort temp cleanup below */ }
    }
    try { fs.rmSync(temporary, { force: true }) } catch { /* original write error wins */ }
    throw error
  }
}

const pruneStagedAttachments = (root: string, maxAgeMs = 24 * 60 * 60 * 1000): void => {
  const dir = path.join(root, "staging")
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return }
  const cutoff = Date.now() - maxAgeMs
  for (const name of names) {
    const candidate = path.join(dir, name)
    try {
      const stat = fs.lstatSync(candidate)
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.rmSync(candidate, { force: true })
    } catch { /* best-effort expiry */ }
  }
}

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
    if (e._tag === "FinishOpsError") return { status: 500, body: { code: "GitError", message } }
    if (e._tag === "MergeConflictError") return { status: 409, body: { code: "Conflict", message } }
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

/** 从 clone URL 推导 repo 目录名（basename，去尾 .git / 斜杠，消毒非法字符）。空/`.`/`..` → null（调用方 400）。 */
export const deriveRepoName = (url: string): string | null => {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "")
  const base = trimmed.split(/[/:]/).filter((s) => s !== "").pop() ?? ""
  const name = base.replace(/[^A-Za-z0-9._-]/g, "")
  return name === "" || name === "." || name === ".." ? null : name
}

export const createApp = ({ runtime, token, onShutdown, onError, bus, sseHeartbeatMs, claudeHome, codexHome, gitRead, config, clients, composerOps, layoutOps, workspaceSerial, sessionReadiness, cloneRepo, attachmentsDir, collector }: AppDeps) =>

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
          "access-control-allow-headers": "authorization, content-type, idempotency-key",
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
        if (route === "POST /hooks/engine-exit") {
          const wsId = url.searchParams.get("workspace")
          if (!wsId) return err(res, 400, "Validation", "workspace query param required")
          const body = await readJson(req)
          if (!Number.isInteger(body.exitCode)) return err(res, 400, "Validation", "exitCode must be an integer")
          const handleEngineExit = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
              if (Option.isNone(workspace) || workspace.value.status !== "active") return { ok: true }
              const tabs = yield* TabsRepo
              const tab = yield* resolveEngineTabContext(tabs, wsId, null, {
                tabId: url.searchParams.get("tabId") ?? (typeof body.tabId === "string" ? body.tabId : null),
                sessionId: url.searchParams.get("sessionId") ?? (typeof body.sessionId === "string" ? body.sessionId : null),
                tmuxWindow: optionalInteger(url.searchParams.get("window")) ?? optionalInteger(body.window),
              })
              if (!tab) return { ok: true } // 已归档/删除的竞态回报：与 /hooks/claude 同款静默
              // C3：状态迁移 + engine.exited 事件同事务（避免半写）
              yield* tabs.recordEngineExit(tab.id, wsId, body.exitCode)
              return { ok: true }
            }),
            (r) => send(res, 200, r),
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(wsId, handleEngineExit) : handleEngineExit())
        }
        // 注意：/hooks/engine-exit 的检查必须在本段之前（engine-exit 也匹配 [^/]+）
        const hookRoute = url.pathname.match(/^\/hooks\/([^/]+)$/)
        if (req.method === "POST" && hookRoute && hookRoute[1] !== "engine-exit") {
          const engineId = hookRoute[1]!
          const wsId = url.searchParams.get("workspace")
          if (!wsId) return err(res, 400, "Validation", "workspace query param required")
          const body = await readJson(req)
          // Readiness is process-local and non-mutating. Signal before waiting on the
          // workspace serial lane held by ensure/bootstrap; DB mutations remain guarded below.
          if ((body as any)?.hook_event_name === "SessionStart") sessionReadiness?.signal(wsId)
          const handleHook = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
              if (Option.isNone(workspace) || workspace.value.status !== "active") return { ok: true }
              const tabs = yield* TabsRepo
              const registry = yield* EngineRegistry
              const engine = registry.get(engineId)
              const hookSessionId = typeof (body as any)?.session_id === "string" && (body as any).session_id !== ""
                ? (body as any).session_id as string : null
              const tab = engine ? yield* resolveEngineTabContext(tabs, wsId, engineId, {
                tabId: url.searchParams.get("tabId") ?? (typeof (body as any)?.tabId === "string" ? (body as any).tabId : null),
                sessionId: url.searchParams.get("sessionId") ?? hookSessionId,
                tmuxWindow: optionalInteger(url.searchParams.get("window")) ?? optionalInteger((body as any)?.window),
              }) : null
              if (!engine || !tab) return { ok: true } // 未知引擎/无 tab：hook 永远成功，静默吞
              yield* tabs.touchHookAt(tab.id, Date.now())
              // --resume 会 fork 新 session id：以 hook 上报为真源同步，否则 mtime 轮询/标题派生盯旧转录
              const hookSid = hookSessionId
              const sid = hookSid ?? tab.engineSessionId
              // C4：stored 为 null 也回填（codex 服务端造 id：起始 null，首个 hook 带来真 id）
              if (hookSid !== null && hookSid !== tab.engineSessionId)
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
              // 首个 turn 完成且尚无标题：hook stdin 的 transcript_path 是最精确真源；
              // 旧 hook payload 没带路径时保留按 engine/session 反推的兼容路径。
              if (evtName === "Stop" && tab.title === null && sid !== null) {
                const hookTranscriptPath =
                  typeof (body as any)?.transcript_path === "string" && (body as any).transcript_path !== ""
                    ? (body as any).transcript_path as string
                    : null
                let transcriptPath = hookTranscriptPath
                if (transcriptPath === null) {
                  const home = engineHome(engine.id, { claudeHome: claudeHome ?? "", codexHome: codexHome ?? "" })
                  if (home !== "") {
                    const ws = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
                    if (Option.isSome(ws))
                      transcriptPath = engine.transcriptPath({ home, cwd: ws.value.path, sessionId: sid })
                  }
                }
                if (transcriptPath !== null) {
                  const exactPath = transcriptPath
                  const title = yield* Effect.sync(() => {
                    try { return engine.deriveTitle(fs.readFileSync(exactPath, "utf8")) } catch { return null }
                  })
                  if (title !== null) yield* tabs.setTitle(tab.id, title)
                }
              }
              return { ok: true }
            }),
            (r) => send(res, 200, r),
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(wsId, handleHook) : handleHook())
        }
        const notifyRoute = url.pathname.match(/^\/notify\/([^/]+)$/)
        if (req.method === "POST" && notifyRoute) {
          const engineId = notifyRoute[1]!
          const wsId = url.searchParams.get("workspace")
          if (!wsId) return err(res, 400, "Validation", "workspace query param required")
          const body = await readJson(req)
          // Codex may add other notify events over time; this endpoint is only a turn-complete edge.
          if ((body as any)?.type !== "agent-turn-complete") return send(res, 200, { ok: true })
          const handleNotify = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
              if (Option.isNone(workspace) || workspace.value.status !== "active") return { ok: true }
              const registry = yield* EngineRegistry
              const engine = registry.get(engineId)
              const tabs = yield* TabsRepo
              const notifiedSessionId =
                typeof (body as any)?.["thread-id"] === "string" ? (body as any)["thread-id"]
                : typeof (body as any)?.thread_id === "string" ? (body as any).thread_id
                : typeof (body as any)?.sessionId === "string" ? (body as any).sessionId
                : null
              const tab = engine ? yield* resolveEngineTabContext(tabs, wsId, engineId, {
                tabId: url.searchParams.get("tabId") ?? (typeof (body as any)?.tabId === "string" ? (body as any).tabId : null),
                sessionId: url.searchParams.get("sessionId") ?? notifiedSessionId,
                tmuxWindow: optionalInteger(url.searchParams.get("window")) ?? optionalInteger((body as any)?.window),
              }) : null
              if (!engine || !tab) return { ok: true }
              if (notifiedSessionId !== null && notifiedSessionId !== tab.engineSessionId)
                yield* tabs.setEngineSessionId(tab.id, notifiedSessionId)
              // Notify gets the short authority window and remains distinguishable from native hooks.
              yield* tabs.touchHookAt(tab.id, Date.now())
              yield* tabs.setStatus(tab.id, "awaiting-input", "notify")
              yield* (yield* EventsRepo).append({
                workspaceId: wsId,
                type: "engine.turn.finished",
                payload: { tabId: tab.id, sessionId: notifiedSessionId ?? tab.engineSessionId, source: "notify" },
              })
              return { ok: true }
            }),
            (result) => send(res, 200, result),
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(wsId, handleNotify) : handleNotify())
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
        if (route === "GET /state") {
          const workspaceRaw = url.searchParams.get("workspace")
          const workspaceId = workspaceRaw === null || workspaceRaw === "" ? undefined : workspaceRaw
          return await runRoute(
            res, runtime,
            readStateSnapshot(workspaceId),
            (snapshot) => send(res, 200, snapshot),
            onError,
          )
        }
        if (route === "GET /collect") {
          if (!collector) return err(res, 501, "Internal", "collector unavailable")
          const workspaceId = url.searchParams.get("workspace")
          return send(res, 200, collector.snapshots().filter((snapshot) =>
            workspaceId === null || snapshot.workspaceId === workspaceId))
        }
        if (route === "POST /collect") {
          if (!collector) return err(res, 501, "Internal", "collector unavailable")
          const body = await readJson(req)
          if (body.workspaceId !== undefined && typeof body.workspaceId !== "string")
            return err(res, 400, "Validation", "workspaceId must be a string")
          return send(res, 200, await collector.collect(body.workspaceId))
        }
        if (route === "GET /projects")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* ProjectsRepo).list() }),
            (list) => send(res, 200, list),
            onError,
          )
        const projectBranches = url.pathname.match(/^\/projects\/([^/]+)\/branches$/)
        if (req.method === "GET" && projectBranches) {
          if (!gitRead) return err(res, 501, "Internal", "git branch listing unavailable")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* ProjectsRepo).get(projectBranches[1]!) }),
            async (project) => {
              try {
                send(res, 200, { branches: await gitRead.branches(project.repoRoot) })
              } catch (error) {
                onError?.(error)
                err(res, 500, "GitError", error instanceof Error ? error.message : String(error))
              }
            },
            onError,
          )
        }
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
        if (route === "POST /projects/clone") {
          if (!cloneRepo) return err(res, 501, "Internal", "clone 不可用")
          const body = await readJson(req)
          if (typeof body.url !== "string" || body.url.trim() === "") return err(res, 400, "Validation", "url required")
          const cloneUrl = body.url.trim()
          // arg-injection 防御：execFile 数组参已挡 shell 注入，但 `-` 开头会被 git 当 flag——显式回绝
          if (cloneUrl.startsWith("-")) return err(res, 400, "Validation", "url 非法（不能以 - 开头）")
          if (body.dest !== undefined && (typeof body.dest !== "string" || !path.isAbsolute(body.dest)))
            return err(res, 400, "Validation", "dest 必须是绝对路径")
          const name = deriveRepoName(cloneUrl)
          if (body.dest === undefined && name === null)
            return err(res, 400, "Validation", "无法从 url 推导仓库名，请显式提供 dest")
          const reposRoot = config?.reposRoot
          if (body.dest === undefined && !reposRoot) return err(res, 500, "Internal", "reposRoot 未配置")
          const dest = (body.dest as string | undefined) ?? path.join(reposRoot!, name!)
          if (fs.existsSync(dest)) return err(res, 409, "Conflict", `目标目录已存在：${dest}`)
          try {
            await cloneRepo(cloneUrl, dest)
          } catch (e: any) {
            return err(res, 500, "GitError", `git clone 失败：${e?.message ?? String(e)}`)
          }
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* ProjectsRepo).add(dest) }),
            (p) => send(res, 201, p),
            onError,
          )
        }
        const adoptable = url.pathname.match(/^\/projects\/([^/]+)\/worktrees\/adoptable$/)
        if (req.method === "GET" && adoptable) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* WorkspaceAdopter).list(adoptable[1]!) }),
            (items) => send(res, 200, items),
            onError,
          )
        }
        const adopt = url.pathname.match(/^\/projects\/([^/]+)\/worktrees\/adopt$/)
        if (req.method === "POST" && adopt) {
          const body = await readJson(req)
          if (typeof body.path !== "string") return err(res, 400, "Validation", "path required")
          if (body.name !== undefined && typeof body.name !== "string")
            return err(res, 400, "Validation", "name must be a string")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspaceAdopter).adopt({
                projectId: adopt[1]!, path: body.path, ...(body.name !== undefined ? { name: body.name } : {}),
              })
            }),
            (ws) => send(res, 201, ws),
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
        const wsGet = url.pathname.match(/^\/workspaces\/([^/]+)$/)
        if (req.method === "GET" && wsGet) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(wsGet[1]!) }),
            (workspace) => send(res, 200, workspace),
            onError,
          )
        }
        if (route === "POST /workspaces") {
          const body = await readJson(req)
          if (typeof body.projectId !== "string") return err(res, 400, "Validation", "projectId required")
          if (body.branchSlug !== undefined && typeof body.branchSlug !== "string")
            return err(res, 400, "Validation", "branchSlug must be a string")
          if (body.baseBranch !== undefined && typeof body.baseBranch !== "string")
            return err(res, 400, "Validation", "baseBranch must be a string")
          if (body.name !== undefined && typeof body.name !== "string")
            return err(res, 400, "Validation", "name must be a string")
          if (body.initialPrompt !== undefined && typeof body.initialPrompt !== "string")
            return err(res, 400, "Validation", "initialPrompt must be a string")
          if (body.engineId !== undefined && typeof body.engineId !== "string")
            return err(res, 400, "Validation", "engineId must be a string")
          if (body.model !== undefined && typeof body.model !== "string")
            return err(res, 400, "Validation", "model must be a string")
          if (body.effort !== undefined && typeof body.effort !== "string")
            return err(res, 400, "Validation", "effort must be a string")
          if (body.fanoutGroup !== undefined && typeof body.fanoutGroup !== "string")
            return err(res, 400, "Validation", "fanoutGroup must be a string")
          const poolIds = new Set([...NAME_POOLS.map((pool) => pool.id), "custom"])
          if (body.namePool !== undefined && (typeof body.namePool !== "string" || !poolIds.has(body.namePool)))
            return err(res, 400, "Validation", `namePool must be one of ${[...poolIds].join("|")}`)
          if (body.customNames !== undefined && body.namePool !== "custom")
            return err(res, 400, "Validation", "customNames is only valid with namePool=custom")
          if (body.namePool === "custom" && body.customNames === undefined && body.name === undefined)
            return err(res, 400, "Validation", "customNames is required with namePool=custom")
          if (body.customNames !== undefined) {
            if (!Array.isArray(body.customNames) || body.customNames.some((value: unknown) => typeof value !== "string"))
              return err(res, 400, "Validation", "customNames must be an array of strings")
            if (body.customNames.length > CUSTOM_NAMES_MAX)
              return err(res, 400, "Validation", `customNames may contain at most ${CUSTOM_NAMES_MAX} items`)
            if (body.customNames.some((value: string) => value.length > NAME_MAX_LENGTH))
              return err(res, 400, "Validation", `custom names may contain at most ${NAME_MAX_LENGTH} characters`)
          }
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspaceLifecycle).createIntent({
                projectId: body.projectId,
                ...(body.branchSlug ? { branchSlug: body.branchSlug } : {}),
                ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
                ...(body.name ? { name: body.name } : {}),
                ...(typeof body.initialPrompt === "string" && body.initialPrompt !== "" ? { initialPrompt: body.initialPrompt } : {}),
                ...(body.engineId ? { engineId: body.engineId } : {}),
                ...(body.model ? { model: body.model } : {}),
                ...(body.effort ? { effort: body.effort } : {}),
                ...(body.fanoutGroup ? { fanoutGroup: body.fanoutGroup } : {}),
                ...(body.namePool ? { namePool: body.namePool } : {}),
                ...(body.customNames !== undefined ? { customNames: body.customNames } : {}),
              })
            }),
            (ws) => send(res, 201, ws),
            onError,
          )
        }
        if (route === "POST /workspaces/reorder") {
          const body = await readJson(req)
          if (body === null || typeof body !== "object" || Array.isArray(body) ||
            typeof body.projectId !== "string" || !Array.isArray(body.workspaceIds) ||
            body.workspaceIds.some((id: unknown) => typeof id !== "string"))
            return err(res, 400, "Validation", "projectId 与 workspaceIds[] 必填")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspaceLifecycle).reorder(body.projectId, body.workspaceIds)
            }),
            (items) => send(res, 200, items),
            onError,
          )
        }
        const wsMetadata = url.pathname.match(/^\/workspaces\/([^/]+)\/(rename|task-status|branch)$/)
        if (req.method === "POST" && wsMetadata) {
          const body = await readJson(req)
          if (body === null || typeof body !== "object" || Array.isArray(body))
            return err(res, 400, "Validation", "body must be an object")
          const action = wsMetadata[2]!
          if (action === "rename" && typeof body.name !== "string")
            return err(res, 400, "Validation", "name required")
          const taskStatuses = new Set<TaskStatus>(["backlog", "in_progress", "in_review", "done", "canceled", "error"])
          if (action === "task-status" && !taskStatuses.has(body.status))
            return err(res, 400, "Validation", "status must be backlog|in_progress|in_review|done|canceled|error")
          if (action === "branch" && typeof body.branch !== "string")
            return err(res, 400, "Validation", "branch required")
          const workspaceId = wsMetadata[1]!
          const handleMetadata = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(workspaceId)
              if (workspace.status === "archiving")
                return yield* new ConflictError({ message: "workspace 正在归档，不能修改 metadata" })
              const lifecycle = yield* WorkspaceLifecycle
              if (action === "rename") return yield* lifecycle.rename(workspaceId, body.name)
              if (action === "task-status")
                return yield* lifecycle.setTaskStatus(workspaceId, body.status as TaskStatus)
              return yield* lifecycle.renameBranch(workspaceId, body.branch)
            }),
            (workspace) => send(res, 200, workspace),
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(workspaceId, handleMetadata) : handleMetadata())
        }
        const wsPin = url.pathname.match(/^\/workspaces\/([^/]+)\/pin$/)
        if (req.method === "POST" && wsPin) {
          const body = await readJson(req)
          if (
            body === null ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).length !== 1 ||
            typeof body.pinned !== "boolean"
          )
            return err(res, 400, "Validation", "body 必须严格为 { pinned: boolean }")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspacesRepo).setPinned(wsPin[1]!, body.pinned)
            }),
            (ws) => send(res, 200, ws),
            onError,
          )
        }
        const wsAction = url.pathname.match(/^\/workspaces\/([^/]+)\/(archive|unarchive|retry)$/)
        if (req.method === "POST" && wsAction) {
          const id = wsAction[1]!
          const action = wsAction[2]!
          const body = await readJson(req)
          const force = body.force === true
          const handleAction = () => runRoute(
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
          // Archive shares the input/queue serial lane: already-started delivery completes first,
          // then status=archiving freezes every later delivery before runtime teardown.
          return await (workspaceSerial
            ? workspaceSerial.run(id, handleAction)
            : handleAction())
        }
        const wsEnsure = url.pathname.match(/^\/workspaces\/([^/]+)\/ensure$/)
        if (req.method === "POST" && wsEnsure) {
          const workspaceId = wsEnsure[1]!
          const handleEnsure = () => runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).ensure(workspaceId) }),
            (out) => send(res, 200, out),
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(workspaceId, handleEnsure) : handleEnsure())
        }
        const wsFinish = url.pathname.match(/^\/workspaces\/([^/]+)\/finish$/)
        if (req.method === "POST" && wsFinish) {
          const body = await readJson(req)
          if (body.createPr !== undefined && typeof body.createPr !== "boolean")
            return err(res, 400, "Validation", "createPr must be boolean")
          if (body.mergeBack !== undefined && typeof body.mergeBack !== "boolean")
            return err(res, 400, "Validation", "mergeBack must be boolean")
          if (body.title !== undefined && typeof body.title !== "string")
            return err(res, 400, "Validation", "title must be string")
          if (body.body !== undefined && typeof body.body !== "string")
            return err(res, 400, "Validation", "body must be string")
          const workspaceId = wsFinish[1]!
          const handleFinish = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(workspaceId)
              if (workspace.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${workspace.status}）` })
              return yield* (yield* WorkspaceFinisher).finish(workspaceId, body)
            }),
            (outcome) => send(res, 200, outcome),
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(workspaceId, handleFinish) : handleFinish())
        }
        const checkpointCollection = url.pathname.match(/^\/workspaces\/([^/]+)\/checkpoints$/)
        if (checkpointCollection && (req.method === "GET" || req.method === "POST")) {
          const workspaceId = checkpointCollection[1]!
          if (req.method === "GET")
            return await runRoute(
              res, runtime,
              Effect.gen(function* () { return yield* (yield* WorkspaceCheckpoints).list(workspaceId) }),
              (items) => send(res, 200, items),
              onError,
            )
          const body = await readJson(req)
          if (body === null || typeof body !== "object" || Array.isArray(body))
            return err(res, 400, "Validation", "body must be an object")
          if (body.label !== undefined && typeof body.label !== "string")
            return err(res, 400, "Validation", "label must be a string")
          if (typeof body.label === "string" && body.label.length > MAX_CHECKPOINT_LABEL_LENGTH)
            return err(res, 400, "Validation", `label 最长 ${MAX_CHECKPOINT_LABEL_LENGTH} 字符`)
          if (typeof body.label === "string" && /[\x00-\x1f\x7f]/.test(body.label))
            return err(res, 400, "Validation", "label 不能包含控制字符")
          const handleCheckpointCreate = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspaceCheckpoints).create(
                workspaceId,
                body.label as string | undefined,
              )
            }),
            (item) => send(res, 201, item),
            onError,
          )
          return await (workspaceSerial
            ? workspaceSerial.run(workspaceId, handleCheckpointCreate)
            : handleCheckpointCreate())
        }
        const checkpointItem = url.pathname.match(/^\/workspaces\/([^/]+)\/checkpoints\/([^/]+)$/)
        if (req.method === "DELETE" && checkpointItem) {
          const workspaceId = checkpointItem[1]!
          const handleCheckpointDelete = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              yield* (yield* WorkspaceCheckpoints).delete(workspaceId, checkpointItem[2]!)
            }),
            () => send(res, 204),
            onError,
          )
          return await (workspaceSerial
            ? workspaceSerial.run(workspaceId, handleCheckpointDelete)
            : handleCheckpointDelete())
        }
        const tabResume = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/resume$/)
        if (req.method === "POST" && tabResume) {
          const handleResume = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(tabResume[1]!)
              if (workspace.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${workspace.status}）` })
              return yield* (yield* SessionEnsurer).resumeTab(tabResume[1]!, tabResume[2]!)
            }),
            (out) => send(res, 200, out),
            onError,
          )
          return await (workspaceSerial
            ? workspaceSerial.run(tabResume[1]!, handleResume)
            : handleResume())
        }
        const tabRename = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/rename$/)
        if (req.method === "POST" && tabRename) {
          const body = await readJson(req)
          if (typeof body.title !== "string" || body.title.trim() === "")
            return err(res, 400, "Validation", "title 必须是非空 string")
          const workspaceId = tabRename[1]!
          const handleTabRename = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(workspaceId)
              if (workspace.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${workspace.status}）` })
              const tabs = yield* TabsRepo
              const tab = yield* tabs.get(tabRename[2]!)
              if (tab.workspaceId !== workspaceId) return yield* new NotFoundError({ message: "tab 不属于该 workspace" })
              yield* tabs.setTitle(tab.id, body.title.trim())
              return yield* tabs.get(tab.id)
            }),
            (tab) => send(res, 200, tab),
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(workspaceId, handleTabRename) : handleTabRename())
        }
        const zenRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/zen$/)
        if (req.method === "POST" && zenRoute) {
          if (!layoutOps) return err(res, 501, "Internal", "tmux layout unavailable")
          const body = await readJson(req)
          if (body.zen !== undefined && typeof body.zen !== "boolean")
            return err(res, 400, "Validation", "zen 必须是 boolean")
          if (body.tabId !== undefined && typeof body.tabId !== "string")
            return err(res, 400, "Validation", "tabId 必须是 string")
          const workspaceId = zenRoute[1]!
          const handleZen = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(workspaceId)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              if (typeof body.tabId === "string") {
                const tab = yield* (yield* TabsRepo).get(body.tabId)
                if (tab.workspaceId !== ws.id || tab.kind !== "engine")
                  return yield* new ConflictError({ message: "zen 只能聚焦该 workspace 的 engine tab" })
              }
              return {
                workspaceId: ws.id,
                zen: typeof body.zen === "boolean" ? body.zen : !ws.zenMode,
                tabId: typeof body.tabId === "string" ? body.tabId : null,
              }
            }),
            async (input) => {
              try { send(res, 200, await layoutOps.setZen(input.workspaceId, input.zen, input.tabId)) }
              catch (error) {
                onError?.(error)
                if (!res.headersSent) err(res, 500, "TmuxError", error instanceof Error ? error.message : String(error))
              }
            },
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(workspaceId, handleZen) : handleZen())
        }
        const wsDel = url.pathname.match(/^\/workspaces\/([^/]+)$/)
        if (req.method === "DELETE" && wsDel) {
          const workspaceId = wsDel[1]!
          const handleWorkspaceDelete = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              yield* (yield* WorkspaceLifecycle).delete(workspaceId, { force: url.searchParams.get("force") === "1" })
            }),
            () => send(res, 204),
            onError,
          )
          return await (workspaceSerial
            ? workspaceSerial.run(workspaceId, handleWorkspaceDelete)
            : handleWorkspaceDelete())
        }
        const attachmentRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/attachments$/)
        const stagingAttachmentRoute = url.pathname === "/attachments"
        if (req.method === "POST" && (attachmentRoute || stagingAttachmentRoute)) {
          if (!attachmentsDir) return err(res, 501, "Internal", "attachments unavailable")
          const body = await readJson(req, MAX_ATTACHMENT_BODY_BYTES)
          if (body === null || typeof body !== "object" || Array.isArray(body))
            return err(res, 400, "Validation", "body must describe one attachment")
          if (typeof body.name !== "string" || typeof body.mime !== "string" || typeof body.dataBase64 !== "string")
            return err(res, 400, "Validation", "name, mime and dataBase64 are required strings")
          if (!Object.hasOwn(IMAGE_EXT, body.mime)) return err(res, 400, "Validation", "unsupported image mime")
          const data = decodeAttachmentBase64(body.dataBase64)
          if (data === null) return err(res, 400, "Validation", "dataBase64 is not canonical base64")
          if (data.byteLength > MAX_ATTACHMENT_BYTES)
            return err(res, 413, "Validation", `attachment exceeds ${MAX_ATTACHMENT_BYTES} decoded bytes`)
          const detectedMime = imageMimeFromMagic(data)
          if (detectedMime === null || detectedMime !== body.mime)
            return err(res, 400, "Validation", "image magic bytes do not match mime")
          if (stagingAttachmentRoute) {
            try {
              pruneStagedAttachments(attachmentsDir)
              const attachmentPath = writeAttachmentAtomic(attachmentsDir, "staging", detectedMime, data)
              return send(res, 201, { path: attachmentPath, mime: detectedMime, size: data.byteLength })
            } catch (error) {
              return err(res, 500, "Internal", error instanceof Error ? error.message : String(error))
            }
          }
          return await runRoute(
            res,
            runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(attachmentRoute![1]!)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              return ws
            }),
            async (ws) => {
              try {
                const attachmentPath = writeAttachmentAtomic(attachmentsDir, ws.id, detectedMime, data)
                send(res, 201, { path: attachmentPath, mime: detectedMime, size: data.byteLength })
              } catch (error) {
                if (!res.headersSent) err(res, 500, "Internal", error instanceof Error ? error.message : String(error))
              }
            },
            onError,
          )
        }
        if (route === "GET /engines/custom") {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* CustomEngineStore).list() }),
            (items) => send(res, 200, items),
            onError,
          )
        }
        if (route === "POST /engines/custom") {
          const body = await readJson(req)
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const definition = yield* (yield* CustomEngineStore).put(body)
              const registry = yield* EngineRegistry
              if (definition.enabled) (registry as Map<string, any>).set(definition.id, makeCustomEngine(definition))
              else (registry as Map<string, any>).delete(definition.id)
              return definition
            }),
            (definition) => send(res, 200, definition),
            onError,
          )
        }
        if (route === "POST /engines/custom/presets/copilot") {
          const body = await readJson(req)
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const definition = yield* (yield* CustomEngineStore).put(copilotPreset(
                typeof body.id === "string" ? body.id : "copilot",
              ))
              const registry = yield* EngineRegistry
              ;(registry as Map<string, any>).set(definition.id, makeCustomEngine(definition))
              return definition
            }),
            (definition) => send(res, 201, definition),
            onError,
          )
        }
        const customDetect = url.pathname.match(/^\/engines\/custom\/([^/]+)\/detect$/)
        if (req.method === "POST" && customDetect) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const definition = yield* (yield* CustomEngineStore).get(customDetect[1]!)
              return yield* Effect.promise(() => detectCustomEngine(definition))
            }),
            (result) => send(res, 200, result),
            onError,
          )
        }
        const customItem = url.pathname.match(/^\/engines\/custom\/([^/]+)$/)
        if (req.method === "DELETE" && customItem) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              yield* (yield* CustomEngineStore).remove(customItem[1]!)
              const registry = yield* EngineRegistry
              ;(registry as Map<string, any>).delete(customItem[1]!)
            }),
            () => send(res, 204),
            onError,
          )
        }
        const switchRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/engine$/)
        if (req.method === "POST" && switchRoute) {
          const body = await readJson(req)
          if (typeof body.engineId !== "string") return err(res, 400, "Validation", "engineId 必填")
          const action = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(switchRoute[1]!)
              if (workspace.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${workspace.status}）` })
              const tabs = yield* TabsRepo
              const selected = typeof body.tabId === "string"
                ? yield* tabs.get(body.tabId)
                : yield* tabs.findEngineTab(switchRoute[1]!)
              if (!selected || selected.workspaceId !== switchRoute[1]! || selected.kind !== "engine")
                return yield* new NotFoundError({ message: "engine tab 不存在" })
              return yield* (yield* SessionEnsurer).switchEngine(switchRoute[1]!, selected.id, body.engineId, {
                ...(typeof body.model === "string" ? { model: body.model } : {}),
                ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
              })
            }),
            (result) => send(res, 200, result),
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(switchRoute[1]!, action) : action())
        }
        if (route === "GET /config") {
          if (!config) return err(res, 500, "Internal", "config unavailable")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const registry = yield* EngineRegistry
              const customStore = yield* Effect.serviceOption(CustomEngineStore)
              const definitions = Option.isSome(customStore) ? yield* customStore.value.list() : []
              const byId = new Map(definitions.map((definition) => [definition.id, definition]))
              const availability = yield* Effect.promise(async () => new Map(await Promise.all(
                [...registry.values()].map(async (engine) => {
                  const definition = byId.get(engine.id)
                  return [engine.id, definition
                    ? await detectCustomEngine(definition)
                    : await detectArgvAvailability([engine.id, "--version"])] as const
                }),
              )))
              const engines: any[] = [...registry.values()].map((e) => ({
                id: e.id,
                displayName: e.displayName,
                capabilities: e.capabilities,
                models: e.models ?? [], // F4：models 可选，缺省下发空数组（fake 引擎无 models）
                ...(e.modelEfforts !== undefined ? { modelEfforts: e.modelEfforts } : {}),
                ...(e.efforts !== undefined ? { efforts: e.efforts } : {}),
                custom: byId.has(e.id),
                enabled: true,
                presetId: byId.get(e.id)?.presetId ?? null,
                availability: availability.get(e.id) ?? { available: false, accountHint: null, error: "not detected" },
                ...(byId.has(e.id) ? { definition: byId.get(e.id) } : {}),
              }))
              for (const definition of definitions) if (!definition.enabled) engines.push({
                id: definition.id, displayName: definition.displayName, capabilities: definition.capabilities,
                models: definition.models ?? [], ...(definition.efforts ? { efforts: definition.efforts } : {}),
                custom: true, enabled: false, presetId: definition.presetId ?? null,
                availability: { available: false, accountHint: null, error: "disabled" }, definition,
              })
              return {
                tmuxSocket: config.tmuxSocket,
                engines,
                namePools: [
                  ...NAME_POOLS.map(({ id, displayName }) => ({ id, displayName })),
                  { id: "custom", displayName: "Custom" },
                ],
              }
            }),
            (body) => send(res, 200, body),
            onError,
          )
        }
        const gitRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/(git\/diffstat|git\/changes|git\/diff|files|commands|pr-instructions)$/)
        if (req.method === "GET" && gitRoute) {
          const wsId = gitRoute[1]!
          const kind = gitRoute[2]!
          if (kind !== "commands" && kind !== "pr-instructions" && !gitRead) return err(res, 501, "Internal", "gitRead unavailable")
          // Validate request-controlled diff arguments before workspace lookup/status checks.
          let diffSection: DiffSection = "againstBase"
          let diffPath = ""
          if (kind === "git/diff") {
            const section = url.searchParams.get("section") ?? ""
            diffPath = url.searchParams.get("path") ?? ""
            if (!isDiffSection(section))
              return err(res, 400, "Validation", "section 必须是 againstBase|committed|staged|unstaged")
            if (diffPath === "") return err(res, 400, "Validation", "path required")
            if (!isSafeRelPath(diffPath))
              return err(res, 400, "Validation", "path 非法（禁绝对路径 / .. 穿越 / 前导 -）")
            diffSection = section
          }
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
                // Main tasks inspect the checked-out HEAD itself. "HEAD" also keeps
                // pre-m0007 rows with an empty/branch-name baseRef readable.
                const baseRef = ws.kind === "main" ? "HEAD" : ws.baseRef
                if (kind === "git/diffstat") return send(res, 200, await gitRead!.diffstat(ws.path, baseRef))
                if (kind === "git/changes") return send(res, 200, await gitRead!.changes(ws.path, baseRef))
                if (kind === "git/diff") return send(res, 200, await gitRead!.diff(ws.path, baseRef, diffSection, diffPath))
                if (kind === "files") return send(res, 200, { files: await gitRead!.files(ws.path) })
                if (kind === "pr-instructions") return send(res, 200, readPrInstructions(ws.path))
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
          const body = await readJson(req)
          if (body.kind === "engine") {
            if (typeof body.engineId !== "string") return err(res, 400, "Validation", "engineId 必填")
            const action = () => runRoute(
              res, runtime,
              Effect.gen(function* () {
                const workspace = yield* (yield* WorkspacesRepo).get(tabsCreate[1]!)
                if (workspace.status !== "active")
                  return yield* new ConflictError({ message: `workspace 非 active（当前 ${workspace.status}）` })
                const outcome = yield* (yield* SessionEnsurer).createEngineTab(tabsCreate[1]!, body.engineId, {
                  ...(typeof body.model === "string" ? { model: body.model } : {}),
                  ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
                  ...(typeof body.title === "string" && body.title.trim() !== "" ? { title: body.title.trim() } : {}),
                })
                return yield* (yield* TabsRepo).get(outcome.tabId!)
              }),
              (tab) => send(res, 201, tab),
              onError,
            )
            return await (workspaceSerial ? workspaceSerial.run(tabsCreate[1]!, action) : action())
          }
          if (!composerOps) return err(res, 501, "Internal", "composerOps unavailable")
          if (body.kind !== "shell") return err(res, 400, "Validation", "kind 必须是 engine|shell")
          const handleTabsCreate = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(tabsCreate[1]!)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              return ws
            }),
            async (ws) => {
              try {
                const session = tmuxSessionName(ws.id)
                const idx = await composerOps.newShellWindow(session, ws.path)
                const exit = await runtime(Effect.gen(function* () {
                  return yield* (yield* TabsRepo).insert({ workspaceId: ws.id, kind: "shell", tmuxWindow: idx })
                }))
                await Exit.match(exit, {
                  onSuccess: async (tab) => {
                    await layoutOps?.reconcile(ws.id)
                    send(res, 201, tab)
                  },
                  onFailure: async (cause) => {
                    // The tmux operation has committed but the DB operation has not.
                    // Compensation is best-effort; the HTTP response must retain the
                    // original insert failure even if killing the window also fails.
                    try { await composerOps.killWindow(session, idx) } catch { /* original error wins */ }
                    const { status, body } = errorFromCause(cause, onError)
                    send(res, status, body)
                  },
                })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
            onError,
          )
          return await (workspaceSerial
            ? workspaceSerial.run(tabsCreate[1]!, handleTabsCreate)
            : handleTabsCreate())
        }
        const tabDel = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)$/)
        if (req.method === "DELETE" && tabDel) {
          if (!composerOps) return err(res, 501, "Internal", "composerOps unavailable")
          const workspaceId = tabDel[1]!
          const handleTabDelete = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(workspaceId)
              if (workspace.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${workspace.status}）` })
              const tab = yield* (yield* TabsRepo).get(tabDel[2]!)
              if (tab.workspaceId !== workspaceId) return yield* new NotFoundError({ message: "tab 不属于该 workspace" })
              if (tab.kind !== "shell" && tab.kind !== "engine")
                return yield* new ConflictError({ message: `只能关 shell/engine tab（当前 ${tab.kind}）` })
              if (tab.kind === "engine") {
                const engineTabs = yield* (yield* TabsRepo).listEngineTabsByWorkspace(tab.workspaceId)
                if (engineTabs.length <= 1)
                  return yield* new ConflictError({ message: "不能关闭最后一个 engine tab" })
              }
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
          return await (workspaceSerial ? workspaceSerial.run(workspaceId, handleTabDelete) : handleTabDelete())
        }
        const queueList = url.pathname.match(/^\/workspaces\/([^/]+)\/queue$/)
        if (req.method === "GET" && queueList) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const tabId = url.searchParams.get("tabId") ?? undefined
              const items = yield* (yield* QueueRepo).listQueued(queueList[1]!, tabId)
              return {
                deliveryGuarantee: QUEUE_DELIVERY_GUARANTEE,
                queue: items.map((item, index) => ({
                  id: item.id,
                  queueId: item.queueId,
                  messageId: item.messageId,
                  tabId: item.tabId,
                  text: item.text,
                  mode: item.mode,
                  createdAt: item.createdAt,
                  position: index + 1,
                  deliveryGuarantee: QUEUE_DELIVERY_GUARANTEE,
                })),
              } satisfies QueueListResponse
            }),
            (body) => send(res, 200, body),
            onError,
          )
        }
        const queueDelete = url.pathname.match(/^\/workspaces\/([^/]+)\/queue\/([^/]+)$/)
        if (req.method === "DELETE" && queueDelete) {
          const queueId = Number(queueDelete[2])
          if (!Number.isSafeInteger(queueId) || queueId <= 0)
            return err(res, 400, "Validation", "queueId 必须是正整数")
          const workspaceId = queueDelete[1]!
          const handleQueueDelete = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              const workspace = yield* (yield* WorkspacesRepo).get(workspaceId)
              if (workspace.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${workspace.status}）` })
              const queue = yield* QueueRepo
              const result = yield* queue.withdraw(queueId, workspaceId)
              if (result.status === "missing")
                return yield* new NotFoundError({ message: "队列条目不存在（已投递或已撤回）" })
              if (result.status === "inflight")
                return yield* new ConflictError({ message: "队列条目正在投递，已不可撤回" })
              return { withdrawn: true }
            }),
            (body) => send(res, 200, body),
            onError,
          )
          return await (workspaceSerial ? workspaceSerial.run(workspaceId, handleQueueDelete) : handleQueueDelete())
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
          const workspaceId = inputRoute[1]!
          const headerKey = req.headers["idempotency-key"]
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey
            : typeof headerKey === "string" ? headerKey
            : Array.isArray(headerKey) ? headerKey[0]
            : undefined
          const idempotencyBody = canonicalInputIdempotencyBody({
            text: body.text,
            mode,
            ...(typeof body.tabId === "string" ? { tabId: body.tabId } : {}),
            ...(body.skipStable === true ? { skipStable: true } : {}),
          })
          const bodyHash = hashInputBody(idempotencyBody)
          const bodyByteLength = Buffer.byteLength(idempotencyBody, "utf8")
          const handleInput = () => runRoute(
            res, runtime,
            Effect.gen(function* () {
              if (idempotencyKey) {
                const check = yield* (yield* InputReceiptsRepo).check({
                  workspaceId, key: idempotencyKey, bodyHash, bodyByteLength,
                })
                if (check.replay) {
                  return {
                    kind: "replay" as const,
                    response: JSON.parse(check.responseJson) as Record<string, unknown>,
                  }
                }
              }
              const ws = yield* (yield* WorkspacesRepo).get(workspaceId)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              const tabs = yield* TabsRepo
              const tab = typeof body.tabId === "string"
                ? yield* tabs.get(body.tabId)
                : yield* tabs.findEngineTab(ws.id)
              if (!tab) return yield* new NotFoundError({ message: "无 engine tab" })
              if (tab.workspaceId !== ws.id || tab.kind !== "engine")
                return yield* new NotFoundError({ message: "engine tab 不属于该 workspace" })
              const engine = (yield* EngineRegistry).get(tab.engineId ?? "claude")
              const queuedCount = (yield* (yield* QueueRepo).listQueued(ws.id, tab.id)).length
              return { kind: "deliver" as const, ws, tab, engine, queuedCount }
            }),
            async (result) => {
              if (result.kind === "replay") {
                return send(res, inputReceiptStatus(result.response), result.response)
              }
              const { ws, tab, engine, queuedCount } = result
              const saveReceipt = async (response: Record<string, unknown>): Promise<boolean> => {
                if (!idempotencyKey) return true
                const exit = await runtime(Effect.gen(function* () {
                  yield* (yield* InputReceiptsRepo).put({
                    workspaceId: ws.id, key: idempotencyKey, bodyHash, response,
                  })
                }))
                Exit.match(exit, {
                  onSuccess: () => {},
                  onFailure: (cause) => {
                    const mapped = errorFromCause(cause, onError)
                    if (!res.headersSent) send(res, mapped.status, mapped.body)
                  },
                })
                if (Exit.isFailure(exit)) return false
                return true
              }
              const shouldQueue = mode === "send" && engine?.capabilities.nativeQueue === false &&
                (tab.status === "working" || queuedCount > 0)
              if (shouldQueue) {
                const exit = await runtime(Effect.gen(function* () {
                  return yield* (yield* QueueRepo).enqueue({ workspaceId: ws.id, tabId: tab.id, text: body.text })
                }))
                return Exit.match(exit, {
                  onSuccess: async (queued) => {
                    const response = {
                      queued: true,
                      id: queued.id,
                      queueId: queued.queueId,
                      messageId: queued.messageId,
                      position: queued.position,
                      deliveryGuarantee: queued.deliveryGuarantee,
                    } satisfies QueueAcceptedResponse
                    if (!(await saveReceipt(response))) return
                    send(res, 202, response)
                  },
                  onFailure: (cause) => {
                    const mapped = errorFromCause(cause, onError)
                    send(res, mapped.status, mapped.body)
                  },
                })
              }
              try {
                const target = `${tmuxSessionName(ws.id)}:${tab.tmuxWindow ?? 0}`
                await composerOps.input(target, { text: body.text, mode, skipStable: body.skipStable === true })
                // 无原生队列引擎的裸 Esc 没有可靠回调：先反映打断意图。lastHookAt 只给 monitor
                // 5 秒防抖窗；若引擎仍在输出，fresh mtime 随后会纠回 working。
                if (mode === "interrupt" && engine?.capabilities.nativeQueue === false && tab.status === "working") {
                  await runtime(Effect.gen(function* () {
                    const tabs = yield* TabsRepo
                    yield* tabs.touchHookAt(tab.id, Date.now())
                    yield* tabs.setStatus(tab.id, "awaiting-input", "interrupt")
                  }))
                }
                if (engine?.capabilities.nativeQueue === false &&
                    (mode === "interrupt-send" || mode === "send")) {
                  await runtime(Effect.gen(function* () {
                    yield* (yield* TabsRepo).setStatus(tab.id, "working", "composer")
                  }))
                }
                await runtime(Effect.gen(function* () {
                  yield* (yield* EventsRepo).append({
                    workspaceId: ws.id, type: "composer.delivered",
                    payload: { mode, tabId: tab.id, chars: body.text.length },
                  })
                }))
                const response = { ok: true }
                if (!(await saveReceipt(response))) return
                send(res, 200, response)
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
            onError,
          )
          return await (workspaceSerial
            ? workspaceSerial.run(workspaceId, handleInput)
            : handleInput())
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
