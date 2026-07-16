import type { IncomingMessage, ServerResponse } from "node:http"
import { Effect, Exit } from "effect"
import { tmuxSessionName, type ApiErrorBody } from "@coolie/protocol"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { TabsRepo } from "../repo/tabs.js"
import { QueueRepo } from "../repo/queue.js"
import { EngineRegistry } from "../engine/registry.js"
import { SessionEnsurer } from "../workspace/heal.js"
import { ConflictError, NotFoundError } from "../repo/errors.js"
import { collectChanges, fileDiff, isDiffSection, isSafeRelPath, type DiffSection } from "../git/inspect.js"
import {
  REVIEW_TAB_TITLE,
  assertSafeReviewTarget,
  buildReviewPrompt,
  planReviewTab,
  readReviewPrompt,
} from "../workspace/review.js"
import type { ComposerOps } from "../tmux/ops.js"

type Runtime = <A, E>(eff: Effect.Effect<A, E, any>) => Promise<import("effect").Exit.Exit<A, E>>

const readJson = async (req: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  catch { return null }
}

export const handleWorkspaceReview = async (opts: {
  readonly res: ServerResponse
  readonly req: IncomingMessage
  readonly runtime: Runtime
  readonly workspaceId: string
  readonly composerOps: ComposerOps | undefined
  readonly send: (res: ServerResponse, status: number, body?: unknown) => void
  readonly err: (res: ServerResponse, status: number, code: ApiErrorBody["code"], message: string) => void
  readonly onError?: ((cause: unknown) => void) | undefined
  readonly runRoute: (
    res: ServerResponse,
    runtime: Runtime,
    effect: Effect.Effect<any, any, any>,
    onSuccess: (value: any) => void | Promise<void>,
    onError?: (cause: unknown) => void,
  ) => Promise<void>
}): Promise<void> => {
  const { res, req, runtime, workspaceId, composerOps, send, err, onError, runRoute } = opts
  if (!composerOps) return err(res, 501, "Internal", "composerOps unavailable")

  const body = await readJson(req)
  if (body === null) return err(res, 400, "Validation", "invalid JSON body")

  let focus: { section: DiffSection; path: string } | null = null
  if (body.focus != null) {
    if (typeof body.focus !== "object") return err(res, 400, "Validation", "focus must be object")
    const section = String(body.focus.section ?? "")
    const focusPath = String(body.focus.path ?? "")
    if (!isDiffSection(section))
      return err(res, 400, "Validation", "focus.section must be againstBase|committed|staged|unstaged|untracked")
    if (!isSafeRelPath(focusPath))
      return err(res, 400, "Validation", "focus.path illegal")
    focus = { section, path: focusPath }
  }

  const preferredEngineId = typeof body.engineId === "string" && body.engineId !== ""
    ? body.engineId : "claude"
  const override = typeof body.reviewPrompt === "string" ? body.reviewPrompt : null

  return runRoute(
    res, runtime,
    Effect.gen(function* () {
      const ws = yield* (yield* WorkspacesRepo).get(workspaceId)
      if (ws.status !== "active")
        return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
      if (ws.kind === "main")
        return yield* new ConflictError({ message: "main workspace 不支持 Agent Review" })
      const tabsRepo = yield* TabsRepo
      const tabs = yield* tabsRepo.listByWorkspace(ws.id)
      const plan = planReviewTab(tabs, preferredEngineId)
      assertSafeReviewTarget(plan, tabs)
      let tabId: string
      let engineId: string
      if (plan.action === "create") {
        const outcome = yield* (yield* SessionEnsurer).createEngineTab(ws.id, plan.engineId, {
          title: REVIEW_TAB_TITLE,
          ...(typeof body.model === "string" ? { model: body.model } : {}),
        })
        tabId = outcome.tabId!
        engineId = plan.engineId
      } else {
        tabId = plan.tabId
        engineId = plan.engineId
      }
      const tab = yield* tabsRepo.get(tabId)
      if (tab.workspaceId !== ws.id || tab.kind !== "engine" || tab.title !== REVIEW_TAB_TITLE)
        return yield* new ConflictError({ message: "review tab 无效" })
      const registry = yield* EngineRegistry
      const engine = registry.get(tab.engineId ?? engineId)
      if (!engine) return yield* new NotFoundError({ message: `engine 不存在：${engineId}` })
      const promptMeta = yield* Effect.try({
        try: () => readReviewPrompt(ws.path, override),
        catch: (e) => new ConflictError({ message: e instanceof Error ? e.message : String(e) }),
      })
      const baseRef = ws.baseRef || "HEAD"
      const changes = yield* Effect.tryPromise({
        try: () => collectChanges(ws.path, baseRef),
        catch: (e) => new ConflictError({ message: e instanceof Error ? e.message : String(e) }),
      })
      const focusDiff = focus
        ? yield* Effect.promise(() => fileDiff(ws.path, baseRef, focus.section, focus.path).catch(() => null))
        : null
      const text = buildReviewPrompt({
        instructions: promptMeta.content,
        changes,
        baseRef,
        focus,
        focusDiff,
      })
      const queuedCount = (yield* (yield* QueueRepo).listQueued(ws.id, tab.id)).length
      return { ws, tab, engine, text, promptMeta, queuedCount }
    }),
    async ({ ws, tab, engine, text, promptMeta, queuedCount }) => {
      const shouldQueue = engine.capabilities.nativeQueue === false &&
        (tab.status === "working" || queuedCount > 0)
      if (shouldQueue) {
        const exit = await runtime(Effect.gen(function* () {
          return yield* (yield* QueueRepo).enqueue({ workspaceId: ws.id, tabId: tab.id, text })
        }))
        if (Exit.isFailure(exit)) {
          onError?.(exit.cause)
          return err(res, 500, "Internal", "queue enqueue failed")
        }
        return send(res, 202, {
          tabId: tab.id,
          title: REVIEW_TAB_TITLE,
          queued: true,
          queueId: exit.value.queueId,
          promptSource: promptMeta.source,
          engineId: tab.engineId,
        })
      }
      try {
        const target = `${tmuxSessionName(ws.id)}:${tab.tmuxWindow ?? 0}`
        await composerOps.input(target, { text, mode: "send", skipStable: false })
        await runtime(Effect.gen(function* () {
          yield* (yield* TabsRepo).setStatus(tab.id, "working", "composer")
        }))
        return send(res, 200, {
          tabId: tab.id,
          title: REVIEW_TAB_TITLE,
          queued: false,
          promptSource: promptMeta.source,
          engineId: tab.engineId,
        })
      } catch (e: any) {
        return err(res, 500, "Internal", e?.message ?? String(e))
      }
    },
    onError,
  )
}
