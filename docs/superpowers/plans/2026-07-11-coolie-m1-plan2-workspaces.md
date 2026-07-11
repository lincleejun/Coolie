# Coolie M1 · Plan 2：Workspace Lifecycle（服务端）+ SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Plan 1 基座之上实现 workspace 生命周期的服务端全链路：WorkspacesRepo、GitService（git CLI 封装）、create 流水线（fetch → worktree add → branch.base → info/exclude → .worktreeinclude 复制 → 端口段 → 三层 setup script → active，失败自动回滚）、archive/unarchive/delete、durable SSE 事件流，以及 CLI 的 `create/list/archive/unarchive/delete`。

**Architecture:** 一切业务经 Effect Layer 组装：`WorkspaceLifecycle` service 编排 `WorkspacesRepo`（SQLite CRUD + 状态机守卫）、`GitService`（child_process 包 git CLI，可用假实现替换）、`SetupRunner`（非交互 spawn 三层脚本）与 `EventsRepo`（每步落事件）。**create 契约取 M1 最简形态：先插 `creating` 行，同步跑完流水线才返回**——成功 `201` 带 `status=active` 的 Workspace；失败返回错误信封（`GitError`/`SetupScriptError`/…），行留在 `status=error` 可经 `POST /workspaces/:id/retry` 重试。SSE 端点 `GET /events/stream` = events 表游标回放（durable）+ 进程内 EventEmitter live 推送（先订阅后回放、seq 守卫去重）。Plan 3 的 tmux/engine 启动通过 `PostCreateHooks` 插拔点接入。设计依据：`docs/superpowers/specs/2026-07-11-coolie-design.md` §四、§三、§2.3、§八、§十、§十二。

**Tech Stack:** 与 Plan 1 落地代码一致：TypeScript ^5.x（strict + exactOptionalPropertyTypes）、Node ≥22 运行时（bun 仅装包/跑脚本）、Effect ^3.21.4（Context.Tag / Layer / Effect.gen / Data.TaggedError / runPromiseExit+Exit 解包）、better-sqlite3、vitest、commander、git CLI（child_process execFile）。

## Global Constraints

- server 与 CLI 的一切进程**必须以 Node 运行**（`node`/`tsx`），bun 只做 `bun install`/`bun run`（设计文档 §2.2）。
- Effect 已锁 `^3.21.4`（Plan 1 commit 65423d1）。本计划代码按 Plan 1 已合入代码的实际 API 风格书写（`Runtime` 返回 `Exit`、`errorFromCause` 按 `_tag` 映射状态码）；若个别 API 有出入以官方 docs 等价改写，**任务的行为契约（每步测试断言）不变**。
- SQLite 写库纪律（设计文档 §三）：migration 幂等；**m0002 只追加新索引，绝不改动 m0001**；禁止无 WHERE 的 sweep；本计划无破坏性 schema 变更故无需 `.bak`。
- server 绑定地址硬编码 `127.0.0.1`；除 `GET /health` 外所有端点（含 SSE `GET /events/stream`）强制 `Authorization: Bearer <token>`。
- **git worktree 纪律（本计划新增，不可违背）**：删除 worktree 只走 `git worktree remove`（脏树自动拒绝；`--force` 只能来自用户显式 force 参数或 create 失败回滚）；**绝不 `rm -rf` 用户数据**；create 任何一步失败必回滚（`git worktree remove --force` + `git worktree prune`）绝不留孤儿；**branch 永不删除**——连回滚都不删 branch，retry 通过"branch 仍指向 baseRef 时复用"实现。
- **破坏性 API 默认拒绝 + 显式 force**：archive/delete 遇脏树返回 `409 Conflict`，客户端确认后带 force 重试；server 绝不默认 force。
- 所有测试经 `COOLIE_HOME` 与 `COOLIE_WORKSPACES_ROOT` 指向 mkdtemp 临时目录，**绝不读写真实 `~/.coolie` 或 `~/coolie`**。
- 测试分层（设计文档 §十一）：单测 = Effect Layer 注入**假 GitService/SetupRunner** + 内存 SQLite；集成 = mkdtemp 真 git repo（本地 clone 作 origin）真跑状态机与失败回滚；SSE 测试 = 真 http server + fetch ReadableStream。
- 日志纪律沿用 Plan 1（append-only、10MB 轮转一代 `.old`、fire-and-forget、crash net）；setup script 输出**落 events（outputTail）+ server.log**。
- 每个 Task 结束必须 `git commit`，conventional commits（feat/test/docs/chore）。
- 本计划**不做**（显式延后）：tmux session/engine 启动与首条 prompt 投递（Plan 3，经本计划的 `PostCreateHooks` 插拔点接入）、`coolie enter`（Plan 3）、finish/adopt/checkpoint（M1 四项之外）、refcount 惰性退出（Plan 4）、GUI（Plan 5）、live-only SSE 第二通道（M2，本计划只做一个 durable SSE 端点）。

## File Structure（本计划新建/修改）

```
packages/protocol/src/
  domain.ts                       # 修改：+Workspace Schema.Class + decodeWorkspace
  routes.ts                       # 修改：+workspaces 五路由 + retry + /events/stream
packages/server/src/
  db/migrations.ts                # 修改：+m0002（唯一索引 + events 复合索引，幂等追加）
  repo/errors.ts                  # 新建：ValidationError/ConflictError/NotFoundError（从 projects.ts 移出）
  repo/projects.ts                # 修改：错误类改为 re-export；+get(id)
  repo/workspaces.ts              # 新建：WorkspacesRepo（CRUD + 状态机守卫 + 端口占用查询）
  repo/events.ts                  # 修改（Task 10）：append 时向 EventsBus 广播（serviceOption，可选依赖）
  git/service.ts                  # 新建：GitService + GitError + parseWorktreeList（真实现 = git CLI）
  workspace/names.ts              # 新建：名池 provider 接口 + national-parks 池 + pickName + sanitizeSlug
  workspace/ports.ts              # 新建：10 端口段分配（4 万段起步）+ portEnv
  workspace/include.ts            # 新建：.git/info/exclude 注入 + .worktreeinclude 读取/复制
  workspace/setup.ts              # 新建：SetupRunner service + 三层脚本解析 + SetupScriptError
  workspace/lifecycle.ts          # 新建：WorkspaceLifecycle（create/retry/archive/unarchive/delete + PostCreateHooks 插拔点）
  events/bus.ts                   # 新建（Task 10）：EventsBus = 进程内 EventEmitter 的 Context.Tag
  http/app.ts                     # 修改：Runtime 扩为 AppServices、+workspace 路由、错误映射、SSE 分发
  http/sse.ts                     # 新建：handleEventsStream（replay + live + 心跳 + 断开清理）
  main.ts                         # 修改：appLayer 装配 lifecycle 链 + EventsBus
packages/cli/src/main.ts          # 修改：+create/list/archive/unarchive/delete 命令
packages/server/test/
  helpers/fake-git.ts             # 新建：makeFakeGit（单测注入用，不匹配 *.test.ts 不会被跑）
  workspaces-repo.test.ts  git-service.test.ts  names-ports.test.ts  include.test.ts
  setup-runner.test.ts  lifecycle-create.test.ts  lifecycle-archive.test.ts
  http-workspaces.test.ts  sse.test.ts  integration-lifecycle.test.ts
  migrations.test.ts              # 修改：schema_migrations 计数 1 → 2
  http.test.ts / events.test.ts   # 修改（Task 9）：runtime 加 cast 适配扩宽后的 AppServices
packages/cli/test/workspace-e2e.test.ts   # 新建
```

事件类型清单（lifecycle 各步写入 `events` 表，SSE/export/`events tail` 均可见）：
`workspace.creating`、`workspace.setup.started`、`workspace.setup.finished`、`workspace.created`、`workspace.error`、`workspace.archived`、`workspace.unarchived`、`workspace.deleted`。

---

### Task 1: protocol——Workspace Schema 与路由表扩展

**Files:**
- Modify: `packages/protocol/src/domain.ts`
- Modify: `packages/protocol/src/routes.ts`
- Test: `packages/protocol/test/domain.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 `WorkspaceStatus`（domain.ts 已有 `Schema.Literal("creating","active","archived","error")`）
- Produces（后续所有任务消费）:
  - `Workspace`（Schema.Class）：`{ id: string; projectId: string; name: string; path: string; branch: string; baseBranch: string; baseRef: string; status: WorkspaceStatus; pinned: boolean; createdAt: number; archivedAt: number | null; portBase: number }`
  - `decodeWorkspace(u: unknown): Workspace`
  - ROUTES 新增 7 条（见 Step 3），`coolie api schema` 自动展示

- [ ] **Step 1: 追加失败测试**

在 `packages/protocol/test/domain.test.ts` 的 describe 内追加（imports 行加入 `decodeWorkspace`）：

```ts
  it("round-trips a Workspace", () => {
    const raw = {
      id: "w1", projectId: "p1", name: "usa-yellowstone", path: "/tmp/ws",
      branch: "coolie/fix-x", baseBranch: "main", baseRef: "abc123", status: "creating",
      pinned: false, createdAt: 1, archivedAt: null, portBase: 40000,
    }
    const w = decodeWorkspace(raw)
    expect(w.branch).toBe("coolie/fix-x")
    expect(w.portBase).toBe(40000)
    expect(w.archivedAt).toBeNull()
  })
  it("rejects a bad workspace status", () => {
    expect(() => decodeWorkspace({
      id: "w1", projectId: "p1", name: "n", path: "/p", branch: "b",
      baseBranch: "main", baseRef: "r", status: "nope",
      pinned: false, createdAt: 1, archivedAt: null, portBase: 0,
    })).toThrow()
  })
  it("ROUTES contains workspace lifecycle + SSE routes", () => {
    const paths = ROUTES.map(r => `${r.method} ${r.path}`)
    for (const p of [
      "GET /workspaces", "POST /workspaces",
      "POST /workspaces/:id/archive", "POST /workspaces/:id/unarchive",
      "POST /workspaces/:id/retry", "DELETE /workspaces/:id",
      "GET /events/stream",
    ]) expect(paths).toContain(p)
  })
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/protocol`
Expected: FAIL（`decodeWorkspace` 无导出；ROUTES 缺条目）。

- [ ] **Step 3: 实现**

`packages/protocol/src/domain.ts` 追加（放在 `WorkspaceStatus` 之后）：

```ts
export class Workspace extends Schema.Class<Workspace>("Workspace")({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  baseRef: Schema.String,
  status: WorkspaceStatus,
  pinned: Schema.Boolean,
  createdAt: Schema.Number,
  archivedAt: Schema.NullOr(Schema.Number),
  portBase: Schema.Number,
}) {}
export const decodeWorkspace = Schema.decodeUnknownSync(Workspace)
```

`packages/protocol/src/routes.ts` 的 ROUTES 数组追加（`GET /events` 之后）：

```ts
  { method: "GET",    path: "/workspaces",               description: "列出 workspace ?project=" },
  { method: "POST",   path: "/workspaces",               description: "创建 workspace {projectId, branchSlug?, name?}（同步跑完流水线才返回）" },
  { method: "POST",   path: "/workspaces/:id/archive",   description: "归档：删 worktree 留 branch {force?}" },
  { method: "POST",   path: "/workspaces/:id/unarchive", description: "从保留的 branch 重建 worktree" },
  { method: "POST",   path: "/workspaces/:id/retry",     description: "error 状态重跑创建流水线" },
  { method: "DELETE", path: "/workspaces/:id",           description: "删 worktree+记录，branch 保留 ?force=1" },
  { method: "GET",    path: "/events/stream",            description: "SSE：durable replay + live 推送 ?after=&workspace=" },
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/protocol` → PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol && git commit -m "feat(protocol): workspace schema + lifecycle/SSE route table"
```

---

### Task 2: WorkspacesRepo + m0002 索引 + ProjectsRepo.get

**Files:**
- Create: `packages/server/src/repo/errors.ts`, `packages/server/src/repo/workspaces.ts`
- Modify: `packages/server/src/repo/projects.ts`（错误类移出改 re-export + 新增 `get`）、`packages/server/src/db/migrations.ts`（追加 m0002）、`packages/server/test/migrations.test.ts`（计数 1→2）
- Test: `packages/server/test/workspaces-repo.test.ts`

**Interfaces:**
- Consumes: `Db`（Plan 1 Task 4）、`Workspace`/`WorkspaceStatus`（Task 1）
- Produces:
  - `repo/errors.ts`：`ValidationError/ConflictError/NotFoundError`（Data.TaggedError，与 Plan 1 同型；projects.ts re-export 保持既有 import 路径可用）
  - `ProjectsRepoShape` 新增 `get(id: string): Effect<Project, NotFoundError>`
  - `WorkspacesRepo`（Context.Tag）+ `WorkspacesRepoLive: Layer<WorkspacesRepo, never, Db>`：
    - `insertCreating(w: { projectId; name; path; branch; baseBranch; portBase: number }): Effect<Workspace, ConflictError>` — 行落库 `status="creating"`、`base_ref=""` 占位、`data=JSON {portBase}`；唯一索引冲突 → ConflictError
    - `get(id): Effect<Workspace, NotFoundError>`；`list(filter?: { projectId?: string }): Effect<Workspace[]>`（created_at 升序）
    - `setStatus(id, next: WorkspaceStatus): Effect<Workspace, NotFoundError | ConflictError>` — **状态机守卫**：`creating→active|error`、`active→archived`、`archived→active`、`error→creating`；到 `archived` 写 `archived_at=now`，离开清 null
    - `setBaseRef(id, baseRef): Effect<void, NotFoundError>`；`setLastError(id, {tag, message}): Effect<void, NotFoundError>`（merge 进 data JSON 的 `lastError`）
    - `usedPortBases(): Effect<number[]>`（全库所有 workspace 的 data.portBase）；`remove(id): Effect<void, NotFoundError>`
  - m0002：`workspaces(project_id,name)`、`workspaces(project_id,branch)`、`workspaces(path)` 三个 UNIQUE 索引 + `events(workspace_id, seq)` 普通索引

- [ ] **Step 1: 写失败测试**

`packages/server/test/workspaces-repo.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import { Effect, Layer, Exit, Cause, Option } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "../src/repo/workspaces.js"

const make = () => {
  const db = new Database(":memory:"); runMigrations(db)
  db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
    .run("p1", "demo", "/tmp/demo", "main", 1)
  const layer = WorkspacesRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
  const run = <A, E>(eff: Effect.Effect<A, E, WorkspacesRepo>) =>
    Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<A, E, never>)
  return { db, run }
}
const w1 = { projectId: "p1", name: "usa-zion", path: "/tmp/ws/usa-zion", branch: "coolie/fix-a", baseBranch: "main", portBase: 40000 }
const failTag = (exit: Exit.Exit<any, any>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const f = Cause.failureOption(exit.cause)
  return Option.isSome(f) ? (f.value as any)._tag : undefined
}

describe("WorkspacesRepo", () => {
  it("insertCreating + get round-trips incl portBase", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      expect(ws.status).toBe("creating")
      expect(ws.portBase).toBe(40000)
      expect(ws.baseRef).toBe("")
      expect(ws.archivedAt).toBeNull()
      return yield* repo.get(ws.id)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.name).toBe("usa-zion")
  })
  it("duplicate name in same project -> ConflictError (m0002 unique index)", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      yield* repo.insertCreating(w1)
      return yield* repo.insertCreating({ ...w1, path: "/tmp/ws/other", branch: "coolie/fix-b" })
    }))
    expect(failTag(exit)).toBe("ConflictError")
  })
  it("status machine: creating→active→archived→active; illegal moves rejected", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      const a = yield* repo.setStatus(ws.id, "active")
      expect(a.status).toBe("active")
      const ar = yield* repo.setStatus(ws.id, "archived")
      expect(ar.status).toBe("archived")
      expect(ar.archivedAt).toBeTypeOf("number")
      const back = yield* repo.setStatus(ws.id, "active")
      expect(back.archivedAt).toBeNull()
      return ws.id
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    const { run: run2 } = make()
    const illegal = await run2(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      return yield* repo.setStatus(ws.id, "archived") // creating→archived 非法
    }))
    expect(failTag(illegal)).toBe("ConflictError")
  })
  it("error→creating is the retry transition", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const ws = yield* repo.insertCreating(w1)
      yield* repo.setStatus(ws.id, "error")
      yield* repo.setLastError(ws.id, { tag: "GitError", message: "boom" })
      const again = yield* repo.setStatus(ws.id, "creating")
      return again.status
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toBe("creating")
  })
  it("list filters by project; usedPortBases spans all rows; remove deletes", async () => {
    const { db, run } = make()
    db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
      .run("p2", "demo2", "/tmp/demo2", "main", 2)
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      const a = yield* repo.insertCreating(w1)
      yield* repo.insertCreating({ projectId: "p2", name: "usa-zion", path: "/tmp/ws2/usa-zion", branch: "coolie/x", baseBranch: "main", portBase: 40010 })
      const onlyP1 = yield* repo.list({ projectId: "p1" })
      const all = yield* repo.list()
      const ports = yield* repo.usedPortBases()
      yield* repo.remove(a.id)
      const gone = yield* repo.list({ projectId: "p1" })
      return { onlyP1, all, ports, gone }
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.onlyP1).toHaveLength(1)
      expect(exit.value.all).toHaveLength(2)
      expect(exit.value.ports.sort()).toEqual([40000, 40010])
      expect(exit.value.gone).toHaveLength(0)
    }
  })
  it("get/remove unknown id -> NotFoundError", async () => {
    const { run } = make()
    const exit = await run(Effect.gen(function* () {
      const repo = yield* WorkspacesRepo
      return yield* repo.get("nope")
    }))
    expect(failTag(exit)).toBe("NotFoundError")
  })
})
```

