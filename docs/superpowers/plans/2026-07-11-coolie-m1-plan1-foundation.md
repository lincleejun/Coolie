# Coolie M1 · Plan 1：基座（monorepo + protocol + server 核心 + CLI 骨架）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起 Coolie 的 CS 骨架：bun workspaces monorepo、`packages/protocol` 共享契约、`coolie-server` 按需 daemon（Effect + SQLite + loopback HTTP + token）、`coolie` CLI（自动拉起 server），端到端跑通 `coolie project add/list`。

**Architecture:** server 是独立 Node 进程，监听 127.0.0.1 随机端口，把 `{port, token, pid}` 写入 `~/.coolie/server.json`（0600）做发现与单实例互斥；CLI 读该文件探活，不在则 detached spawn 后轮询 `/health`。所有域类型与 API 形状只在 `packages/protocol` 定义一次。设计依据：`docs/superpowers/specs/2026-07-11-coolie-design.md` 第二、三、八、十一节。

**Tech Stack:** TypeScript ^5.x（strict）、bun ≥1.2（仅作包管理与脚本运行器）、**server/CLI 运行时 = Node ≥22**（node-pty 后续计划需要，禁 Bun 运行时）、Effect（Layer DI + Effect.gen + Schema）、better-sqlite3、vitest、commander。

## Global Constraints

- server 与 CLI 的一切进程**必须以 Node 运行**（`node`/`tsx`），bun 只做 `bun install`/`bun run`（设计文档 §2.2：node-pty 不兼容 Bun）。
- Effect 装当日最新稳定主版本（`bun add effect@latest`）。本计划代码按 `Context.Tag / Layer / Effect.gen / Schema` 稳定 API 书写；若所装版本 API 有出入，以官方 docs 为准做等价改写，**任务的行为契约（每步测试断言）不变**。
- SQLite 写库纪律（设计文档 §三）：migration 幂等、破坏性变更前先 `.bak`、禁止无 WHERE 的 sweep。
- server 绑定地址硬编码 `127.0.0.1`；除 `GET /health` 外所有端点强制 `Authorization: Bearer <token>`（设计文档 §2.1 安全默认值）。
- 所有测试通过 `COOLIE_HOME` 环境变量指向临时目录，绝不读写真实 `~/.coolie`。
- 每个 Task 结束必须 `git commit`；commit message 用 conventional commits（feat/test/chore）。
- 本计划**不做**：unix socket 监听（Plan 3 加）、SSE/events（Plan 2）、refcount 惰性退出（Plan 4）、workspaces 表的业务逻辑（Plan 2，本计划只建表）。

## File Structure（本计划新建）

```
package.json                     # bun workspaces 根
tsconfig.base.json               # 共享严格 tsconfig
vitest.config.ts                 # monorepo 测试入口
packages/protocol/
  package.json
  src/domain.ts                  # Project/Workspace/状态/错误 信封 Schema
  src/routes.ts                  # API 路由表（方法/路径/描述）
  src/index.ts                   # re-export
  test/domain.test.ts
packages/server/
  package.json
  src/config.ts                  # CoolieConfig service（路径解析）
  src/db/sqlite.ts               # Db service（better-sqlite3 + WAL）
  src/db/migrations.ts           # 幂等 migration runner + m0001
  src/repo/projects.ts           # ProjectsRepo service
  src/http/token.ts              # token 生成 + bearer 校验
  src/http/app.ts                # 路由组装（health/projects/shutdown）
  src/daemon/info.ts             # server.json 读写/探活/单实例
  src/main.ts                    # bin：start/status/stop
  test/{config,migrations,projects-repo,http,daemon}.test.ts
packages/cli/
  package.json
  src/client.ts                  # 发现 + 自动拉起 + fetch 封装
  src/main.ts                    # commander：server/project/api schema
  test/cli-e2e.test.ts
```

---

### Task 1: Monorepo 脚手架

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `packages/protocol/package.json`, `packages/server/package.json`, `packages/cli/package.json`, 各包 `tsconfig.json` 与空的 `src/index.ts`

**Interfaces:**
- Produces: 包名 `@coolie/protocol`、`@coolie/server`、`@coolie/cli`；根脚本 `bun run test` / `bun run typecheck`。后续所有任务在此结构内工作。

- [ ] **Step 1: 写根配置与三个包骨架**

`package.json`：
```json
{
  "name": "coolie",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b packages/protocol packages/server packages/cli"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

`tsconfig.base.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "composite": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  }
}
```

`vitest.config.ts`：
```ts
import { defineConfig } from "vitest/config"
export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
})
```

`packages/protocol/package.json`（server/cli 同型，改 name；server 与 cli 的 dependencies 加 `"@coolie/protocol": "workspace:*"`）：
```json
{
  "name": "@coolie/protocol",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "effect": "latest" }
}
```

各包 `tsconfig.json`：
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
（server/cli 的再加 `"references": [{ "path": "../protocol" }]`）

各包 `src/index.ts` 暂时只写 `export {}`。

- [ ] **Step 2: 安装并验证**

Run: `bun install && bun run typecheck && bun run test`
Expected: typecheck 通过；vitest 输出 "No test files found"（退出码 0，vitest 3 对空集默认 pass；若非 0，在 vitest.config.ts 的 test 里加 `passWithNoTests: true`）。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: monorepo scaffold (protocol/server/cli, bun workspaces + vitest)"
```

