import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { Effect, Layer, Exit, Cause, Option } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { QueueRepo, QueueRepoLive } from "../src/repo/queue.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { GitService } from "../src/git/service.js"
import { SetupRunner, type SetupRunnerShape } from "../src/workspace/setup.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive, PostCreateHooksEmpty } from "../src/workspace/lifecycle.js"
import { SessionEnsurer } from "../src/workspace/heal.js"
import { makeFakeGit } from "./helpers/fake-git.js"
import { TmuxError, TmuxService, type TmuxServiceShape } from "../src/tmux/service.js"

type AnyServices = WorkspaceLifecycle | WorkspacesRepo | ProjectsRepo | EventsRepo | QueueRepo | TabsRepo

const makeEnv = (options?: { onKillSession?: () => void; failKillSession?: boolean }) => {
  const db = new Database(":memory:"); runMigrations(db)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-la-home-"))
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-la-ws-"))
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-la-repo-"))
  fs.mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true })
  const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: wsRoot }
  const fake = makeFakeGit()
  let setupRuns = 0
  let ensureRuns = 0
  let killRuns = 0
  let failEnsure = false
  const setup: SetupRunnerShape = { run: () => Effect.sync(() => { setupRuns++; return [] }) }
  const tmux = {
    socket: "archive-test",
    hasSession: () => Effect.succeed(false),
    killSession: () => {
      killRuns++
      if (options?.failKillSession)
        return Effect.fail(new TmuxError({ op: "kill-session", message: "injected kill failure", exitCode: 1, stderr: "" }))
      return Effect.sync(() => { options?.onKillSession?.() })
    },
  } as unknown as TmuxServiceShape
  const layer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(GitService, fake.git),
      Layer.succeed(SetupRunner, setup),
      ...(options ? [Layer.succeed(TmuxService, tmux)] : []),
      Layer.succeed(SessionEnsurer, {
        ensure: (id: string) => failEnsure
          ? Effect.fail({ _tag: "TmuxError" as const, message: "ensure failed", exitCode: 1, stderr: "" })
          : Effect.sync(() => {
            ensureRuns++
            return { action: "recreated" as const, resumed: false, sessionName: `coolie-${id}`, tabId: null, sessionId: null }
          }),
        recoverArchive: (id: string) => failEnsure
          ? Effect.fail({ _tag: "TmuxError" as const, message: "archive recovery failed", exitCode: 1, stderr: "" })
          : Effect.sync(() => {
            ensureRuns++
            return { action: "recreated" as const, resumed: false, sessionName: `coolie-${id}`, tabId: null, sessionId: null }
          }),
        resumeTab: null as any,
      }),
      PostCreateHooksEmpty,
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, QueueRepoLive, TabsRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
  )
  const run = <A, E>(eff: Effect.Effect<A, E, AnyServices>) =>
    Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<A, E, never>)
  return {
    db, fake, repoRoot, run,
    setupRuns: () => setupRuns,
    ensureRuns: () => ensureRuns,
    killRuns: () => killRuns,
    setFailEnsure: (value: boolean) => { failEnsure = value },
  }
}
const ok = async <A, E>(env: ReturnType<typeof makeEnv>, eff: Effect.Effect<A, E, AnyServices>): Promise<A> => {
  const exit = await env.run(eff)
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}
const failTag = (exit: Exit.Exit<any, any>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const f = Cause.failureOption(exit.cause)
  return Option.isSome(f) ? (f.value as any)._tag : undefined
}
/** 建好一个 active workspace 备用 */
const setupActive = async (env: ReturnType<typeof makeEnv>) =>
  ok(env, Effect.gen(function* () {
    const p = yield* (yield* ProjectsRepo).add(env.repoRoot)
    return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id, branchSlug: "work" })
  }))
const setupAdopted = async (env: ReturnType<typeof makeEnv>) =>
  ok(env, Effect.gen(function* () {
    const p = yield* (yield* ProjectsRepo).add(env.repoRoot)
    const wsPath = path.join(path.dirname(env.repoRoot), "external-worktree")
    env.fake.state.refs.set("refs/heads/feature/external", "a".repeat(40))
    env.fake.state.worktrees.set(wsPath, "feature/external")
    return yield* (yield* WorkspacesRepo).insertAdopted({
      projectId: p.id,
      name: "external",
      path: wsPath,
      branch: "feature/external",
      baseBranch: "main",
      baseRef: "a".repeat(40),
      portBase: 40100,
    })
  }))