并修改 `packages/server/test/migrations.test.ts` 第 19 行的计数断言（m0002 落地后共 2 条迁移记录）：

```ts
    expect(db.prepare("SELECT COUNT(*) c FROM schema_migrations").get()).toEqual({ c: 2 })
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server`
Expected: workspaces-repo 全 FAIL（模块不存在）；migrations 的幂等用例 FAIL（计数仍为 1）。

- [ ] **Step 3: 实现**

`packages/server/src/db/migrations.ts` 的 `MIGRATIONS` 数组**追加**一项（m0001 一字不动）：

```ts
  {
    id: "m0002-workspace-indexes",
    up: (db) => {
      db.exec(`
        CREATE UNIQUE INDEX idx_workspaces_project_name   ON workspaces(project_id, name);
        CREATE UNIQUE INDEX idx_workspaces_project_branch ON workspaces(project_id, branch);
        CREATE UNIQUE INDEX idx_workspaces_path           ON workspaces(path);
        CREATE INDEX idx_events_workspace_seq             ON events(workspace_id, seq);
      `)
    },
  },
```

`packages/server/src/repo/errors.ts`（从 projects.ts 原样移出）：

```ts
import { Data } from "effect"

export class ValidationError extends Data.TaggedError("ValidationError")<{ message: string }> {}
export class ConflictError extends Data.TaggedError("ConflictError")<{ message: string }> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{ message: string }> {}
```

`packages/server/src/repo/projects.ts` 修改三处：

1. 删除文件内的三个错误类定义，换成：

```ts
import { ValidationError, ConflictError, NotFoundError } from "./errors.js"
export { ValidationError, ConflictError, NotFoundError } from "./errors.js"
```

（原 `import { Context, Data, Effect, Layer } from "effect"` 中的 `Data` 不再需要，移除。）

2. `ProjectsRepoShape` 增加一行：

```ts
  readonly get: (id: string) => Effect.Effect<Project, NotFoundError>
```

3. Layer 返回对象中 `add` 之后增加：

```ts
      get: (id) => Effect.gen(function* () {
        const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id)
        if (!r) return yield* new NotFoundError({ message: `项目不存在：${id}` })
        return rowToProject(r)
      }),
```

`packages/server/src/repo/workspaces.ts`：

```ts
import { Context, Effect, Layer } from "effect"
import { ulid } from "ulid"
import { Workspace, type WorkspaceStatus } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { ConflictError, NotFoundError } from "./errors.js"

/** 设计文档 §四 状态机：creating→active→archived→active；creating 失败→error；error 可重试回 creating */
const ALLOWED_TRANSITIONS: Record<WorkspaceStatus, ReadonlyArray<WorkspaceStatus>> = {
  creating: ["active", "error"],
  active: ["archived"],
  archived: ["active"],
  error: ["creating"],
}

const rowToWorkspace = (r: any): Workspace => {
  let data: any = {}
  try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 坏 JSON 视为无 data */ }
  return new Workspace({
    id: r.id, projectId: r.project_id, name: r.name, path: r.path, branch: r.branch,
    baseBranch: r.base_branch, baseRef: r.base_ref, status: r.status,
    pinned: !!r.pinned, createdAt: r.created_at, archivedAt: r.archived_at ?? null,
    portBase: typeof data.portBase === "number" ? data.portBase : 0,
  })
}

export interface WorkspacesRepoShape {
  readonly insertCreating: (w: {
    projectId: string; name: string; path: string; branch: string; baseBranch: string; portBase: number
  }) => Effect.Effect<Workspace, ConflictError>
  readonly get: (id: string) => Effect.Effect<Workspace, NotFoundError>
  readonly list: (filter?: { projectId?: string }) => Effect.Effect<Workspace[]>
  readonly setStatus: (id: string, next: WorkspaceStatus) => Effect.Effect<Workspace, NotFoundError | ConflictError>
  readonly setBaseRef: (id: string, baseRef: string) => Effect.Effect<void, NotFoundError>
  readonly setLastError: (id: string, err: { tag: string; message: string }) => Effect.Effect<void, NotFoundError>
  readonly usedPortBases: () => Effect.Effect<number[]>
  readonly remove: (id: string) => Effect.Effect<void, NotFoundError>
}
export class WorkspacesRepo extends Context.Tag("WorkspacesRepo")<WorkspacesRepo, WorkspacesRepoShape>() {}

export const WorkspacesRepoLive = Layer.effect(
  WorkspacesRepo,
  Effect.gen(function* () {
    const db = yield* Db
    const getRow = (id: string): any => db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id)
    const mustGetRow = (id: string) => Effect.gen(function* () {
      const r = getRow(id)
      if (!r) return yield* new NotFoundError({ message: `workspace 不存在：${id}` })
      return r
    })
    return {
      insertCreating: (w) => Effect.gen(function* () {
        const id = ulid()
        try {
          db.prepare(`INSERT INTO workspaces
            (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
            VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?)`)
            .run(id, w.projectId, w.name, w.path, w.branch, w.baseBranch, "", "creating",
              Date.now(), JSON.stringify({ portBase: w.portBase }))
        } catch (e: any) {
          if (String(e?.code ?? "").startsWith("SQLITE_CONSTRAINT"))
            return yield* new ConflictError({ message: `workspace 名称/分支/路径已被占用（name=${w.name} branch=${w.branch}）` })
          throw e // 非约束错误 → defect
        }
        return rowToWorkspace(getRow(id))
      }),
      get: (id) => mustGetRow(id).pipe(Effect.map(rowToWorkspace)),
      list: (filter) => Effect.sync(() => {
        const rows = filter?.projectId
          ? db.prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at").all(filter.projectId)
          : db.prepare("SELECT * FROM workspaces ORDER BY created_at").all()
        return rows.map(rowToWorkspace)
      }),
      setStatus: (id, next) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        const cur = r.status as WorkspaceStatus
        if (!ALLOWED_TRANSITIONS[cur].includes(next))
          return yield* new ConflictError({ message: `非法状态迁移：${cur} → ${next}` })
        const archivedAt = next === "archived" ? Date.now() : null
        db.prepare("UPDATE workspaces SET status = ?, archived_at = ? WHERE id = ?").run(next, archivedAt, id)
        return rowToWorkspace(getRow(id))
      }),
      setBaseRef: (id, baseRef) => Effect.gen(function* () {
        yield* mustGetRow(id)
        db.prepare("UPDATE workspaces SET base_ref = ? WHERE id = ?").run(baseRef, id)
      }),
      setLastError: (id, err) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let data: any = {}
        try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 重建 */ }
        data.lastError = { tag: err.tag, message: err.message, at: Date.now() }
        db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
      }),
      usedPortBases: () => Effect.sync(() =>
        (db.prepare("SELECT data FROM workspaces").all() as any[])
          .map((r) => { try { return JSON.parse(r.data ?? "{}").portBase } catch { return undefined } })
          .filter((n): n is number => typeof n === "number")),
      remove: (id) => Effect.gen(function* () {
        const res = db.prepare("DELETE FROM workspaces WHERE id = ?").run(id)
        if (res.changes === 0) return yield* new NotFoundError({ message: `workspace 不存在：${id}` })
      }),
    }
  }),
)
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → 全绿（含既有 projects/migrations 用例）；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): WorkspacesRepo with status machine + m0002 indexes + ProjectsRepo.get"
```

---

### Task 3: GitService——git CLI 的 Effect 封装 + 典型 GitError

**Files:**
- Create: `packages/server/src/git/service.ts`
- Test: `packages/server/test/git-service.test.ts`

**Interfaces:**
- Consumes: 无（叶子 service；真实现直接 execFile git）
- Produces（Task 5/7/8/11 消费；Task 7 的假实现按同一 Shape 伪造）:
  - `GitError`（Data.TaggedError）：`{ op: string; message: string; exitCode: number | null; stderr: string }`
  - `WorktreeInfo = { path: string; head: string; branch: string | null }`（branch 为全 ref 名 `refs/heads/x`，detached 为 null）
  - `GitServiceShape`（全方法签名见 Step 3 代码）+ `GitService`（Context.Tag）+ `GitServiceLive: Layer<GitService>`
  - `parseWorktreeList(porcelain: string): WorktreeInfo[]`（纯函数，单独可测）
  - 纪律体现在接口上：**没有任何删 branch 的方法**；`worktreeRemove` 是唯一删除入口且 force 必须显式传

- [ ] **Step 1: 写失败测试**

`packages/server/test/git-service.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { Effect, Exit, Cause, Option } from "effect"
import { GitService, GitServiceLive, parseWorktreeList } from "../src/git/service.js"

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" })

const mkRepo = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-git-")))
  sh(dir, "init", "-b", "main")
  sh(dir, "config", "user.email", "t@t"); sh(dir, "config", "user.name", "t")
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n")
  sh(dir, "add", "-A"); sh(dir, "commit", "-m", "init")
  return dir
}

const run = <A, E>(eff: Effect.Effect<A, E, GitService>) =>
  Effect.runPromiseExit(Effect.provide(eff, GitServiceLive))
const git = Effect.gen(function* () { return yield* GitService })
const failTag = (exit: Exit.Exit<any, any>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const f = Cause.failureOption(exit.cause)
  return Option.isSome(f) ? (f.value as any)._tag : undefined
}

let repo: string
beforeEach(() => { repo = mkRepo() })

describe("parseWorktreeList (pure)", () => {
  it("parses main + linked + detached blocks", () => {
    const out = [
      "worktree /r", "HEAD " + "a".repeat(40), "branch refs/heads/main", "",
      "worktree /r-wt", "HEAD " + "b".repeat(40), "branch refs/heads/coolie/x", "",
      "worktree /r-det", "HEAD " + "c".repeat(40), "detached", "",
    ].join("\n")
    const wts = parseWorktreeList(out)
    expect(wts).toHaveLength(3)
    expect(wts[1]).toEqual({ path: "/r-wt", head: "b".repeat(40), branch: "refs/heads/coolie/x" })
    expect(wts[2]!.branch).toBeNull()
  })
})

describe("GitService (real git)", () => {
  it("revParse / refExists", async () => {
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      const sha = yield* g.revParse(repo, "main")
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      expect(yield* g.refExists(repo, "refs/heads/main")).toBe(true)
      expect(yield* g.refExists(repo, "refs/heads/nope")).toBe(false)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
  it("worktreeAdd -b + list + setBranchBase", async () => {
    const wt = path.join(path.dirname(repo), path.basename(repo) + "-wt")
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      yield* g.worktreeAdd(repo, wt, "coolie/t1", "main")
      const wts = yield* g.worktreeList(repo)
      expect(wts.some((w) => w.path === wt && w.branch === "refs/heads/coolie/t1")).toBe(true)
      yield* g.setBranchBase(repo, "coolie/t1", "origin/main")
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true)
    expect(sh(repo, "config", "branch.coolie/t1.base").trim()).toBe("origin/main")
  })
  it("dirty worktree: remove refuses without force, succeeds with force", async () => {
    const wt = path.join(path.dirname(repo), path.basename(repo) + "-dirty")
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      yield* g.worktreeAdd(repo, wt, "coolie/t2", "main")
      expect(yield* g.isDirty(wt)).toBe(false)
      fs.writeFileSync(path.join(wt, "junk.txt"), "x")
      expect(yield* g.isDirty(wt)).toBe(true)
      return yield* g.worktreeRemove(repo, wt, { force: false })
    }))
    expect(failTag(exit)).toBe("GitError")
    const exit2 = await run(Effect.gen(function* () {
      const g = yield* git
      yield* g.worktreeRemove(repo, wt, { force: true })
      yield* g.worktreePrune(repo)
      return yield* g.worktreeList(repo)
    }))
    expect(Exit.isSuccess(exit2)).toBe(true)
    if (Exit.isSuccess(exit2)) expect(exit2.value.some((w) => w.path === wt)).toBe(false)
    expect(fs.existsSync(wt)).toBe(false)
    // branch 保留（纪律：删除只动 worktree，永不动 branch）
    expect(sh(repo, "rev-parse", "--verify", "refs/heads/coolie/t2").trim()).toMatch(/^[0-9a-f]{40}$/)
  })
  it("worktreeAddExisting checks out an existing branch", async () => {
    const wt = path.join(path.dirname(repo), path.basename(repo) + "-again")
    sh(repo, "branch", "coolie/t3", "main")
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      yield* g.worktreeAddExisting(repo, wt, "coolie/t3")
      return yield* g.worktreeList(repo)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.some((w) => w.branch === "refs/heads/coolie/t3")).toBe(true)
  })
  it("remoteExists / fetchOrigin against a local clone", async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clone-")))
    const clone = path.join(parent, "clone")
    execFileSync("git", ["clone", repo, clone], { encoding: "utf8" })
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      expect(yield* g.remoteExists(repo, "origin")).toBe(false)
      expect(yield* g.remoteExists(clone, "origin")).toBe(true)
      yield* g.fetchOrigin(clone)
      expect(yield* g.refExists(clone, "refs/remotes/origin/main")).toBe(true)
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
  it("listIgnoredMatching finds gitignored files at root and nested", async () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env*\n")
    sh(repo, "add", ".gitignore"); sh(repo, "commit", "-m", "ignore")
    fs.writeFileSync(path.join(repo, ".env"), "A=1\n")
    fs.mkdirSync(path.join(repo, "config"), { recursive: true })
    fs.writeFileSync(path.join(repo, "config", ".env.local"), "B=2\n")
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      return yield* g.listIgnoredMatching(repo, [".env*"])
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toContain(".env")
      expect(exit.value).toContain("config/.env.local")
    }
  })
  it("failure carries op/exitCode/stderr", async () => {
    const exit = await run(Effect.gen(function* () {
      const g = yield* git
      return yield* g.revParse(repo, "no-such-ref")
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause)
      const e = Option.isSome(f) ? (f.value as any) : {}
      expect(e._tag).toBe("GitError")
      expect(e.op).toBe("rev-parse")
      expect(typeof e.exitCode === "number" || e.exitCode === null).toBe(true)
    }
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server` → git-service 全 FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`packages/server/src/git/service.ts`：