---

### Task 2: protocol 域模型与路由表

**Files:**
- Create: `packages/protocol/src/domain.ts`, `packages/protocol/src/routes.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/domain.test.ts`

**Interfaces:**
- Produces（后续所有任务消费）:
  - `Project`（Schema.Class）：`{ id: string; name: string; repoRoot: string; defaultBaseBranch: string; createdAt: number }`
  - `WorkspaceStatus = "creating" | "active" | "archived" | "error"`（Schema.Literal）
  - `ApiErrorBody`：`{ code: "GitError"|"TmuxError"|"EngineError"|"SetupScriptError"|"NotFound"|"Conflict"|"Validation"|"Internal"; message: string }`
  - `decodeProject(u: unknown): Project`（Schema.decodeUnknownSync 封装）
  - `ROUTES: ReadonlyArray<{ method: "GET"|"POST"|"DELETE"; path: string; description: string }>`

- [ ] **Step 1: 写失败测试**

`packages/protocol/test/domain.test.ts`：
```ts
import { describe, it, expect } from "vitest"
import { decodeProject, ApiErrorBody, ROUTES } from "@coolie/protocol"
import { Schema } from "effect"

describe("protocol domain", () => {
  it("round-trips a Project", () => {
    const raw = { id: "p1", name: "Coolie", repoRoot: "/tmp/x", defaultBaseBranch: "main", createdAt: 1 }
    const p = decodeProject(raw)
    expect(p.name).toBe("Coolie")
  })
  it("rejects a bad Project", () => {
    expect(() => decodeProject({ id: 1 })).toThrow()
  })
  it("ApiErrorBody accepts known codes only", () => {
    const dec = Schema.decodeUnknownSync(ApiErrorBody)
    expect(dec({ code: "NotFound", message: "x" }).code).toBe("NotFound")
    expect(() => dec({ code: "Nope", message: "x" })).toThrow()
  })
  it("ROUTES contains health and projects", () => {
    const paths = ROUTES.map(r => `${r.method} ${r.path}`)
    expect(paths).toContain("GET /health")
    expect(paths).toContain("POST /projects")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test -- packages/protocol`
Expected: FAIL（模块无导出）。

- [ ] **Step 3: 最小实现**

`packages/protocol/src/domain.ts`：
```ts
import { Schema } from "effect"

export const WorkspaceStatus = Schema.Literal("creating", "active", "archived", "error")
export type WorkspaceStatus = typeof WorkspaceStatus.Type

export class Project extends Schema.Class<Project>("Project")({
  id: Schema.String,
  name: Schema.String,
  repoRoot: Schema.String,
  defaultBaseBranch: Schema.String,
  createdAt: Schema.Number,
}) {}
export const decodeProject = Schema.decodeUnknownSync(Project)

export const ApiErrorCode = Schema.Literal(
  "GitError", "TmuxError", "EngineError", "SetupScriptError",
  "NotFound", "Conflict", "Validation", "Internal",
)
export const ApiErrorBody = Schema.Struct({ code: ApiErrorCode, message: Schema.String })
export type ApiErrorBody = typeof ApiErrorBody.Type
```

`packages/protocol/src/routes.ts`：
```ts
export const ROUTES = [
  { method: "GET",    path: "/health",       description: "存活探测（免 token）" },
  { method: "POST",   path: "/shutdown",     description: "优雅退出 daemon" },
  { method: "GET",    path: "/projects",     description: "列出已保存项目" },
  { method: "POST",   path: "/projects",     description: "保存项目 {repoRoot}" },
  { method: "DELETE", path: "/projects/:id", description: "忘记项目（只删记录）" },
] as const satisfies ReadonlyArray<{ method: "GET" | "POST" | "DELETE"; path: string; description: string }>
```

`packages/protocol/src/index.ts`：
```ts
export * from "./domain.js"
export * from "./routes.js"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test -- packages/protocol` → PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol && git commit -m "feat(protocol): domain schemas + route table"
```

---

### Task 3: server CoolieConfig service

**Files:**
- Create: `packages/server/src/config.ts`
- Test: `packages/server/test/config.test.ts`

**Interfaces:**
- Produces: `CoolieConfig`（Context.Tag）字段 `{ home; dbPath; serverInfoPath; workspacesRoot }`（全 string 绝对路径）；`CoolieConfigLive: Layer<CoolieConfig>`。解析规则：`COOLIE_HOME` 覆盖 `~/.coolie`；`COOLIE_WORKSPACES_ROOT` 覆盖 `~/coolie/workspaces`；`dbPath = <home>/coolie.db`；`serverInfoPath = <home>/server.json`。

- [ ] **Step 1: 写失败测试**

`packages/server/test/config.test.ts`：
```ts
import { describe, it, expect, afterEach } from "vitest"
import { Effect } from "effect"
import { CoolieConfig, CoolieConfigLive } from "../src/config.js"

const load = () => Effect.runSync(CoolieConfig.pipe(Effect.provide(CoolieConfigLive)))

