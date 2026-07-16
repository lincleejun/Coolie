import { Context, Data, Effect, Layer } from "effect"
import type { RunInstanceRecord } from "@coolie/protocol"
import { ProjectScriptsRepo } from "../repo/project-scripts.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { ProjectsRepo } from "../repo/projects.js"
import { EventsRepo } from "../repo/events.js"
import { NotFoundError } from "../repo/errors.js"
import { buildWorkspaceEnv } from "../workspace/env.js"
import { appendRunLog, emptyRunLog, type RunLogBuffer } from "./log.js"
import { isProcessAlive, signalProcessGroup, spawnRunProcess, waitMs } from "./process.js"

export class RunError extends Data.TaggedError("RunError")<{ readonly message: string }> {}

interface ActiveRun {
  readonly record: RunInstanceRecord
  readonly pid: number
  readonly log: RunLogBuffer
}

type RunDeps = ProjectScriptsRepo | WorkspacesRepo | ProjectsRepo | EventsRepo

export interface RunManagerShape {
  readonly start: (workspaceId: string, runId: string) => Effect.Effect<RunInstanceRecord, RunError | NotFoundError, RunDeps>
  readonly stop: (workspaceId: string, runId: string) => Effect.Effect<RunInstanceRecord, RunError | NotFoundError, RunDeps>
  readonly reconcile: (workspaceId: string) => Effect.Effect<RunInstanceRecord[], never, ProjectScriptsRepo>
  readonly getLog: (workspaceId: string, runId: string) => Effect.Effect<RunLogBuffer, NotFoundError>
  readonly list: (workspaceId: string) => Effect.Effect<RunInstanceRecord[], never, ProjectScriptsRepo>
}

export class RunManager extends Context.Tag("RunManager")<RunManager, RunManagerShape>() {}

const instanceId = (workspaceId: string, runId: string): string => `run-${workspaceId}-${runId}`

const toRunError = (cause: unknown): RunError =>
  new RunError({ message: cause instanceof Error ? cause.message : String(cause) })

export const makeRunManager = (): RunManagerShape => {
  const active = new Map<string, ActiveRun>()

  const persist = (record: RunInstanceRecord) =>
    Effect.gen(function* () {
      return yield* (yield* ProjectScriptsRepo).recordRun(record)
    }).pipe(Effect.mapError(toRunError))

  const emit = (workspaceId: string, type: string, payload: Record<string, unknown>) =>
    Effect.gen(function* () {
      yield* (yield* EventsRepo).append({ workspaceId, type, payload })
    }).pipe(Effect.catchAll(() => Effect.void))

  const finishRecord = (record: RunInstanceRecord, exitCode: number | null): RunInstanceRecord => ({
    ...record,
    status: exitCode === 0 ? "exited" : "error",
    exitedAt: Date.now(),
    exitCode,
  })

  return {
    start: (workspaceId, runId) => Effect.gen(function* () {
      const key = instanceId(workspaceId, runId)
      const existing = active.get(key)
      if (existing && isProcessAlive(existing.pid))
        return existing.record

      const workspaces = yield* WorkspacesRepo
      const projects = yield* ProjectsRepo
      const scripts = yield* ProjectScriptsRepo
      const ws = yield* workspaces.get(workspaceId)
      const project = yield* projects.get(ws.projectId)
      const script = yield* scripts.get(ws.projectId, runId)
      if (script.scriptType !== "run")
        return yield* new RunError({ message: `script ${runId} is not a run script` })

      const env = buildWorkspaceEnv({ workspace: ws, repoRoot: project.repoRoot })
      const spawned = yield* Effect.try({
        try: () => spawnRunProcess({
          command: script.command,
          args: script.args,
          cwd: ws.path,
          env,
        }),
        catch: toRunError,
      })
      const startedAt = Date.now()
      const record: RunInstanceRecord = {
        id: key,
        workspaceId,
        runId,
        scriptType: "run",
        status: "running",
        startedAt,
        exitedAt: null,
        exitCode: null,
      }
      let log = emptyRunLog()
      spawned.child.stdout?.on("data", (chunk: Buffer) => {
        log = appendRunLog(log.text, chunk.toString("utf8"))
        active.set(key, { record, pid: spawned.pid, log })
      })
      spawned.child.stderr?.on("data", (chunk: Buffer) => {
        log = appendRunLog(log.text, chunk.toString("utf8"))
        active.set(key, { record, pid: spawned.pid, log })
      })
      spawned.child.on("exit", (code) => {
        const finished = finishRecord(record, code)
        active.set(key, { record: finished, pid: spawned.pid, log })
      })
      active.set(key, { record, pid: spawned.pid, log })
      const persisted = yield* persist(record)
      yield* emit(workspaceId, "run.started", { runId, pid: spawned.pid })
      return persisted
    }),

    stop: (workspaceId, runId) => Effect.gen(function* () {
      const key = instanceId(workspaceId, runId)
      const entry = active.get(key)
      if (!entry)
        return yield* new NotFoundError({ message: `run 未运行：${workspaceId}/${runId}` })
      if (!isProcessAlive(entry.pid)) {
        const finished = finishRecord(entry.record, entry.record.exitCode)
        active.set(key, { ...entry, record: finished })
        return yield* persist(finished)
      }
      signalProcessGroup(entry.pid, "SIGHUP")
      yield* Effect.tryPromise({
        try: () => waitMs(200),
        catch: toRunError,
      })
      if (isProcessAlive(entry.pid))
        signalProcessGroup(entry.pid, "SIGTERM")
      const finished = finishRecord(entry.record, entry.record.exitCode ?? 143)
      active.set(key, { ...entry, record: finished })
      const persisted = yield* persist(finished)
      yield* emit(workspaceId, "run.stopped", { runId })
      return persisted
    }),

    reconcile: (workspaceId) => Effect.gen(function* () {
      const scripts = yield* ProjectScriptsRepo
      const persisted = yield* scripts.listRuns(workspaceId)
      const next: RunInstanceRecord[] = []
      for (const run of persisted) {
        if (run.status !== "running") {
          next.push(run)
          continue
        }
        const entry = active.get(run.id)
        const alive = entry ? isProcessAlive(entry.pid) : false
        if (alive && entry) {
          next.push(entry.record)
          continue
        }
        const finished = finishRecord(run, run.exitCode ?? 1)
        active.delete(run.id)
        next.push(yield* persist(finished).pipe(Effect.orDie))
      }
      return next
    }),

    getLog: (workspaceId, runId) => Effect.gen(function* () {
      const entry = active.get(instanceId(workspaceId, runId))
      if (!entry)
        return yield* new NotFoundError({ message: `run log 不存在：${workspaceId}/${runId}` })
      return entry.log
    }),

    list: (workspaceId) => Effect.gen(function* () {
      const scripts = yield* ProjectScriptsRepo
      const persisted = yield* scripts.listRuns(workspaceId)
      for (const run of persisted) {
        if (run.status !== "running") continue
        const entry = active.get(run.id)
        if (entry && isProcessAlive(entry.pid)) continue
        const finished: RunInstanceRecord = {
          ...run,
          status: "error",
          exitedAt: Date.now(),
          exitCode: run.exitCode ?? 1,
        }
        active.delete(run.id)
        yield* (yield* ProjectScriptsRepo).recordRun(finished).pipe(Effect.orDie)
      }
      return yield* scripts.listRuns(workspaceId)
    }),
  }
}

export const RunManagerLive = Layer.succeed(RunManager, makeRunManager())
