import { Cause, Effect, Exit, Option } from "effect"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ApiErrorBody } from "@coolie/protocol"
import { WorktreeEnvironment } from "../workspace/worktree-environment.js"
import { ValidationError } from "../repo/errors.js"
import type { Runtime } from "./app.js"

const send = (res: ServerResponse, status: number, body?: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body === undefined ? "" : JSON.stringify(body))
}

const err = (res: ServerResponse, status: number, code: ApiErrorBody["code"], message: string): void =>
  send(res, status, { error: { code, message } })

const runRoute = async <A, E>(
  res: ServerResponse,
  runtime: Runtime,
  eff: Effect.Effect<A, E, any>,
  onSuccess: (value: A) => void,
  onError: (res: ServerResponse, cause: unknown) => void,
): Promise<void> => {
  const exit = await runtime(eff)
  if (Exit.isSuccess(exit)) return onSuccess(exit.value)
  const failure = Cause.failureOption(exit.cause)
  onError(res, Option.isSome(failure) ? failure.value : exit.cause)
}

const parsePreviewPatterns = (url: URL): string[] | ValidationError => {
  const raw = url.searchParams.get("patterns")
  if (raw === null || raw === "") return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.some((line) => typeof line !== "string"))
      return new ValidationError({ message: "patterns must be a JSON string array" })
    return parsed
  } catch {
    return new ValidationError({ message: "patterns must be valid JSON" })
  }
}

export const handleEnvironmentPreview = (
  res: ServerResponse,
  runtime: Runtime,
  projectId: string,
  url: URL,
  onError: (res: ServerResponse, cause: unknown) => void,
): Promise<void> => {
  const patterns = parsePreviewPatterns(url)
  if (patterns instanceof ValidationError)
    return Promise.resolve(err(res, 400, "Validation", patterns.message))
  return runRoute(
    res,
    runtime,
    Effect.gen(function* () {
      return yield* (yield* WorktreeEnvironment).preview(projectId, {
        ...(patterns.length > 0 ? { projectPatterns: patterns } : {}),
      })
    }),
    (plan) => send(res, 200, plan),
    onError,
  )
}

export const handleEnvironmentRecopy = async (
  req: IncomingMessage,
  res: ServerResponse,
  runtime: Runtime,
  workspaceId: string,
  readJson: (req: IncomingMessage) => Promise<unknown>,
  onError: (res: ServerResponse, cause: unknown) => void,
): Promise<void> => {
  const body = (await readJson(req)) as { force?: boolean }
  if (body?.force !== undefined && typeof body.force !== "boolean")
    return err(res, 400, "Validation", "force must be boolean")
  return runRoute(
    res,
    runtime,
    Effect.gen(function* () {
      return yield* (yield* WorktreeEnvironment).apply(workspaceId, "explicit-recopy", {
        ...(body?.force ? { force: true } : {}),
      })
    }),
    (result) => send(res, 200, result),
    onError,
  )
}