const eventTypes = (env: ReturnType<typeof makeEnv>) =>
  ok(env, Effect.gen(function* () {
    return (yield* (yield* EventsRepo).listAfter({ after: 0 })).map((e) => e.type)
  }))

describe("archive", () => {
  it("archives a dirty adopted workspace without removing or cleaning its external worktree", async () => {
    const env = makeEnv()
    const ws = await setupAdopted(env)
    env.fake.state.dirty.add(ws.path)
    const out = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(out.status).toBe("archived")
    expect(env.fake.state.worktrees.get(ws.path)).toBe(ws.branch)
    expect(env.fake.state.dirty.has(ws.path)).toBe(true)
    expect(env.fake.state.calls.some((call) => call[0] === "worktreeRemove")).toBe(false)
  })
  it("removes non-engine tab rows while retaining the engine resume key", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () {
      const tabs = yield* TabsRepo
      yield* tabs.insert({ workspaceId: ws.id, kind: "engine", engineSessionId: "resume-me", tmuxWindow: 0 })
      yield* tabs.insert({ workspaceId: ws.id, kind: "setup", tmuxWindow: 1 })
      yield* tabs.insert({ workspaceId: ws.id, kind: "shell", tmuxWindow: 2 })
      yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    const tabs = await ok(env, Effect.gen(function* () { return yield* (yield* TabsRepo).listByWorkspace(ws.id) }))
    expect(tabs.map((tab) => [tab.kind, tab.engineSessionId])).toEqual([["engine", "resume-me"]])
  })
  it("keeps queued prompts on archive", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () {
      yield* (yield* QueueRepo).enqueue({ workspaceId: ws.id, tabId: "t1", text: "稍后继续" })
      yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    const queued = await ok(env, Effect.gen(function* () { return yield* (yield* QueueRepo).listQueued(ws.id) }))
    expect(queued.map((item) => item.text)).toEqual(["稍后继续"])
  })
  it("clean worktree: removes worktree (non-force), keeps branch, sets archived_at", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    const out = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(out.status).toBe("archived")
    expect(out.archivedAt).toBeTypeOf("number")
    expect(env.fake.state.worktrees.size).toBe(0)
    expect(env.fake.state.calls.some((c) => c[0] === "worktreeRemove" && c[3] === "false")).toBe(true)
    expect(env.fake.state.refs.has("refs/heads/coolie/work")).toBe(true) // branch 保留
    expect(await eventTypes(env)).toContain("workspace.archived")
  })
  it("dirty worktree: refuses without force, succeeds with force", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    env.fake.state.dirty.add(ws.path)
    const refused = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(failTag(refused)).toBe("ConflictError")
    const still = await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(ws.id) }))
    expect(still.status).toBe("active") // 拒绝时不改状态
    const forced = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id, { force: true })
    }))
    expect(forced.status).toBe("archived")
  })
  it("freezes input before killing the session, then restores active runtime when the final dirty guard fails", async () => {
    let env!: ReturnType<typeof makeEnv>
    env = makeEnv({
      onKillSession: () => {
        const row = env.db.prepare("SELECT status FROM workspaces WHERE branch = ?").get("coolie/work") as { status: string }
        expect(row.status).toBe("archiving")
        const wsPath = [...env.fake.state.worktrees.keys()][0]!
        env.fake.state.dirty.add(wsPath)
      },
    })
    const ws = await setupActive(env)
    const ensuresBeforeArchive = env.ensureRuns()
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(failTag(exit)).toBe("ConflictError")
    expect(env.killRuns()).toBe(1)
    expect(env.ensureRuns()).toBe(ensuresBeforeArchive + 1)
    expect((await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).get(ws.id)
    }))).status).toBe("active")
    expect(await eventTypes(env)).toContain("workspace.archive.failed")
  })
  it("restores active only after kill-session failure is followed by successful runtime recovery", async () => {
    const env = makeEnv({ failKillSession: true })
    const ws = await setupActive(env)
    const ensuresBeforeArchive = env.ensureRuns()
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(failTag(exit)).toBe("TmuxError")
    expect(env.ensureRuns()).toBe(ensuresBeforeArchive + 1)
    expect((await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).get(ws.id)
    }))).status).toBe("active")
  })
  it("keeps archiving with a typed retry error when runtime recovery fails", async () => {
    let env!: ReturnType<typeof makeEnv>
    env = makeEnv({ onKillSession: () => env.fake.state.dirty.add([...env.fake.state.worktrees.keys()][0]!) })
    const ws = await setupActive(env)
    env.setFailEnsure(true)
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(failTag(exit)).toBe("ArchiveError")
    const state = await ok(env, Effect.gen(function* () {
      const workspaces = yield* WorkspacesRepo
      return { workspace: yield* workspaces.get(ws.id), operation: yield* workspaces.getArchiveOperation(ws.id) }
    }))
    expect(state.workspace.status).toBe("archiving")
    expect(state.operation.lastError).toMatchObject({ tag: "ArchiveError", stage: "runtime-recovery" })
    env.setFailEnsure(false)
    const completed = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id, { force: true })
    }))
    expect(completed.status).toBe("archived")
    expect(env.fake.state.worktrees.has(ws.path)).toBe(false)
  })
  it("compensates a tab-cleanup failure without deleting tab metadata", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () {
      yield* (yield* TabsRepo).insert({ workspaceId: ws.id, kind: "shell", tmuxWindow: 2 })
    }))
    env.db.exec(`CREATE TRIGGER fail_archive_tab_cleanup
      BEFORE DELETE ON tabs WHEN OLD.kind <> 'engine'
      BEGIN SELECT RAISE(FAIL, 'injected tab cleanup failure'); END`)
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(failTag(exit)).toBe("ArchiveError")
    expect((await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).get(ws.id)
    }))).status).toBe("active")
    expect((await ok(env, Effect.gen(function* () {
      return yield* (yield* TabsRepo).listByWorkspace(ws.id)
    }))).some((tab) => tab.kind === "shell")).toBe(true)
  })
  it("compensates worktree-remove failure to a verified active runtime", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    env.fake.state.failOps.add("worktreeRemove")
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(failTag(exit)).toBe("GitError")
    expect((await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).get(ws.id)
    }))).status).toBe("active")
    expect(env.fake.state.worktrees.has(ws.path)).toBe(true)
  })
  it("reconciles a persisted archiving phase after daemon restart", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () {
      yield* (yield* WorkspacesRepo).setStatus(ws.id, "archiving")
      yield* (yield* WorkspaceLifecycle).reconcileArchives()
    }))
    const recovered = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).get(ws.id)
    }))
    expect(recovered.status).toBe("archived")
    expect(env.fake.state.worktrees.has(ws.path)).toBe(false)
  })
  it("rebuilds the layer from file SQLite and preserves force intent across restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-archive-restart-"))
    const dbPath = path.join(root, "coolie.db")
    const workspacePath = path.join(root, "workspace")
    const fake = makeFakeGit()
    const db1 = new Database(dbPath)
    runMigrations(db1)
    db1.prepare("INSERT INTO projects VALUES ('p1', 'demo', ?, 'main', 1)").run(root)
    const repoLayer1 = WorkspacesRepoLive.pipe(Layer.provide(Layer.succeed(Db, db1)))
    const first = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating({
        projectId: "p1", name: "restart", path: workspacePath, branch: "coolie/restart",
        baseBranch: "main", portBase: 41000,
      })
      yield* repo.setStatus(ws.id, "active")
      return yield* repo.beginArchive(ws.id, true)
    }), repoLayer1))
    fake.state.refs.set("refs/heads/coolie/restart", "a".repeat(40))
    fake.state.worktrees.set(workspacePath, "coolie/restart")
    fake.state.dirty.add(workspacePath)
    db1.close()

    const db2 = new Database(dbPath)
    runMigrations(db2)
    const cfg = {
      home: root, dbPath, serverInfoPath: path.join(root, "server.json"),
      workspacesRoot: path.join(root, "workspaces"),
    }
    const layer2 = WorkspaceLifecycleLive.pipe(
      Layer.provideMerge(Layer.mergeAll(
        Layer.succeed(GitService, fake.git),
        Layer.succeed(SetupRunner, { run: () => Effect.succeed([]) }),
        Layer.succeed(SessionEnsurer, {
          ensure: null as any, recoverArchive: null as any, resumeTab: null as any,
          createEngineTab: null as any, switchEngine: null as any,
        }),
        PostCreateHooksEmpty,
      )),
      Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
      Layer.provideMerge(Layer.succeed(Db, db2)),
      Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
    )
    const recovered = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      yield* (yield* WorkspaceLifecycle).reconcileArchives()
      return yield* (yield* WorkspacesRepo).get(first.workspace.id)
    }), layer2))
    expect(recovered.status).toBe("archived")
    expect(fake.state.calls.some((call) =>
      call[0] === "worktreeRemove" && call[2] === workspacePath && call[3] === "true")).toBe(true)
    expect(fake.state.worktrees.has(workspacePath)).toBe(false)
    db2.close()
  })
  it("non-active workspace cannot be archived", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).archive(ws.id) }))
    const again = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).archive(ws.id)
    }))
    expect(failTag(again)).toBe("ConflictError")
  })
})

