import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"
import { Effect, Layer, Exit, Cause, Option } from "effect"
import { CoolieConfigLive } from "../src/config.js"
import { DbLive } from "../src/db/sqlite.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { GitServiceLive } from "../src/git/service.js"
import { SetupRunnerLive } from "../src/workspace/setup.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive, PostCreateHooksEmpty } from "../src/workspace/lifecycle.js"

type AnyServices = WorkspaceLifecycle | WorkspacesRepo | ProjectsRepo | EventsRepo

const sh = (cwd: string, cmd: string, ...args: string[]): string =>
  execFileSync(cmd, args, { cwd, encoding: "utf8" })
const mkdir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

let home: string, wsRoot: string, upstream: string, parent: string, repoRoot: string
let projectId: string
let ws1: any, ws2: any

const buildLayer = () => WorkspaceLifecycleLive.pipe(
  Layer.provideMerge(Layer.mergeAll(GitServiceLive, SetupRunnerLive, PostCreateHooksEmpty)),
  Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
  Layer.provideMerge(DbLive),
  Layer.provideMerge(CoolieConfigLive),
)
// 每次运行重建 layer（Db 开关一次）；状态经 <home>/coolie.db 文件持续
const run = <A, E>(eff: Effect.Effect<A, E, AnyServices>) =>
  Effect.runPromiseExit(Effect.provide(eff, buildLayer()) as Effect.Effect<A, E, never>)
const ok = async <A, E>(eff: Effect.Effect<A, E, AnyServices>): Promise<A> => {
  const exit = await run(eff)
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}
const failTag = async (eff: Effect.Effect<any, any, AnyServices>): Promise<string | undefined> => {
  const exit = await run(eff)
  if (!Exit.isFailure(exit)) return undefined
  const f = Cause.failureOption(exit.cause)
  return Option.isSome(f) ? (f.value as any)._tag : undefined
}
const lc = <A, E>(f: (l: import("../src/workspace/lifecycle.js").WorkspaceLifecycleShape) => Effect.Effect<A, E, any>) =>
  Effect.gen(function* () { return yield* f(yield* WorkspaceLifecycle) })

