import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { GitServiceLive } from "../src/git/service.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { ConflictError } from "../src/repo/errors.js"
import { SessionEnsurer } from "../src/workspace/heal.js"
import { WorkspaceAdopter, WorkspaceAdopterLive } from "../src/workspace/adopt.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

describe("WorkspaceAdopter", () => {
  it("discovers only linked branch worktrees and adopts the exact listed path", async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-adopt-")))
    const repoRoot = path.join(parent, "repo")
    fs.mkdirSync(repoRoot)
    git(repoRoot, "init", "-b", "main")
    git(repoRoot, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init")
    const linked = path.join(parent, "existing")
    git(repoRoot, "worktree", "add", "-b", "feature/existing", linked, "main")

    const db = new Database(":memory:")
    runMigrations(db)
    const repos = Layer.mergeAll(ProjectsRepoLive, WorkspacesRepoLive).pipe(Layer.provide(Layer.succeed(Db, db)))
    let ensured = ""
    const layer = WorkspaceAdopterLive.pipe(
      Layer.provideMerge(Layer.mergeAll(
        GitServiceLive,
        Layer.succeed(SessionEnsurer, {
          ensure: (id: string) => Effect.sync(() => {
            ensured = id
            return { action: "recreated" as const, resumed: false, sessionName: `coolie-${id}`, tabId: null, sessionId: null }
          }),
          resumeTab: null as any,
        }),
      )),
      Layer.provideMerge(repos),
    )
    const effect = Effect.gen(function* () {
      const project = yield* (yield* ProjectsRepo).add(repoRoot)
      const adopter = yield* WorkspaceAdopter
      const candidates = yield* adopter.list(project.id)
      const adopted = yield* adopter.adopt({ projectId: project.id, path: linked, name: "imported" })
      const again = yield* adopter.adopt({ projectId: project.id, path: linked })
      return { candidates, adopted, again }
    })
    const out = await Effect.runPromise(Effect.provide(effect, layer))
    expect(out.candidates).toEqual([{
      path: linked,
      branch: "feature/existing",
      head: git(repoRoot, "rev-parse", "feature/existing"),
    }])
    expect(out.adopted.status).toBe("active")
    expect(out.adopted.ownership).toBe("adopted")
    expect(out.adopted.baseRef).toBe(git(repoRoot, "rev-parse", "main"))
    expect(out.again.id).toBe(out.adopted.id)
    expect(ensured).toBe(out.adopted.id)
  })

  it("records ensure failure as retryable error without removing or modifying the real external worktree", async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-adopt-fail-")))
    const repoRoot = path.join(parent, "repo")
    fs.mkdirSync(repoRoot)
    git(repoRoot, "init", "-b", "main")
    git(repoRoot, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init")
    const linked = path.join(parent, "existing")
    git(repoRoot, "worktree", "add", "-b", "feature/failing", linked, "main")
    const dirty = path.join(linked, "keep.txt")
    fs.writeFileSync(dirty, "keep this dirty change\n")

    const db = new Database(":memory:")
    runMigrations(db)
    const repos = Layer.mergeAll(ProjectsRepoLive, WorkspacesRepoLive).pipe(Layer.provide(Layer.succeed(Db, db)))
    const layer = WorkspaceAdopterLive.pipe(
      Layer.provideMerge(Layer.mergeAll(
        GitServiceLive,
        Layer.succeed(SessionEnsurer, {
          ensure: () => Effect.fail(new ConflictError({ message: "runtime ensure failed" })),
          resumeTab: null as any,
        }),
      )),
      Layer.provideMerge(repos),
    )
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      const project = yield* (yield* ProjectsRepo).add(repoRoot)
      const adopter = yield* WorkspaceAdopter
      yield* adopter.adopt({ projectId: project.id, path: linked, name: "failed-adopt" })
    }), layer))
    expect(exit._tag).toBe("Failure")
    const rows = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).list()
    }), layer))
    const adopted = rows.filter((workspace) => workspace.kind === "task")
    expect(adopted).toHaveLength(1)
    expect(adopted[0]).toMatchObject({ ownership: "adopted", status: "error", path: linked })
    expect(fs.readFileSync(dirty, "utf8")).toBe("keep this dirty change\n")
    expect(git(repoRoot, "worktree", "list", "--porcelain")).toContain(linked)
  })
})
