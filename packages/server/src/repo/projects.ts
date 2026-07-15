import { Context, Effect, Layer, Option } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { ulid } from "ulid"
import { Project } from "@coolie/protocol"
import type { CoolieEvent } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { ValidationError, ConflictError, NotFoundError } from "./errors.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { appendEventRow } from "./events.js"
export { ValidationError, ConflictError, NotFoundError } from "./errors.js"

const rowToProject = (r: any): Project =>
  new Project({ id: r.id, name: r.name, repoRoot: r.repo_root, defaultBaseBranch: r.default_base_branch, createdAt: r.created_at })

const detectDefaultBranch = (repoRoot: string): string => {
  try {
    const head = fs.readFileSync(path.join(repoRoot, ".git", "HEAD"), "utf8").trim()
    const m = head.match(/^ref: refs\/heads\/(.+)$/)
    return m?.[1] ?? "main"
  } catch { return "main" }
}

export interface ProjectsRepoShape {
  readonly add: (repoRoot: string) => Effect.Effect<Project, ValidationError | ConflictError>
  readonly get: (id: string) => Effect.Effect<Project, NotFoundError>
  readonly list: () => Effect.Effect<Project[]>
  readonly remove: (id: string) => Effect.Effect<void, NotFoundError | ConflictError>
}
export class ProjectsRepo extends Context.Tag("ProjectsRepo")<ProjectsRepo, ProjectsRepoShape>() {}

export const ProjectsRepoLive = Layer.effect(
  ProjectsRepo,
  Effect.gen(function* () {
    const db = yield* Db
    const bus = yield* Effect.serviceOption(EventsBus)
    const broadcast = (ev: CoolieEvent): void => { if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, ev) }
    return {
      add: (repoRoot) => Effect.gen(function* () {
        const abs = path.resolve(repoRoot)
        if (!fs.existsSync(path.join(abs, ".git")))
          return yield* new ValidationError({ message: `${abs} 不是 git 仓库（缺 .git）` })
        if (db.prepare("SELECT 1 FROM projects WHERE repo_root = ?").get(abs))
          return yield* new ConflictError({ message: `项目已存在：${abs}` })
        const p = new Project({
          id: ulid(), name: path.basename(abs), repoRoot: abs,
          defaultBaseBranch: detectDefaultBranch(abs), createdAt: Date.now(),
        })
        const mainId = ulid()
        let ev!: CoolieEvent
        let mainEv!: CoolieEvent
        db.transaction(() => {
          db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
            .run(p.id, p.name, p.repoRoot, p.defaultBaseBranch, p.createdAt)
          db.prepare(`INSERT INTO workspaces
            (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at,
             archived_at, data, task_status, kind, materialized, sort_order)
            VALUES (?,?,?,?,?,?,?,'active',0,?,NULL,?,'in_progress','main',1,-1)`)
            .run(mainId, p.id, p.name, p.repoRoot, p.defaultBaseBranch, p.defaultBaseBranch, "HEAD",
              p.createdAt, JSON.stringify({ portBase: 0, ownership: "managed" }))
          ev = appendEventRow(db, { workspaceId: null, type: "project.added", payload: { id: p.id, repoRoot: p.repoRoot } })
          mainEv = appendEventRow(db, {
            workspaceId: mainId, type: "workspace.main.created",
            payload: { id: mainId, projectId: p.id, path: p.repoRoot, branch: p.defaultBaseBranch },
          })
        })()
        broadcast(ev)
        broadcast(mainEv)
        return p
      }),
      get: (id) => Effect.gen(function* () {
        const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id)
        if (!r) return yield* new NotFoundError({ message: `项目不存在：${id}` })
        return rowToProject(r)
      }),
      list: () => Effect.sync(() =>
        db.prepare("SELECT * FROM projects ORDER BY created_at").all().map(rowToProject)),
      remove: (id) => Effect.gen(function* () {
        let ev: CoolieEvent | null = null
        const project = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)
        if (!project) return yield* new NotFoundError({ message: `项目不存在：${id}` })
        const taskCount = (db.prepare(
          "SELECT count(*) AS n FROM workspaces WHERE project_id = ? AND kind <> 'main'",
        ).get(id) as { n: number }).n
        if (taskCount > 0)
          return yield* new ConflictError({ message: `项目仍有 ${taskCount} 个非 main task，拒绝移除` })
        db.transaction(() => {
          const mainRows = db.prepare("SELECT id FROM workspaces WHERE project_id = ? AND kind = 'main'")
            .all(id) as Array<{ id: string }>
          for (const main of mainRows) {
            db.prepare("DELETE FROM prompt_queue WHERE workspace_id = ?").run(main.id)
            db.prepare("DELETE FROM tabs WHERE workspace_id = ?").run(main.id)
          }
          db.prepare("DELETE FROM workspaces WHERE project_id = ? AND kind = 'main'").run(id)
          const res = db.prepare("DELETE FROM projects WHERE id = ?").run(id)
          if (res.changes > 0)
            ev = appendEventRow(db, { workspaceId: null, type: "project.removed", payload: { id } })
        })()
        if (ev !== null) broadcast(ev)
      }),
    }
  }),
)