describe("CoolieConfig", () => {
  afterEach(() => { delete process.env.COOLIE_HOME; delete process.env.COOLIE_WORKSPACES_ROOT })
  it("respects COOLIE_HOME", () => {
    process.env.COOLIE_HOME = "/tmp/coolie-test-home"
    const c = load()
    expect(c.home).toBe("/tmp/coolie-test-home")
    expect(c.dbPath).toBe("/tmp/coolie-test-home/coolie.db")
    expect(c.serverInfoPath).toBe("/tmp/coolie-test-home/server.json")
  })
  it("defaults under homedir", () => {
    const c = load()
    expect(c.home.endsWith("/.coolie")).toBe(true)
    expect(c.workspacesRoot.endsWith("/coolie/workspaces")).toBe(true)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server` → FAIL（文件不存在）。

- [ ] **Step 3: 实现**

`packages/server/src/config.ts`：
```ts
import { Context, Layer } from "effect"
import * as os from "node:os"
import * as path from "node:path"

export interface CoolieConfigShape {
  readonly home: string
  readonly dbPath: string
  readonly serverInfoPath: string
  readonly workspacesRoot: string
}
export class CoolieConfig extends Context.Tag("CoolieConfig")<CoolieConfig, CoolieConfigShape>() {}

export const CoolieConfigLive = Layer.sync(CoolieConfig, () => {
  const home = process.env.COOLIE_HOME ?? path.join(os.homedir(), ".coolie")
  return {
    home,
    dbPath: path.join(home, "coolie.db"),
    serverInfoPath: path.join(home, "server.json"),
    workspacesRoot: process.env.COOLIE_WORKSPACES_ROOT ?? path.join(os.homedir(), "coolie", "workspaces"),
  }
})
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → PASS。

- [ ] **Step 5: Commit** — `git add packages/server && git commit -m "feat(server): CoolieConfig service"`

---

### Task 4: SQLite service + 幂等 migration（m0001 四表）

**Files:**
- Create: `packages/server/src/db/sqlite.ts`, `packages/server/src/db/migrations.ts`
- Test: `packages/server/test/migrations.test.ts`
- 依赖：`cd packages/server && bun add better-sqlite3 && bun add -d @types/better-sqlite3`

**Interfaces:**
- Consumes: `CoolieConfig`（Task 3）
- Produces:
  - `Db`（Context.Tag，值为 `better-sqlite3` 的 `Database` 实例）；`DbLive: Layer<Db, never, CoolieConfig>`（scoped，acquire 时开库+WAL+migrate，release 时 close）
  - `runMigrations(db: Database): void`（幂等；migration 表 `schema_migrations(id TEXT PRIMARY KEY, applied_at INTEGER)`）
  - m0001 建表：`projects(id TEXT PK, name TEXT, repo_root TEXT UNIQUE, default_base_branch TEXT, created_at INTEGER)`；`workspaces(id TEXT PK, project_id TEXT REFERENCES projects(id), name TEXT, path TEXT, branch TEXT, base_branch TEXT, base_ref TEXT, status TEXT, pinned INTEGER DEFAULT 0, created_at INTEGER, archived_at INTEGER, data TEXT)`；`tabs(id TEXT PK, workspace_id TEXT REFERENCES workspaces(id), kind TEXT, engine_id TEXT, engine_session_id TEXT, tmux_window INTEGER, title TEXT, status TEXT, data TEXT)`；`events(seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, type TEXT, payload TEXT, ts INTEGER)`

- [ ] **Step 1: 写失败测试**

`packages/server/test/migrations.test.ts`：
```ts
import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../src/db/migrations.js"

const tables = (db: Database.Database) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name)

describe("migrations", () => {
  it("creates the four core tables", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const t = tables(db)
    for (const n of ["projects", "workspaces", "tabs", "events", "schema_migrations"]) expect(t).toContain(n)
  })
  it("is idempotent", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
    expect(db.prepare("SELECT COUNT(*) c FROM schema_migrations").get()).toEqual({ c: 1 })
  })
})
```

- [ ] **Step 2: 确认失败** → FAIL。

- [ ] **Step 3: 实现**

`packages/server/src/db/migrations.ts`：
```ts
import type Database from "better-sqlite3"

interface Migration { id: string; up: (db: Database.Database) => void }

const MIGRATIONS: Migration[] = [
  {
    id: "m0001-core-tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_root TEXT NOT NULL UNIQUE,
          default_base_branch TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
          name TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL,
          base_branch TEXT NOT NULL, base_ref TEXT NOT NULL, status TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          archived_at INTEGER, data TEXT);
        CREATE TABLE tabs (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          kind TEXT NOT NULL, engine_id TEXT, engine_session_id TEXT,
          tmux_window INTEGER, title TEXT, status TEXT, data TEXT);
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT,
          type TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL);
      `)
    },
  },
]

export const runMigrations = (db: Database.Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((r: any) => r.id))
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    const tx = db.transaction(() => {
      m.up(db)
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, Date.now())
    })
    tx()
  }
}
```

`packages/server/src/db/sqlite.ts`：
```ts
import { Context, Effect, Layer } from "effect"
import Database from "better-sqlite3"
import * as fs from "node:fs"
import * as path from "node:path"
import { CoolieConfig } from "../config.js"
import { runMigrations } from "./migrations.js"

export class Db extends Context.Tag("Db")<Db, Database.Database>() {}