beforeAll(() => {
  home = mkdir("coolie-int-home-")
  wsRoot = mkdir("coolie-int-wsroot-")
  process.env.COOLIE_HOME = home
  process.env.COOLIE_WORKSPACES_ROOT = wsRoot
  // upstream：被 clone 的"远端"
  upstream = mkdir("coolie-int-upstream-")
  sh(upstream, "git", "init", "-b", "main")
  sh(upstream, "git", "config", "user.email", "t@t")
  sh(upstream, "git", "config", "user.name", "t")
  fs.writeFileSync(path.join(upstream, "README.md"), "hello\n")
  fs.writeFileSync(path.join(upstream, ".gitignore"), ".env\n")
  fs.writeFileSync(path.join(upstream, ".worktreeinclude"), ".env*\n")
  fs.mkdirSync(path.join(upstream, ".coolie"), { recursive: true })
  fs.writeFileSync(path.join(upstream, ".coolie", "setup.sh"),
    '#!/bin/bash\nset -e\necho setup-ran\nmkdir -p .coolie\necho "$COOLIE_PORT_0" > .coolie/port.txt\n')
  sh(upstream, "git", "add", "-A")
  sh(upstream, "git", "commit", "-m", "init")
  // 用户主 checkout = clone（自动有 origin/main）
  parent = mkdir("coolie-int-parent-")
  repoRoot = path.join(parent, "repo")
  execFileSync("git", ["clone", upstream, repoRoot], { encoding: "utf8" })
  sh(repoRoot, "git", "config", "user.email", "t@t")
  sh(repoRoot, "git", "config", "user.name", "t")
  fs.writeFileSync(path.join(repoRoot, ".env"), "SECRET=42\n") // gitignored，等待被复制
})
afterAll(() => {
  delete process.env.COOLIE_HOME
  delete process.env.COOLIE_WORKSPACES_ROOT
  // Best-effort cleanup of mkdtemp directories
  for (const dir of [home, wsRoot, upstream, parent]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
})

describe("integration: workspace lifecycle against a real git repo", () => {
  it("create -> active with worktree, branch.base, baseRef, .env copy, ports, info/exclude, events", async () => {
    projectId = (await ok(Effect.gen(function* () {
      return yield* (yield* ProjectsRepo).add(repoRoot)
    }))).id
    ws1 = await ok(lc((l) => l.create({ projectId, branchSlug: "fix-login" })))
    expect(ws1.status).toBe("active")
    expect(ws1.branch).toBe("coolie/fix-login")
    expect(ws1.name).toMatch(/^[a-z]+-[a-z0-9]+(-\d+)?$/)
    expect(ws1.portBase).toBe(40000)
    expect(fs.existsSync(path.join(ws1.path, "README.md"))).toBe(true)
    expect(fs.readFileSync(path.join(ws1.path, ".env"), "utf8")).toBe("SECRET=42\n") // .worktreeinclude 复制
    expect(fs.readFileSync(path.join(ws1.path, ".coolie", "port.txt"), "utf8").trim())
      .toBe(String(ws1.portBase)) // setup 收到 COOLIE_PORT_0
    expect(sh(repoRoot, "git", "config", `branch.${ws1.branch}.base`).trim()).toBe("origin/main")
    expect(ws1.baseRef).toBe(sh(repoRoot, "git", "rev-parse", "origin/main").trim())
    expect(fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8")).toContain(".coolie/")
    const types = (await ok(Effect.gen(function* () {
      return yield* (yield* EventsRepo).listAfter({ after: 0 })
    }))).map((e) => e.type)
    for (const t of ["workspace.intent.created", "workspace.setup.started", "workspace.setup.finished", "workspace.created"])
      expect(types).toContain(t)
  }, 30_000)

  it("setup exit 1 -> rollback (no orphan worktree, status=error); retry -> active with next port block", async () => {
    // 本机覆盖层脚本故意失败（三层中的第 2 层）
    const overlay = path.join(home, "projects", projectId)
    fs.mkdirSync(overlay, { recursive: true })
    fs.writeFileSync(path.join(overlay, "setup.sh"), "#!/bin/bash\nexit 1\n")
    expect(await failTag(lc((l) => l.create({ projectId, branchSlug: "will-fail" }))))
      .toBe("SetupScriptError")
    ws2 = (await ok(Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).list({ projectId })
    }))).find((w) => w.branch === "coolie/will-fail")!
    expect(ws2.status).toBe("error")
    expect(fs.existsSync(ws2.path)).toBe(false) // 回滚删净
    expect(sh(repoRoot, "git", "worktree", "list")).not.toContain(ws2.path) // git 眼中也没有
    // branch 保留且仍指向 baseRef（纪律 + retry 复用前提）
    expect(sh(repoRoot, "git", "rev-parse", "refs/heads/coolie/will-fail").trim())
      .toBe(sh(repoRoot, "git", "rev-parse", "origin/main").trim())
    // Verify lastError persistence in the DB
    const db = new Database(path.join(home, "coolie.db"), { readonly: true })
    try {
      const row = db.prepare("SELECT data FROM workspaces WHERE id = ?").get(ws2.id) as { data: string } | undefined
      expect(row).toBeDefined()
      const data = JSON.parse(row!.data)
      expect(data.lastError).toBeDefined()
      expect(data.lastError.tag).toBe("SetupScriptError")
      expect(typeof data.lastError.at).toBe("number")
    } finally {
      db.close()
    }
    fs.rmSync(path.join(overlay, "setup.sh"))
    ws2 = await ok(lc((l) => l.retry(ws2.id)))
    expect(ws2.status).toBe("active")
    expect(ws2.portBase).toBe(40010)
    expect(fs.existsSync(ws2.path)).toBe(true)
    expect(ws2.name).not.toBe(ws1.name)
  }, 30_000)

  it("archive (clean) removes worktree, keeps branch; unarchive restores committed work", async () => {
    fs.writeFileSync(path.join(ws2.path, "feature.txt"), "done\n")
    sh(ws2.path, "git", "add", "-A")
    sh(ws2.path, "git", "commit", "-m", "feature")
    const archived = await ok(lc((l) => l.archive(ws2.id)))
    expect(archived.status).toBe("archived")
    expect(fs.existsSync(ws2.path)).toBe(false)
    expect(sh(repoRoot, "git", "rev-parse", "--verify", "refs/heads/coolie/will-fail").trim())
      .toMatch(/^[0-9a-f]{40}$/)
    const back = await ok(lc((l) => l.unarchive(ws2.id)))
    expect(back.status).toBe("active")
    expect(fs.readFileSync(path.join(ws2.path, "feature.txt"), "utf8")).toBe("done\n")
  }, 30_000)

  it("dirty guards: archive/delete refuse without force; force delete keeps branch, removes row", async () => {
    fs.appendFileSync(path.join(ws1.path, "README.md"), "dirty\n") // tracked 改动 → 脏
    expect(await failTag(lc((l) => l.archive(ws1.id)))).toBe("ConflictError")
    expect(await failTag(lc((l) => l.delete(ws1.id)))).toBe("ConflictError")
    await ok(lc((l) => l.delete(ws1.id, { force: true })))
    expect(await failTag(Effect.gen(function* () {
      return yield* (yield* WorkspacesRepo).get(ws1.id)
    }))).toBe("NotFoundError")
    expect(fs.existsSync(ws1.path)).toBe(false)
    expect(sh(repoRoot, "git", "rev-parse", "--verify", "refs/heads/coolie/fix-login").trim())
      .toMatch(/^[0-9a-f]{40}$/) // branch 保留
  }, 30_000)

  it("delete on active clean ws2; only the main checkout remains a worktree", async () => {
    await ok(lc((l) => l.delete(ws2.id)))
    const list = sh(repoRoot, "git", "worktree", "list")
    expect(list.trim().split("\n")).toHaveLength(1) // 只剩主 checkout，无孤儿
  }, 30_000)
})
