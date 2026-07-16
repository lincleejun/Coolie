import { Context, Effect, Layer } from "effect"
import type Database from "better-sqlite3"
import {
  decodeProjectScriptDefinition,
  decodeRunInstanceRecord,
  decodeRunLogMetadata,
  type ProjectScriptDefinition,
  type ProjectScriptUpsert,
  validateProjectScriptInput,
} from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { NotFoundError } from "./errors.js"

export interface ProjectScriptsShape {
  readonly upsert: (projectId: string, input: ProjectScriptUpsert) => Effect.Effect<ProjectScriptDefinition, Error>
  readonly list: (projectId: string) => Effect.Effect<ProjectScriptDefinition[], never>
  readonly get: (projectId: string, runId: string) => Effect.Effect<ProjectScriptDefinition, NotFoundError>
  readonly recordRun: (input: Omit<Parameters<typeof decodeRunInstanceRecord>[0], never>) => Effect.Effect<ReturnType<typeof decodeRunInstanceRecord>, Error>
  readonly recordLog: (input: Omit<Parameters<typeof decodeRunLogMetadata>[0], never>) => Effect.Effect<ReturnType<typeof decodeRunLogMetadata>, Error>
  readonly listRuns: (workspaceId: string) => Effect.Effect<ReturnType<typeof decodeRunInstanceRecord>[], never>
}

export class ProjectScriptsRepo extends Context.Tag("ProjectScriptsRepo")<
  ProjectScriptsRepo,
  ProjectScriptsShape
>() {}

const rowToScript = (row: any): ProjectScriptDefinition =>
  decodeProjectScriptDefinition({
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    scriptType: row.script_type,
    scope: row.scope,
    command: row.command,
    args: JSON.parse(row.args_json ?? "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

export const makeProjectScriptsRepo = (db: Database.Database): ProjectScriptsShape => ({
  upsert: (projectId, input) => Effect.try({
    try: () => {
      const validated = validateProjectScriptInput(input)
      const now = Date.now()
      const existing = db.prepare("SELECT id, created_at FROM project_scripts WHERE project_id = ? AND run_id = ?")
        .get(projectId, validated.runId) as { id: string; created_at: number } | undefined
      const id = existing?.id ?? `script-${projectId}-${validated.runId}`
      const createdAt = existing?.created_at ?? now
      db.prepare(`INSERT INTO project_scripts
        (id, project_id, run_id, script_type, scope, command, args_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, run_id) DO UPDATE SET
          script_type = excluded.script_type,
          scope = excluded.scope,
          command = excluded.command,
          args_json = excluded.args_json,
          updated_at = excluded.updated_at`).run(
        id,
        projectId,
        validated.runId,
        validated.scriptType,
        validated.scope,
        validated.command,
        JSON.stringify(validated.args ?? []),
        createdAt,
        now,
      )
      const row = db.prepare("SELECT * FROM project_scripts WHERE project_id = ? AND run_id = ?").get(projectId, validated.runId)
      if (!row) throw new Error("script upsert failed")
      return rowToScript(row)
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  }),

  list: (projectId) => Effect.sync(() =>
    db.prepare("SELECT * FROM project_scripts WHERE project_id = ? ORDER BY script_type ASC, run_id ASC").all(projectId)
      .map(rowToScript)),

  get: (projectId, runId) => Effect.try({
    try: () => {
      const row = db.prepare("SELECT * FROM project_scripts WHERE project_id = ? AND run_id = ?").get(projectId, runId)
      if (!row) throw new NotFoundError({ message: `script 不存在：${projectId}/${runId}` })
      return rowToScript(row)
    },
    catch: (cause) => cause instanceof NotFoundError
      ? cause
      : new NotFoundError({ message: cause instanceof Error ? cause.message : String(cause) }),
  }),

  recordRun: (input) => Effect.try({
    try: () => {
      const run = decodeRunInstanceRecord(input)
      db.prepare(`INSERT INTO run_instances
        (id, workspace_id, run_id, script_type, status, started_at, exited_at, exit_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          exited_at = excluded.exited_at,
          exit_code = excluded.exit_code`).run(
        run.id,
        run.workspaceId,
        run.runId,
        run.scriptType,
        run.status,
        run.startedAt,
        run.exitedAt,
        run.exitCode,
      )
      return run
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  }),

  recordLog: (input) => Effect.try({
    try: () => {
      const meta = decodeRunLogMetadata(input)
      db.prepare(`INSERT INTO run_log_metadata
        (id, run_instance_id, workspace_id, script_type, bytes, truncated, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          bytes = excluded.bytes,
          truncated = excluded.truncated,
          updated_at = excluded.updated_at`).run(
        meta.id,
        meta.runInstanceId,
        meta.workspaceId,
        meta.scriptType,
        meta.bytes,
        meta.truncated ? 1 : 0,
        meta.updatedAt,
      )
      return meta
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  }),

  listRuns: (workspaceId) => Effect.sync(() =>
    db.prepare("SELECT * FROM run_instances WHERE workspace_id = ? ORDER BY started_at ASC, id ASC").all(workspaceId)
      .map((row: any) => decodeRunInstanceRecord({
        id: row.id,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        scriptType: row.script_type,
        status: row.status,
        startedAt: row.started_at,
        exitedAt: row.exited_at ?? null,
        exitCode: row.exit_code ?? null,
      }))),
})

export const ProjectScriptsRepoLive = Layer.effect(
  ProjectScriptsRepo,
  Effect.gen(function* () {
    const db = yield* Db
    return makeProjectScriptsRepo(db)
  }),
)