export const DbLive = Layer.scoped(
  Db,
  Effect.gen(function* () {
    const cfg = yield* CoolieConfig
    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true })
        const db = new Database(cfg.dbPath)
        db.pragma("journal_mode = WAL")
        runMigrations(db)
        return db
      }),
      (db) => Effect.sync(() => db.close()),
    )
  }),
)
```

- [ ] **Step 4: 确认通过**，且 `bun run typecheck` 通过。

- [ ] **Step 5: Commit** — `git commit -am "feat(server): sqlite service + idempotent migrations (m0001 core tables)"`

---

### Task 5: ProjectsRepo service

**Files:**
- Create: `packages/server/src/repo/projects.ts`
- Test: `packages/server/test/projects-repo.test.ts`
- 依赖：`cd packages/server && bun add ulid`

**Interfaces:**
- Consumes: `Db`（Task 4）、`Project`（Task 2）
- Produces: `ProjectsRepo`（Context.Tag）+ `ProjectsRepoLive: Layer<ProjectsRepo, never, Db>`，方法：
  - `add(repoRoot: string): Effect<Project, ValidationError | ConflictError>` — 校验 `repoRoot` 存在且含 `.git`；name = basename；defaultBaseBranch 读 `HEAD`（`.git/HEAD` 的 `ref: refs/heads/<b>`，读不到则 `"main"`）；id = ulid
  - `list(): Effect<Project[]>`
  - `remove(id: string): Effect<void, NotFoundError>` — 只删记录
  - 错误类型（本包内定义，供 http 层映射）：`class ValidationError extends Data.TaggedError("ValidationError")<{message:string}>{}`；`ConflictError`、`NotFoundError` 同型

- [ ] **Step 1: 写失败测试**

`packages/server/test/projects-repo.test.ts`：
```ts
import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Layer, Exit } from "effect"
import Database from "better-sqlite3"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"

let repoRoot: string
beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-proj-"))
  execSync("git init -b main", { cwd: repoRoot })
})

const memDb = () => { const db = new Database(":memory:"); runMigrations(db); return db }
const layer = () => ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, memDb())))
const run = <A, E>(eff: Effect.Effect<A, E, ProjectsRepo>) =>
  Effect.runPromiseExit(eff.pipe(Effect.provide(layer())))

describe("ProjectsRepo", () => {
  it("adds and lists a project", async () => {
    const exit = await run(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      const p = yield* repo.add(repoRoot)
      expect(p.name).toBe(path.basename(repoRoot))
      expect(p.defaultBaseBranch).toBe("main")
      return yield* repo.list()
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toHaveLength(1)
  })
  it("rejects a non-git dir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-nogit-"))
    const exit = await run(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      return yield* repo.add(dir)
    }))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
```

- [ ] **Step 2: 确认失败** → FAIL。

- [ ] **Step 3: 实现**

`packages/server/src/repo/projects.ts`：
```ts
import { Context, Data, Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { ulid } from "ulid"
import { Project } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"

export class ValidationError extends Data.TaggedError("ValidationError")<{ message: string }> {}
export class ConflictError extends Data.TaggedError("ConflictError")<{ message: string }> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{ message: string }> {}

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
  readonly list: () => Effect.Effect<Project[]>
  readonly remove: (id: string) => Effect.Effect<void, NotFoundError>
}
export class ProjectsRepo extends Context.Tag("ProjectsRepo")<ProjectsRepo, ProjectsRepoShape>() {}

export const ProjectsRepoLive = Layer.effect(
  ProjectsRepo,
  Effect.gen(function* () {
    const db = yield* Db
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
        db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
          .run(p.id, p.name, p.repoRoot, p.defaultBaseBranch, p.createdAt)
        return p
      }),
      list: () => Effect.sync(() =>
        db.prepare("SELECT * FROM projects ORDER BY created_at").all().map(rowToProject)),
      remove: (id) => Effect.gen(function* () {
        const res = db.prepare("DELETE FROM projects WHERE id = ?").run(id)
        if (res.changes === 0) return yield* new NotFoundError({ message: `项目不存在：${id}` })
      }),
    }
  }),
)
```

- [ ] **Step 4: 确认通过** → PASS。

- [ ] **Step 5: Commit** — `git commit -am "feat(server): ProjectsRepo with git-repo validation"`

---

### Task 6: HTTP 层（health / projects / shutdown + bearer token）

**Files:**
- Create: `packages/server/src/http/token.ts`, `packages/server/src/http/app.ts`
- Test: `packages/server/test/http.test.ts`

**Interfaces:**
- Consumes: `ProjectsRepo`（Task 5）、`ApiErrorBody` 错误信封（Task 2）
- Produces:
  - `newToken(): string`（32 字节随机 hex）
  - `createApp(deps: { runtime: <A,E>(eff: Effect.Effect<A, E, ProjectsRepo>) => Promise<A>; token: string; onShutdown: () => void }): (req: IncomingMessage, res: ServerResponse) => void` — 纯 Node `http` handler，方便 Task 7 挂到 `http.createServer` 与未来 unix socket 复用
  - 行为契约：`GET /health → 200 {ok:true}` 免 token；其余路径缺/错 token → `401 {code:"Validation"...}`；`POST /projects {repoRoot}` → 201 Project JSON / 400 Validation / 409 Conflict；`GET /projects` → 200 数组；`DELETE /projects/:id` → 204 / 404；`POST /shutdown` → 202 后调用 `onShutdown`；未知路径 → 404 `{code:"NotFound"}`

- [ ] **Step 1: 写失败测试**

`packages/server/test/http.test.ts`：
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { execSync } from "node:child_process"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { createApp, newToken } from "../src/http/app.js"

let server: http.Server, base: string, token: string, shutdownCalled = false

beforeEach(async () => {
  const db = new Database(":memory:"); runMigrations(db)
  const layer = ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<any, never, never>),
    token,
    onShutdown: () => { shutdownCalled = true },
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})
afterEach(() => server.close())

const auth = { Authorization: `Bearer TOKEN` } // 占位，实际测试里模板替换 token
const req = (p: string, init: RequestInit = {}) =>
  fetch(base + p, { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })

describe("http app", () => {
  it("health needs no token", async () => {
    const r = await fetch(base + "/health")
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })
  it("rejects missing token elsewhere", async () => {
    const r = await fetch(base + "/projects")
    expect(r.status).toBe(401)
  })
  it("projects CRUD happy path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-http-"))
    execSync("git init -b main", { cwd: dir })
    const created = await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot: dir }) })
    expect(created.status).toBe(201)
    const p = await created.json()
    const list = await (await req("/projects")).json()
    expect(list.map((x: any) => x.id)).toContain(p.id)
    expect((await req(`/projects/${p.id}`, { method: "DELETE" })).status).toBe(204)
    expect((await req(`/projects/${p.id}`, { method: "DELETE" })).status).toBe(404)
  })
  it("bad repoRoot -> 400", async () => {
    const r = await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot: "/nonexistent-xyz" }) })
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe("Validation")
  })
  it("shutdown calls hook", async () => {
    expect((await req("/shutdown", { method: "POST" })).status).toBe(202)
    expect(shutdownCalled).toBe(true)
  })
})
```