describe("delete queue cleanup", () => {
  it("clears queued prompts before deleting workspace", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () {
      yield* (yield* QueueRepo).enqueue({ workspaceId: ws.id, tabId: "t1", text: "不要投了" })
      yield* (yield* WorkspaceLifecycle).delete(ws.id)
    }))
    expect(await ok(env, Effect.gen(function* () { return yield* (yield* QueueRepo).listQueued(ws.id) }))).toEqual([])
  })
})

describe("unarchive", () => {
  it("reactivates and heals an adopted workspace only while its external worktree remains registered", async () => {
    const env = makeEnv()
    const ws = await setupAdopted(env)
    await ok(env, Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).archive(ws.id) }))
    const out = await ok(env, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).unarchive(ws.id) }))
    expect(out.status).toBe("active")
    expect(env.ensureRuns()).toBe(1)
    expect(env.fake.state.calls.some((call) => call[0] === "worktreeAddExisting")).toBe(false)
  })
  it("returns Conflict when an archived adopted worktree was externally removed and never recreates it", async () => {
    const env = makeEnv()
    const ws = await setupAdopted(env)
    await ok(env, Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).archive(ws.id) }))
    env.fake.state.worktrees.delete(ws.path)
    const exit = await env.run(Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).unarchive(ws.id) }))
    expect(failTag(exit)).toBe("ConflictError")
    expect(env.fake.state.calls.some((call) => call[0] === "worktreeAddExisting")).toBe(false)
    expect((await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(ws.id) }))).status).toBe("archived")
  })
  it("does not rerun setup scripts", async () => {
    const env = makeEnv()
    fs.mkdirSync(path.join(env.repoRoot, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(env.repoRoot, ".coolie", "setup.local.sh"), "echo setup\n")
    const ws = await setupActive(env)
    expect(env.setupRuns()).toBe(1)
    await ok(env, Effect.gen(function* () {
      const lifecycle = yield* WorkspaceLifecycle
      yield* lifecycle.archive(ws.id)
      yield* lifecycle.unarchive(ws.id)
    }))
    expect(env.setupRuns()).toBe(1)
  })
  it("rebuilds the worktree from the kept branch", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).archive(ws.id) }))
    const out = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).unarchive(ws.id)
    }))
    expect(out.status).toBe("active")
    expect(out.archivedAt).toBeNull()
    expect(env.fake.state.worktrees.get(ws.path)).toBe("coolie/work")
    expect(env.fake.state.calls.some((c) => c[0] === "worktreeAddExisting" && c[3] === "coolie/work")).toBe(true)
    expect(await eventTypes(env)).toContain("workspace.unarchived")
  })
  it("missing branch -> ConflictError, stays archived", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).archive(ws.id) }))
    env.fake.state.refs.delete("refs/heads/coolie/work")
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).unarchive(ws.id)
    }))
    expect(failTag(exit)).toBe("ConflictError")
    const still = await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(ws.id) }))
    expect(still.status).toBe("archived")
  })
  it("worktree add failure cleans up and stays archived", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).archive(ws.id) }))
    env.fake.state.failOps.add("worktreeAddExisting")
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).unarchive(ws.id)
    }))
    expect(failTag(exit)).toBe("GitError")
    const still = await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(ws.id) }))
    expect(still.status).toBe("archived")
  })
  it("resumable after partial failure: worktree already present is not re-added", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).archive(ws.id) }))
    // 模拟卡住的半成品：上次 unarchive 里 worktreeAddExisting 已经成功落盘，
    // 但紧接着的 setStatus("active") 崩溃/DB 错误——row 仍是 archived，worktree 却已经在。
    // 直接把 worktree 注册回 fake 的状态里，模拟这个既成事实（与其它用例直接摆弄 state 的写法一致）。
    env.fake.state.worktrees.set(ws.path, ws.branch)
    const callsBefore = env.fake.state.calls.length
    const out = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).unarchive(ws.id)
    }))
    expect(out.status).toBe("active")
    expect(out.archivedAt).toBeNull()
    // resume path：不应再调用 worktreeAddExisting（真实 git 会报 already exists，把已经恢复好的 worktree 又删掉）
    expect(env.fake.state.calls.slice(callsBefore).some((c) => c[0] === "worktreeAddExisting")).toBe(false)
    expect(env.fake.state.worktrees.get(ws.path)).toBe("coolie/work")
    expect(await eventTypes(env)).toContain("workspace.unarchived")
  })
  it("non-archived workspace cannot be unarchived", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).unarchive(ws.id)
    }))
    expect(failTag(exit)).toBe("ConflictError")
  })
})