```ts
import { Context, Data, Effect, Layer } from "effect"
import { execFile } from "node:child_process"

export class GitError extends Data.TaggedError("GitError")<{
  readonly op: string
  readonly message: string
  readonly exitCode: number | null
  readonly stderr: string
}> {}

export interface WorktreeInfo {
  readonly path: string
  readonly head: string
  /** 全 ref 名（refs/heads/x）；detached 时为 null */
  readonly branch: string | null
}

export interface GitServiceShape {
  readonly remoteExists: (repoRoot: string, name: string) => Effect.Effect<boolean, GitError>
  readonly fetchOrigin: (repoRoot: string) => Effect.Effect<void, GitError>
  readonly refExists: (repoRoot: string, ref: string) => Effect.Effect<boolean, GitError>
  readonly revParse: (repoRoot: string, ref: string) => Effect.Effect<string, GitError>
  /** git worktree add --no-track -b <branch> <path> <startPoint> */
  readonly worktreeAdd: (repoRoot: string, path: string, branch: string, startPoint: string) => Effect.Effect<void, GitError>
  /** git worktree add <path> <branch>（unarchive/retry：branch 已存在） */
  readonly worktreeAddExisting: (repoRoot: string, path: string, branch: string) => Effect.Effect<void, GitError>
  /** 唯一的删除入口；脏树时 git 自动拒绝，force 必须显式传（绝不裸 rm） */
  readonly worktreeRemove: (repoRoot: string, path: string, opts: { force: boolean }) => Effect.Effect<void, GitError>
  readonly worktreePrune: (repoRoot: string) => Effect.Effect<void, GitError>
  readonly worktreeList: (repoRoot: string) => Effect.Effect<WorktreeInfo[], GitError>
  /** git status --porcelain 非空（含 untracked；ignored 不算——与 worktree remove 的判定一致） */
  readonly isDirty: (worktreePath: string) => Effect.Effect<boolean, GitError>
  /** git config branch.<branch>.base <base>（Conductor 惯例，供 diff 基点用） */
  readonly setBranchBase: (repoRoot: string, branch: string, base: string) => Effect.Effect<void, GitError>
  /** git ls-files --others --ignored --exclude-standard -- <pathspecs>：用 git 自己做 gitignore 匹配 */
  readonly listIgnoredMatching: (repoRoot: string, patterns: readonly string[]) => Effect.Effect<string[], GitError>
}
export class GitService extends Context.Tag("GitService")<GitService, GitServiceShape>() {}

const runGit = (op: string, args: readonly string[], cwd: string): Effect.Effect<string, GitError> =>
  Effect.async<string, GitError>((resume) => {
    execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout, stderr) => {
      if (error) {
        resume(Effect.fail(new GitError({
          op,
          message: `git ${op} 失败：${String(stderr || error.message).trim()}`,
          exitCode: typeof error.code === "number" ? error.code : null,
          stderr: String(stderr ?? ""),
        })))
      } else {
        resume(Effect.succeed(stdout))
      }
    })
  })

export const parseWorktreeList = (porcelain: string): WorktreeInfo[] =>
  porcelain.trim().split("\n\n").filter((b) => b.trim() !== "").map((block) => {
    let p = "", head = ""
    let branch: string | null = null
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) p = line.slice("worktree ".length)
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length)
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length)
    }
    return { path: p, head, branch }
  })

export const GitServiceLive = Layer.succeed(GitService, {
  remoteExists: (repoRoot, name) =>
    runGit("remote", ["remote"], repoRoot).pipe(
      Effect.map((out) => out.split("\n").map((l) => l.trim()).includes(name))),
  fetchOrigin: (repoRoot) =>
    runGit("fetch", ["fetch", "origin"], repoRoot).pipe(Effect.asVoid),
  refExists: (repoRoot, ref) =>
    runGit("rev-parse", ["rev-parse", "--verify", "--quiet", ref], repoRoot).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)), // 不存在与仓库级错误统一视为 false（M1 足够）
    ),
  revParse: (repoRoot, ref) =>
    runGit("rev-parse", ["rev-parse", "--verify", ref], repoRoot).pipe(Effect.map((s) => s.trim())),
  worktreeAdd: (repoRoot, p, branch, startPoint) =>
    runGit("worktree add", ["worktree", "add", "--no-track", "-b", branch, p, startPoint], repoRoot).pipe(Effect.asVoid),
  worktreeAddExisting: (repoRoot, p, branch) =>
    runGit("worktree add", ["worktree", "add", p, branch], repoRoot).pipe(Effect.asVoid),
  worktreeRemove: (repoRoot, p, opts) =>
    runGit("worktree remove",
      opts.force ? ["worktree", "remove", "--force", p] : ["worktree", "remove", p],
      repoRoot).pipe(Effect.asVoid),
  worktreePrune: (repoRoot) =>
    runGit("worktree prune", ["worktree", "prune"], repoRoot).pipe(Effect.asVoid),
  worktreeList: (repoRoot) =>
    runGit("worktree list", ["worktree", "list", "--porcelain"], repoRoot).pipe(Effect.map(parseWorktreeList)),
  isDirty: (worktreePath) =>
    runGit("status", ["status", "--porcelain"], worktreePath).pipe(Effect.map((out) => out.trim() !== "")),
  setBranchBase: (repoRoot, branch, base) =>
    runGit("config", ["config", `branch.${branch}.base`, base], repoRoot).pipe(Effect.asVoid),
  listIgnoredMatching: (repoRoot, patterns) => {
    if (patterns.length === 0) return Effect.succeed([])
    // 无 '/' 的 pattern 视为任意层级（gitignore 直觉）：加 **/ 前缀；带 '/' 的按原样根相对匹配
    const pathspecs = patterns.map((p) => (p.includes("/") ? `:(glob)${p}` : `:(glob)**/${p}`))
    return runGit("ls-files",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...pathspecs],
      repoRoot).pipe(Effect.map((out) => out.split("\0").filter((s) => s !== "")))
  },
} satisfies GitServiceShape)
```

实现注记：若所装 git 版本的 `:(glob)**/p` 不匹配根层文件（wildmatch 行为差异），等价改写为对无 `/` 的 pattern 同时传 `:(glob)p` 与 `:(glob)**/p` 两个 pathspec 再去重——行为契约（Step 1 里"根层 `.env` 与嵌套 `config/.env.local` 都被列出"）不变。

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): GitService wrapping git CLI with typed GitError"
```

---

### Task 4: 名池 provider + 端口段分配（纯函数）

**Files:**
- Create: `packages/server/src/workspace/names.ts`, `packages/server/src/workspace/ports.ts`
- Test: `packages/server/test/names-ports.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 7 消费）:
  - `NamePool = { id: string; names: ReadonlyArray<string> }`（provider 接口可插拔；M1 只内置一个池）
  - `NATIONAL_PARKS: NamePool`（≥40 个 `国家-公园` slug；默认池）
  - `pickName(taken: ReadonlySet<string>, pool?, rand?): string`（未用名随机取；全占用时数字后缀 `-2`、`-3`…）
  - `sanitizeSlug(input: string): string`（小写、非 `[a-z0-9]` 折叠为 `-`、去首尾 `-`、限 60 字符；空串留给调用方判 ValidationError）
  - `PORT_BLOCK_SIZE = 10`、`PORT_BASE_START = 40000`
  - `allocatePortBase(used: ReadonlyArray<number>): number`（从 40000 起找第一个未占用的 10 对齐段；已删 workspace 的段可复用）
  - `portEnv(portBase: number): Record<string, string>`（`COOLIE_PORT_0..9`）

- [ ] **Step 1: 写失败测试**

`packages/server/test/names-ports.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { NATIONAL_PARKS, pickName, sanitizeSlug } from "../src/workspace/names.js"
import { PORT_BLOCK_SIZE, PORT_BASE_START, allocatePortBase, portEnv } from "../src/workspace/ports.js"

describe("name pool", () => {
  it("national-parks pool has >=40 unique country-park slugs", () => {
    expect(NATIONAL_PARKS.id).toBe("national-parks")
    expect(NATIONAL_PARKS.names.length).toBeGreaterThanOrEqual(40)
    expect(new Set(NATIONAL_PARKS.names).size).toBe(NATIONAL_PARKS.names.length)
    for (const n of NATIONAL_PARKS.names) expect(n).toMatch(/^[a-z]+-[a-z0-9]+$/)
  })
  it("pickName avoids taken names (deterministic with rand=0)", () => {
    const first = NATIONAL_PARKS.names[0]!
    expect(pickName(new Set(), NATIONAL_PARKS, () => 0)).toBe(first)
    expect(pickName(new Set([first]), NATIONAL_PARKS, () => 0)).toBe(NATIONAL_PARKS.names[1]!)
  })
  it("pickName suffixes when the whole pool is taken", () => {
    const taken = new Set(NATIONAL_PARKS.names)
    expect(pickName(taken, NATIONAL_PARKS, () => 0)).toBe(`${NATIONAL_PARKS.names[0]!}-2`)
    const taken2 = new Set([...NATIONAL_PARKS.names, ...NATIONAL_PARKS.names.map((n) => `${n}-2`)])
    expect(pickName(taken2, NATIONAL_PARKS, () => 0)).toBe(`${NATIONAL_PARKS.names[0]!}-3`)
  })
  it("sanitizeSlug normalizes arbitrary input", () => {
    expect(sanitizeSlug("Fix Login!!")).toBe("fix-login")
    expect(sanitizeSlug("--weird__Case--")).toBe("weird-case")
    expect(sanitizeSlug("!!!")).toBe("")
  })
})

describe("port block allocation", () => {
  it("starts at 40000, steps by 10, reuses freed blocks", () => {
    expect(PORT_BLOCK_SIZE).toBe(10)
    expect(PORT_BASE_START).toBe(40000)
    expect(allocatePortBase([])).toBe(40000)
    expect(allocatePortBase([40000])).toBe(40010)
    expect(allocatePortBase([40000, 40010])).toBe(40020)
    expect(allocatePortBase([40010])).toBe(40000) // 已删 workspace 的段可复用
  })
  it("portEnv exposes COOLIE_PORT_0..9", () => {
    const env = portEnv(40020)
    expect(env.COOLIE_PORT_0).toBe("40020")
    expect(env.COOLIE_PORT_9).toBe("40029")
    expect(Object.keys(env)).toHaveLength(10)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server` → names-ports 全 FAIL。

- [ ] **Step 3: 实现**

`packages/server/src/workspace/names.ts`：

```ts
/** 名池 provider：目录名生成后不变（rename 只改显示 label，M2）。M1 只内置 national-parks。 */
export interface NamePool {
  readonly id: string
  readonly names: ReadonlyArray<string>
}

export const NATIONAL_PARKS: NamePool = {
  id: "national-parks",
  names: [
    "usa-yellowstone", "usa-yosemite", "usa-zion", "usa-glacier", "usa-denali",
    "usa-acadia", "usa-olympic", "usa-sequoia", "usa-arches", "usa-badlands",
    "usa-everglades", "usa-shenandoah", "usa-redwood", "usa-bigbend",
    "canada-banff", "canada-jasper", "canada-yoho", "canada-kootenay", "canada-fundy", "canada-grosmorne",
    "china-zhangjiajie", "china-jiuzhaigou", "china-huangshan", "china-sanqingshan", "china-potatso", "china-shennongjia",
    "japan-fuji", "japan-shiretoko", "japan-nikko", "japan-daisetsuzan",
    "australia-kakadu", "australia-uluru", "australia-daintree",
    "newzealand-fiordland", "newzealand-tongariro",
    "chile-torres", "argentina-iguazu", "argentina-glaciares", "peru-manu", "ecuador-galapagos", "brazil-chapada",
    "tanzania-serengeti", "kenya-amboseli", "southafrica-kruger", "namibia-etosha", "botswana-chobe",
    "iceland-vatnajokull", "norway-jotunheimen", "sweden-sarek", "finland-oulanka",
    "spain-ordesa", "france-vanoise", "italy-gransasso", "croatia-plitvice",
  ],
}

/** 未用名里随机取一个；全占用时找最小可用数字后缀（-2 起）。rand 可注入以便测试。 */
export const pickName = (
  taken: ReadonlySet<string>,
  pool: NamePool = NATIONAL_PARKS,
  rand: () => number = Math.random,
): string => {
  const free = pool.names.filter((n) => !taken.has(n))
  if (free.length > 0) return free[Math.floor(rand() * free.length)]!
  for (let i = 2; ; i++) {
    const cands = pool.names.filter((n) => !taken.has(`${n}-${i}`))
    if (cands.length > 0) return `${cands[Math.floor(rand() * cands.length)]!}-${i}`
  }
}

/** branch slug 消毒：小写、非字母数字折叠为 '-'、去首尾 '-'、限 60 字符。空结果由调用方判 Validation。 */
export const sanitizeSlug = (input: string): string =>
  input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
```

`packages/server/src/workspace/ports.ts`：

```ts
/** 每 workspace 一段 10 个连续端口（Conductor 同款），base 从 4 万段起步。 */
export const PORT_BLOCK_SIZE = 10
export const PORT_BASE_START = 40_000
const PORT_BASE_MAX = 64_990

/** 找第一个未占用的段基址；持久化在 workspaces.data.portBase，删行后自然回收。 */
export const allocatePortBase = (used: ReadonlyArray<number>): number => {
  const taken = new Set(used)
  for (let base = PORT_BASE_START; base <= PORT_BASE_MAX; base += PORT_BLOCK_SIZE) {
    if (!taken.has(base)) return base
  }
  throw new Error("端口段耗尽（>2400 个并存 workspace？）") // 视为 defect
}

export const portEnv = (portBase: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: PORT_BLOCK_SIZE }, (_, i) => [`COOLIE_PORT_${i}`, String(portBase + i)]),
  )
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): national-parks name pool + port block allocator"
```

---

### Task 5: include——.git/info/exclude 注入 + .worktreeinclude 复制

**Files:**
- Create: `packages/server/src/workspace/include.ts`
- Test: `packages/server/test/include.test.ts`

**Interfaces:**
- Consumes: `GitService.listIgnoredMatching`（Task 3；本模块只消费其结果列表，文件匹配交给 git 本体做）
- Produces（Task 7 消费）:
  - `injectInfoExclude(repoRoot: string, entry = ".coolie/"): void` — 往 `<repoRoot>/.git/info/exclude` 幂等追加（worktree 共享 common git dir，注一次全体生效；Conductor 同款零仓库污染手法）
  - `DEFAULT_INCLUDE_PATTERNS = [".env*"]`
  - `readWorktreeIncludePatterns(repoRoot: string): string[]` — 读 `<repoRoot>/.worktreeinclude`（gitignore 语法逐行；`#` 注释与空行忽略）；文件不存在或为空 → 默认 pattern
  - `copyIncludedFiles(repoRoot: string, worktreePath: string, relFiles: readonly string[]): string[]` — 逐个相对路径复制（mkdir -p 目标父目录），返回实际复制列表；缺失/非普通文件跳过

- [ ] **Step 1: 写失败测试**

`packages/server/test/include.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import {
  injectInfoExclude, readWorktreeIncludePatterns, copyIncludedFiles, DEFAULT_INCLUDE_PATTERNS,
} from "../src/workspace/include.js"

const mkdir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

describe("injectInfoExclude", () => {
  it("appends .coolie/ once, idempotently", () => {
    const repo = mkdir("coolie-inc-")
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true })
    injectInfoExclude(repo)
    injectInfoExclude(repo)
    const text = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")
    expect(text.split("\n").filter((l) => l.trim() === ".coolie/")).toHaveLength(1)
  })
  it("preserves existing exclude content", () => {
    const repo = mkdir("coolie-inc2-")
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true })
    fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), "node_modules/\n")
    injectInfoExclude(repo)
    const text = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")
    expect(text).toContain("node_modules/")
    expect(text).toContain(".coolie/")
  })
})

describe("readWorktreeIncludePatterns", () => {
  it("defaults to .env* when no file", () => {
    expect(readWorktreeIncludePatterns(mkdir("coolie-inc3-"))).toEqual([...DEFAULT_INCLUDE_PATTERNS])
  })
  it("reads lines, skipping comments and blanks", () => {
    const repo = mkdir("coolie-inc4-")
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "# secrets\n.env*\n\nconfig/local.json\n")
    expect(readWorktreeIncludePatterns(repo)).toEqual([".env*", "config/local.json"])
  })
})

describe("copyIncludedFiles", () => {
  it("copies nested relative paths, skips missing", () => {
    const repo = mkdir("coolie-inc5-"); const wt = mkdir("coolie-inc6-")
    fs.writeFileSync(path.join(repo, ".env"), "A=1\n")
    fs.mkdirSync(path.join(repo, "config"), { recursive: true })
    fs.writeFileSync(path.join(repo, "config", ".env.local"), "B=2\n")
    const copied = copyIncludedFiles(repo, wt, [".env", "config/.env.local", "missing.txt"])
    expect(copied).toEqual([".env", "config/.env.local"])
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("A=1\n")
    expect(fs.readFileSync(path.join(wt, "config", ".env.local"), "utf8")).toBe("B=2\n")
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server` → include 全 FAIL。