- [ ] **Step 2: 确认失败** → FAIL。

- [ ] **Step 3: 实现**

`packages/server/src/http/token.ts`：
```ts
import { randomBytes, timingSafeEqual } from "node:crypto"
export const newToken = (): string => randomBytes(32).toString("hex")
export const tokenEquals = (a: string, b: string): boolean => {
  const ba = Buffer.from(a), bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
```

`packages/server/src/http/app.ts`：
```ts
import type { IncomingMessage, ServerResponse } from "node:http"
import { Effect } from "effect"
import type { ApiErrorBody } from "@coolie/protocol"
import { ProjectsRepo } from "../repo/projects.js"
import { tokenEquals } from "./token.js"
export { newToken } from "./token.js"

type Runtime = <A, E>(eff: Effect.Effect<A, E, ProjectsRepo>) => Promise<A>
export interface AppDeps { runtime: Runtime; token: string; onShutdown: () => void }

const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) { res.writeHead(status).end(); return }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}
const err = (res: ServerResponse, status: number, code: ApiErrorBody["code"], message: string) =>
  send(res, status, { code, message } satisfies ApiErrorBody)

const readJson = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    let buf = ""
    req.on("data", (c) => { buf += c })
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}) } catch (e) { reject(e) } })
    req.on("error", reject)
  })

export const createApp = ({ runtime, token, onShutdown }: AppDeps) =>
  (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://local")
      const route = `${req.method} ${url.pathname}`
      if (route === "GET /health") return send(res, 200, { ok: true })

      const got = (req.headers.authorization ?? "").replace(/^Bearer /, "")
      if (!got || !tokenEquals(got, token)) return err(res, 401, "Validation", "missing or bad token")

      try {
        if (route === "POST /shutdown") { send(res, 202, { ok: true }); onShutdown(); return }
        if (route === "GET /projects")
          return send(res, 200, await runtime(Effect.gen(function* () { return yield* (yield* ProjectsRepo).list() })))
        if (route === "POST /projects") {
          const body = await readJson(req)
          if (typeof body.repoRoot !== "string") return err(res, 400, "Validation", "repoRoot required")
          return send(res, 201, await runtime(Effect.gen(function* () { return yield* (yield* ProjectsRepo).add(body.repoRoot) })))
        }
        const del = url.pathname.match(/^\/projects\/([^/]+)$/)
        if (req.method === "DELETE" && del) {
          await runtime(Effect.gen(function* () { yield* (yield* ProjectsRepo).remove(del[1]!) }))
          return send(res, 204)
        }
        return err(res, 404, "NotFound", `no route: ${route}`)
      } catch (e: any) {
        const tag = e?._tag ?? e?.error?._tag ?? (typeof e?.message === "string" && e.message.includes("ValidationError") ? "ValidationError" : undefined)
        if (tag === "ValidationError") return err(res, 400, "Validation", e.message ?? String(e))
        if (tag === "ConflictError") return err(res, 409, "Conflict", e.message ?? String(e))
        if (tag === "NotFoundError") return err(res, 404, "NotFound", e.message ?? String(e))
        return err(res, 500, "Internal", e?.message ?? String(e))
      }
    })()
  }
```

注意：Effect 失败经 `runPromise` 抛出的是 `FiberFailure`，其 `cause` 里才是 TaggedError。实现时用 `Effect.runPromise(eff)` 前先 `Effect.catchAll` 不可行（跨层），正确做法是在 `runtime` 处用 `Effect.runPromiseExit` 并在 app 层解包 Exit——**如果上面的 `_tag` 探测在测试中不可靠，改为：`runtime` 返回 `Exit`，app 层用 `Exit.match` + `Cause.failureOption` 取 TaggedError**。以测试通过为准，两种写法都符合本任务契约。

