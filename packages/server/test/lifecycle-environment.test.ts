import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execSync } from "node:child_process"
import Database from "better-sqlite3"
import * as http from "node:http"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { GitService, GitServiceLive } from "../src/git/service.js"
import { SetupRunner, type SetupRunnerShape } from "../src/workspace/setup.js"
import {
  WorkspaceLifecycle,
  WorkspaceLifecycleLive,
  PostCreateHooks,
  type PostCreateHook,
} from "../src/workspace/lifecycle.js"
import { WorktreeEnvironment, WorktreeEnvironmentLive } from "../src/workspace/worktree-environment.js"
import { createApp, newToken } from "../src/http/app.js"

const mkdir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

const initRepo = (repo: string): void => {
  execSync("git init -b main", { cwd: repo, stdio: "ignore" })
  execSync("git config user.email test@example.com", { cwd: repo, stdio: "ignore" })
  execSync("git config user.name Test", { cwd: repo, stdio: "ignore" })
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n")
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=repo\n")
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n")
  execSync("git add README.md", { cwd: repo, stdio: "ignore" })
  execSync("git commit -m init", { cwd: repo, stdio: "ignore" })
}

describe("lifecycle environment wiring (Task 2B.3)", () => {
  it("provision copies .env before setup scripts run", async () => {
    const home = mkdir("coolie-env-life-home-")
    const wsRoot = mkdir("coolie-env-life-wsroot-")
    const repo = mkdir("coolie-env-life-repo-")
    initRepo(repo)

    const copiedBeforeSetup: string[] = []
    let setupImpl: SetupRunnerShape["run"] = ({ worktreePath }) => Effect.sync(() => {
      copiedBeforeSetup.push(fs.readFileSync(path.join(worktreePath, ".env"), "utf8"))
      return []
    })
    const setup: SetupRunnerShape = { run: (o) => setupImpl(o) }

    const db = new Database(":memory:")
    runMigrations(db)
    const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: wsRoot }
    const hooks: PostCreateHook[] = []
    const layer = WorkspaceLifecycleLive.pipe(
      Layer.provideMerge(Layer.mergeAll(
        GitServiceLive,
        Layer.succeed(SetupRunner, setup),
        Layer.succeed(PostCreateHooks, hooks),
        WorktreeEnvironmentLive,
      )),
      Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
      Layer.provideMerge(Layer.succeed(Db, db)),
      Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
    )
    const run = <A, E>(eff: Effect.Effect<A, E, any>) =>
      Effect.runPromise(Effect.provide(eff, layer))

    const project = await run(Effect.gen(function* () {
      return yield* (yield* ProjectsRepo).add(repo)
    }))
    const ws = await run(Effect.gen(function* () {
      const lifecycle = yield* WorkspaceLifecycle
      const intent = yield* lifecycle.create({ projectId: project.id })
      yield* lifecycle.ensure(intent.id)
      return yield* (yield* WorkspacesRepo).get(intent.id)
    }))

    expect(fs.readFileSync(path.join(ws.path, ".env"), "utf8")).toBe("SECRET=repo\n")
    expect(copiedBeforeSetup).toEqual(["SECRET=repo\n"])
    const copiedEvent = db.prepare("SELECT payload FROM events WHERE type = 'workspace.environment.copied'").get() as any
    expect(copiedEvent).toBeDefined()
    expect(JSON.parse(copiedEvent.payload)).toMatchObject({ mode: "provision", fileCount: 1 })
    expect(JSON.stringify(copiedEvent)).not.toContain("SECRET=repo")
  })

  it("ensure/reconnect does not recopy over workspace .env", async () => {
    const home = mkdir("coolie-env-ensure-home-")
    const wsRoot = mkdir("coolie-env-ensure-wsroot-")
    const repo = mkdir("coolie-env-ensure-repo-")
    initRepo(repo)

    const db = new Database(":memory:")
    runMigrations(db)
    const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: wsRoot }
    const setup: SetupRunnerShape = { run: () => Effect.succeed([]) }
    const layer = WorkspaceLifecycleLive.pipe(
      Layer.provideMerge(Layer.mergeAll(
        GitServiceLive,
        Layer.succeed(SetupRunner, setup),
        Layer.succeed(PostCreateHooks, []),
        WorktreeEnvironmentLive,
      )),
      Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
      Layer.provideMerge(Layer.succeed(Db, db)),
      Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
    )
    const run = <A, E>(eff: Effect.Effect<A, E, any>) =>
      Effect.runPromise(Effect.provide(eff, layer))

    const project = await run(Effect.gen(function* () {
      return yield* (yield* ProjectsRepo).add(repo)
    }))
    const ws = await run(Effect.gen(function* () {
      const lifecycle = yield* WorkspaceLifecycle
      const intent = yield* lifecycle.create({ projectId: project.id })
      yield* lifecycle.ensure(intent.id)
      return yield* (yield* WorkspacesRepo).get(intent.id)
    }))

    fs.writeFileSync(path.join(ws.path, ".env"), "SECRET=workspace\n")
    const before = db.prepare("SELECT COUNT(*) c FROM events WHERE type = 'workspace.environment.copied'").get() as any
    await run(Effect.gen(function* () {
      yield* (yield* WorkspaceLifecycle).ensure(ws.id)
    }))
    const after = db.prepare("SELECT COUNT(*) c FROM events WHERE type = 'workspace.environment.copied'").get() as any
    expect(after.c).toBe(before.c)
    expect(fs.readFileSync(path.join(ws.path, ".env"), "utf8")).toBe("SECRET=workspace\n")
  })

  it("recopy defaults to no-overwrite and force can replace files", async () => {
    const repo = mkdir("coolie-env-recopy-repo-")
    const wt = mkdir("coolie-env-recopy-wt-")
    initRepo(repo)
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=repo-new\n")

    const db = new Database(":memory:")
    runMigrations(db)
    db.prepare("INSERT INTO projects (id,name,repo_root,default_base_branch,created_at) VALUES ('p1','p',?,'main',1)").run(repo)
    db.prepare(`INSERT INTO workspaces (id,project_id,name,path,branch,base_branch,base_ref,status,pinned,created_at,data)
      VALUES ('w1','p1','task',?,'coolie/task','main','r','active',0,1,'{}')`).run(wt)
    fs.writeFileSync(path.join(wt, ".env"), "SECRET=workspace\n")

    const layer = Layer.mergeAll(
      ProjectsRepoLive,
      EventsRepoLive,
      WorkspacesRepoLive,
      GitServiceLive,
      WorktreeEnvironmentLive,
    ).pipe(Layer.provide(Layer.succeed(Db, db)))
    const token = newToken()
    const server = http.createServer(createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
      token,
      onShutdown: () => {},
    }))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    const post = (body: unknown) => fetch(`${base}/workspaces/w1/environment/recopy`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

    const noOverwrite = await post({})
    expect(noOverwrite.status).toBe(200)
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("SECRET=workspace\n")

    const forced = await post({ force: true })
    expect(forced.status).toBe(200)
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("SECRET=repo-new\n")

    const event = db.prepare("SELECT payload FROM events WHERE type = 'workspace.environment.copied' ORDER BY seq DESC").get() as any
    expect(JSON.parse(event.payload)).toMatchObject({ mode: "explicit-recopy", force: true })

    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
  })
})