- [ ] **Step 3: 实现**

`packages/server/src/workspace/include.ts`：

```ts
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * 往 <repoRoot>/.git/info/exclude 幂等追加一行（默认 .coolie/）。
 * info/exclude 属 common git dir，所有 worktree 共享——注一次全体生效，且零仓库污染（Conductor 手法）。
 */
export const injectInfoExclude = (repoRoot: string, entry = ".coolie/"): void => {
  const p = path.join(repoRoot, ".git", "info", "exclude")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""
  if (cur.split("\n").some((l) => l.trim() === entry)) return
  const sep = cur === "" || cur.endsWith("\n") ? "" : "\n"
  fs.appendFileSync(p, `${sep}${entry}\n`)
}

/** .worktreeinclude 缺席时的默认 pattern（Conductor 默认同款）。 */
export const DEFAULT_INCLUDE_PATTERNS = [".env*"] as const

export const readWorktreeIncludePatterns = (repoRoot: string): string[] => {
  const p = path.join(repoRoot, ".worktreeinclude")
  if (!fs.existsSync(p)) return [...DEFAULT_INCLUDE_PATTERNS]
  const lines = fs.readFileSync(p, "utf8").split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
  return lines.length > 0 ? lines : [...DEFAULT_INCLUDE_PATTERNS]
}

/** 把 repoRoot 下的相对路径文件复制进 worktree（保结构）。列表来自 GitService.listIgnoredMatching。 */
export const copyIncludedFiles = (
  repoRoot: string,
  worktreePath: string,
  relFiles: readonly string[],
): string[] => {
  const copied: string[] = []
  for (const rel of relFiles) {
    const src = path.join(repoRoot, rel)
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue
    const dst = path.join(worktreePath, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    copied.push(rel)
  }
  return copied
}
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): info/exclude injection + .worktreeinclude copy helpers"
```

---

### Task 6: SetupRunner——三层 setup script 的非交互执行

**Files:**
- Create: `packages/server/src/workspace/setup.ts`
- Test: `packages/server/test/setup-runner.test.ts`

**Interfaces:**
- Consumes: 无（叶子 service；spawn bash）
- Produces（Task 7 消费）:
  - `SetupScriptError`（Data.TaggedError）：`{ script: string; exitCode: number | null; message: string; outputTail: string }`
  - `SetupResult = { script: string; exitCode: number; outputTail: string }`（outputTail = stdout+stderr 合流的末尾 4000 字符，落 events 用）
  - `resolveSetupScripts(opts: { worktreePath; repoRoot; projectId; home }): string[]` — 三层合并（设计文档 §四）：① `<worktree>/.coolie/setup.sh`（repo 可提交，取 worktree 里的 checkout 版本）→ ② `<home>/projects/<projectId>/setup.sh`（本机覆盖层）→ ③ `<repoRoot>/.coolie/setup.local.sh`（local overlay，不入库、被 info/exclude 排除）；只返回存在的，按此顺序执行
  - `SetupRunner`（Context.Tag）+ `makeSetupRunnerLive(log?: (chunk: string) => void): Layer<SetupRunner>` + `SetupRunnerLive = makeSetupRunnerLive()`；`run(opts: { worktreePath; scripts: readonly string[]; env: Record<string,string>; timeoutMs?: number }): Effect<SetupResult[], SetupScriptError>` — `spawn("bash", [script], { detached: true })` 自成进程组，cwd=worktree，stdin ignore（非交互），顺序执行、首个失败即停；超时杀全组（`process.kill(-pid, "SIGKILL")` + `child.kill` 兜底），以 `exit` 事件定局（后台子进程握住管道时 `close` 永不来）；`log` 供 main.ts 接 server.log（"落日志"要求）

- [ ] **Step 1: 写失败测试**

`packages/server/test/setup-runner.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { Effect, Exit, Cause, Option } from "effect"
import {
  SetupRunner, SetupRunnerLive, resolveSetupScripts, SetupScriptError,
} from "../src/workspace/setup.js"

const mkdir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const writeScript = (file: string, body: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`)
  return file
}
const run = <A, E>(eff: Effect.Effect<A, E, SetupRunner>) =>
  Effect.runPromiseExit(Effect.provide(eff, SetupRunnerLive))

describe("resolveSetupScripts", () => {
  it("returns the three layers in order, skipping missing", () => {
    const worktreePath = mkdir("coolie-setup-wt-")
    const repoRoot = mkdir("coolie-setup-repo-")
    const home = mkdir("coolie-setup-home-")
    const l1 = writeScript(path.join(worktreePath, ".coolie", "setup.sh"), "echo repo")
    const l3 = writeScript(path.join(repoRoot, ".coolie", "setup.local.sh"), "echo local")
    expect(resolveSetupScripts({ worktreePath, repoRoot, projectId: "p1", home })).toEqual([l1, l3])
    const l2 = writeScript(path.join(home, "projects", "p1", "setup.sh"), "echo machine")
    expect(resolveSetupScripts({ worktreePath, repoRoot, projectId: "p1", home })).toEqual([l1, l2, l3])
  })
})