- [ ] **Step 4: 确认通过** → PASS（5 个用例全绿）。

- [ ] **Step 5: Commit** — `git commit -am "feat(server): http app with bearer token + projects routes + shutdown"`

---

### Task 7: daemon 入口（start/status/stop + server.json 单实例）

**Files:**
- Create: `packages/server/src/daemon/info.ts`, `packages/server/src/main.ts`
- Modify: `packages/server/package.json`（加 `"bin": { "coolie-server": "./src/main.ts" }` 与 `"scripts": { "start": "tsx src/main.ts start" }`）
- Test: `packages/server/test/daemon.test.ts`

**Interfaces:**
- Consumes: Task 3-6 全部
- Produces:
  - `ServerInfo = { port: number; token: string; pid: number }`
  - `readServerInfo(infoPath: string): ServerInfo | null`（不存在/坏 JSON → null）
  - `probeAlive(info: ServerInfo): Promise<boolean>`（`GET /health`，500ms 超时）
  - `writeServerInfo(infoPath, info): void`（mkdir -p + mode 0600）
  - CLI 语义（Task 8 消费）：`coolie-server start`（前台运行；已有活实例 → stderr 提示后 exit 1；写 server.json，SIGINT/SIGTERM/shutdown 时删除后退出）；`coolie-server status`（运行中 → stdout `running pid=<pid> port=<port>` exit 0；否则 `stopped` exit 1）；`coolie-server stop`（POST /shutdown；没跑 → `stopped` exit 0）

- [ ] **Step 1: 写失败测试**

`packages/server/test/daemon.test.ts`：
```ts
import { describe, it, expect, afterEach } from "vitest"
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { readServerInfo } from "../src/daemon/info.js"

let child: ChildProcess | undefined
let home: string
const MAIN = path.resolve(__dirname, "../src/main.ts")
const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")

const startServer = async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-daemon-"))
  child = spawn(TSX, [MAIN, "start"], { env: { ...process.env, COOLIE_HOME: home }, stdio: "pipe" })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const info = readServerInfo(path.join(home, "server.json"))
    if (info) {
      const r = await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null)
      if (r?.ok) return info
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("server did not become healthy")
}
afterEach(() => { child?.kill("SIGKILL"); child = undefined })

describe("daemon", () => {
  it("start writes server.json and serves health; stop removes it", async () => {
    const info = await startServer()
    expect(info.pid).toBeGreaterThan(0)
    const st = execFileSync(TSX, [MAIN, "status"], { env: { ...process.env, COOLIE_HOME: home } }).toString()
    expect(st).toContain("running")
    execFileSync(TSX, [MAIN, "stop"], { env: { ...process.env, COOLIE_HOME: home } })
    const deadline = Date.now() + 5_000
    while (fs.existsSync(path.join(home, "server.json")) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100))
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false)
  })
  it("second start refuses while first is alive", async () => {
    await startServer()
    expect(() =>
      execFileSync(TSX, [MAIN, "start"], { env: { ...process.env, COOLIE_HOME: home }, stdio: "pipe" }),
    ).toThrow() // exit 1
  })
})
```

- [ ] **Step 2: 确认失败** → FAIL。

- [ ] **Step 3: 实现**

`packages/server/src/daemon/info.ts`：
```ts
import * as fs from "node:fs"
import * as path from "node:path"

export interface ServerInfo { port: number; token: string; pid: number }

export const readServerInfo = (infoPath: string): ServerInfo | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(infoPath, "utf8"))
    if (typeof raw.port === "number" && typeof raw.token === "string" && typeof raw.pid === "number") return raw
    return null
  } catch { return null }
}

export const writeServerInfo = (infoPath: string, info: ServerInfo): void => {
  fs.mkdirSync(path.dirname(infoPath), { recursive: true })
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 })
}

export const probeAlive = async (info: ServerInfo): Promise<boolean> => {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(500) })
    return r.ok
  } catch { return false }
}
```

