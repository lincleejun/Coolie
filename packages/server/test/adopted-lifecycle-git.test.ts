import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { GitServiceLive } from "../src/git/service.js"
import { TmuxError } from "../src/tmux/service.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { SessionEnsurer } from "../src/workspace/heal.js"
import { PostCreateHooksEmpty, WorkspaceLifecycle, WorkspaceLifecycleLive } from "../src/workspace/lifecycle.js"
import { SetupRunner } from "../src/workspace/setup.js"

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

describe("adopted lifecycle with real git", () => {
  it("preserves a dirty external worktree through archive, failed retry, successful retry, and delete", async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-adopted-lifecycle-")))
    const repoRoot = path.join(parent, "repo")
    const linked = path.join(parent, "external")
    const home = path.join(parent, "home")
    fs.mkdirSync(repoRoot)
    fs.mkdirSync(home)
    git(repoRoot, "init", "-b", "main")
    git(repoRoot, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init")
    git(repoRoot, "worktree", "add", "-b", "feature/external", linked, "main")
    const dirtyFile = path.join(linked, "keep-me.txt")
    fs.writeFileSync(dirtyFile, "uncommitted and external\n")

    const db = new Database(":memory:")
    runMigrations(db)
    let failEnsure = false
    let ensureRuns = 0
    const cfg = {
      home,
      dbPath: ":memory:",
      serverInfoPath: path.join(home, "server.json"),
      workspacesRoot: path.join(parent, "managed"),
    }
    const layer = WorkspaceLifecycleLive.pipe(
      Layer.provideMerge(Layer.mergeAll(
        GitServiceLive,
        Layer.succeed(SetupRunner, { run: () => Effect.succeed([]) }),
        Layer.succeed(SessionEnsurer, {
          ensure: (id: string) => failEnsure
            ? Effect.fail(new TmuxError({ op: "ensure", message: "ensure failed", exitCode: 1, stderr: "" }))
            : Effect.sync(() => {
              ensureRuns++
              return { action: "recreated" as const, resumed: false, sessionName: `coolie-${id}`, tabId: null, sessionId: null }
            }),
          recoverArchive: (id: string) => failEnsure
            ? Effect.fail(new TmuxError({ op: "ensure", message: "ensure failed", exitCode: 1, stderr: "" }))
            : Effect.sync(() => {
              ensureRuns++
              return { action: "recreated" as const, resumed: false, sessionName: `coolie-${id}`, tabId: null, sessionId: null }
            }),
          resumeTab: null as any,
        }),
        PostCreateHooksEmpty,
      )),
      Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, WorkspacesRepoLive, EventsRepoLive)),
      Layer.provideMerge(Layer.succeed(Db, db)),
      Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
    )
    const run = <A, E>(effect: Effect.Effect<A, E, WorkspaceLifecycle | WorkspacesRepo | ProjectsRepo>) =>
      Effect.runPromiseExit(Effect.provide(effect, layer) as Effect.Effect<A, E, never>)
    const success = async <A, E>(effect: Effect.Effect<A, E, WorkspaceLifecycle | WorkspacesRepo | ProjectsRepo>): Promise<A> => {
      const exit = await run(effect)
      if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
      return exit.value
    }

    const ws = await success(Effect.gen(function* () {
      const project = yield* (yield* ProjectsRepo).add(repoRoot)
      return yield* (yield* WorkspacesRepo).insertAdopted({
        projectId: project.id,
        name: "external",
        path: linked,
        branch: "feature/external",
        baseBranch: "main",
        baseRef: git(repoRoot, "rev-parse", "main"),
        portBase: 40200,
      })
    }))

    const archived = await success(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(archived.status).toBe("archived")
    expect(fs.readFileSync(dirtyFile, "utf8")).toBe("uncommitted and external\n")
    expect(git(repoRoot, "worktree", "list", "--porcelain")).toContain(linked)

    await success(Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).unarchive(ws.id) }))
    await success(Effect.gen(function* () { yield* (yield* WorkspacesRepo).setStatus(ws.id, "error") }))
    failEnsure = true
    const failedRetry = await run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).retry(ws.id)
    }))
    expect(Exit.isFailure(failedRetry)).toBe(true)
    if (Exit.isFailure(failedRetry)) {
      const failure = Cause.failureOption(failedRetry.cause)
      expect(Option.isSome(failure) ? (failure.value as any)._tag : undefined).toBe("TmuxError")
    }
    expect((await success(Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(ws.id) }))).status).toBe("error")
    expect(fs.readFileSync(dirtyFile, "utf8")).toBe("uncommitted and external\n")

    failEnsure = false
    const active = await success(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).retry(ws.id)
    }))
    expect(active.status).toBe("active")
    expect(ensureRuns).toBe(2)
    await success(Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).delete(ws.id, { force: true }) }))
    expect(fs.readFileSync(dirtyFile, "utf8")).toBe("uncommitted and external\n")
    expect(git(repoRoot, "worktree", "list", "--porcelain")).toContain(linked)
    expect(git(repoRoot, "branch", "--list", "feature/external")).toContain("feature/external")
  })
})
