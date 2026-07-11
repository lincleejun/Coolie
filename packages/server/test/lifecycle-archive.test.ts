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
import { GitService } from "../src/git/service.js"
import { SetupRunner, type SetupRunnerShape } from "../src/workspace/setup.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive, PostCreateHooksEmpty } from "../src/workspace/lifecycle.js"
import { makeFakeGit } from "./helpers/fake-git.js"

type AnyServices = WorkspaceLifecycle | WorkspacesRepo | ProjectsRepo | EventsRepo

const makeEnv = () => {
  const db = new Database(":memory:"); runMigrations(db)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-la-home-"))
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-la-ws-"))
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-la-repo-"))
  fs.mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true })
  const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: wsRoot }
  const fake = makeFakeGit()
  const setup: SetupRunnerShape = { run: () => Effect.succeed([]) }
  const layer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(GitService, fake.git),
      Layer.succeed(SetupRunner, setup),
      PostCreateHooksEmpty,
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
  )
  const run = <A, E>(eff: Effect.Effect<A, E, AnyServices>) =>
    Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<A, E, never>)
  return { fake, repoRoot, run }
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
const eventTypes = (env: ReturnType<typeof makeEnv>) =>
  ok(env, Effect.gen(function* () {
    return (yield* (yield* EventsRepo).listAfter({ after: 0 })).map((e) => e.type)
  }))

describe("archive", () => {
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

describe("unarchive", () => {
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
