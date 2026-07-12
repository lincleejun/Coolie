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
import { SetupRunner, SetupScriptError, type SetupRunnerShape } from "../src/workspace/setup.js"
import {
  WorkspaceLifecycle, WorkspaceLifecycleLive, PostCreateHooks, HookError, type PostCreateHook,
} from "../src/workspace/lifecycle.js"
import { NATIONAL_PARKS } from "../src/workspace/names.js"
import { makeFakeGit, FAKE_SHA } from "./helpers/fake-git.js"

type AnyServices = WorkspaceLifecycle | WorkspacesRepo | ProjectsRepo | EventsRepo

const makeEnv = (gitInit?: Parameters<typeof makeFakeGit>[0]) => {
  const db = new Database(":memory:"); runMigrations(db)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lc-home-"))
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lc-ws-"))
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lc-repo-"))
  fs.mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true }) // 假 repo：过 ProjectsRepo.add 校验 + info/exclude 可写
  const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: wsRoot }
  const fake = makeFakeGit(gitInit)
  let setupImpl: SetupRunnerShape["run"] = () => Effect.succeed([])
  const setup: SetupRunnerShape = { run: (o) => setupImpl(o) }
  const hooks: PostCreateHook[] = []
  const layer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(GitService, fake.git),
      Layer.succeed(SetupRunner, setup),
      Layer.succeed(PostCreateHooks, hooks),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
  )
  const run = <A, E>(eff: Effect.Effect<A, E, AnyServices>) =>
    Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<A, E, never>)
  return { fake, repoRoot, wsRoot, run, hooks, setSetup: (f: SetupRunnerShape["run"]) => { setupImpl = f } }
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
const addProject = (repoRoot: string) => Effect.gen(function* () {
  return yield* (yield* ProjectsRepo).add(repoRoot)
})
const eventTypes = Effect.gen(function* () {
  return (yield* (yield* EventsRepo).listAfter({ after: 0 })).map((e) => e.type)
})