describe("delete", () => {
  it("rejects delete while an archive operation is retryable", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () {
      yield* (yield* WorkspacesRepo).beginArchive(ws.id, false)
    }))
    const exit = await env.run(Effect.gen(function* () {
      yield* (yield* WorkspaceLifecycle).delete(ws.id, { force: true })
    }))
    expect(failTag(exit)).toBe("ConflictError")
    expect(env.fake.state.worktrees.has(ws.path)).toBe(true)
    expect((await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).get(ws.id)
    }))).status).toBe("archiving")
  })
  it("deletes adopted registration while preserving a dirty external worktree and branch", async () => {
    const env = makeEnv()
    const ws = await setupAdopted(env)
    env.fake.state.dirty.add(ws.path)
    await ok(env, Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).delete(ws.id, { force: true }) }))
    expect(env.fake.state.worktrees.get(ws.path)).toBe(ws.branch)
    expect(env.fake.state.dirty.has(ws.path)).toBe(true)
    expect(env.fake.state.refs.has(`refs/heads/${ws.branch}`)).toBe(true)
    expect(env.fake.state.calls.some((call) => call[0] === "worktreeRemove")).toBe(false)
  })
  it("active + dirty: refuses without force; force removes worktree, row and keeps branch", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    env.fake.state.dirty.add(ws.path)
    const refused = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).delete(ws.id)
    }))
    expect(failTag(refused)).toBe("ConflictError")
    await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).delete(ws.id, { force: true })
    }))
    const gone = await env.run(Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(ws.id) }))
    expect(failTag(gone)).toBe("NotFoundError")
    expect(env.fake.state.worktrees.size).toBe(0)
    expect(env.fake.state.refs.has("refs/heads/coolie/work")).toBe(true) // branch 保留
    expect(await eventTypes(env)).toContain("workspace.deleted")
  })
  it("archived workspace deletes without touching worktrees (prune only)", async () => {
    const env = makeEnv()
    const ws = await setupActive(env)
    await ok(env, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).archive(ws.id) }))
    const before = env.fake.state.calls.filter((c) => c[0] === "worktreeRemove").length
    await ok(env, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).delete(ws.id) }))
    const after = env.fake.state.calls.filter((c) => c[0] === "worktreeRemove").length
    expect(after).toBe(before) // 没有 worktree 可删 → 不调 remove
    const gone = await env.run(Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(ws.id) }))
    expect(failTag(gone)).toBe("NotFoundError")
  })
})