`packages/server/src/main.ts`：
```ts
#!/usr/bin/env node
import * as http from "node:http"
import * as fs from "node:fs"
import { Effect, Layer, Exit, Scope } from "effect"
import { CoolieConfig, CoolieConfigLive } from "./config.js"
import { DbLive } from "./db/sqlite.js"
import { ProjectsRepo, ProjectsRepoLive } from "./repo/projects.js"
import { createApp, newToken } from "./http/app.js"
import { readServerInfo, writeServerInfo, probeAlive } from "./daemon/info.js"

const cfg = Effect.runSync(CoolieConfig.pipe(Effect.provide(CoolieConfigLive)))

const cmdStatus = async (): Promise<never> => {
  const info = readServerInfo(cfg.serverInfoPath)
  if (info && (await probeAlive(info))) { console.log(`running pid=${info.pid} port=${info.port}`); process.exit(0) }
  console.log("stopped"); process.exit(1)
}

const cmdStop = async (): Promise<never> => {
  const info = readServerInfo(cfg.serverInfoPath)
  if (!info || !(await probeAlive(info))) { console.log("stopped"); process.exit(0) }
  await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
    method: "POST", headers: { Authorization: `Bearer ${info.token}` },
  })
  console.log("stopping"); process.exit(0)
}

const cmdStart = async (): Promise<void> => {
  const existing = readServerInfo(cfg.serverInfoPath)
  if (existing && (await probeAlive(existing))) {
    console.error(`already running pid=${existing.pid} port=${existing.port}`); process.exit(1)
  }
  if (existing) fs.rmSync(cfg.serverInfoPath, { force: true }) // 陈旧文件

  // 组装 Effect runtime（scope 手动管理，进程退出时 close）
  const scope = Effect.runSync(Scope.make())
  const appLayer = ProjectsRepoLive.pipe(Layer.provide(DbLive), Layer.provide(CoolieConfigLive))
  const runtimeCtx = await Effect.runPromise(Layer.buildWithScope(appLayer, scope))
  const runtime = <A, E>(eff: Effect.Effect<A, E, ProjectsRepo>) =>
    Effect.runPromise(Effect.provide(eff, runtimeCtx) as Effect.Effect<A, E, never>)

  const token = newToken()
  const shutdown = async () => {
    fs.rmSync(cfg.serverInfoPath, { force: true })
    server.close()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    process.exit(0)
  }
  const server = http.createServer(createApp({ runtime, token, onShutdown: () => void shutdown() }))
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port
    writeServerInfo(cfg.serverInfoPath, { port, token, pid: process.pid })
    console.log(`coolie-server listening on 127.0.0.1:${port}`)
  })
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

const cmd = process.argv[2]
if (cmd === "start") void cmdStart()
else if (cmd === "status") void cmdStatus()
else if (cmd === "stop") void cmdStop()
else { console.error(`unknown command: ${cmd ?? "(none)"}；可用：start|status|stop`); process.exit(1) }
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server`。Expected: daemon 两用例 PASS（真实子进程起停）。

- [ ] **Step 5: Commit** — `git commit -am "feat(server): daemon start/status/stop with server.json discovery + single instance"`

---

### Task 8: CLI（自动拉起 + project add/list/remove + api schema）

**Files:**
- Create: `packages/cli/src/client.ts`, `packages/cli/src/main.ts`
- Modify: `packages/cli/package.json`（`"bin": { "coolie": "./src/main.ts" }`；`bun add commander` + `"@coolie/protocol": "workspace:*"`）
- Test: `packages/cli/test/cli-e2e.test.ts`

**Interfaces:**
- Consumes: `ServerInfo/readServerInfo/probeAlive`（Task 7；从 `@coolie/server` 导出——在 `packages/server/src/index.ts` re-export `daemon/info.js`）、`ROUTES`（Task 2）
- Produces（用户可见 CLI 面）:
  - `coolie project add <path>` → 打印 `added <name> (<id>)`；重复添加 → stderr Conflict 信息，exit 1
  - `coolie project list` → 每行 `<id>\t<name>\t<repoRoot>`
  - `coolie project remove <id>` → `removed <id>`
  - `coolie server status|stop` → 语义同 Task 7
  - `coolie api schema` → 打印 ROUTES 表（`GET /health  存活探测…` 每行一条）
  - 自动拉起：任何需要 server 的命令发现无活实例时，detached spawn `tsx <server main> start`，10s 内轮询 health，失败则报错 exit 1

- [ ] **Step 1: 写失败测试**

`packages/cli/test/cli-e2e.test.ts`：
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
let home: string, repo: string

const coolie = (...args: string[]) =>
  execFileSync(TSX, [CLI, ...args], { env: { ...process.env, COOLIE_HOME: home }, encoding: "utf8" })

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-"))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repo })
})
afterAll(() => { try { coolie("server", "stop") } catch {} })

describe("coolie CLI e2e", () => {
  it("auto-spawns server and manages projects", () => {
    const added = coolie("project", "add", repo)
    expect(added).toContain("added")
    expect(coolie("project", "list")).toContain(repo)
    expect(coolie("server", "status")).toContain("running")
  })
  it("api schema prints the route table", () => {
    const out = coolie("api", "schema")
    expect(out).toContain("GET /health")
    expect(out).toContain("POST /projects")
  })
  it("unknown command exits non-zero", () => {
    expect(() => coolie("frobnicate")).toThrow()
  })
})
```

- [ ] **Step 2: 确认失败** → FAIL。

- [ ] **Step 3: 实现**

先在 `packages/server/src/index.ts`：
```ts
export * from "./daemon/info.js"
export { CoolieConfig, CoolieConfigLive } from "./config.js"
```

`packages/cli/src/client.ts`：
```ts
import { spawn } from "node:child_process"
import * as os from "node:os"; import * as path from "node:path"
import { createRequire } from "node:module"
import { readServerInfo, probeAlive, type ServerInfo } from "@coolie/server"

const require_ = createRequire(import.meta.url)
const home = () => process.env.COOLIE_HOME ?? path.join(os.homedir(), ".coolie")
const infoPath = () => path.join(home(), "server.json")

const spawnServer = (): void => {
  const serverMain = require_.resolve("@coolie/server/src/main.ts")
  const tsx = path.resolve(path.dirname(require_.resolve("tsx/package.json")), "../.bin/tsx")
  const child = spawn(tsx, [serverMain, "start"], { detached: true, stdio: "ignore", env: process.env })
  child.unref()
}

export const ensureServer = async (): Promise<ServerInfo> => {
  const existing = readServerInfo(infoPath())
  if (existing && (await probeAlive(existing))) return existing
  spawnServer()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const info = readServerInfo(infoPath())
    if (info && (await probeAlive(info))) return info
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error("无法启动 coolie-server（10s 超时）")
}