describe("WorkspaceLifecycle.create", () => {
  it("happy path: pool name, coolie/<name> branch, port 40000, branch.base, info/exclude, events", async () => {
    const env = makeEnv()
    const ws = await ok(env, Effect.gen(function* () {
      const p = yield* addProject(env.repoRoot)
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id })
    }))
    expect(ws.status).toBe("active")
    expect(NATIONAL_PARKS.names).toContain(ws.name)
    expect(ws.branch).toBe(`coolie/${ws.name}`)
    expect(ws.path).toBe(path.join(env.wsRoot, path.basename(env.repoRoot), ws.name))
    expect(ws.portBase).toBe(40000)
    expect(ws.baseRef).toBe(FAKE_SHA)
    expect(env.fake.state.worktrees.get(ws.path)).toBe(ws.branch)
    expect(env.fake.state.branchBases.get(ws.branch)).toBe("origin/main")
    expect(fs.readFileSync(path.join(env.repoRoot, ".git", "info", "exclude"), "utf8")).toContain(".coolie/")
    const types = await ok(env, eventTypes)
    expect(types).toContain("workspace.creating")
    expect(types).toContain("workspace.created")
  })
  it("sanitizes an explicit branchSlug", async () => {
    const env = makeEnv()
    const ws = await ok(env, Effect.gen(function* () {
      const p = yield* addProject(env.repoRoot)
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id, branchSlug: "Fix Login!!" })
    }))
    expect(ws.branch).toBe("coolie/fix-login")
  })
  it("second workspace gets a different name and the next port block", async () => {
    const env = makeEnv()
    const [a, b] = await ok(env, Effect.gen(function* () {
      const p = yield* addProject(env.repoRoot)
      const lc = yield* WorkspaceLifecycle
      const w1 = yield* lc.create({ projectId: p.id })
      const w2 = yield* lc.create({ projectId: p.id })
      return [w1, w2] as const
    }))
    expect(b.name).not.toBe(a.name)
    expect(b.portBase).toBe(40010)
  })
  it("no origin remote: skips fetch, bases off local branch", async () => {
    const env = makeEnv({ hasOrigin: false, refs: { main: FAKE_SHA } })
    const ws = await ok(env, Effect.gen(function* () {
      const p = yield* addProject(env.repoRoot)
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id })
    }))
    expect(ws.status).toBe("active")
    expect(env.fake.state.calls.some((c) => c[0] === "fetchOrigin")).toBe(false)
    // startPoint 落在本地 main
    expect(env.fake.state.calls.some((c) => c[0] === "worktreeAdd" && c[4] === "main")).toBe(true)
  })
  it("setup failure -> rollback: worktree force-removed, status=error, workspace.error event; branch kept", async () => {
    const env = makeEnv()
    const p = await ok(env, addProject(env.repoRoot))
    // local overlay 放一个真实脚本文件（resolveSetupScripts 查 <repoRoot>/.coolie/setup.local.sh），
    // 让 scripts 非空、SetupRunner 假实现被调用并失败

    const overlayDir = path.join(env.repoRoot, ".coolie")
    fs.mkdirSync(overlayDir, { recursive: true })
    fs.writeFileSync(path.join(overlayDir, "setup.local.sh"), "#!/bin/bash\nexit 1\n")
    env.setSetup(() => Effect.fail(new SetupScriptError({ script: "setup.local.sh", exitCode: 1, message: "boom", outputTail: "" })))
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id, branchSlug: "will-fail" })
    }))
    expect(failTag(exit)).toBe("SetupScriptError")
    const rows = await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).list() }))
    const ws = rows.find((w) => w.branch === "coolie/will-fail")!
    expect(ws.status).toBe("error")
    expect(env.fake.state.worktrees.size).toBe(0) // 回滚删净，不留孤儿
    expect(env.fake.state.calls.some((c) => c[0] === "worktreeRemove" && c[3] === "true")).toBe(true) // 回滚走 force remove
    expect(env.fake.state.refs.has(`refs/heads/coolie/will-fail`)).toBe(true) // branch 保留
    const types = await ok(env, eventTypes)
    expect(types).toContain("workspace.error")
  })
  it("retry reruns the pipeline reusing name/branch/path/port; existing branch at baseRef is reused", async () => {
    const env = makeEnv()
    const p = await ok(env, addProject(env.repoRoot))
    fs.mkdirSync(path.join(env.repoRoot, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(env.repoRoot, ".coolie", "setup.local.sh"), "#!/bin/bash\nexit 1\n")
    env.setSetup(() => Effect.fail(new SetupScriptError({ script: "x", exitCode: 1, message: "boom", outputTail: "" })))
    await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id, branchSlug: "retry-me" })
    }))
    env.setSetup(() => Effect.succeed([]))
    const errored = (await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).list() })))
      .find((w) => w.branch === "coolie/retry-me")!
    const ws = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).retry(errored.id)
    }))
    expect(ws.id).toBe(errored.id)
    expect(ws.status).toBe("active")
    expect(ws.portBase).toBe(errored.portBase)
    // branch 已存在且指向 baseRef → 复用而非 -b 新建
    expect(env.fake.state.calls.some((c) => c[0] === "worktreeAddExisting" && c[3] === "coolie/retry-me")).toBe(true)
  })
  it("retry survives the base branch advancing: untouched branch is reused at its own tip, not the new base", async () => {
    const env = makeEnv()
    const p = await ok(env, addProject(env.repoRoot))
    fs.mkdirSync(path.join(env.repoRoot, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(env.repoRoot, ".coolie", "setup.local.sh"), "#!/bin/bash\nexit 1\n")
    env.setSetup(() => Effect.fail(new SetupScriptError({ script: "x", exitCode: 1, message: "boom", outputTail: "" })))
    await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id, branchSlug: "base-advances" })
    }))
    const errored = (await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).list() })))
      .find((w) => w.branch === "coolie/base-advances")!
    expect(errored.status).toBe("error")
    expect(errored.baseRef).toBe(FAKE_SHA) // 失败尝试记的旧 baseRef == branch 当前所在提交（未被动过）
    // origin/main 在失败尝试之后前进（模拟远端合入了新提交），但 coolie/base-advances 分支未被动过
    const ADVANCED_SHA = "b".repeat(40)
    env.fake.state.refs.set("origin/main", ADVANCED_SHA)
    env.setSetup(() => Effect.succeed([]))
    const ws = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).retry(errored.id)
    }))
    expect(ws.status).toBe("active")
    // diff base 记为 branch 实际所在的位置（旧 baseRef），而非已前进的 origin/main
    expect(ws.baseRef).toBe(FAKE_SHA)
    expect(env.fake.state.calls.some((c) => c[0] === "worktreeAddExisting" && c[3] === "coolie/base-advances")).toBe(true)
    // branch 本身从未被删除/重置：仍指向失败尝试时的提交
    expect(env.fake.state.refs.get("refs/heads/coolie/base-advances")).toBe(FAKE_SHA)
  })
  it("retry 补投原 initialPrompt + engineId（C2）", async () => {
    const env = makeEnv()
    const seen: Array<{ initialPrompt?: string; engineId?: string }> = []
    let calls = 0
    env.hooks.push((_ws, ctx) => {
      seen.push({ ...ctx })
      calls += 1
      // 首次 hook（pre-delivery）失败 → status=error；重试时须补回原 ctx
      return calls === 1 ? Effect.fail(new HookError({ message: "pre-delivery boom" })) : Effect.void
    })
    const p = await ok(env, addProject(env.repoRoot))
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id, engineId: "codex", initialPrompt: "第一句" })
    }))
    expect(failTag(exit)).toBe("HookError")
    const errored = (await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).list() })))[0]!
    expect(errored.status).toBe("error")
    seen.length = 0
    await ok(env, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).retry(errored.id) }))
    // 重试补回原 prompt+引擎，而非 {}（账本 C2）
    expect(seen[0]).toEqual({ initialPrompt: "第一句", engineId: "codex" })
  })
  it("retry on a non-error workspace -> ConflictError", async () => {
    const env = makeEnv()
    const p = await ok(env, addProject(env.repoRoot))
    const ws = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id })
    }))
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).retry(ws.id)
    }))
    expect(failTag(exit)).toBe("ConflictError")
  })
  it("existing branch with diverged history -> ConflictError + rollback", async () => {
    const env = makeEnv()
    env.fake.state.refs.set("refs/heads/coolie/taken", "f".repeat(40)) // ≠ baseRef
    const p = await ok(env, addProject(env.repoRoot))
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id, branchSlug: "taken" })
    }))
    expect(failTag(exit)).toBe("ConflictError")
    const rows = await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).list() }))
    expect(rows[0]!.status).toBe("error")
  })
  it("git failure (worktreeAdd) -> GitError + rollback to error", async () => {
    const env = makeEnv()
    env.fake.state.failOps.add("worktreeAdd")
    const p = await ok(env, addProject(env.repoRoot))
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id })
    }))
    expect(failTag(exit)).toBe("GitError")
    const rows = await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).list() }))
    expect(rows[0]!.status).toBe("error")
    expect(env.fake.state.worktrees.size).toBe(0)
  })
  it("post-create hooks run before active; a failing hook rolls back", async () => {
    const env = makeEnv()
    const seen: string[] = []
    let capturedBaseRef: string | undefined
    let capturedStatus: string | undefined
    env.hooks.push((ws) => Effect.sync(() => {
      seen.push(ws.id)
      capturedBaseRef = ws.baseRef
      capturedStatus = ws.status
    }))
    const p = await ok(env, addProject(env.repoRoot))
    const ws = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id })
    }))
    expect(seen).toEqual([ws.id])
    // hook 必须收到 provision 里已写入真实 baseRef 之后的新鲜快照，而非 insertCreating 时 baseRef="" 的旧快照
    expect(capturedBaseRef).toBe(FAKE_SHA)
    expect(capturedBaseRef).not.toBe("")
    expect(capturedStatus).toBe("creating")
    env.hooks.push(() => Effect.fail(new HookError({ message: "tmux exploded" })))
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id })
    }))
    expect(failTag(exit)).toBe("HookError")
  })
  it("unknown project -> NotFoundError, no row inserted", async () => {
    const env = makeEnv()
    const exit = await env.run(Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: "nope" })
    }))
    expect(failTag(exit)).toBe("NotFoundError")
    const rows = await ok(env, Effect.gen(function* () { return yield* (yield* WorkspacesRepo).list() }))
    expect(rows).toHaveLength(0)
  })
})