describe("adopted retry", () => {
  it("retries only runtime ensure and never provisions or removes the external worktree", async () => {
    const env = makeEnv()
    const ws = await setupAdopted(env)
    await ok(env, Effect.gen(function* () {
      yield* (yield* WorkspacesRepo).setStatus(ws.id, "error")
    }))
    const callsBefore = env.fake.state.calls.length
    const out = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).retry(ws.id)
    }))
    expect(out.status).toBe("active")
    expect(env.ensureRuns()).toBe(1)
    expect(env.fake.state.calls.slice(callsBefore).some((call) =>
      ["fetchOrigin", "worktreeAdd", "worktreeAddExisting", "worktreeRemove"].includes(call[0]!))).toBe(false)
    expect(env.fake.state.worktrees.get(ws.path)).toBe(ws.branch)
  })
  it("keeps adopted retry in error when ensure fails without touching the external worktree", async () => {
    const env = makeEnv()
    const ws = await setupAdopted(env)
    await ok(env, Effect.gen(function* () { yield* (yield* WorkspacesRepo).setStatus(ws.id, "error") }))
    env.setFailEnsure(true)
    const exit = await env.run(Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).retry(ws.id) }))
    expect(failTag(exit)).toBe("TmuxError")
    expect((await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(ws.id) }))).status).toBe("error")
    expect(env.fake.state.worktrees.get(ws.path)).toBe(ws.branch)
    expect(env.fake.state.calls.some((call) => call[0] === "worktreeRemove")).toBe(false)
  })
})