describe("SetupRunner", () => {
  it("runs scripts with injected env, captures outputTail", async () => {
    const wt = mkdir("coolie-run-wt-")
    const script = writeScript(path.join(wt, ".coolie", "setup.sh"),
      'echo "port=$COOLIE_PORT_0 root=$COOLIE_ROOT"\necho "$COOLIE_PORT_0" > port.txt')
    const exit = await run(Effect.gen(function* () {
      const runner = yield* SetupRunner
      return yield* runner.run({
        worktreePath: wt, scripts: [script],
        env: { COOLIE_ROOT: "/main/checkout", COOLIE_PORT_0: "40000" },
      })
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toHaveLength(1)
      expect(exit.value[0]!.exitCode).toBe(0)
      expect(exit.value[0]!.outputTail).toContain("port=40000 root=/main/checkout")
    }
    expect(fs.readFileSync(path.join(wt, "port.txt"), "utf8").trim()).toBe("40000")
  })
  it("non-zero exit -> SetupScriptError with exitCode and outputTail; later scripts not run", async () => {
    const wt = mkdir("coolie-fail-wt-")
    const bad = writeScript(path.join(wt, "bad.sh"), 'echo "boom happened" >&2\nexit 3')
    const never = writeScript(path.join(wt, "never.sh"), "touch never-ran.txt")
    const exit = await run(Effect.gen(function* () {
      const runner = yield* SetupRunner
      return yield* runner.run({ worktreePath: wt, scripts: [bad, never], env: {} })
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause)
      const e = Option.isSome(f) ? (f.value as SetupScriptError) : undefined
      expect(e?._tag).toBe("SetupScriptError")
      expect(e?.exitCode).toBe(3)
      expect(e?.outputTail).toContain("boom happened")
    }
    expect(fs.existsSync(path.join(wt, "never-ran.txt"))).toBe(false)
  })
  it("empty script list resolves to []", async () => {
    const exit = await run(Effect.gen(function* () {
      const runner = yield* SetupRunner
      return yield* runner.run({ worktreePath: mkdir("coolie-empty-wt-"), scripts: [], env: {} })
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual([])
  })
  it("timeout kills the script and fails typed", async () => {
    const wt = mkdir("coolie-to-wt-")
    // 两行脚本：防 bash 对单命令做 exec 优化（那样 bash 自己就变成 sleep，进程组击杀就测不到了）
    const slow = writeScript(path.join(wt, "slow.sh"), "sleep 30\necho never-reached")
    const exit = await run(Effect.gen(function* () {
      const runner = yield* SetupRunner
      return yield* runner.run({ worktreePath: wt, scripts: [slow], env: {}, timeoutMs: 300 })
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause)
      expect(Option.isSome(f) && (f.value as any)._tag).toBe("SetupScriptError")
      expect(Option.isSome(f) && (f.value as any).message).toContain("超时")
    }
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server` → setup-runner 全 FAIL。

- [ ] **Step 3: 实现**

`packages/server/src/workspace/setup.ts`：

```ts
import { Context, Data, Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export class SetupScriptError extends Data.TaggedError("SetupScriptError")<{
  readonly script: string
  readonly exitCode: number | null
  readonly message: string
  readonly outputTail: string
}> {}

export interface SetupResult {
  readonly script: string
  readonly exitCode: number
  readonly outputTail: string
}

export interface SetupRunOpts {
  readonly worktreePath: string
  readonly scripts: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface SetupRunnerShape {
  readonly run: (opts: SetupRunOpts) => Effect.Effect<SetupResult[], SetupScriptError>
}
export class SetupRunner extends Context.Tag("SetupRunner")<SetupRunner, SetupRunnerShape>() {}

/**
 * 三层合并（设计文档 §四）：repo 层取 worktree 里的 checkout 版本（branch 各自生效）；
 * 本机覆盖层在 COOLIE_HOME；local overlay 在主 checkout 的 .coolie/（不入库，被 info/exclude 排除）。
 * 只返回存在的脚本，按 repo → 本机 → local 顺序执行。
 */
export const resolveSetupScripts = (opts: {
  readonly worktreePath: string
  readonly repoRoot: string
  readonly projectId: string
  readonly home: string
}): string[] => {
  const candidates = [
    path.join(opts.worktreePath, ".coolie", "setup.sh"),
    path.join(opts.home, "projects", opts.projectId, "setup.sh"),
    path.join(opts.repoRoot, ".coolie", "setup.local.sh"),
  ]
  return candidates.filter((p) => fs.existsSync(p))
}

const TAIL_CHARS = 4000
const DEFAULT_TIMEOUT_MS = 600_000 // 10 分钟

const runOne = (
  script: string,
  opts: SetupRunOpts,
  log: ((chunk: string) => void) | undefined,
): Promise<SetupResult> =>
  new Promise((resolve, reject) => {
    // 非交互：stdin ignore；stdout/stderr 合流截尾落 events，整流经 log 落 server.log。
    // detached: true 让 bash 自成进程组——超时才能连它留下的后台子进程一起杀
    const child = spawn("bash", [script], {
      cwd: opts.worktreePath,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    let tail = ""
    let timedOut = false
    const push = (c: Buffer): void => {
      const s = c.toString()
      tail = (tail + s).slice(-TAIL_CHARS)
      log?.(s)
    }
    child.stdout.on("data", push)
    child.stderr.on("data", push)
    const timer = setTimeout(() => {
      timedOut = true
      // 杀整个进程组：脚本留下的后台子进程（如 `npm run dev &`）只杀 bash 是清不掉的
      // （Plan 1 daemon.test.ts 的进程组教训同款）
      try { process.kill(-child.pid!, "SIGKILL") } catch { /* 组已不在 */ }
      child.kill("SIGKILL") // 兜底
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(new SetupScriptError({ script, exitCode: null, message: `无法启动 setup script：${e.message}`, outputTail: tail }))
    })
    // 以 'exit' 定局而非 'close'：后台子进程若继承并握住 stdout/stderr 管道，
    // 'close' 要等管道全关、永不触发；'exit' 在 bash 本体退出即触发
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (timedOut)
        return reject(new SetupScriptError({ script, exitCode: null, message: `setup script 超时被杀（${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`, outputTail: tail }))
      if (code === 0) return resolve({ script, exitCode: 0, outputTail: tail })
      reject(new SetupScriptError({ script, exitCode: code, message: `setup script 退出码 ${code}：${script}`, outputTail: tail }))
    })
  })

/** log 参数供 main.ts 接诊断日志（fire-and-forget）；测试用无参版 SetupRunnerLive。 */
export const makeSetupRunnerLive = (log?: (chunk: string) => void): Layer.Layer<SetupRunner> =>
  Layer.succeed(SetupRunner, {
    run: (opts) => Effect.gen(function* () {
      const results: SetupResult[] = []
      for (const script of opts.scripts) {
        results.push(yield* Effect.tryPromise({
          try: () => runOne(script, opts, log),
          catch: (e) => e instanceof SetupScriptError
            ? e
            : new SetupScriptError({ script, exitCode: null, message: String(e), outputTail: "" }),
        }))
      }
      return results
    }),
  })
export const SetupRunnerLive = makeSetupRunnerLive()
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → PASS（timeout 用例约 0.3s）。

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): three-layer setup script runner (non-interactive, typed errors)"
```

---

### Task 7: WorkspaceLifecycle——create 流水线 + 回滚 + retry + PostCreateHooks 插拔点

**Files:**
- Create: `packages/server/src/workspace/lifecycle.ts`, `packages/server/test/helpers/fake-git.ts`
- Test: `packages/server/test/lifecycle-create.test.ts`

**Interfaces:**
- Consumes: `WorkspacesRepo`（Task 2）、`ProjectsRepo.get`（Task 2）、`GitServiceShape/GitError`（Task 3）、`pickName/sanitizeSlug`（Task 4）、`allocatePortBase/portEnv`（Task 4）、`injectInfoExclude/readWorktreeIncludePatterns/copyIncludedFiles`（Task 5）、`SetupRunner/resolveSetupScripts/SetupScriptError`（Task 6）、`EventsRepo`（Plan 1）、`CoolieConfig`（Plan 1）
- Produces（Task 8 在同文件补 archive/unarchive/delete；Task 9/11 消费）:
  - `HookError`（Data.TaggedError `{message: string}`）；`PostCreateHook = (ws: Workspace) => Effect<void, HookError>`
  - `PostCreateHooks`（Context.Tag，值 `ReadonlyArray<PostCreateHook>`）+ `PostCreateHooksEmpty: Layer`——**Plan 3 的 tmux session/engine 启动在此插入**，hook 失败走与 git/setup 失败相同的回滚
  - `CreateError = ValidationError | NotFoundError | ConflictError | GitError | SetupScriptError | HookError`
  - `WorkspaceLifecycle`（Context.Tag）+ `WorkspaceLifecycleLive: Layer<WorkspaceLifecycle, never, CoolieConfig | ProjectsRepo | WorkspacesRepo | EventsRepo | GitService | SetupRunner | PostCreateHooks>`：
    - `create(opts: { projectId: string; branchSlug?: string; name?: string }): Effect<Workspace, CreateError>`
    - `retry(id: string): Effect<Workspace, CreateError>`（仅 error 状态；复用同一 provision 流水线与原 name/branch/path/portBase）
  - 本 Task 的 `archive/unarchive/delete` 先放 stub（`Effect.die(new Error("… 在 Task 8 实装"))`），Task 8 换实现——shape 一次定全，HTTP 层类型不反复
  - 已知边界（M1 接受并记录）：两个不同 repo 的 basename 相同时（如都叫 `api`），workspace 路径共用 `<wsRoot>/api/` 段；若园名再撞车，m0002 的 `UNIQUE(path)` 会让 `insertCreating` 报 409（信息略隐晦）。M1 不做项目目录去重
  - 假 GitService：`makeFakeGit(init?) → { git: GitServiceShape; state }`（call 记录 / refs / worktrees / dirty / failOps 可编程）

- [ ] **Step 1: 写测试助手 fake-git**

`packages/server/test/helpers/fake-git.ts`（不匹配 `*.test.ts`，vitest 不会执行）：

```ts
import { Effect } from "effect"
import { GitError, type GitServiceShape, type WorktreeInfo } from "../../src/git/service.js"

export interface FakeGitState {
  /** 每次调用记录：[方法名, ...参数字符串] */
  readonly calls: string[][]
  /** ref 名 → 假 sha。默认含 main / origin/main / refs/remotes/origin/main */
  readonly refs: Map<string, string>
  /** worktree path → branch 名 */
  readonly worktrees: Map<string, string>
  /** 视为脏的 worktree path */
  readonly dirty: Set<string>
  /** branch → 写入的 base（setBranchBase 记录） */
  readonly branchBases: Map<string, string>
  /** listIgnoredMatching 返回值（可变） */
  ignoredFiles: string[]
  /** 命中即 fail 的方法名集合（可变） */
  readonly failOps: Set<string>
  hasOrigin: boolean
}

export const FAKE_SHA = "a".repeat(40)

export const makeFakeGit = (init?: {
  refs?: Record<string, string>
  hasOrigin?: boolean
  ignoredFiles?: string[]
}): { git: GitServiceShape; state: FakeGitState } => {
  const defaultRefs = { main: FAKE_SHA, "origin/main": FAKE_SHA, "refs/remotes/origin/main": FAKE_SHA }
  const state: FakeGitState = {
    calls: [],
    refs: new Map(Object.entries(init?.refs ?? defaultRefs)),
    worktrees: new Map(),
    dirty: new Set(),
    branchBases: new Map(),
    ignoredFiles: init?.ignoredFiles ?? [],
    failOps: new Set(),
    hasOrigin: init?.hasOrigin ?? true,
  }
  const rec = (...call: string[]): void => { state.calls.push(call) }
  const gitErr = (op: string, message: string): GitError =>
    new GitError({ op, message, exitCode: 128, stderr: "" })
  const guard = <A>(op: string, a: () => A): Effect.Effect<A, GitError> =>
    state.failOps.has(op) ? Effect.fail(gitErr(op, `fake git failure: ${op}`)) : Effect.sync(a)

  const git: GitServiceShape = {
    remoteExists: (repoRoot, name) => {
      rec("remoteExists", repoRoot, name)
      return guard("remoteExists", () => name === "origin" && state.hasOrigin)
    },
    fetchOrigin: (repoRoot) => { rec("fetchOrigin", repoRoot); return guard("fetchOrigin", () => undefined) },
    refExists: (repoRoot, ref) => { rec("refExists", repoRoot, ref); return guard("refExists", () => state.refs.has(ref)) },
    revParse: (repoRoot, ref) => {
      rec("revParse", repoRoot, ref)
      if (state.failOps.has("revParse")) return Effect.fail(gitErr("revParse", "fake git failure: revParse"))
      const sha = state.refs.get(ref)
      return sha ? Effect.succeed(sha) : Effect.fail(gitErr("rev-parse", `unknown ref ${ref}`))
    },
    worktreeAdd: (repoRoot, p, branch, startPoint) => {
      rec("worktreeAdd", repoRoot, p, branch, startPoint)
      return guard("worktreeAdd", () => {
        const sha = state.refs.get(startPoint) ?? FAKE_SHA
        state.refs.set(`refs/heads/${branch}`, sha)
        state.worktrees.set(p, branch)
      })
    },
    worktreeAddExisting: (repoRoot, p, branch) => {
      rec("worktreeAddExisting", repoRoot, p, branch)
      return guard("worktreeAddExisting", () => { state.worktrees.set(p, branch) })
    },
    worktreeRemove: (repoRoot, p, opts) => {
      rec("worktreeRemove", repoRoot, p, String(opts.force))
      if (state.failOps.has("worktreeRemove")) return Effect.fail(gitErr("worktreeRemove", "fake git failure: worktreeRemove"))
      if (!state.worktrees.has(p)) return Effect.fail(gitErr("worktree remove", `not a working tree: ${p}`))
      if (state.dirty.has(p) && !opts.force) return Effect.fail(gitErr("worktree remove", "contains modified or untracked files"))
      return Effect.sync(() => { state.worktrees.delete(p); state.dirty.delete(p) })
    },
    worktreePrune: (repoRoot) => { rec("worktreePrune", repoRoot); return guard("worktreePrune", () => undefined) },
    worktreeList: (repoRoot) => {
      rec("worktreeList", repoRoot)
      return guard("worktreeList", (): WorktreeInfo[] =>
        [...state.worktrees.entries()].map(([p, b]) => ({ path: p, head: FAKE_SHA, branch: `refs/heads/${b}` })))
    },
    isDirty: (p) => { rec("isDirty", p); return guard("isDirty", () => state.dirty.has(p)) },
    setBranchBase: (repoRoot, branch, base) => {
      rec("setBranchBase", repoRoot, branch, base)
      return guard("setBranchBase", () => { state.branchBases.set(branch, base) })
    },
    listIgnoredMatching: (repoRoot, patterns) => {
      rec("listIgnoredMatching", repoRoot, ...patterns)
      return guard("listIgnoredMatching", () => [...state.ignoredFiles])
    },
  }
  return { git, state }
}
```

- [ ] **Step 2: 写失败测试**

`packages/server/test/lifecycle-create.test.ts`：

```ts
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
    env.hooks.push((ws) => Effect.sync(() => { seen.push(ws.id) }))
    const p = await ok(env, addProject(env.repoRoot))
    const ws = await ok(env, Effect.gen(function* () {
      return yield* (yield* WorkspaceLifecycle).create({ projectId: p.id })
    }))
    expect(seen).toEqual([ws.id])
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
```

- [ ] **Step 3: 确认失败** — Run: `bun run test -- packages/server` → lifecycle-create 全 FAIL（模块不存在）。

- [ ] **Step 4: 实现**

`packages/server/src/workspace/lifecycle.ts`：

```ts
import { Context, Data, Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { Workspace } from "@coolie/protocol"
import { CoolieConfig } from "../config.js"
import { ProjectsRepo } from "../repo/projects.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { EventsRepo } from "../repo/events.js"
import { ValidationError, ConflictError, NotFoundError } from "../repo/errors.js"
import { GitService, GitError } from "../git/service.js"
import { SetupRunner, SetupScriptError, resolveSetupScripts } from "./setup.js"
import { pickName, sanitizeSlug } from "./names.js"
import { allocatePortBase, portEnv } from "./ports.js"
import { injectInfoExclude, readWorktreeIncludePatterns, copyIncludedFiles } from "./include.js"

/** Plan 3 插拔点：tmux session / engine 启动 / 首条 prompt 投递以 hook 形式挂进 create 流水线末尾。 */
export class HookError extends Data.TaggedError("HookError")<{ readonly message: string }> {}
export type PostCreateHook = (ws: Workspace) => Effect.Effect<void, HookError>
export class PostCreateHooks extends Context.Tag("PostCreateHooks")<PostCreateHooks, ReadonlyArray<PostCreateHook>>() {}
export const PostCreateHooksEmpty = Layer.succeed(PostCreateHooks, [])

export type CreateError = ValidationError | NotFoundError | ConflictError | GitError | SetupScriptError | HookError
export type LifecycleError = NotFoundError | ConflictError | GitError

export interface WorkspaceLifecycleShape {
  readonly create: (opts: { projectId: string; branchSlug?: string; name?: string }) => Effect.Effect<Workspace, CreateError>
  readonly retry: (id: string) => Effect.Effect<Workspace, CreateError>
  readonly archive: (id: string, opts?: { force?: boolean }) => Effect.Effect<Workspace, LifecycleError>
  readonly unarchive: (id: string) => Effect.Effect<Workspace, LifecycleError>
  readonly delete: (id: string, opts?: { force?: boolean }) => Effect.Effect<void, LifecycleError>
}
export class WorkspaceLifecycle extends Context.Tag("WorkspaceLifecycle")<WorkspaceLifecycle, WorkspaceLifecycleShape>() {}

export const WorkspaceLifecycleLive = Layer.effect(
  WorkspaceLifecycle,
  Effect.gen(function* () {
    const cfg = yield* CoolieConfig
    const projects = yield* ProjectsRepo
    const repo = yield* WorkspacesRepo
    const events = yield* EventsRepo
    const git = yield* GitService
    const setup = yield* SetupRunner
    const hooks = yield* PostCreateHooks

    const emit = (workspaceId: string | null, type: string, payload: unknown) =>
      events.append({ workspaceId, type, payload })

    /**
     * create/retry 共用的置备流水线（设计文档 §四，本计划裁掉 tmux/engine 段）：
     * fetch → prune → 解析 startPoint/baseRef → worktree add（或复用既有 branch）→
     * branch.<name>.base → info/exclude 注入 → .worktreeinclude 复制 → 三层 setup → hooks → active
     */
    const provision = (ws: Workspace, repoRoot: string): Effect.Effect<Workspace, CreateError> =>
      Effect.gen(function* () {
        if (yield* git.remoteExists(repoRoot, "origin")) yield* git.fetchOrigin(repoRoot)
        yield* git.worktreePrune(repoRoot)
        const startPoint = (yield* git.refExists(repoRoot, `refs/remotes/origin/${ws.baseBranch}`))
          ? `origin/${ws.baseBranch}`
          : ws.baseBranch
        const baseRef = yield* git.revParse(repoRoot, startPoint)
        yield* repo.setBaseRef(ws.id, baseRef)
        // fs 步骤也走 typed error（GitError 的 op 标注来源）——否则 defect 会绕过 catchAll 回滚
        yield* Effect.try({
          try: () => fs.mkdirSync(path.dirname(ws.path), { recursive: true }),
          catch: (e) => new GitError({ op: "mkdir", message: `创建 worktree 父目录失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        if (yield* git.refExists(repoRoot, `refs/heads/${ws.branch}`)) {
          // branch 已存在（error 重试 / 删除后同 slug 重建）：只允许仍指向 baseRef 时复用——branch 永不删除的配套语义
          const cur = yield* git.revParse(repoRoot, `refs/heads/${ws.branch}`)
          if (cur !== baseRef)
            return yield* new ConflictError({ message: `branch ${ws.branch} 已存在且有独立历史；换一个 --slug 或手动处理该 branch` })
          yield* git.worktreeAddExisting(repoRoot, ws.path, ws.branch)
        } else {
          yield* git.worktreeAdd(repoRoot, ws.path, ws.branch, startPoint)
        }
        yield* git.setBranchBase(repoRoot, ws.branch, startPoint)
        yield* Effect.try({
          try: () => injectInfoExclude(repoRoot),
          catch: (e) => new GitError({ op: "info/exclude", message: `注入 .git/info/exclude 失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        const patterns = readWorktreeIncludePatterns(repoRoot)
        const ignored = yield* git.listIgnoredMatching(repoRoot, patterns)
        yield* Effect.try({
          try: () => copyIncludedFiles(repoRoot, ws.path, ignored),
          catch: (e) => new GitError({ op: "worktreeinclude", message: `复制 .worktreeinclude 文件失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        const scripts = resolveSetupScripts({ worktreePath: ws.path, repoRoot, projectId: ws.projectId, home: cfg.home })
        if (scripts.length > 0) {
          yield* emit(ws.id, "workspace.setup.started", { scripts })
          const results = yield* setup.run({
            worktreePath: ws.path,
            scripts,
            env: { COOLIE_ROOT: repoRoot, ...portEnv(ws.portBase) },
          })
          for (const r of results) yield* emit(ws.id, "workspace.setup.finished", r)
        }
        for (const hook of hooks) yield* hook(ws)
        const active = yield* repo.setStatus(ws.id, "active")
        yield* emit(ws.id, "workspace.created", { id: ws.id, branch: ws.branch, path: ws.path })
        return active
      })

    /** 失败回滚：删半成品 worktree（只走 git worktree remove --force + prune，绝不裸 rm；branch 保留）→ status=error */
    const rollbackToError = (ws: Workspace, repoRoot: string, cause: CreateError): Effect.Effect<never, CreateError> =>
      Effect.gen(function* () {
        yield* git.worktreeRemove(repoRoot, ws.path, { force: true }).pipe(Effect.ignore)
        yield* git.worktreePrune(repoRoot).pipe(Effect.ignore)
        yield* repo.setLastError(ws.id, { tag: cause._tag, message: cause.message }).pipe(Effect.ignore)
        yield* repo.setStatus(ws.id, "error").pipe(Effect.ignore)
        yield* emit(ws.id, "workspace.error", { id: ws.id, error: { tag: cause._tag, message: cause.message } }).pipe(Effect.ignore)
        return yield* Effect.fail(cause)
      })

    const create: WorkspaceLifecycleShape["create"] = (opts) =>
      Effect.gen(function* () {
        const project = yield* projects.get(opts.projectId)
        const existing = yield* repo.list({ projectId: project.id })
        const taken = new Set(existing.map((w) => w.name))
        const name = opts.name !== undefined ? sanitizeSlug(opts.name) : pickName(taken)
        if (name === "") return yield* new ValidationError({ message: "name 消毒后为空" })
        const slug = sanitizeSlug(opts.branchSlug ?? name)
        if (slug === "") return yield* new ValidationError({ message: "branchSlug 消毒后为空" })
        const branch = `coolie/${slug}`
        const wsPath = path.join(cfg.workspacesRoot, project.name, name)
        const portBase = allocatePortBase(yield* repo.usedPortBases())
        const ws = yield* repo.insertCreating({
          projectId: project.id, name, path: wsPath, branch,
          baseBranch: project.defaultBaseBranch, portBase,
        })
        yield* emit(ws.id, "workspace.creating", { id: ws.id, projectId: project.id, name, branch, path: wsPath, portBase })
        return yield* provision(ws, project.repoRoot).pipe(
          Effect.catchAll((e) => rollbackToError(ws, project.repoRoot, e)),
        )
      })

    const retry: WorkspaceLifecycleShape["retry"] = (id) =>
      Effect.gen(function* () {
        const ws0 = yield* repo.get(id)
        if (ws0.status !== "error")
          return yield* new ConflictError({ message: `只有 error 状态可重试（当前 ${ws0.status}）` })
        const project = yield* projects.get(ws0.projectId)
        const ws = yield* repo.setStatus(id, "creating")
        yield* emit(id, "workspace.creating", { id, retry: true, name: ws.name, branch: ws.branch, path: ws.path, portBase: ws.portBase })
        return yield* provision(ws, project.repoRoot).pipe(
          Effect.catchAll((e) => rollbackToError(ws, project.repoRoot, e)),
        )
      })

    return {
      create,
      retry,
      archive: () => Effect.die(new Error("archive 在 Task 8 实装")),
      unarchive: () => Effect.die(new Error("unarchive 在 Task 8 实装")),
      delete: () => Effect.die(new Error("delete 在 Task 8 实装")),
    }
  }),
)
```

- [ ] **Step 5: 确认通过** — Run: `bun run test -- packages/server` → lifecycle-create 全 PASS；`bun run typecheck` → 通过。

- [ ] **Step 6: Commit**

```bash
git add packages/server && git commit -m "feat(server): workspace create pipeline with rollback, retry and post-create hooks"
```

---

### Task 8: WorkspaceLifecycle——archive / unarchive / delete（脏树守卫）

**Files:**
- Modify: `packages/server/src/workspace/lifecycle.ts`（替换三个 stub）
- Test: `packages/server/test/lifecycle-archive.test.ts`

**Interfaces:**
- Consumes: Task 7 的全部（同文件）、`makeFakeGit`（Task 7 helper）
- Produces（Task 9/11/12 消费；签名已在 Task 7 的 Shape 定死）:
  - `archive(id, opts?: {force?})`：仅 active 可归档；worktree 存在（以 `git worktree list` 为真源）且脏 → 无 force 报 `ConflictError`（HTTP 层映射 409）；`git worktree remove [--force]` + prune → `status=archived`（archived_at 由 repo 写）→ **branch 一律保留** → 事件 `workspace.archived`
  - `unarchive(id)`：仅 archived；branch 不存在 → ConflictError；`git worktree add <path> <branch>` 重建（失败则清半成品、状态留 archived）→ `status=active` → 事件 `workspace.unarchived`。**刻意的 M1 决定（spec 未规定）：unarchive 不重复 `.worktreeinclude` 复制、不重跑 setup script**——它只恢复 branch 的干净 checkout；环境再置备走 Plan 3 的 setup/run 入口
  - `delete(id, opts?: {force?})`：任意状态可删（error/archived 无 worktree 时只 prune）；active 脏树规则同 archive；`git worktree remove` + prune → 删记录 → **branch 保留** → 事件 `workspace.deleted`

- [ ] **Step 1: 写失败测试**

`packages/server/test/lifecycle-archive.test.ts`（复用 Task 7 测试的 makeEnv 结构，独立成文避免共享可变状态）：

```ts
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
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server`
Expected: lifecycle-archive 全 FAIL（stub `Effect.die(new Error("… 在 Task 8 实装"))` 直接炸 defect）。

- [ ] **Step 3: 实现**

`packages/server/src/workspace/lifecycle.ts`：在 `retry` 定义之后、`return { ... }` 之前加入三个实现与两个内部 helper，并把 return 里的三个 stub 替换：

```ts
    /** worktree 是否仍在（以 git worktree list 为真源，而非 fs——目录可能被外力挪走） */
    const worktreePresent = (repoRoot: string, wsPath: string) =>
      git.worktreeList(repoRoot).pipe(
        Effect.map((wts) => wts.some((w) => path.resolve(w.path) === path.resolve(wsPath))),
      )

    /** archive/delete 共用：脏树守卫 + 唯一删除入口（git worktree remove）+ prune。不存在则只 prune。 */
    const removeWorktreeGuarded = (
      repoRoot: string, ws: Workspace, force: boolean, action: string,
    ): Effect.Effect<void, ConflictError | GitError> =>
      Effect.gen(function* () {
        if (!(yield* worktreePresent(repoRoot, ws.path))) {
          yield* git.worktreePrune(repoRoot)
          return
        }
        if (!force && (yield* git.isDirty(ws.path)))
          return yield* new ConflictError({ message: `worktree 有未提交改动，拒绝${action}；确认丢弃请带 force 重试` })
        yield* git.worktreeRemove(repoRoot, ws.path, { force })
        yield* git.worktreePrune(repoRoot)
      })

    const archive: WorkspaceLifecycleShape["archive"] = (id, opts) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(id)
        if (ws.status !== "active")
          return yield* new ConflictError({ message: `只能归档 active 的 workspace（当前 ${ws.status}）` })
        const project = yield* projects.get(ws.projectId)
        yield* removeWorktreeGuarded(project.repoRoot, ws, opts?.force === true, "归档")
        const out = yield* repo.setStatus(id, "archived")
        yield* emit(id, "workspace.archived", { id, force: opts?.force === true })
        return out
      })

    const unarchive: WorkspaceLifecycleShape["unarchive"] = (id) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(id)
        if (ws.status !== "archived")
          return yield* new ConflictError({ message: `只能恢复 archived 的 workspace（当前 ${ws.status}）` })
        const project = yield* projects.get(ws.projectId)
        if (!(yield* git.refExists(project.repoRoot, `refs/heads/${ws.branch}`)))
          return yield* new ConflictError({ message: `branch ${ws.branch} 已不存在，无法恢复` })
        // 与 provision 同款：fs 步骤走 typed error，失败留在可恢复的 archived 态而非 defect
        yield* Effect.try({
          try: () => fs.mkdirSync(path.dirname(ws.path), { recursive: true }),
          catch: (e) => new GitError({ op: "mkdir", message: `创建 worktree 父目录失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        yield* git.worktreePrune(project.repoRoot)
        yield* git.worktreeAddExisting(project.repoRoot, ws.path, ws.branch).pipe(
          // 失败清半成品（同回滚纪律），状态留 archived 可再试
          Effect.tapError(() => Effect.all([
            git.worktreeRemove(project.repoRoot, ws.path, { force: true }).pipe(Effect.ignore),
            git.worktreePrune(project.repoRoot).pipe(Effect.ignore),
          ])),
        )
        const out = yield* repo.setStatus(id, "active")
        yield* emit(id, "workspace.unarchived", { id })
        return out
      })

    const del: WorkspaceLifecycleShape["delete"] = (id, opts) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(id)
        const project = yield* projects.get(ws.projectId)
        yield* removeWorktreeGuarded(project.repoRoot, ws, opts?.force === true, "删除")
        yield* repo.remove(id)
        yield* emit(id, "workspace.deleted", { id, branch: ws.branch }) // branch 保留，事件记下名字便于追溯
      })
```

return 改为：

```ts
    return { create, retry, archive, unarchive, delete: del }
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → lifecycle-archive 与 lifecycle-create 全 PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): workspace archive/unarchive/delete with dirty-tree guard"
```

---

### Task 9: HTTP API——workspace 路由 + 错误映射 + main.ts 装配

**Files:**
- Modify: `packages/server/src/http/app.ts`（Runtime 扩宽、errorFromCause 补映射、新增路由）、`packages/server/src/main.ts`（appLayer 装配 lifecycle 链）、`packages/server/test/http.test.ts:20,101` 与 `packages/server/test/events.test.ts:48`（runtime 加 cast）
- Test: `packages/server/test/http-workspaces.test.ts`

**Interfaces:**
- Consumes: `WorkspaceLifecycle/WorkspacesRepo`（Task 7/8）、`makeFakeGit`（Task 7）、Plan 1 的 `createApp/errorFromCause/runRoute`
- Produces（Task 10/12 消费）:
  - `export type AppServices = ProjectsRepo | EventsRepo | WorkspacesRepo | WorkspaceLifecycle`；`export type Runtime = <A, E>(eff: Effect.Effect<A, E, AppServices>) => Promise<Exit.Exit<A, E>>`（原私有 type 提升导出，供 sse.ts/main.ts 用）
  - 错误映射新增：`GitError → 500 {code:"GitError"}`、`SetupScriptError → 500 {code:"SetupScriptError"}`、`HookError → 500 {code:"Internal"}`（脏树/非法迁移在 lifecycle 层已是 ConflictError → 409，天然携带"加 force 重试"语义）
  - HTTP 契约：
    - `GET /workspaces?project=<id>` → 200 Workspace[]
    - `POST /workspaces {projectId, branchSlug?, name?}` → **同步跑完流水线**；成功 201 Workspace(active)；失败对应错误信封且行留 error（可 GET 看到、可 retry）
    - `POST /workspaces/:id/archive {force?}` → 200 Workspace(archived) / 409
    - `POST /workspaces/:id/unarchive` → 200 Workspace(active)
    - `POST /workspaces/:id/retry` → 200 Workspace(active) / 错误信封（行留 error）
    - `DELETE /workspaces/:id?force=1` → 204 / 409
  - workspace 事件由 lifecycle 落库（HTTP 层不再 emitThenRespond）

- [ ] **Step 1: 写失败测试**

`packages/server/test/http-workspaces.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { GitService } from "../src/git/service.js"
import { SetupRunner, SetupScriptError, type SetupRunnerShape } from "../src/workspace/setup.js"
import { WorkspaceLifecycleLive, PostCreateHooksEmpty } from "../src/workspace/lifecycle.js"
import { createApp, newToken } from "../src/http/app.js"
import { makeFakeGit } from "./helpers/fake-git.js"

let server: http.Server, base: string, token: string
let fake: ReturnType<typeof makeFakeGit>
let setupFails = false
let repoRoot: string

beforeEach(async () => {
  const db = new Database(":memory:"); runMigrations(db)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hw-home-"))
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hw-ws-"))
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hw-repo-"))
  fs.mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true })
  const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: wsRoot }
  fake = makeFakeGit()
  setupFails = false
  const setup: SetupRunnerShape = {
    run: () => setupFails
      ? Effect.fail(new SetupScriptError({ script: "fake.sh", exitCode: 1, message: "setup 退出码 1", outputTail: "boom" }))
      : Effect.succeed([]),
  }
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
  token = newToken()
  const app = createApp({
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => server.close())

const req = (p: string, init: RequestInit = {}) =>
  fetch(base + p, { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })
const addProject = async (): Promise<string> => {
  const r = await req("/projects", { method: "POST", body: JSON.stringify({ repoRoot }) })
  expect(r.status).toBe(201)
  return (await r.json()).id
}
const createWs = async (projectId: string, extra: Record<string, unknown> = {}) =>
  req("/workspaces", { method: "POST", body: JSON.stringify({ projectId, ...extra }) })

describe("workspace HTTP API", () => {
  it("POST /workspaces -> 201 active; GET /workspaces lists and filters", async () => {
    const pid = await addProject()
    const created = await createWs(pid, { branchSlug: "fix-x" })
    expect(created.status).toBe(201)
    const ws = await created.json()
    expect(ws.status).toBe("active")
    expect(ws.branch).toBe("coolie/fix-x")
    const list = await (await req("/workspaces")).json()
    expect(list.map((w: any) => w.id)).toContain(ws.id)
    const filtered = await (await req(`/workspaces?project=${pid}`)).json()
    expect(filtered).toHaveLength(1)
    const empty = await (await req("/workspaces?project=nope")).json()
    expect(empty).toHaveLength(0)
  })
  it("validation: missing projectId -> 400; unknown project -> 404", async () => {
    const bad = await req("/workspaces", { method: "POST", body: JSON.stringify({}) })
    expect(bad.status).toBe(400)
    const missing = await createWs("nope")
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe("NotFound")
  })
  it("archive: dirty -> 409 Conflict; force -> 200 archived; unarchive -> 200 active", async () => {
    const pid = await addProject()
    const ws = await (await createWs(pid)).json()
    fake.state.dirty.add(ws.path)
    const refused = await req(`/workspaces/${ws.id}/archive`, { method: "POST", body: JSON.stringify({}) })
    expect(refused.status).toBe(409)
    expect((await refused.json()).code).toBe("Conflict")
    const forced = await req(`/workspaces/${ws.id}/archive`, { method: "POST", body: JSON.stringify({ force: true }) })
    expect(forced.status).toBe(200)
    expect((await forced.json()).status).toBe("archived")
    const back = await req(`/workspaces/${ws.id}/unarchive`, { method: "POST", body: JSON.stringify({}) })
    expect(back.status).toBe(200)
    expect((await back.json()).status).toBe("active")
  })
  it("DELETE: dirty -> 409; ?force=1 -> 204 and row gone", async () => {
    const pid = await addProject()
    const ws = await (await createWs(pid)).json()
    fake.state.dirty.add(ws.path)
    expect((await req(`/workspaces/${ws.id}`, { method: "DELETE" })).status).toBe(409)
    expect((await req(`/workspaces/${ws.id}?force=1`, { method: "DELETE" })).status).toBe(204)
    const list = await (await req("/workspaces")).json()
    expect(list).toHaveLength(0)
  })
  it("setup failure -> 500 SetupScriptError, row stays error; retry -> 200 active", async () => {
    const pid = await addProject()
    fs.mkdirSync(path.join(repoRoot, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, ".coolie", "setup.local.sh"), "#!/bin/bash\nexit 1\n")
    setupFails = true
    const failed = await createWs(pid, { branchSlug: "broken" })
    expect(failed.status).toBe(500)
    expect((await failed.json()).code).toBe("SetupScriptError")
    const list = await (await req("/workspaces")).json()
    expect(list[0].status).toBe("error")
    setupFails = false
    const retried = await req(`/workspaces/${list[0].id}/retry`, { method: "POST", body: JSON.stringify({}) })
    expect(retried.status).toBe(200)
    expect((await retried.json()).status).toBe("active")
  })
  it("lifecycle events are visible via GET /events", async () => {
    const pid = await addProject()
    await createWs(pid)
    const events = await (await req("/events?after=0")).json()
    const types = events.map((e: any) => e.type)
    expect(types).toContain("workspace.creating")
    expect(types).toContain("workspace.created")
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server` → http-workspaces 全 FAIL（路由 404）。

- [ ] **Step 3: 实现**

`packages/server/src/http/app.ts` 修改点：

1. imports 增加：

```ts
import { WorkspacesRepo } from "../repo/workspaces.js"
import { WorkspaceLifecycle } from "../workspace/lifecycle.js"
```

2. Runtime 类型扩宽并导出（替换原 `type Runtime = ...` 一行）：

```ts
export type AppServices = ProjectsRepo | EventsRepo | WorkspacesRepo | WorkspaceLifecycle
export type Runtime = <A, E>(eff: Effect.Effect<A, E, AppServices>) => Promise<Exit.Exit<A, E>>
```

同时把 `runRoute` 的参数类型 `Effect.Effect<A, E, ProjectsRepo | EventsRepo>` 改为 `Effect.Effect<A, E, AppServices>`。

3. `errorFromCause` 在 `NotFoundError` 分支后追加：

```ts
    if (e._tag === "GitError") return { status: 500, body: { code: "GitError", message } }
    if (e._tag === "SetupScriptError") return { status: 500, body: { code: "SetupScriptError", message } }
    if (e._tag === "HookError") return { status: 500, body: { code: "Internal", message } }
```

4. 路由：在 `const del = url.pathname.match(/^\/projects\/...)` 之前插入：

```ts
        if (route === "GET /workspaces") {
          const project = url.searchParams.get("project")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspacesRepo).list(project ? { projectId: project } : {})
            }),
            (list) => send(res, 200, list),
            onError,
          )
        }
        if (route === "POST /workspaces") {
          const body = await readJson(req)
          if (typeof body.projectId !== "string") return err(res, 400, "Validation", "projectId required")
          if (body.branchSlug !== undefined && typeof body.branchSlug !== "string")
            return err(res, 400, "Validation", "branchSlug must be a string")
          if (body.name !== undefined && typeof body.name !== "string")
            return err(res, 400, "Validation", "name must be a string")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              return yield* (yield* WorkspaceLifecycle).create({
                projectId: body.projectId,
                ...(body.branchSlug ? { branchSlug: body.branchSlug } : {}),
                ...(body.name ? { name: body.name } : {}),
              })
            }),
            (ws) => send(res, 201, ws),
            onError,
          )
        }
        const wsAction = url.pathname.match(/^\/workspaces\/([^/]+)\/(archive|unarchive|retry)$/)
        if (req.method === "POST" && wsAction) {
          const id = wsAction[1]!
          const action = wsAction[2]!
          const body = await readJson(req)
          const force = body.force === true
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const lc = yield* WorkspaceLifecycle
              if (action === "archive") return yield* lc.archive(id, { force })
              if (action === "unarchive") return yield* lc.unarchive(id)
              return yield* lc.retry(id)
            }),
            (ws) => send(res, 200, ws),
            onError,
          )
        }
        const wsDel = url.pathname.match(/^\/workspaces\/([^/]+)$/)
        if (req.method === "DELETE" && wsDel) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              yield* (yield* WorkspaceLifecycle).delete(wsDel[1]!, { force: url.searchParams.get("force") === "1" })
            }),
            () => send(res, 204),
            onError,
          )
        }
```

5. 既有测试适配（Runtime 扩宽后，只提供 `ProjectsRepo|EventsRepo` 的 layer 需要 cast——这些用例只打 project/event 路由，运行时安全）：

`packages/server/test/http.test.ts` 第 20 行与第 101 行、`packages/server/test/events.test.ts` 第 48 行，统一改为：

```ts
    runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>),
```

（events.test.ts 里局部变量名是 `l`，对应改 `Effect.provide(eff, l)`。）

6. `packages/server/src/main.ts` 的 `cmdStart`：imports 增加

```ts
import { WorkspacesRepoLive } from "./repo/workspaces.js"
import { WorkspaceLifecycleLive, PostCreateHooksEmpty } from "./workspace/lifecycle.js"
import { GitServiceLive } from "./git/service.js"
import { makeSetupRunnerLive } from "./workspace/setup.js"
import type { AppServices } from "./http/app.js"
```

appLayer 与 runtime 替换为（原 `const appLayer = Layer.mergeAll(...)` 到 `const runtime = ...` 整段）：

```ts
  const appLayer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive,
      makeSetupRunnerLive((chunk) => logger.info(`setup: ${chunk.trimEnd()}`)),
      PostCreateHooksEmpty,
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
    Layer.provideMerge(DbLive),
    Layer.provideMerge(CoolieConfigLive),
  )
  const runtimeCtx = await Effect.runPromise(Layer.buildWithScope(appLayer, scope))
  const runtime = <A, E>(eff: Effect.Effect<A, E, AppServices>) =>
    Effect.runPromiseExit(Effect.provide(eff, runtimeCtx) as Effect.Effect<A, E, never>)
```

（`Layer.provideMerge` 单链构建：所有 service 同一实例、共享同一个 Db，避免 Layer 重复实例化。runtime 泛型改用 `AppServices` 后，原 import 行里的 `ProjectsRepo` 与 `EventsRepo` 类型引用都不再被使用，一并移除。）

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → 全 PASS（含 Plan 1 的 http/events/daemon 旧用例）；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): workspace HTTP API with GitError/SetupScriptError mapping"
```

---

### Task 10: SSE——GET /events/stream（durable replay + live 推送 + 心跳）

**Files:**
- Create: `packages/server/src/events/bus.ts`, `packages/server/src/http/sse.ts`
- Modify: `packages/server/src/repo/events.ts`（append 时广播，EventsBus 为**可选**依赖）、`packages/server/src/http/app.ts`（AppDeps 加 `bus?`/`sseHeartbeatMs?` + 路由分发）、`packages/server/src/main.ts`（建 bus 并接入 layer 与 createApp）
- Test: `packages/server/test/sse.test.ts`

**Interfaces:**
- Consumes: `EventsRepo.listAfter`（Plan 1）、`CoolieEvent`（protocol）、`Runtime`（Task 9 导出）
- Produces:
  - `EventsBus`（Context.Tag，值为 Node `EventEmitter`）+ `EventsBusLive` + `EVENT_CHANNEL = "event"`
  - `EventsRepoLive` 行为增强：**通过 `Effect.serviceOption(EventsBus)` 可选读取**——layer 组合里提供了 bus 就在 append 落库后 `bus.emit(EVENT_CHANNEL, CoolieEvent)`；没提供则行为与 Plan 1 完全一致（**既有测试零改动**）
  - `handleEventsStream(req, res, deps: { runtime; bus; heartbeatMs? }, opts: { after; workspaceId? }): Promise<void>`
  - SSE 线格式：`:ok` 起始注释 → 每事件 `id: <seq>\ndata: <CoolieEvent JSON>\n\n` → 心跳注释 `:hb`（默认 15s）；`?after=<seq>` 从 events 表回放（durable，批 200 直到追平），随后 live 推送；`?workspace=` 过滤；**先订阅后回放 + seq 守卫**保证不丢不重；客户端断开时清理 listener 与心跳 timer
  - 设计文档 §2.3：M1 只做这一个 durable 通道；live-only 通道 M2

- [ ] **Step 1: 写失败测试**

`packages/server/test/sse.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import { EventEmitter } from "node:events"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { EventsBus } from "../src/events/bus.js"
import { createApp, newToken } from "../src/http/app.js"

let server: http.Server, base: string, token: string, bus: EventEmitter
let append: (workspaceId: string | null, type: string) => Promise<unknown>

beforeEach(async () => {
  const db = new Database(":memory:"); runMigrations(db)
  bus = new EventEmitter()
  const layer = EventsRepoLive.pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(EventsBus, bus))),
  )
  const runtime = (eff: Effect.Effect<any, any, any>) =>
    Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>)
  append = (workspaceId, type) =>
    runtime(Effect.gen(function* () {
      return yield* (yield* EventsRepo).append({ workspaceId, type, payload: { t: type } })
    }))
  token = newToken()
  const app = createApp({
    runtime, token, onShutdown: () => {},
    bus, sseHeartbeatMs: 60,
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => server.close())

const connect = async (qs: string, ac: AbortController) => {
  const res = await fetch(`${base}/events/stream${qs}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: ac.signal,
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  return res.body!.getReader()
}
const readUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>, pred: (buf: string) => boolean, timeoutMs = 5000,
): Promise<string> => {
  let buf = ""
  const t0 = Date.now()
  const dec = new TextDecoder()
  while (!pred(buf)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`SSE read timeout; got: ${JSON.stringify(buf)}`)
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value)
  }
  return buf
}
// 容忍半截 chunk：最后一行可能是被截断的 data 行，parse 失败就先跳过（下一轮读齐再算）
const dataEvents = (buf: string): any[] =>
  buf.split("\n").filter((l) => l.startsWith("data: ")).flatMap((l) => {
    try { return [JSON.parse(l.slice(6))] } catch { return [] }
  })

describe("GET /events/stream", () => {
  it("requires a token", async () => {
    const r = await fetch(`${base}/events/stream?after=0`)
    expect(r.status).toBe(401)
  })
  it("replays history from ?after= then pushes live events", async () => {
    await append("w1", "workspace.creating") // 连接前：走 replay
    const ac = new AbortController()
    const reader = await connect("?after=0", ac)
    let buf = await readUntil(reader, (b) => dataEvents(b).length >= 1)
    expect(dataEvents(buf)[0].type).toBe("workspace.creating")
    await append("w1", "workspace.created") // 连接后：走 live
    buf += await readUntil(reader, (b) => dataEvents(buf + b).length >= 2)
    const all = dataEvents(buf)
    expect(all.map((e) => e.type)).toEqual(["workspace.creating", "workspace.created"])
    expect(all[1].seq).toBeGreaterThan(all[0].seq)
    ac.abort()
  })
  it("filters by ?workspace=", async () => {
    await append("w1", "a.w1")
    await append("w2", "b.w2")
    const ac = new AbortController()
    const reader = await connect("?after=0&workspace=w2", ac)
    const buf = await readUntil(reader, (b) => dataEvents(b).length >= 1)
    const all = dataEvents(buf)
    expect(all).toHaveLength(1)
    expect(all[0].type).toBe("b.w2")
    ac.abort()
  })
  it("sends heartbeat comments", async () => {
    const ac = new AbortController()
    const reader = await connect("?after=0", ac)
    const buf = await readUntil(reader, (b) => b.includes(":hb"))
    expect(buf).toContain(":hb")
    ac.abort()
  })
  it("cleans up bus listener on disconnect", async () => {
    const ac = new AbortController()
    const reader = await connect("?after=0", ac)
    await readUntil(reader, (b) => b.includes(":ok"))
    expect(bus.listenerCount("event")).toBe(1)
    ac.abort()
    await new Promise((r) => setTimeout(r, 100))
    expect(bus.listenerCount("event")).toBe(0)
  })
})
```

注：`sseHeartbeatMs: 60` 一箭双雕——除了心跳用例本身，filter 用例也靠它周期性给流上喂字节、让 `readUntil` 的 read 不至于干等挂到超时。实现完成后**不要**把它当"测试加速器"顺手删掉。

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server` → sse 全 FAIL（`../src/events/bus.js` 不存在）。

- [ ] **Step 3: 实现**

`packages/server/src/events/bus.ts`：

```ts
import { EventEmitter } from "node:events"
import { Context, Layer } from "effect"

/** 进程内事件总线：EventsRepo.append 落库后在此广播，SSE 在线连接订阅（设计文档 §2.3 live 侧）。 */
export class EventsBus extends Context.Tag("EventsBus")<EventsBus, EventEmitter>() {}
export const EventsBusLive = Layer.sync(EventsBus, () => new EventEmitter())
export const EVENT_CHANNEL = "event"
```

`packages/server/src/repo/events.ts` 整文件替换为：

```ts
import { Context, Effect, Layer, Option } from "effect"
import type { CoolieEvent } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"

export interface EventsRepoShape {
  readonly append: (e: { workspaceId: string | null; type: string; payload: unknown }) => Effect.Effect<number>
  readonly listAfter: (opts: { after: number; limit?: number; workspaceId?: string }) => Effect.Effect<CoolieEvent[]>
}
export class EventsRepo extends Context.Tag("EventsRepo")<EventsRepo, EventsRepoShape>() {}

export const EventsRepoLive = Layer.effect(
  EventsRepo,
  Effect.gen(function* () {
    const db = yield* Db
    // EventsBus 是可选依赖（serviceOption 不产生新的 R 需求）：
    // 组合里提供了就广播 live 事件，没提供（Plan 1 的既有测试）行为不变。
    const bus = yield* Effect.serviceOption(EventsBus)
    return {
      append: (e) => Effect.sync(() => {
        const ts = Date.now()
        const res = db
          .prepare("INSERT INTO events (workspace_id, type, payload, ts) VALUES (?,?,?,?)")
          .run(e.workspaceId, e.type, JSON.stringify(e.payload ?? null), ts)
        const seq = Number(res.lastInsertRowid)
        if (Option.isSome(bus)) {
          bus.value.emit(EVENT_CHANNEL, {
            seq, workspaceId: e.workspaceId, type: e.type, payload: e.payload ?? null, ts,
          } satisfies CoolieEvent)
        }
        return seq
      }),
      listAfter: ({ after, limit = 200, workspaceId }) => Effect.sync(() => {
        const rows = workspaceId
          ? db.prepare("SELECT * FROM events WHERE seq > ? AND workspace_id = ? ORDER BY seq LIMIT ?").all(after, workspaceId, limit)
          : db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit)
        return rows.map((r: any) => ({
          seq: r.seq, workspaceId: r.workspace_id, type: r.type,
          payload: JSON.parse(r.payload), ts: r.ts,
        }))
      }),
    }
  }),
)
```

`packages/server/src/http/sse.ts`：

```ts
import type { IncomingMessage, ServerResponse } from "node:http"
import type { EventEmitter } from "node:events"
import { Effect, Exit } from "effect"
import type { CoolieEvent } from "@coolie/protocol"
import { EventsRepo } from "../repo/events.js"
import { EVENT_CHANNEL } from "../events/bus.js"
import type { Runtime } from "./app.js"

export interface SseDeps {
  readonly runtime: Runtime
  readonly bus: EventEmitter
  readonly heartbeatMs?: number
}

/**
 * durable SSE（设计文档 §2.3）：先订阅 bus（live 进队列），再从 events 表回放到追平，
 * 然后排空队列进入直推。seq 守卫（只发 > lastSent）保证回放与 live 交界处不丢不重。
 */
export const handleEventsStream = async (
  req: IncomingMessage,
  res: ServerResponse,
  deps: SseDeps,
  opts: { readonly after: number; readonly workspaceId?: string },
): Promise<void> => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.write(":ok\n\n")

  let lastSent = opts.after
  const writeEvent = (e: CoolieEvent): void => {
    // destroyed 也要挡：客户端 abort 时 destroyed=true 而 writableEnded 仍是 false，
    // 只查 writableEnded 会往已销毁的流上写，抛 ERR_STREAM_DESTROYED
    if (res.destroyed || res.writableEnded) return
    if (e.seq <= lastSent) return
    if (opts.workspaceId && e.workspaceId !== opts.workspaceId) return
    lastSent = e.seq
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
  }

  const queue: CoolieEvent[] = []
  let replaying = true
  const onLive = (e: CoolieEvent): void => {
    if (replaying) queue.push(e)
    else writeEvent(e)
  }
  deps.bus.on(EVENT_CHANNEL, onLive)

  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(":hb\n\n")
  }, deps.heartbeatMs ?? 15_000)
  const cleanup = (): void => {
    clearInterval(heartbeat)
    deps.bus.off(EVENT_CHANNEL, onLive)
  }
  req.on("close", cleanup)
  // 心跳/live emit 与 close 处理器竞态时的残余写入会在 res 上发 'error'——
  // 吞掉，防 unhandled 'error' 事件打死 daemon
  res.on("error", () => {})

  let cursor = opts.after
  for (;;) {
    const exit = await deps.runtime(Effect.gen(function* () {
      return yield* (yield* EventsRepo).listAfter({
        after: cursor, limit: 200,
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      })
    }))
    if (Exit.isFailure(exit)) { cleanup(); res.end(); return }
    const batch = exit.value
    for (const e of batch) writeEvent(e)
    if (batch.length < 200) break
    cursor = batch[batch.length - 1]!.seq
  }
  replaying = false
  for (const e of queue.splice(0)) writeEvent(e)
}
```

`packages/server/src/http/app.ts` 修改点：

1. imports 增加：

```ts
import type { EventEmitter } from "node:events"
import { handleEventsStream } from "./sse.js"
```

2. `AppDeps` 增加两个可选字段：

```ts
  /** SSE live 推送用的进程内事件总线；未提供时 /events/stream 返回 500 */
  readonly bus?: EventEmitter
  /** SSE 心跳间隔（测试注入用），默认 15s */
  readonly sseHeartbeatMs?: number
```

`createApp` 解构加上 `bus, sseHeartbeatMs`。

3. 路由（放在 `GET /events` 分支之前——`/events/stream` 更长，先匹配防吞）：

```ts
        if (route === "GET /events/stream") {
          if (!bus) return err(res, 500, "Internal", "event bus unavailable")
          const after = Number(url.searchParams.get("after") ?? "0")
          const ws = url.searchParams.get("workspace")
          return await handleEventsStream(req, res,
            { runtime, bus, ...(sseHeartbeatMs !== undefined ? { heartbeatMs: sseHeartbeatMs } : {}) },
            { after, ...(ws ? { workspaceId: ws } : {}) })
        }
```

（既有精确匹配 `route === "GET /events"` 不会命中 `/events/stream`，顺序只是防御性约定。）

4. `packages/server/src/main.ts`：imports 增加

```ts
import { EventEmitter } from "node:events"
import { EventsBus } from "./events/bus.js"
```

`cmdStart` 里 appLayer 之前建 bus，并把 bus 注入 layer 链与 createApp：

```ts
  const bus = new EventEmitter()
```

appLayer 链在 repos 之后插一层（Task 9 的链基础上）：

```ts
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
    Layer.provideMerge(Layer.succeed(EventsBus, bus)),
    Layer.provideMerge(DbLive),
```

createApp 调用加 `bus`：

```ts
  const server = http.createServer(createApp({
    runtime, token, bus, onShutdown: () => void shutdown(),
    onError: (e) => logger.error("http 500", e),
  }))
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → sse 5 用例 PASS，且 Plan 1 的 events/http 旧用例不改仍绿（bus 可选依赖生效）。`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): SSE /events/stream with durable replay, live push and heartbeat"
```

---

### Task 11: 集成测试——真 git repo 全状态机 + 失败回滚

**Files:**
- Test: `packages/server/test/integration-lifecycle.test.ts`（纯测试任务：把 Task 3-10 的真实现串起来对真 git 仓库验收）

**Interfaces:**
- Consumes: `GitServiceLive`、`SetupRunnerLive`、`WorkspaceLifecycleLive`、`PostCreateHooksEmpty`、三个 RepoLive、`DbLive`、`CoolieConfigLive`（env 驱动）
- Produces: 设计文档 §四 的可执行验收：create→active→archive→unarchive→delete 全链 + setup `exit 1` 回滚 + retry + 脏树守卫 + branch 保留 + 端口/命名不冲突

- [ ] **Step 1: 写失败测试（先写就是全量验收，当前会因环境未就绪而红——本任务无新实现，红→绿靠修实现里被真 git 暴露的问题）**

`packages/server/test/integration-lifecycle.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { execFileSync } from "node:child_process"
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

let home: string, wsRoot: string, upstream: string, repoRoot: string
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
  const parent = mkdir("coolie-int-parent-")
  repoRoot = path.join(parent, "repo")
  execFileSync("git", ["clone", upstream, repoRoot], { encoding: "utf8" })
  sh(repoRoot, "git", "config", "user.email", "t@t")
  sh(repoRoot, "git", "config", "user.name", "t")
  fs.writeFileSync(path.join(repoRoot, ".env"), "SECRET=42\n") // gitignored，等待被复制
})
afterAll(() => {
  delete process.env.COOLIE_HOME
  delete process.env.COOLIE_WORKSPACES_ROOT
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
    for (const t of ["workspace.creating", "workspace.setup.started", "workspace.setup.finished", "workspace.created"])
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
```

- [ ] **Step 2: 跑测试（RED→GREEN）** — Run: `bun run test -- packages/server/test/integration-lifecycle.test.ts`
Expected: 首跑若有失败，全部属于实现被真 git 暴露的缺陷（如 pathspec 行为、worktree 路径解析），按失败信息修 `src/`（行为契约=本测试断言，不改断言）。修至 5 用例全 PASS。

- [ ] **Step 3: 全量回归** — Run: `bun run test && bun run typecheck` → 全绿。

- [ ] **Step 4: Commit**

```bash
git add packages/server && git commit -m "test(server): real-git integration for workspace state machine + rollback"
```

---

### Task 12: CLI——create / list / archive / unarchive / delete

**Files:**
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/workspace-e2e.test.ts`

**Interfaces:**
- Consumes: `api()`（Plan 1 client.ts，自动拉起 server）、Task 9 的 HTTP 契约
- Produces（用户可见 CLI 面，设计文档 §八的 workspace 子集）:
  - `coolie create <projectId|repoPath> [--slug <s>] [--name <n>]` — 参数是存在的目录时按 repoPath 处理：先在 `GET /projects` 里按绝对路径找，找不到自动 `POST /projects` 注册；成功打印单行 `created <name> (<id>) branch=<branch> path=<path>`
  - `coolie list` — 每行 `<id>\t<name>\t<status>\t<branch>\t<path>`
  - `coolie archive <wsId> [--force]` → `archived <id>`；脏树无 --force 时 stderr 显示 409 信息、exit 1
  - `coolie unarchive <wsId>` → `unarchived <id>`
  - `coolie delete <wsId> [--force]` → `deleted <id>`
  - `coolie export workspaces`（Plan 1 已有）对新数据自然生效，无需改动

- [ ] **Step 1: 写失败测试**

`packages/cli/test/workspace-e2e.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
let home: string, wsRoot: string, repo: string
let wsId: string, wsPath: string

const coolie = (...args: string[]) =>
  execFileSync(TSX, [CLI, ...args], {
    env: { ...process.env, COOLIE_HOME: home, COOLIE_WORKSPACES_ROOT: wsRoot },
    encoding: "utf8",
  })
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-we2e-home-")))
  wsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-we2e-ws-")))
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-we2e-repo-")))
  sh(repo, "init", "-b", "main")
  sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t")
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n")
  sh(repo, "add", "-A"); sh(repo, "commit", "-m", "init")
})
afterAll(() => { try { coolie("server", "stop") } catch {} })

describe("coolie workspace commands e2e", () => {
  it("create by repo path auto-registers the project and prints the workspace line", () => {
    const out = coolie("create", repo, "--slug", "cli-e2e")
    const m = out.match(/^created (\S+) \((\S+)\) branch=coolie\/cli-e2e path=(.+)$/m)
    expect(m).not.toBeNull()
    wsId = m![2]!
    wsPath = m![3]!
    expect(fs.existsSync(path.join(wsPath, "README.md"))).toBe(true)
    expect(coolie("list")).toContain(`${wsId}\t`)
    expect(coolie("list")).toContain("active")
  }, 60_000)
  it("archive removes the worktree dir, keeps the branch", () => {
    expect(coolie("archive", wsId)).toContain(`archived ${wsId}`)
    expect(fs.existsSync(wsPath)).toBe(false)
    expect(coolie("list")).toContain("archived")
    expect(sh(repo, "rev-parse", "--verify", "refs/heads/coolie/cli-e2e").trim()).toMatch(/^[0-9a-f]{40}$/)
  }, 30_000)
  it("unarchive rebuilds the worktree", () => {
    expect(coolie("unarchive", wsId)).toContain(`unarchived ${wsId}`)
    expect(fs.existsSync(path.join(wsPath, "README.md"))).toBe(true)
    expect(coolie("list")).toContain("active")
  }, 30_000)
  it("delete refuses a dirty tree without --force, succeeds with it; branch survives", () => {
    fs.writeFileSync(path.join(wsPath, "junk.txt"), "x") // untracked → 脏
    expect(() => coolie("delete", wsId)).toThrow() // exit 1（409 Conflict）
    expect(coolie("delete", wsId, "--force")).toContain(`deleted ${wsId}`)
    expect(coolie("list")).not.toContain(wsId)
    expect(sh(repo, "rev-parse", "--verify", "refs/heads/coolie/cli-e2e").trim()).toMatch(/^[0-9a-f]{40}$/)
  }, 30_000)
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/cli`
Expected: workspace-e2e FAIL（`error: unknown command 'create'`），Plan 1 的 cli-e2e/export-doctor 仍绿。

- [ ] **Step 3: 实现**

`packages/cli/src/main.ts` 在 `const server = program.command("server")` 之前插入：

```ts
// ---------- workspace lifecycle（Plan 2） ----------
program.command("create")
  .argument("<projectIdOrPath>", "项目 id，或 git 仓库路径（未注册时自动注册）")
  .option("--slug <slug>", "branch 语义名（branch = coolie/<slug>；缺省用目录名）")
  .option("--name <name>", "指定目录名（缺省从 national-parks 名池取）")
  .action(async (arg: string, opts: { slug?: string; name?: string }) => {
    try {
      let projectId = arg
      if (fs.existsSync(arg)) {
        const abs = path.resolve(arg)
        const projects: any[] = await api("GET", "/projects")
        let p = projects.find((x) => x.repoRoot === abs)
        if (!p) p = await api("POST", "/projects", { repoRoot: abs })
        projectId = p.id
      }
      const ws = await api("POST", "/workspaces", {
        projectId,
        ...(opts.slug ? { branchSlug: opts.slug } : {}),
        ...(opts.name ? { name: opts.name } : {}),
      })
      console.log(`created ${ws.name} (${ws.id}) branch=${ws.branch} path=${ws.path}`)
    } catch (e) { fail(e) }
  })

program.command("list").action(async () => {
  try {
    for (const w of await api("GET", "/workspaces"))
      console.log(`${w.id}\t${w.name}\t${w.status}\t${w.branch}\t${w.path}`)
  } catch (e) { fail(e) }
})

program.command("archive <wsId>")
  .option("--force", "脏树也归档（丢弃未提交改动）")
  .action(async (id: string, opts: { force?: boolean }) => {
    try { await api("POST", `/workspaces/${id}/archive`, { force: !!opts.force }); console.log(`archived ${id}`) }
    catch (e) { fail(e) }
  })

program.command("unarchive <wsId>").action(async (id: string) => {
  try { await api("POST", `/workspaces/${id}/unarchive`, {}); console.log(`unarchived ${id}`) }
  catch (e) { fail(e) }
})

program.command("delete <wsId>")
  .option("--force", "脏树也删（丢弃未提交改动）")
  .action(async (id: string, opts: { force?: boolean }) => {
    try { await api("DELETE", `/workspaces/${id}${opts.force ? "?force=1" : ""}`); console.log(`deleted ${id}`) }
    catch (e) { fail(e) }
  })
```

（`fs`/`path`/`api`/`fail` 均已在文件顶部 import/定义，无需新增 import。）

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/cli` → 全 PASS（含 Plan 1 旧用例）；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/cli && git commit -m "feat(cli): workspace commands (create/list/archive/unarchive/delete)"
```

---

### Task 13: 收尾——README 试用段 + 全量回归

**Files:**
- Modify: `README.md`（追加 workspace 命令段）

**Interfaces:**
- Produces: 新人照 README 能跑通 workspace 全生命周期；Plan 3 的执行者知道从 `PostCreateHooks` 接入。

- [ ] **Step 1: README 追加**

在 `## 试用（Plan 1 阶段能力）` 小节之后插入：

````markdown
## Workspace 生命周期（Plan 2 阶段能力）

```bash
# 创建（repo 路径未注册时自动注册项目；--slug 决定 branch 名 coolie/<slug>）
bun x tsx packages/cli/src/main.ts create ~/some/git/repo --slug fix-login
bun x tsx packages/cli/src/main.ts list                 # id/name/status/branch/path
bun x tsx packages/cli/src/main.ts archive <wsId>       # 删 worktree、留 branch（脏树需 --force）
bun x tsx packages/cli/src/main.ts unarchive <wsId>     # 从保留的 branch 重建
bun x tsx packages/cli/src/main.ts delete <wsId> --force # 删 worktree+记录，branch 永远保留
```

- worktree 落在 `~/coolie/workspaces/<repo>/<园名>`（`COOLIE_WORKSPACES_ROOT` 可覆盖）；目录名取自 national-parks 名池，生成后不变。
- 每个 workspace 分配 10 个端口（`$COOLIE_PORT_0..9`，40000 起步），setup script 可直接使用。
- setup script 三层合并：repo `.coolie/setup.sh`（可提交）→ `~/.coolie/projects/<projectId>/setup.sh`（本机覆盖）→ repo `.coolie/setup.local.sh`（本地 overlay，不入库）。
- gitignored 文件按 repo 根 `.worktreeinclude`（gitignore 语法，缺省 `.env*`）带入新 worktree。
- 创建失败自动回滚（不留半成品 worktree），workspace 落 `error` 态，可 `POST /workspaces/:id/retry` 重试。

### 事件流（SSE）

```bash
INFO=~/.coolie/server.json
curl -N -H "Authorization: Bearer $(jq -r .token $INFO)" \
  "http://127.0.0.1:$(jq -r .port $INFO)/events/stream?after=0"
# durable 回放 + live 推送；?workspace=<id> 过滤；15s 心跳注释行
```
````

- [ ] **Step 2: 全量回归**

Run: `bun install && bun run typecheck && bun run test`
Expected: 三包全绿（protocol/server/cli，含集成与 e2e）。

再手工冒烟（隔离 HOME，绝不碰真实 `~/.coolie`）：

```bash
export COOLIE_HOME=/tmp/coolie-manual COOLIE_WORKSPACES_ROOT=/tmp/coolie-manual-ws
bun x tsx packages/cli/src/main.ts create <某个真实 git repo 路径> --slug smoke
bun x tsx packages/cli/src/main.ts list
bun x tsx packages/cli/src/main.ts export events --format table   # 看到 workspace.creating/created
bun x tsx packages/cli/src/main.ts delete <wsId> && bun x tsx packages/cli/src/main.ts server stop
```

确认输出符合 Task 12 契约、`git -C <repo> branch` 里 `coolie/smoke` 保留。

- [ ] **Step 3: Commit**

```bash
git add README.md && git commit -m "docs: README workspace lifecycle + SSE usage (plan 2 scope)"
```

---

## Self-Review 记录

1. **Spec 覆盖（Plan 2 范围内）**：
   - §四 lifecycle 四项：create 全流水线（fetch→prune→worktree add --no-track -b→branch.base→info/exclude→.worktreeinclude→端口段→三层 setup→active）→ Task 7；失败回滚不留孤儿 + error 可重试 → Task 7（rollbackToError/retry）+ Task 9（/retry 路由）；archive 删树留 branch / unarchive 重建 / delete 只走 `git worktree remove` + 脏树拒绝 → Task 8；真 git 验收 → Task 11。
   - §三 workspaces 表业务化（含唯一索引 m0002、data JSON 存 portBase/lastError）→ Task 2。
   - §2.3 SSE：durable 游标回放 + live 推送（M1 单端点）→ Task 10。
   - §八 CLI workspace 子集（create/list/archive/delete + unarchive）→ Task 12；`api schema` 经 ROUTES 自动更新 → Task 1。
   - §十 GitError/SetupScriptError：typed error 建模（Task 3/6）+ API 错误信封映射（Task 9；protocol 的 ApiErrorCode 早已含这两码，无需改）。
   - §十二 磁盘布局：`~/coolie/workspaces/<repo>/<园名>`（CoolieConfig.workspacesRoot 已有）、repo 内 `.coolie/` 约定 + info/exclude 注入 → Task 5/7。
   - 命名池（national-parks ≥40 + 后缀去冲突 + provider 接口）与端口段（10 个/workspace，4 万起）→ Task 4。
   - 显式移出：tmux/engine（PostCreateHooks 插拔点已就位）、enter/finish/adopt/checkpoint、refcount、GUI、live-only SSE 通道——见 Global Constraints 末条。
2. **占位符扫描**：无 TBD/TODO/"similar to"。两处"等价改写"注记（Task 3 pathspec 兜底、Task 9 既有测试 cast）均给出了具体替代写法与不变的行为契约，非占位。Task 7 的 archive/unarchive/delete stub 是刻意设计（Shape 一次定全、Task 8 换实现），stub 体为显式 `Effect.die`，不是待填空。
3. **类型一致性**：`GitServiceShape` 方法名/参数在 Task 3（真实现）、Task 7 helper（假实现）、Task 7/8（lifecycle 调用）三处一致（remoteExists/fetchOrigin/refExists/revParse/worktreeAdd/worktreeAddExisting/worktreeRemove/worktreePrune/worktreeList/isDirty/setBranchBase/listIgnoredMatching）；`WorkspaceLifecycleShape` 在 Task 7 一次定全（含 archive/unarchive/delete 签名），Task 8 只换实现、Task 9/11/12 消费不变；`CreateError/LifecycleError` 与 `errorFromCause` 的 `_tag` 分支一一对应（Validation→400、Conflict→409、NotFound→404、GitError/SetupScriptError→500 专码、HookError→500 Internal）；`Runtime`/`AppServices` 在 Task 9 导出、Task 10 sse.ts type-only 引用（无值循环）；`EventsBus` 经 `Effect.serviceOption` 做可选依赖，`EventsRepoLive` 的 `Layer<EventsRepo, never, Db>` 类型不变，Plan 1 既有测试无需触碰（Task 9 的 cast 修改除外，原因已注明）。
4. **补漏动作**：自查中发现四处并已内联修正——(a) retry 需要 HTTP 入口，补了 `POST /workspaces/:id/retry` 路由与 ROUTES 条目（否则"error 可重试"无法触达）；(b) 回滚若删 branch 会违反"branch 永不删"，改为"branch 保留 + 指向 baseRef 时复用"策略并在 create/retry 流水线中显式处理 diverged 分支的 409；(c) m0002 会让 Plan 1 的 migrations 计数断言失效，Task 2 显式更新该断言；(d) provision 里的 fs 步骤（mkdir/info-exclude/复制）原是裸同步调用，抛错会成 defect 绕过 `Effect.catchAll` 回滚——已包 `Effect.try` 映射为带 op 标注的 GitError，确保任何一步失败都走回滚。
5. **评审修订（READY-WITH-FIXES 折入）**：R1——SetupRunner 改为 `detached: true` 进程组 + 超时 `process.kill(-pid, "SIGKILL")` 杀全组（`child.kill` 兜底）+ 以 `exit` 而非 `close` 定局（后台子进程握管道时 `close` 永不触发；Plan 1 daemon.test.ts 进程组教训），超时测试脚本加第二行防 bash exec 优化；R2——SSE 写守卫统一为 `res.destroyed || res.writableEnded`（客户端 abort 时 destroyed=true 而 writableEnded=false）并加 `res.on("error", () => {})` 吞竞态 ERR_STREAM_DESTROYED。另六处澄清已入正文：unarchive 不重跑 include/setup（M1 刻意决定，Task 8）；SSE 测试的 60ms 心跳兼作 read 解堵器不可删（Task 10）；main.ts 需同时移除 `ProjectsRepo` 与 `EventsRepo` 两个失效 import（Task 9）；同 basename 项目的路径冲突由 `UNIQUE(path)` 以 409 兜底、M1 接受（Task 7）；Task 7 stub 措辞对齐实际代码 `Effect.die(new Error(...))`；unarchive 的 `fs.mkdirSync` 与 provision 同款包 `Effect.try`（Task 8）。