export const api = async (method: string, p: string, body?: unknown): Promise<any> => {
  const info = await ensureServer()
  const r = await fetch(`http://127.0.0.1:${info.port}${p}`, {
    method,
    headers: { "content-type": "application/json", Authorization: `Bearer ${info.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (r.status === 204) return undefined
  const json = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${json.code ?? r.status}: ${json.message ?? "request failed"}`)
  return json
}
```

`packages/cli/src/main.ts`：
```ts
#!/usr/bin/env node
import { Command } from "commander"
import { ROUTES } from "@coolie/protocol"
import { readServerInfo, probeAlive } from "@coolie/server"
import * as os from "node:os"; import * as path from "node:path"
import { api } from "./client.js"

const program = new Command("coolie").showHelpAfterError()
const fail = (e: unknown): never => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1) }

const project = program.command("project")
project.command("add <path>").action(async (p) => {
  try { const proj = await api("POST", "/projects", { repoRoot: p }); console.log(`added ${proj.name} (${proj.id})`) }
  catch (e) { fail(e) }
})
project.command("list").action(async () => {
  try { for (const p of await api("GET", "/projects")) console.log(`${p.id}\t${p.name}\t${p.repoRoot}`) }
  catch (e) { fail(e) }
})
project.command("remove <id>").action(async (id) => {
  try { await api("DELETE", `/projects/${id}`); console.log(`removed ${id}`) } catch (e) { fail(e) }
})

const server = program.command("server")
server.command("status").action(async () => {
  const info = readServerInfo(path.join(process.env.COOLIE_HOME ?? path.join(os.homedir(), ".coolie"), "server.json"))
  if (info && (await probeAlive(info))) { console.log(`running pid=${info.pid} port=${info.port}`) }
  else { console.log("stopped"); process.exit(1) }
})
server.command("stop").action(async () => {
  try { await api("POST", "/shutdown") } catch {} // server 可能没跑或应答后立刻退出
  console.log("stopped")
})

program.command("api").command("schema").action(() => {
  for (const r of ROUTES) console.log(`${r.method.padEnd(6)} ${r.path.padEnd(20)} ${r.description}`)
})

program.parseAsync().catch(fail)
```

注意：`server stop` 复用 `api()` 会在 server 没跑时把它拉起再关掉——浪费但正确。若测试因此不稳，改为直接 `readServerInfo + probeAlive + fetch /shutdown`（同 Task 7 `cmdStop` 逻辑），行为契约不变。

- [ ] **Step 4: 确认通过** — Run: `bun run test`。Expected: 全绿（protocol/server/cli 三包）。再跑 `bun run typecheck` → 通过。

- [ ] **Step 5: Commit** — `git commit -am "feat(cli): coolie CLI with auto-spawn server + project commands + api schema"`

---

### Task 9: 收尾——README 快速开始 + 全量回归

**Files:**
- Create: `README.md`（根）

**Interfaces:**
- Produces: 新人（或下一个计划的执行者）照 README 三条命令能跑通。

- [ ] **Step 1: 写 README**

````markdown
# Coolie

coding agent 的干净开发环境伴侣（= repo + branch）。设计文档：`docs/superpowers/specs/2026-07-11-coolie-design.md`。

## 开发快速开始

```bash
bun install
bun run test          # 全部测试
bun run typecheck
```

## 试用（Plan 1 阶段能力）

```bash
bun x tsx packages/cli/src/main.ts project add ~/some/git/repo
bun x tsx packages/cli/src/main.ts project list
bun x tsx packages/cli/src/main.ts server status && bun x tsx packages/cli/src/main.ts server stop
```

server 数据在 `~/.coolie/`（`COOLIE_HOME` 可覆盖）。
````

- [ ] **Step 2: 全量回归**

Run: `bun install && bun run typecheck && bun run test`
Expected: 全绿。手工照 README 试用段跑一遍，`~/.coolie` 用 `COOLIE_HOME=/tmp/coolie-manual` 替代，确认三条命令输出符合 Task 8 契约。

- [ ] **Step 3: Commit**

```bash
git add README.md && git commit -m "docs: README quick start (plan 1 scope)"
```

---

## Self-Review 记录

1. **Spec 覆盖（Plan 1 范围内）**：设计文档 §2.1 拓扑（daemon/发现/单实例/token）→ Task 6-7；§2.2 monorepo 五包中的三个 + Node 运行时约束 → Task 1、Global Constraints；§三 数据模型四表 + 写库纪律 → Task 4；§八 CLI 基础面（project 子集 + api schema + 未知命令报错退出）→ Task 8。**显式移出本计划**：unix socket、SSE/events 写入、refcount、workspaces 业务、engines/client 两包（见 Global Constraints 末条与四计划路线图）。
2. **占位符扫描**：无 TBD/TODO；Task 6 与 Task 8 各有一处"两种等价写法以测试为准"的实现注记，均给出了两种写法的具体内容，非占位。
3. **类型一致性**：`ServerInfo{port,token,pid}` 在 Task 7 定义、Task 8 消费一致；`ProjectsRepo.add/list/remove` 签名在 Task 5 定义、Task 6 消费一致；错误 `_tag` 三种（Validation/Conflict/NotFound）与 HTTP 状态映射一致；`@coolie/server` 的 re-export（Task 8 Step 3 首段）补上了 Task 7 未导出的缺口。
