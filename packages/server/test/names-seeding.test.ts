import { describe, it, expect, beforeAll } from "vitest"
import { Effect, Layer } from "effect"
import Database from "better-sqlite3"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { GitServiceLive } from "../src/git/service.js"
import { SetupRunnerLive } from "../src/workspace/setup.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive, PostCreateHooksEmpty } from "../src/workspace/lifecycle.js"
import { NATIONAL_PARKS } from "../src/workspace/names.js"

let db: Database.Database, home: string, wsRoot: string, repoA: string, repoB: string

const gitInit = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: dir })
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-seed-home-"))
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-seed-ws-"))
  // 两个不同 repo，目录名（= project.name）相同 → 共享 workspacesRoot/alpha/ 名字空间
  repoA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-seed-a-")), "alpha")
  repoB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-seed-b-")), "alpha")
  fs.mkdirSync(repoA); fs.mkdirSync(repoB)
  gitInit(repoA); gitInit(repoB)
  db = new Database(":memory:"); runMigrations(db)
})

const layer = () => WorkspaceLifecycleLive.pipe(
  Layer.provideMerge(Layer.mergeAll(GitServiceLive, SetupRunnerLive, PostCreateHooksEmpty)),
  Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
  Layer.provideMerge(Layer.succeed(Db, db)),
  Layer.provideMerge(Layer.succeed(CoolieConfig, {
    home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
    workspacesRoot: wsRoot, tmuxSocket: "coolie-test-unused", claudeHome: path.join(home, "ch"), codexHome: path.join(home, "cx"),
  })),
)

describe("名池跨项目 seeding（路径撞车防护）", () => {
  it("project B 的自动命名在全局池耗尽时给出可读错误", async () => {
    const create = Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const wsRepo = yield* WorkspacesRepo
      const lc = yield* WorkspaceLifecycle
      const pA = yield* projects.add(repoA)
      const pB = yield* projects.add(repoB)
      // project A 占满整个名池（直接插行，不跑 git——占名即可）
      let port = 40_000
      for (const name of NATIONAL_PARKS.names) {
        yield* wsRepo.insertCreating({
          projectId: pA.id, name, path: path.join(wsRoot, "alpha", name),
          branch: `coolie/${name}`, baseBranch: "main", portBase: (port += 10),
        })
      }
      return yield* lc.create({ projectId: pB.id })
    }), layer()) as Effect.Effect<any, never, never>)
    await expect(create).rejects.toThrow("national-parks")
  })
})
