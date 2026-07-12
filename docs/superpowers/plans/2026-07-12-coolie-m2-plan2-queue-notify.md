# Coolie M2 · Plan 2：server 端 prompt 队列 + 通知与注意力管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给**无原生队列的 engine（codex，`nativeQueue=false`）**补上 server 端 prompt 队列——忙时 composer 投递进 SQLite 持久队列，turn-complete（tab 状态迁到 `awaiting-input`）后按 FIFO 自动投递下一条；composer「⏳ N 条排队中」可撤回。叠加**通知与注意力管理**：turn-complete → OS 通知 + 注意力路由（哪个 workspace 需要你）+ 未聚焦角标/横幅。附带清 M1 carry-over C7（SSE-shutdown `<1.5s` 真钉 `closeAllConnections`）、C13（`server.json` reader mid-write 窗短退避重读 + 原子写）、N1（过长 `COOLIE_HOME` 致 unix socket 路径超限 → 响亮报错 + doctor 警告）、N2（裸 Esc 中断后状态滞留 `working` → interrupt 乐观收敛，短授权窗不压制 mtime 主权）；清 M2 Plan 1 残留（codex hooks **版本门控**落地——≥0.144 走 hooks lane、≤0.139 走本计划 notify 兜底 lane；标题派生双 lane（hook-stdin transcript_path / rollout 回填）；回填 watcher 归档即停）。

**Architecture:** 队列的**触发信号是引擎无关的**——turn detector 已把两种引擎的「turn 结束」统一收敛成 `tab.status.changed → awaiting-input` 事件（claude 来自 Stop hook 即时；codex 来自 `monitor.ts` 的 rollout mtime 静默 `IDLE_THRESHOLD_MS=30_000` 兜底，或本计划 T9 的 codex `notify` 兜底即时）。故**队列投递器（queue drainer）与通知/注意力两套逻辑都订阅同一个 `EventsBus` 的 `tab.status.changed` 事件**，与具体 engine 解耦。队列本身是新增 SQLite 表 `prompt_queue`（m0003 migration）+ `QueueRepo`（与 `TabsRepo` 同构：写库 + 事件 append 同一 `db.transaction`、commit 后 broadcast）。drainer 每次 turn-complete 只投**一条**——投出后该条开启新 turn（`working`），下个 turn-complete 再投下一条，天然串行、零并发写 PTY。`/input` 路由的 M2 Plan-1 降级守卫（F6 REMOVAL MARKER：忙时 `send` 回 409 `EngineBusy`）替换为 enqueue（回 202）。**通知/注意力的主实现是纯 client store 内建、必然可用的两件套：in-app 注意力横幅 + `document.title` 前缀角标**（无任何平台能力依赖）；OS 级 `Notification`/`navigator.setAppBadge` 作为**渐进增强**层，先经运行时能力探测（feature-detect）再启用——**Tauri WKWebView 内的 web `Notification` 权限流未经证实、很可能失效**，故绝不把它当默认可用（能力探测失败时静默退回内建两件套，M3 再评估是否引 `tauri-plugin-notification`）。**codex turn-complete 有两条 lane（版本门控，见 T9/T10）**：codex ≥0.144（探测确认 hooks 可用）走 hooks Stop lane，≤0.139 走 `notify` 兜底 lane——两 lane 都收敛成 `tab.status.changed → awaiting-input`，队列/通知与具体 lane 解耦。依据：spec §7.2（发送/排队三档 + 「⏳ N 条排队中」可撤回）、§六（turnDetector 徽标）、§九（doctor 只读诊断）是**里程碑/spec 条目**，其下的具体交互（横幅/角标/撤回 affordance/通知触发条件）是**本计划从这些条目设计推导**、非 spec 逐字规定；roadmap `2026-07-12-coolie-m2-roadmap.md` §二分诊表（C7/C11/C13/N1/N2）+ §三 Plan 2 定义。

**Tech Stack:** 与 main（`@b4a84e7`，M1 完成 + codex 引擎）落地代码一致：TypeScript ^5.x（strict + exactOptionalPropertyTypes）、Node ≥22 运行时（bun 仅装包/跑脚本）、Effect ^3.21.4（`Context.Tag`/`Layer`/`Effect.gen`/`Data.TaggedError`/`Runtime` 返回 `Exit`）、better-sqlite3（`db.transaction` 同步事务）、Node `EventEmitter`（`EventsBus`，`EVENT_CHANNEL="event"` 上广播 `CoolieEvent`）、vitest、commander（CLI）、zustand 5 + React（client）。**无新增 npm 依赖**——OS 通知用浏览器内建 `Notification`/`navigator.setAppBadge`，codex `notify` 走 shell 转发脚本（同 hook forwarder 路线）。真 engine 只出现在最终 Task 13 手工冒烟；自动化测试一律 fake（`QueueRepo`/`EventsBus`/`composerOps` 注入 spy，engine 命令用 `COOLIE_CODEX_CMD=cat` seam）。

## Global Constraints

（承 M1 + M2 Plan 1 全套，逐条仍生效——每个 task 的要求隐含本节）

- server 与 CLI 的一切进程**必须以 Node 运行**（`node`/`tsx`），bun 只做 `bun install`/`bun run`（spec §2.2：node-pty 不兼容 Bun）。
- Effect 锁 `^3.21.4`；代码按 main 已合入代码的实际 API 风格书写（`Runtime` 返回 `Exit`、repo 的「写库 + 事件 append」同一 `db.transaction`、bus 广播在 commit 后、`EventsBus` 为 `serviceOption` 可选依赖）。若个别 API 有出入以官方 docs 等价改写，**任务的行为契约（每步测试断言）不变**。
- **engine 进程只属于 tmux**：server 死亡不得杀 engine。队列 drainer 只经 `composerOps.input`（复用 M1 消毒 + 稳定检测管线）投递，绝不自起进程、绝不 attach。
- **prompt 消毒强制**：任何经队列投向 engine pane 的文本必须先过 `sanitizePromptForPty`（`composerOps.input` 已内建）——drainer 绝不绕过 `composerOps` 直写 tmux。
- **turn detector 单一真源纪律**（承 monitor.ts `decideStatusFromMtime` 注释「推导逻辑只此一处」）：本计划不新增第二处状态推导；队列/通知/注意力都**消费** `tab.status.changed` 事件，不自行推断 turn 边界。
- 安全默认值不变：server 绑 `127.0.0.1` + unix socket；除 `GET /health` 外一切端点（含 `/queue`、`/notify/:engine`）强制 token；日志绝不打印含 token 的完整 URL。codex notify / hook 转发脚本本体绝不含密钥（运行时从 `server.json` 读 port/token）。
- SQLite 写库纪律：migration 幂等（`schema_migrations` 记账、每 migration 单 `db.transaction`）、禁无 `WHERE` sweep；`prompt_queue` 的 `workspace_id` 外键指向 `workspaces(id)`。
- 所有测试经 `COOLIE_HOME`/`COOLIE_WORKSPACES_ROOT`/`COOLIE_TMUX_SOCKET`/`COOLIE_CLAUDE_HOME`/`COOLIE_CODEX_HOME`/`COOLIE_CODEX_CONFIG` 指向 `mkdtemp` 临时目录/专属测试 socket，绝不读写真实 `~/.coolie`、`~/.claude`、`~/.codex`，绝不碰生产 `-L coolie` socket；每个用了 tmux 的测试文件 `afterAll` `kill-server`；套件跑完真实配置字节级 diff 必须为空。
- **client 无 Rust/cargo 改动**：通知/注意力的**主实现**是 in-app 横幅 + `document.title` 前缀角标（纯 DOM，任何 webview 必然可用，零平台依赖）。OS 级 `Notification`/`navigator.setAppBadge?.()` 是**渐进增强**，仅在运行时能力探测（`Notification.permission` 流可用、`setAppBadge` 是函数）通过后启用；**不假设 Tauri WKWebView 内 web `Notification` 可用**（未经证实、很可能 inert）——探测失败即静默用内建两件套，功能不缺。本计划**不引** `tauri-plugin-notification`（避免 capabilities/cargo 波及 Plan 3/4 的 Rust 侧）；若 T13 冒烟证实 WKWebView web `Notification` 确实 inert，OS 通知的原生实现（tauri-plugin-notification）作为 **M3 升级项**归档，不阻本计划。
- **事件词表 append-only**：新增事件类型是自由字符串（`CoolieEvent.type: Schema.String`，无 enum），追加不改既有；client `applyEvent` 是「前缀分发 + refetch」，新事件按前缀（`prompt.`）挂钩，不改既有分支语义。
- 每个 Task 结束必须 `git commit`，conventional commits（feat/fix/test/docs/chore）。**不 push、不合并**（终审后由控制器合并）。
- 本计划**不做**（显式属其他 M2 plan）：fan-out / `coolie://` deep links / 外部终端（Plan 3）；diff 行评论写回 + `⌘K`/主题/i18n + web client 壳（Plan 4）；codex app-server / headless 自渲染（M3+）。**codex `notify` 只做 turn-complete 兜底转发（T9，且仅当版本门控判定 hooks 不可用时才注入——见 T9/T10 的 lane 分流），不做自渲染对话流。**
- **codex turn-complete 双 lane 与 mtime 授权一致性（H1）**：turn-complete 信号有三源（claude Stop hook / codex notify 或 hooks Stop / rollout mtime 30s 兜底）。`monitor.decideStatusFromMtime` 的「近期有 hook 信号则让位」授权窗**按引擎能力门控**：真 hooks 引擎（claude、codex≥0.144）= `HOOK_AUTHORITY_MS`（10min）；无真 hooks 的 codex（≤0.139，notify/interrupt 是 lastHookAt 的唯一写入者）= `NOTIFY_AUTHORITY_MS`（短，仅护过 3s ACTIVE 窗口）。**故 codex 始终 mtime-authoritative**：notify/interrupt 的乐观收敛只压过投递瞬间的 fresh-mtime 抖动，30s 静默安全网与 N2 自纠在短窗后立即恢复，绝不被 10min 抑制。

## File Structure（本计划新建/修改）

```
packages/protocol/src/
  routes.ts                          # 修改（append-only）：+GET/DELETE /workspaces/:id/queue、+POST /notify/:engine
packages/server/
  src/db/migrations.ts               # 修改：追加 m0003-prompt-queue（新表 + 索引）
  src/repo/queue.ts                  # 新建：QueueRepo（enqueue/peekNext/listQueued/remove/clearWorkspace，写库+事件同事务）
  src/repo/tabs.ts                   # 修改（T8）：TabStatusSource +"notify"/"interrupt"（drainer 源门控 M4 + 事件溯源）
  src/engine/monitor.ts              # 修改（T8）：+NOTIFY_AUTHORITY_MS；decideStatusFromMtime 授权窗改由入参 hookAuthorityMs 门控（H1）
  src/engine/queue-drain.ts          # 新建：startQueueDrainer（订阅 EventsBus，turn-complete 投下一条；源="interrupt" 不投 M4）+ drainWorkspace 纯函数
  src/workspace/lifecycle.ts         # 修改（T5）：delete teardown 追加 QueueRepo.clearWorkspace（archive 保留，M2）
  src/engine/codex/notify.ts         # 新建：ensureNotifyScript（codex notify 转发脚本，同 hook forwarder 三铁律）
  src/engine/codex/version.ts        # 新建（T9）：resolveCodexHooks——codex ≥0.144 版本探测 / COOLIE_CODEX_HOOKS 覆写
  src/engine/registry.ts             # 修改（T9）：EngineRegistryLive 以 resolveCodexHooks() 门控 codex capabilities.hooks
  src/daemon/socket.ts               # 新建（N1）：SUN_PATH_MAX + assertSockPathFits + sockPathWarning
  src/daemon/info.ts                 # 修改（C13）：claimServerInfo 原子（tmp+link 独占-原子）+ 自陈旧覆写路径 rename；+readServerInfoWithRetry（短退避重读）
  src/engine/session.ts              # 修改（T9）：launchCommand 调用点——仅当 engine 无真 hooks 时透传 workspaceId+home（notify 仅 ≤0.139 fallback lane）
  src/engine/types.ts                # 修改（T9）：LaunchCommandInput +workspaceId?/home?（可选）
  src/engine/codex/adapter.ts        # 修改（T9）：launchCommand 注入 -c notify=[...]（有 workspaceId+home 时——即 hooks off lane）
  src/engine/bootstrap.ts            # 修改：codex hooks off 时 ensureNotifyScript（T9）；backfill onFound 派生标题（hooks off lane，T10）；watcher shouldContinue 归档即停（T10）；armRolloutWatcher/gateOnHooks 版本门控（T10，probe ④ SessionStart 仍延迟）
  src/engine/codex/rollout.ts        # 修改（T10）：RolloutWatcherDeps.onFound 携带 rollout path（已有 hit.path），无需改签名——bootstrap 侧消费
  src/http/app.ts                    # 修改：/input 忙时 enqueue（替 F6 REMOVAL MARKER，T5）；+GET/DELETE /queue（T7）；interrupt 乐观收敛（N2，T8）；+POST /notify/:engine（T9）；hooks 路由标题派生优先 hook-stdin transcript_path（T10）
  src/main.ts                        # 修改：装配 QueueRepo（T5）+ startQueueDrainer（T6）；socket 路径 assertSockPathFits（N1，T4）
  src/config.ts                      # 修改（T4）：暴露 sockPath（供 socket guard 复用单一真源，避免 main.ts 与 doctor 各拼一次）
  test/…                             # 每 task 对应测试（见各 task）
packages/cli/src/
  main.ts                            # 修改（T4）：doctor 增 socket 路径警告一行
  client.ts                          # 修改（C13，T3）：读 server.json 用 readServerInfoWithRetry
packages/client/src/
  stores/data.ts                     # 修改（T11）：queuedByWs + refreshQueue + withdrawQueued + applyEvent 接 prompt.*；sendInput 处理 202
  stores/attention.ts                # 新建（T12）：注意力 store（needs-you 集合）——通知/角标的必然可用真源
  chrome/notify.ts                   # 新建（T12）：能力探测（canOsNotify/canAppBadge）+ title 前缀角标（内建）+ OS Notification 渐进增强层
  composer/Composer.tsx              # 修改（T11）：QueueIndicator 改读 server 队列 + 撤回走 DELETE
  chrome/Sidebar.tsx                 # 修改（T12）：workspace 行注意力角标
  App.tsx                            # 修改（T12）：注意力横幅 + 通知权限请求 + 聚焦即清注意力
README.md（或 packages/server/README.md）# 修改（T13）：队列语义 + 通知/注意力分层 + codex 双 lane 版本门控运维说明（COOLIE_CODEX_HOOKS）
```

## Task Order / 波次并行

13 个 task 按共享文件切成五波。**跨 task 共享文件的串行纪律（承 M1 P5 / M2 P1）**：`http/app.ts` 被 T5/T7/T8/T9 触碰，`main.ts` 被 T4/T5/T6 触碰，`stores/data.ts` 被 T11/T12 触碰，`bootstrap.ts` 被 T9/T10 触碰——**这些同文件 task 绝不并发**，靠波内 `→` 串行钉死。

```
Wave A  ∥  { T1, T2, T3, T4 }   # 文件全不相交，可四线并行
        │  T1=queue 表+repo（db/repo，新文件）  T2=C7 SSE-shutdown（仅测试文件）
        │  T3=C13 reader 重读（daemon/info.ts + cli/client.ts）  T4=N1 socket guard（daemon/socket.ts 新建 + main.ts socket 段 + cli/main.ts doctor + config.ts）
        │  依赖门：T1 必须先于 Wave B（B 消费 QueueRepo）；T2/T3 与 B/C/D 无依赖，任意时序。
Wave B  →  T5 → T6 → T7          # server 队列核心（app.ts + main.ts 串行链，消费 T1 的 QueueRepo；T5 另碰 lifecycle.ts）
Wave C  →  T8 → T9 → T10         # codex/残留（T8 碰 app.ts+monitor.ts+tabs.ts；T9 碰 app.ts+registry.ts+version.ts+session/adapter；T9/T10 碰 bootstrap.ts；T10 另碰 app.ts hooks 路由段）——须在 Wave B 之后（同 app.ts）。T8 建的 TabStatusSource +"notify"/"interrupt" 与 monitor 授权门控是 T9 notify 端点/N2 的地基，T9 的版本门控是 T10 lane 判定的地基，故 T8→T9→T10 严格串行
Wave D  →  T11 → T12             # client（stores/data.ts 串行）——须在 Wave B 路由/事件就绪后（client 调 /queue、消费 prompt.*）；与 Wave C 跨包（server↔client）可并行
Wave E  →  T13                   # README + 全量回归 + 真机双引擎冒烟（真 claude 原生队列 + 真 codex server 队列语义）
```

> **可并行说明（file-disjoint）**：Wave A 的 T1（`repo/queue.ts`、`db/migrations.ts`）、T2（`test/daemon.test.ts`）、T3（`daemon/info.ts`、`cli/client.ts`）、T4（新建 `daemon/socket.ts` + `main.ts` socket 段 + `cli/main.ts` doctor + `config.ts`）四者文件全不相交，可同时派四个执行 agent。**注意 T4 与 Wave B 的 T5/T6 都改 `main.ts`**——T4 改的是 socket listen 段（~line 108/201），T5/T6 改的是队列装配段（~line 78/95–106/165），行不相交但同文件，故 Wave B 须在 T4 合入后再起（`→` 串行）。**Wave C（server）与 Wave D（client）跨 `packages/server` ↔ `packages/client`，无共享文件，可并行**。Wave E 依赖全部。

---

### Task 1: `prompt_queue` 表 + `QueueRepo`（m0003 migration）

**Files:**
- Modify: `packages/server/src/db/migrations.ts`（追加 m0003）
- Create: `packages/server/src/repo/queue.ts`
- Test: `packages/server/test/repo.queue.test.ts`

**Interfaces:**
- Consumes: `appendEventRow(db, { workspaceId, type, payload })`（`repo/events.ts`，in-txn 事件写）；`EventsBus`（`serviceOption`，commit 后 `broadcast`）；`better-sqlite3` `Database`。
- Produces:
  - 表 `prompt_queue(id INTEGER PK AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), tab_id TEXT NOT NULL, text TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL)` + `CREATE INDEX idx_queue_ws_id ON prompt_queue(workspace_id, id)`。FIFO 顺序 = `id` 升序。
  - `QueuedPrompt = { id: number; workspaceId: string; tabId: string; text: string; mode: "send"; createdAt: number }`
  - `QueueRepoShape`：
    - `enqueue(e: { workspaceId: string; tabId: string; text: string }): Effect.Effect<{ id: number; position: number }>`——插入 + append `prompt.queued` 事件 `{ tabId, queueId, position, chars }`（同 txn），broadcast；`position` = 插入后本 ws 的 queued 条数（1-based）。
    - `peekNext(workspaceId: string): Effect.Effect<QueuedPrompt | null>`——最老一条（`ORDER BY id ASC LIMIT 1`），无事件。
    - `listQueued(workspaceId: string): Effect.Effect<QueuedPrompt[]>`——按 `id` 升序全部。
    - `remove(id: number, reason: "withdrawn" | "delivered"): Effect.Effect<QueuedPrompt | null>`——删行 + append `prompt.${reason}` 事件 `{ tabId, queueId }`（同 txn），broadcast；返回被删行（已不存在返回 `null`，不发事件）。
    - `clearWorkspace(workspaceId: string): Effect.Effect<number>`——删该 ws 全部 queued（archive/delete 用），返回删除条数，无事件（workspace.archived/deleted 自身已广播）。
  - `class QueueRepo extends Context.Tag("QueueRepo")<QueueRepo, QueueRepoShape>() {}` + `export const QueueRepoLive = Layer.effect(QueueRepo, Effect.gen(...))`——**照抄 `repo/tabs.ts` `TabsRepoLive` 的真实构造**：`const db = yield* Db`（`Db` Context.Tag，来自 `../db/sqlite.js`）+ `const bus = yield* Effect.serviceOption(EventsBus)`，`broadcast` 在 commit 后 `bus.value.emit(EVENT_CHANNEL, ev)`。**不是** `(db)=>Layer` 工厂——依赖经 `Db`/`EventsBus` 两个 Context.Tag 提供（`Layer<QueueRepo, never, Db | EventsBus>`，`EventsBus` 因 `serviceOption` 实际可缺省）。

- [ ] **Step 1: 写失败测试**

`packages/server/test/repo.queue.test.ts`（沿用现有 repo 测试装配：`makeTestDb()` 建内存/临时库 + `runMigrations` + 提供 `EventsBus` fake 收集广播）：

```ts
import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Layer } from "effect"
import Database from "better-sqlite3"
import { EventEmitter } from "node:events"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { QueueRepo, QueueRepoLive } from "../src/repo/queue.js"
import { EventsBus, EVENT_CHANNEL } from "../src/events/bus.js"
import type { CoolieEvent } from "@coolie/protocol"

// 最小 projects/workspaces 行以满足外键（对齐 tabs-repo.test.ts 的 seed 手法；此处直接 SQL 塞）
const seedWs = (db: Database.Database, wsId: string) => {
  db.prepare("INSERT INTO projects (id,name,repo_root,default_base_branch,created_at) VALUES (?,?,?,?,?)")
    .run("p1", "p", `/tmp/${wsId}`, "main", Date.now())
  db.prepare("INSERT INTO workspaces (id,project_id,name,path,branch,base_branch,base_ref,status,pinned,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(wsId, "p1", wsId, `/tmp/${wsId}`, "b", "main", "abc", "active", 0, Date.now())
}

// DI 与 tabs-repo.test.ts 逐字同构：QueueRepoLive 是 Layer.effect，Db/EventsBus 各经 Layer.succeed 注入。
const layer = (db: Database.Database, bus: EventEmitter) =>
  QueueRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)), Layer.provide(Layer.succeed(EventsBus, bus)))
const run = <A>(db: Database.Database, bus: EventEmitter, eff: Effect.Effect<A, any, QueueRepo>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, layer(db, bus)))

describe("QueueRepo", () => {
  let db: Database.Database, bus: EventEmitter, events: CoolieEvent[]
  beforeEach(() => {
    db = new Database(":memory:"); runMigrations(db); seedWs(db, "w1")
    bus = new EventEmitter(); events = []; bus.on(EVENT_CHANNEL, (e: CoolieEvent) => events.push(e))
  })

  it("enqueue 按 FIFO 记 position 并发 prompt.queued", async () => {
    const a = await run(db, bus, Effect.gen(function* () { return yield* (yield* QueueRepo).enqueue({ workspaceId: "w1", tabId: "t1", text: "一" }) }))
    const b = await run(db, bus, Effect.gen(function* () { return yield* (yield* QueueRepo).enqueue({ workspaceId: "w1", tabId: "t1", text: "二" }) }))
    expect(a.position).toBe(1); expect(b.position).toBe(2); expect(b.id).toBeGreaterThan(a.id)
    const queued = events.filter((e) => e.type === "prompt.queued")
    expect(queued).toHaveLength(2)
    expect((queued[1].payload as any).position).toBe(2)
    expect((queued[0].payload as any).chars).toBe(1)
  })

  it("peekNext 取最老、listQueued 升序", async () => {
    await run(db, bus, Effect.gen(function* () { yield* (yield* QueueRepo).enqueue({ workspaceId: "w1", tabId: "t1", text: "一" }) }))
    await run(db, bus, Effect.gen(function* () { yield* (yield* QueueRepo).enqueue({ workspaceId: "w1", tabId: "t1", text: "二" }) }))
    const next = await run(db, bus, Effect.gen(function* () { return yield* (yield* QueueRepo).peekNext("w1") }))
    expect(next?.text).toBe("一")
    const all = await run(db, bus, Effect.gen(function* () { return yield* (yield* QueueRepo).listQueued("w1") }))
    expect(all.map((q) => q.text)).toEqual(["一", "二"])
  })

  it("remove(delivered) 删行发 prompt.delivered；重复 remove 返回 null 不发事件", async () => {
    const a = await run(db, bus, Effect.gen(function* () { return yield* (yield* QueueRepo).enqueue({ workspaceId: "w1", tabId: "t1", text: "一" }) }))
    const removed = await run(db, bus, Effect.gen(function* () { return yield* (yield* QueueRepo).remove(a.id, "delivered") }))
    expect(removed?.text).toBe("一")
    expect(events.some((e) => e.type === "prompt.delivered")).toBe(true)
    const again = await run(db, bus, Effect.gen(function* () { return yield* (yield* QueueRepo).remove(a.id, "delivered") }))
    expect(again).toBeNull()
    expect(events.filter((e) => e.type === "prompt.delivered")).toHaveLength(1)
  })

  it("clearWorkspace 删全部 queued 返回条数", async () => {
    await run(db, bus, Effect.gen(function* () { yield* (yield* QueueRepo).enqueue({ workspaceId: "w1", tabId: "t1", text: "一" }) }))
    await run(db, bus, Effect.gen(function* () { yield* (yield* QueueRepo).enqueue({ workspaceId: "w1", tabId: "t1", text: "二" }) }))
    const n = await run(db, bus, Effect.gen(function* () { return yield* (yield* QueueRepo).clearWorkspace("w1") }))
    expect(n).toBe(2)
    const all = await run(db, bus, Effect.gen(function* () { return yield* (yield* QueueRepo).listQueued("w1") }))
    expect(all).toHaveLength(0)
  })
})
```

> 注：DI 形态**已核对仓库真实代码**（`repo/tabs.ts:44` `export const TabsRepoLive = Layer.effect(TabsRepo, Effect.gen(function*(){ const db = yield* Db; const bus = yield* Effect.serviceOption(EventsBus) ... }))`；测试 `tabs-repo.test.ts:24` `TabsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)), Layer.provide(Layer.succeed(EventsBus, bus)))`）。QueueRepoLive **逐字同构**——非 `(db)` 工厂。契约不变：QueueRepo 五方法签名与事件如上。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/repo.queue.test.ts`
Expected: FAIL——`repo/queue.js` 不存在 / `prompt_queue` 表未建（migration 未加）。

- [ ] **Step 3: 追加 m0003 migration**

`packages/server/src/db/migrations.ts` 的 `MIGRATIONS` 数组末尾追加：

```ts
  {
    id: "m0003-prompt-queue",
    up: (db) => {
      db.exec(`
        CREATE TABLE prompt_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          tab_id TEXT NOT NULL,
          text TEXT NOT NULL,
          mode TEXT NOT NULL,
          created_at INTEGER NOT NULL);
        CREATE INDEX idx_queue_ws_id ON prompt_queue(workspace_id, id);
      `)
    },
  },
```

- [ ] **Step 4: 实现 QueueRepo**

`packages/server/src/repo/queue.ts`（对齐 `repo/tabs.ts` 的 `broadcast`/`db.transaction`/`serviceOption(EventsBus)` 模式）：

```ts
import { Context, Effect, Layer, Option } from "effect"
import type Database from "better-sqlite3"
import type { CoolieEvent } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { appendEventRow } from "./events.js"

export interface QueuedPrompt {
  readonly id: number
  readonly workspaceId: string
  readonly tabId: string
  readonly text: string
  readonly mode: "send"
  readonly createdAt: number
}

const rowToQueued = (r: any): QueuedPrompt => ({
  id: r.id, workspaceId: r.workspace_id, tabId: r.tab_id, text: r.text, mode: r.mode, createdAt: r.created_at,
})

export interface QueueRepoShape {
  readonly enqueue: (e: { workspaceId: string; tabId: string; text: string }) => Effect.Effect<{ id: number; position: number }>
  readonly peekNext: (workspaceId: string) => Effect.Effect<QueuedPrompt | null>
  readonly listQueued: (workspaceId: string) => Effect.Effect<QueuedPrompt[]>
  readonly remove: (id: number, reason: "withdrawn" | "delivered") => Effect.Effect<QueuedPrompt | null>
  readonly clearWorkspace: (workspaceId: string) => Effect.Effect<number>
}

export class QueueRepo extends Context.Tag("QueueRepo")<QueueRepo, QueueRepoShape>() {}

export const makeQueueRepo = (db: Database.Database, broadcast: (ev: CoolieEvent) => void): QueueRepoShape => ({
  enqueue: ({ workspaceId, tabId, text }) => Effect.sync(() => {
    let id = 0, position = 0, ev!: CoolieEvent
    db.transaction(() => {
      const info = db.prepare("INSERT INTO prompt_queue (workspace_id, tab_id, text, mode, created_at) VALUES (?,?,?,?,?)")
        .run(workspaceId, tabId, text, "send", Date.now())
      id = Number(info.lastInsertRowid)
      position = (db.prepare("SELECT COUNT(*) AS n FROM prompt_queue WHERE workspace_id = ?").get(workspaceId) as any).n
      ev = appendEventRow(db, { workspaceId, type: "prompt.queued", payload: { tabId, queueId: id, position, chars: text.length } })
    })()
    broadcast(ev)
    return { id, position }
  }),
  peekNext: (workspaceId) => Effect.sync(() => {
    const r = db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? ORDER BY id ASC LIMIT 1").get(workspaceId)
    return r ? rowToQueued(r) : null
  }),
  listQueued: (workspaceId) => Effect.sync(() =>
    (db.prepare("SELECT * FROM prompt_queue WHERE workspace_id = ? ORDER BY id ASC").all(workspaceId) as any[]).map(rowToQueued)),
  remove: (id, reason) => Effect.sync(() => {
    let removed: QueuedPrompt | null = null, ev: CoolieEvent | null = null
    db.transaction(() => {
      const r = db.prepare("SELECT * FROM prompt_queue WHERE id = ?").get(id)
      if (!r) return // 已被别的路径删除（撤回/drain 竞态）：幂等 no-op
      removed = rowToQueued(r)
      db.prepare("DELETE FROM prompt_queue WHERE id = ?").run(id)
      ev = appendEventRow(db, { workspaceId: removed.workspaceId, type: `prompt.${reason}`, payload: { tabId: removed.tabId, queueId: id } })
    })()
    if (ev) broadcast(ev)
    return removed
  }),
  clearWorkspace: (workspaceId) => Effect.sync(() =>
    db.prepare("DELETE FROM prompt_queue WHERE workspace_id = ?").run(workspaceId).changes),
})

// 逐字同构 TabsRepoLive（repo/tabs.ts:44）：Layer.effect + Db Context.Tag + serviceOption(EventsBus)。
export const QueueRepoLive = Layer.effect(
  QueueRepo,
  Effect.gen(function* () {
    const db = yield* Db
    const bus = yield* Effect.serviceOption(EventsBus)
    const broadcast = (ev: CoolieEvent): void => { if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, ev) }
    return makeQueueRepo(db, broadcast)
  }),
)
```

> **对齐纪律**：`Layer.effect(QueueRepo, gen)` + `yield* Db` + `serviceOption(EventsBus)` 广播 = **照抄 `repo/tabs.ts` `TabsRepoLive` 逐字**（已核对真实代码）。`makeQueueRepo(db, broadcast)` 是纯逻辑工厂，与 DI 解耦——测试直接 `makeQueueRepo` 亦可，但本计划测试走 Layer 以覆盖 broadcast 接线。

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd packages/server && bun run vitest run test/repo.queue.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/migrations.ts packages/server/src/repo/queue.ts packages/server/test/repo.queue.test.ts
git commit -m "feat(server): prompt_queue 表 + QueueRepo（m0003；enqueue/peek/remove/clear，写库+事件同事务）"
```

---

### Task 2: C7 — SSE-shutdown `<1.5s` 真钉 `closeAllConnections`

**Files:**
- Modify: `packages/server/test/daemon.test.ts`（第一个 shutdown 测试的 deadline 从 8000ms 收紧到 1500ms）

**Interfaces:**
- Consumes: 现有 daemon.test 装配（起真 server、开 SSE 连接、`POST /shutdown`、轮询 `server.json`/`coolie.sock` 消失）。
- Produces: 无代码接口——把「未钉死的 2s 兜底遮蔽」收紧为可判别断言。**不改 `main.ts`**（`closeAllConnections` 已就位）：这是纯测试加固。

> **背景（roadmap C7）**：`main.ts` 的 `closeHttp` 已调 `s.closeAllConnections()`——但现有测试用 8000ms deadline，即便 `closeAllConnections` 失灵、fallback 到 2000ms `Promise.race` 兜底退出，8000ms 也照样绿。收紧到 **1500ms**：若 `closeAllConnections` 真失灵，带开着的 SSE 长连接时 `server.close()` 永不完成 → 只能靠 2000ms 兜底 → sock 移除 >1500ms → 测试红。这就把 `closeAllConnections` 的行为钉死了。

- [ ] **Step 1: 定位并改 deadline**

`packages/server/test/daemon.test.ts` 第一个 shutdown 测试（约 line 198–219，注释「没有 closeAllConnections 时 server.close 永不完成」）——把轮询 deadline 常量从 8000 改为 1500，并把注释更新为断言意图：

```ts
    // C7：deadline 收紧到 1500ms 真钉 closeAllConnections——带开着的 SSE 连接，若 closeAllConnections
    // 失灵则 server.close 永不完成、只能靠 shutdown 的 2000ms 兜底退出 → sock 移除必 >1500ms → 本断言红。
    const deadline = Date.now() + 1500
```

（若原文是内联 `Date.now() + 8000`，改内联数字；轮询间隔 100ms 不变。断言仍是 `server.json` + `coolie.sock` 都在 deadline 前消失、`/health` 不再应答。）

- [ ] **Step 2: 跑测试确认通过**

Run: `cd packages/server && bun run vitest run test/daemon.test.ts`
Expected: PASS——`closeAllConnections` 生效，实测 sock 在数十 ms 内移除，远早于 1500ms。若意外红，说明 `closeAllConnections` 未生效（真 bug，回 `main.ts` closeHttp 排查，勿放宽 deadline 掩盖）。

- [ ] **Step 3: 变异验证（可选但推荐，证明测试有判别力）**

临时在 `main.ts` closeHttp 里注释掉 `s.closeAllConnections()` 一行 → 重跑 → 应 FAIL（超 1500ms）→ 恢复该行 → 重跑 PASS。**恢复后再提交**（勿把变异留在库里）。

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/daemon.test.ts
git commit -m "test(server): SSE-shutdown deadline 收紧到 <1.5s 真钉 closeAllConnections（C7）"
```

---

### Task 3: C13 — `server.json` reader mid-write 窗短退避重读 + 原子写

**Files:**
- Modify: `packages/server/src/daemon/info.ts`（`claimServerInfo` 原子化——tmp+`linkSync` 独占-原子写；+`readServerInfoWithRetry`）
- Modify: `packages/cli/src/client.ts`（读 server.json 处改用 `readServerInfoWithRetry`）
- Test: `packages/server/test/daemon-info.test.ts`（**既有文件**，追加原子性 + 重试用例）

**Interfaces:**
- Consumes: `readServerInfo(infoPath): ServerInfo | null`（现有：解析失败/字段缺返回 `null`）；`probeAlive`（现有）。
- Produces:
  - `claimServerInfo` **原子化**（这是**生产唯一写入点**——`main.ts:193` `claimServerInfo(cfg.serverInfoPath, ...)`；`writeServerInfo` 仅测试 seed 用，不动）：把 `writeFileSync(infoPath, payload, {flag:"wx"})` 换成「payload 先整写进同目录 tmp → `fs.linkSync(tmp, infoPath)`」。`linkSync` **既原子**（reader 要么见不到、要么见完整文件，绝无半写）**又独占**（dest 已存在抛 `EEXIST`，等价 `O_EXCL`）——故单实例仲裁语义**逐字不变**（EEXIST → 读既有者 → 活赢家认输 / 陈旧损坏清掉重试）。**关键取舍**：自陈旧覆写路径**不用 `renameSync`**——rename 无条件覆盖会把「刚被别的实例抢注的赢家」clobber 成双赢家（破坏单实例）；`linkSync` 在同一次系统调用里同时给到原子 + 独占，重试仍走 EEXIST→concede，故 O_EXCL 的认输安全性**完整保留**。
  - `readServerInfoWithRetry(infoPath: string, opts?: { retries?: number; delayMs?: number }): Promise<ServerInfo | null>`——`readServerInfo` 返回 `null`（解析失败/字段缺/claim 的 `rmSync`+`link` 删-建 µs 短窗）时按 `delayMs`（默认 20ms）短退避重读，最多 `retries`（默认 3）次；仍 `null` 才放弃。

> **背景（roadmap C13）**：`claimServerInfo` 用 `flag:"wx"`（O_EXCL）独占创建、单实例仲裁正确；但 `writeFileSync(wx)` 写 payload **非原子**，reader 在写入瞬间可能读到半写 JSON（`JSON.parse` 抛 → `readServerInfo` 返回 `null`）。修复两手：**写侧**把独占创建从「wx 半写」换成「tmp 整写 + hardlink（原子且独占）」消除半写而不失独占；**读侧**短退避重读消除「删-建 µs 窗」瞬时假阴。`writeServerInfo`（原 `writeFileSync` 非原子）保持原样——它只在测试里 seed 陈旧/赢家文件，非生产写入点，原子性无所谓。

- [ ] **Step 1: 写失败测试**

`packages/server/test/daemon-info.test.ts`（**既有文件**，顶部 import 追加 `readServerInfoWithRetry`；新增 describe 块。既有 `claimServerInfo` 4 用例保持不变——它们钉的独占/认输/清陈旧语义在 link 化后**逐字仍成立**，是本改动的回归护栏）：

```ts
// 顶部 import 改为：
import { probeAlive, claimServerInfo, readServerInfo, writeServerInfo, readServerInfoWithRetry } from "../src/daemon/info.js"

describe("claimServerInfo 原子性（C13：tmp+link）+ readServerInfoWithRetry", () => {
  it("claim 后目录内不留 .tmp 残渣、内容完整、mode 0600", async () => {
    const p = path.join(tmp(), "server.json")
    expect(await claimServerInfo(p, { port: 5000, token: "tok", pid: process.pid })).toBe(true)
    expect(readServerInfo(p)?.port).toBe(5000)
    expect(fs.statSync(p).mode & 0o777).toBe(0o600)
    const leftover = fs.readdirSync(path.dirname(p)).filter((f) => f.includes(".tmp"))
    expect(leftover).toHaveLength(0) // tmp 在 link 成功后即 rm，绝不残留
  })

  it("readServerInfoWithRetry：起初半写（parse 失败）→ 期间被补全 → 重试读到", async () => {
    const p = path.join(tmp(), "server.json")
    fs.writeFileSync(p, '{"port": 50') // 半写：JSON 不完整
    setTimeout(() => { fs.rmSync(p, { force: true }); void claimServerInfo(p, { port: 5001, token: "t", pid: process.pid }) }, 30)
    const info = await readServerInfoWithRetry(p, { retries: 8, delayMs: 20 })
    expect(info?.port).toBe(5001)
  })

  it("readServerInfoWithRetry：始终缺失 → retries 用尽返回 null（不无限等）", async () => {
    const p = path.join(tmp(), "server.json")
    fs.rmSync(p, { force: true })
    const info = await readServerInfoWithRetry(p, { retries: 2, delayMs: 5 })
    expect(info).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/daemon-info.test.ts`
Expected: FAIL——`readServerInfoWithRetry` 未导出（import 即编译错），重试用例必红。

- [ ] **Step 3: claimServerInfo 原子化（tmp+link）+ 重试读**

`packages/server/src/daemon/info.ts`——`writeServerInfo` **保持原样**（测试 seed 用）；把 `claimServerInfo` 的 `writeFileSync(wx)` 换成 tmp+`linkSync`；追加 `readServerInfoWithRetry`：

```ts
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * post-listen 单实例收口（C13 原子化版）：payload 先整写进同目录 tmp，再 `linkSync` 到最终路径——
 * link 既**原子**（reader 绝不见半写）又**独占**（dest 已存在抛 EEXIST，等价 O_EXCL）。EEXIST 时读既有者：
 * 别人且活着 → 认输（绝不覆盖赢家）；陈旧/损坏/自己的残留 → 清掉重试一次。**不用 rename 覆写**——rename
 * 无条件替换会 clobber 刚抢注的赢家（双赢家）；link 的 EEXIST 保住 O_EXCL 的认输安全性。
 */
export const claimServerInfo = async (infoPath: string, info: ServerInfo): Promise<boolean> => {
  const payload = JSON.stringify(info, null, 2)
  const dir = path.dirname(infoPath)
  for (let attempt = 0; attempt < 2; attempt++) {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${infoPath}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, payload, { mode: 0o600 })
    try {
      fs.linkSync(tmp, infoPath) // 原子 + 独占创建；成功即赢
      return true
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e
      const existing = readServerInfo(infoPath)
      if (existing && existing.pid !== info.pid && (await probeAlive(existing))) return false // 赢家还活着：认输
      fs.rmSync(infoPath, { force: true }) // 陈旧/损坏/自残留：清掉，下一轮 link 重新独占
    } finally {
      fs.rmSync(tmp, { force: true }) // tmp 永不留残渣（link 成功后目标已独立持有 inode）
    }
  }
  return false
}

/** C13：server.json 存在删-建 µs 短窗 / 半写残留，reader 可能读到 null。短退避重读消除瞬时假阴。 */
export const readServerInfoWithRetry = async (
  infoPath: string,
  opts?: { retries?: number; delayMs?: number },
): Promise<ServerInfo | null> => {
  const retries = opts?.retries ?? 3
  const delayMs = opts?.delayMs ?? 20
  for (let i = 0; i <= retries; i++) {
    const info = readServerInfo(infoPath)
    if (info) return info
    if (i < retries) await sleep(delayMs)
  }
  return null
}
```

（`claimServerInfo` 的既有 4 用例——独占成功/清陈旧死 pid/认输活赢家/清坏 JSON——在 link 化后全部逐字仍绿，是回归护栏。`linkSync` 与 tmp 同目录 → 同文件系统，macOS APFS / Linux ext4 均支持常规文件硬链接。）

- [ ] **Step 4: CLI client 读处改用重试读**

`packages/cli/src/client.ts` 顶部 import 加 `readServerInfoWithRetry`；把连接前读 server.json 的同步 `readServerInfo(infoPath())`（约 line 30/35，CLI 命令即将发 HTTP 那处）改为 `await readServerInfoWithRetry(infoPath())`。**只改「即将用它发请求」的读点**——`doctor` 的探活读（cli/main.ts）保持同步 `readServerInfo`（doctor 是诊断快照，不需重试语义；且那文件属 T4 域，勿在此碰）。

```ts
// 例（对齐 client.ts 实际函数）：
const info = await readServerInfoWithRetry(infoPath())
if (!info) { /* 既有「server 未运行」分支不变 */ }
```

- [ ] **Step 5: 跑测试确认通过 + 双 typecheck**

Run: `cd packages/server && bun run vitest run test/daemon-info.test.ts && bun run typecheck && cd ../cli && bun run typecheck`
Expected: PASS（含 `claimServerInfo` 既有 4 用例回归）；双 typecheck 清洁（`client.ts` 若该函数原为同步，改 async 后其调用链需 `await`——grep 该函数调用点补 `await`/`.then`）。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/daemon/info.ts packages/cli/src/client.ts packages/server/test/daemon-info.test.ts
git commit -m "fix(daemon): claimServerInfo tmp+link 原子独占写 + reader 短退避重读（C13）"
```

---

### Task 4: N1 — 过长 `COOLIE_HOME` unix socket 路径超限响亮报错 + doctor 警告

**Files:**
- Create: `packages/server/src/daemon/socket.ts`
- Modify: `packages/server/src/config.ts`（暴露 `sockPath` 单一真源）
- Modify: `packages/server/src/main.ts`（listen 前 `assertSockPathFits`）
- Modify: `packages/cli/src/main.ts`（doctor 增 socket 警告一行）
- Test: `packages/server/test/daemon.socket.test.ts`

**Interfaces:**
- Consumes: `cfg.home`（`COOLIE_HOME ?? ~/.coolie`）、`path.join(cfg.home, "coolie.sock")`（main.ts:108 现拼法）。
- Produces:
  - `packages/server/src/daemon/socket.ts`：
    - `SUN_PATH_MAX: number`——`process.platform === "darwin" ? 104 : 108`（`sockaddr_un.sun_path` 上限含结尾 NUL；实际可用字节 = `MAX - 1`）。
    - `sockPathByteLength(p: string): number` = `Buffer.byteLength(p, "utf8")`（非 ASCII home 也准）。
    - `assertSockPathFits(sockPath: string): void`——`sockPathByteLength >= SUN_PATH_MAX` 时 `throw new Error(...)`，消息含**实际字节长度 + 平台上限 + 出问题的路径 + 修复建议（设更短 COOLIE_HOME）**。
    - `sockPathWarning(sockPath: string): string | null`——达上限 `Math.floor(SUN_PATH_MAX * 0.9)`（≈93/97 字节）返回告警文案（供 doctor），否则 `null`。
  - `config.ts`：`CoolieConfig` 增 `readonly sockPath: string`（= `path.join(home, "coolie.sock")`），`main.ts` 与 doctor 都读它，消除两处各拼一次。

- [ ] **Step 1: 写失败测试**

`packages/server/test/daemon.socket.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { SUN_PATH_MAX, sockPathByteLength, assertSockPathFits, sockPathWarning } from "../src/daemon/socket.js"

describe("unix socket sun_path 上限守卫（N1）", () => {
  it("正常短路径：不抛、无警告", () => {
    const p = "/Users/x/.coolie/coolie.sock"
    expect(() => assertSockPathFits(p)).not.toThrow()
    expect(sockPathWarning(p)).toBeNull()
  })
  it("超限路径：assertSockPathFits 抛且消息含实际长度与上限", () => {
    const long = "/" + "a".repeat(SUN_PATH_MAX + 10) + "/coolie.sock"
    expect(sockPathByteLength(long)).toBeGreaterThanOrEqual(SUN_PATH_MAX)
    try { assertSockPathFits(long); throw new Error("should have thrown") }
    catch (e: any) {
      expect(e.message).toContain(String(sockPathByteLength(long)))
      expect(e.message).toContain(String(SUN_PATH_MAX))
      expect(e.message).toContain("COOLIE_HOME")
    }
  })
  it("接近上限（≥90%）：不抛但 sockPathWarning 返回文案", () => {
    const near = "/" + "b".repeat(Math.floor(SUN_PATH_MAX * 0.92)) + "/s.sock"
    expect(() => assertSockPathFits(near)).not.toThrow()
    expect(sockPathWarning(near)).not.toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/daemon.socket.test.ts`
Expected: FAIL——`daemon/socket.js` 不存在。

- [ ] **Step 3: 实现 socket guard**

`packages/server/src/daemon/socket.ts`：

```ts
/** AF_UNIX sockaddr_un.sun_path 上限（含结尾 NUL）：macOS 104、Linux 108。超限 bind 会静默截断/EINVAL。 */
export const SUN_PATH_MAX = process.platform === "darwin" ? 104 : 108

export const sockPathByteLength = (p: string): number => Buffer.byteLength(p, "utf8")

export const assertSockPathFits = (sockPath: string): void => {
  const len = sockPathByteLength(sockPath)
  if (len >= SUN_PATH_MAX)
    throw new Error(
      `unix socket 路径过长：${len} 字节 ≥ 平台上限 ${SUN_PATH_MAX}（${sockPath}）。` +
      `AF_UNIX 会静默截断该路径导致连接失败——请把 COOLIE_HOME 设到更短的目录（如 ~/.coolie）后重启。`,
    )
}

export const sockPathWarning = (sockPath: string): string | null => {
  const len = sockPathByteLength(sockPath)
  const soft = Math.floor(SUN_PATH_MAX * 0.9)
  return len >= soft
    ? `socket 路径 ${len} 字节，接近平台上限 ${SUN_PATH_MAX}（${sockPath}）——COOLIE_HOME 再长会 bind 失败`
    : null
}
```

- [ ] **Step 4: config 暴露 sockPath + main.ts listen 前守卫**

`packages/server/src/config.ts`：`CoolieConfig` 加 `readonly sockPath: string`，`loadConfig` 返回体加 `sockPath: path.join(home, "coolie.sock")`（紧挨 `serverInfoPath`）。

`packages/server/src/main.ts`：把 line 108 `const sockPath = path.join(cfg.home, "coolie.sock")` 改为 `const sockPath = cfg.sockPath`；并在 `server.listen(0, ...)` 之前（约 line 187 `fs.mkdirSync(cfg.home, ...)` 之后）加：

```ts
  assertSockPathFits(sockPath) // N1：路径超限则响亮报错而非 bind 时静默截断
```

顶部 import 加 `import { assertSockPathFits } from "./daemon/socket.js"`。

- [ ] **Step 5: doctor 增 socket 警告**

`packages/cli/src/main.ts` doctor（约 line 268 log 检查之后、`for (const bin ...)` 之前）加：

```ts
  const sockPath = path.join(h, "coolie.sock")
  const sockWarn = sockPathWarning(sockPath)
  if (sockWarn) check("warn", "socket", sockWarn)
  else check("ok", "socket", `${sockPathByteLength(sockPath)}/${SUN_PATH_MAX} 字节`)
```

顶部 import 加 `import { sockPathWarning, sockPathByteLength, SUN_PATH_MAX } from "@coolie/server"`（若 `@coolie/server` 未 re-export socket helpers，在 server 包 `index.ts` 补 `export * from "./daemon/socket.js"` 或按现有 re-export 风格加三个具名导出）。

- [ ] **Step 6: 跑测试确认通过 + 双 typecheck**

Run: `cd packages/server && bun run vitest run test/daemon.socket.test.ts test/config.test.ts && bun run typecheck && cd ../cli && bun run typecheck`
Expected: PASS（`config.test.ts` 若断言 config 形状，`sockPath` 新字段可能需补断言）；双 typecheck 清洁。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/daemon/socket.ts packages/server/src/config.ts packages/server/src/main.ts packages/cli/src/main.ts packages/server/test/daemon.socket.test.ts
git commit -m "feat(daemon): 过长 socket 路径响亮报错 + doctor 警告（N1）"
```

---

### Task 5: `/input` 忙时 enqueue（替换 F6 REMOVAL MARKER）

**Files:**
- Modify: `packages/server/src/http/app.ts`（`/input` 段的 F6 守卫 → enqueue）
- Modify: `packages/server/src/main.ts`（装配 `QueueRepoLive` 进 runtime Layer）
- Modify: `packages/server/src/workspace/lifecycle.ts`（M2：delete 拆除路径接 `QueueRepo.clearWorkspace`；archive **保留**队列行）
- Modify: `packages/protocol/src/routes.ts`（append `/input` 描述补队列语义——可选文字）
- Test: `packages/server/test/http.input.test.ts`（追加 enqueue 用例）、`packages/server/test/lifecycle-queue.test.ts`（新建：delete 清队列 / archive 保留）

**Interfaces:**
- Consumes: `QueueRepo`（Task 1）；`/input` 现有 `{ ws, tab, engine }` 解析（app.ts:580–588）；`send(res, code, body)`；`err`；lifecycle 的 `teardownRuntime(ws, reason)`（lifecycle.ts:61，archive/delete 共用拆除点，已有 `Effect.serviceOption(TabsRepo)` 可选注入先例——`reason === "delete"` 时 `removeByWorkspace`）。
- Produces:
  - `/input` 的 F6 分支（app.ts:590–594）替换为——`mode==="send" && engine.nativeQueue===false && (tab.status==="working" || 队列非空)` 时 `QueueRepo.enqueue` 并回 **202** `{ queued: true, id, position }`（而非 409）。其余 mode（interrupt/interrupt-send/insert）与 claude（`nativeQueue=true`）仍走原投递路径。`AppServices` DI union 加 `QueueRepo`。
  - **队列生命周期语义（M2 决定，与 tabs 行先例逐字对齐）**：`delete` → `clearWorkspace`（队列行随 workspace 消失，同 `tabsOpt.removeByWorkspace` 先例）；`archive` → **保留**队列行（tabs 行 archive 也保留——unarchive 后队列自动续投：drainer 的 `wsActive` 门在归档期拒投，恢复 active 后下个 turn-complete 照常 FIFO）。接线：lifecycle 加 `const queueOpt = yield* Effect.serviceOption(QueueRepo)`（同 `tabsOpt` 先例），`teardownRuntime` 的 delete 分支追加 `clearWorkspace`。

- [ ] **Step 1: 写失败测试**

`packages/server/test/http.input.test.ts`（沿用现有装配；seed 一个 `engineId=codex`、engine tab `status="working"` 的 active workspace，注入含 codex 的 registry + `QueueRepoLive`）：

```ts
it("codex 忙时 send → 202 入队（不再 409）", async () => {
  const r = await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "send", text: "排队的话" }, token)
  expect(r.status).toBe(202)
  expect(r.body.queued).toBe(true)
  expect(r.body.position).toBe(1)
  // 事件 prompt.queued 落库
  const evs = await getEvents(base, codexWsId, token)
  expect(evs.some((e: any) => e.type === "prompt.queued")).toBe(true)
})

it("codex 队列非空时即使 idle 的 send 也追加入队（保 FIFO）", async () => {
  await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "send", text: "一" }, token) // working → 入队
  await setTabStatus(codexWsId, "awaiting-input") // 模拟 turn 结束但 drainer 未接（本测试无 drainer）
  const r = await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "send", text: "二" }, token)
  expect(r.status).toBe(202) // 队列非空 → 追加而非插队直投
  expect(r.body.position).toBe(2)
})

it("codex 忙时 interrupt 仍放行（不入队）", async () => {
  const r = await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "interrupt", text: "" }, token)
  expect(r.status).not.toBe(202); expect(r.status).toBe(200)
})

it("claude（nativeQueue=true）忙时 send → 直投不入队", async () => {
  const r = await postRaw(base, `/workspaces/${claudeWsId}/input`, { mode: "send", text: "hi" }, token)
  expect(r.status).toBe(200) // 原生 mid-turn 队列，直投
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/http.input.test.ts -t 入队`
Expected: FAIL——现状 F6 守卫回 409（Plan 1 REMOVAL MARKER），无 enqueue、无 202。

- [ ] **Step 3: 替换 F6 守卫为 enqueue**

`packages/server/src/http/app.ts` 的 `/input` 段——把 Effect.gen 解析块补一个「队列是否非空」查询，并把 success 回调里的 F6 if 块（app.ts:590–594）整体替换：

Effect.gen 块（app.ts:580–588）改为一并解析 queued 计数：

```ts
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(inputRoute[1]!)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              const tab = yield* (yield* TabsRepo).findEngineTab(ws.id)
              if (!tab) return yield* new NotFoundError({ message: "无 engine tab" })
              const engine = (yield* EngineRegistry).get(tab.engineId ?? "claude")
              const queuedCount = (yield* (yield* QueueRepo).listQueued(ws.id)).length
              return { ws, tab, engine, queuedCount }
            }),
```

success 回调把 F6 if 块（`if (mode === "send" && tab.status === "working" && engine?.capabilities.nativeQueue === false) return send(res, 409, ...)`）替换为：

```ts
            async ({ ws, tab, engine, queuedCount }) => {
              // Plan 2：非 nativeQueue 引擎（codex）——忙时 or 队列非空时，send 进 server 端持久队列（FIFO），
              // turn-complete（drainer）后自动投递（spec §7.2）。interrupt/interrupt-send/insert 不入队（打断/插字即时生效）；
              // claude nativeQueue=true 恒直投（TUI 原生 mid-turn 队列）。
              const shouldQueue =
                mode === "send" && engine?.capabilities.nativeQueue === false &&
                (tab.status === "working" || queuedCount > 0)
              if (shouldQueue) {
                const q = await runtime(Effect.gen(function* () {
                  return yield* (yield* QueueRepo).enqueue({ workspaceId: ws.id, tabId: tab.id, text: body.text })
                }))
                if (Exit.isSuccess(q)) return send(res, 202, { queued: true, id: q.value.id, position: q.value.position })
                return err(res, 500, "Internal", "入队失败")
              }
              try {
                const target = `${tmuxSessionName(ws.id)}:${tab.tmuxWindow ?? 0}`
                await composerOps.input(target, { text: body.text, mode, skipStable: body.skipStable === true })
                await runtime(Effect.gen(function* () {
                  yield* (yield* EventsRepo).append({
                    workspaceId: ws.id, type: "composer.delivered",
                    payload: { mode, tabId: tab.id, chars: body.text.length },
                  })
                }))
                send(res, 200, { ok: true })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
```

> `runtime(...)` 返回 `Exit`（承 M1 `Runtime` 用法）——若本文件既有 `runtime` 帮手是「成功直接返回值、失败走 onError」的变体，按其实际签名解包（grep 本文件 `runtime(` 既有用法对齐）。顶部确保 import 了 `QueueRepo`（`../repo/queue.js`）与 `Exit`（若用到）。`AppServices` union（app.ts:31 一带）加 `| QueueRepo`。

- [ ] **Step 4: main.ts 装配 QueueRepoLive**

`packages/server/src/main.ts` 的 `appLayer` 组装（line 64–76）——**main.ts 没有裸 `db` 句柄**（`DbLive` 是 scoped Layer），`QueueRepoLive` 与 `TabsRepoLive` 同排进 repos 的 `Layer.mergeAll`（它消费下方已 provideMerge 的 `DbLive`/`EventsBusLive`，与 TabsRepoLive 完全同构）：

```ts
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive, QueueRepoLive)),
```

（即把 line 72 的 mergeAll 追加一项。）顶部 import 加 `import { QueueRepo, QueueRepoLive } from "./repo/queue.js"`。（`createApp` 无需改——`QueueRepo` 经 runtime Layer 提供；`QueueRepoLive` 排在 `WorkspaceLifecycleLive` 的 provideMerge 链**下方** → lifecycle 的 `serviceOption(QueueRepo)`（Step 5）在生产可解析。）

- [ ] **Step 5: lifecycle delete 路径清队列（M2）**

`packages/server/src/workspace/lifecycle.ts`——顶部 import 加 `import { QueueRepo } from "../repo/queue.js"`；`WorkspaceLifecycleLive` 的 gen 块里、`const tabsOpt = yield* Effect.serviceOption(TabsRepo)`（line 52）旁加：

```ts
    const queueOpt = yield* Effect.serviceOption(QueueRepo) // Plan 2：可选注入，单测不提供时 no-op（同 tabsOpt 先例）
```

`teardownRuntime`（line 61–68）的 delete 分支扩为（archive 分支**不**清——与 tabs 行「archive 保留、delete 删」逐字对齐；unarchive 后队列续投）：

```ts
        if (reason === "delete" && Option.isSome(tabsOpt)) yield* tabsOpt.value.removeByWorkspace(ws.id).pipe(Effect.ignore)
        if (reason === "delete" && Option.isSome(queueOpt)) yield* queueOpt.value.clearWorkspace(ws.id).pipe(Effect.ignore)
```

测试 `packages/server/test/lifecycle-queue.test.ts`（**照抄 `lifecycle-archive.test.ts` 的 `makeEnv` 装配**——fake git + `PostCreateHooksEmpty`，repos 的 mergeAll 追加 `QueueRepoLive`，`AnyServices` union 加 `QueueRepo`）：

```ts
import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { Effect, Layer, Exit, Cause } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { QueueRepo, QueueRepoLive } from "../src/repo/queue.js"
import { GitService } from "../src/git/service.js"
import { SetupRunner, type SetupRunnerShape } from "../src/workspace/setup.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive, PostCreateHooksEmpty } from "../src/workspace/lifecycle.js"
import { makeFakeGit } from "./helpers/fake-git.js"

type AnyServices = WorkspaceLifecycle | ProjectsRepo | QueueRepo

const makeEnv = () => {
  const db = new Database(":memory:"); runMigrations(db)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lq-home-"))
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lq-ws-"))
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lq-repo-"))
  fs.mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true })
  const cfg = { home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"), workspacesRoot: wsRoot }
  const fake = makeFakeGit()
  const setup: SetupRunnerShape = { run: () => Effect.succeed([]) }
  const layer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(GitService, fake.git), Layer.succeed(SetupRunner, setup), PostCreateHooksEmpty,
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, QueueRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(Layer.succeed(CoolieConfig, cfg)),
  )
  const run = <A, E>(eff: Effect.Effect<A, E, AnyServices>) =>
    Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<A, E, never>)
  const ok = async <A, E>(eff: Effect.Effect<A, E, AnyServices>): Promise<A> => {
    const exit = await run(eff)
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    return exit.value
  }
  return { repoRoot, ok }
}
const setupActiveWithQueue = async (env: ReturnType<typeof makeEnv>) =>
  env.ok(Effect.gen(function* () {
    const p = yield* (yield* ProjectsRepo).add(env.repoRoot)
    const ws = yield* (yield* WorkspaceLifecycle).create({ projectId: p.id, branchSlug: "work" })
    yield* (yield* QueueRepo).enqueue({ workspaceId: ws.id, tabId: "t1", text: "排队一" })
    yield* (yield* QueueRepo).enqueue({ workspaceId: ws.id, tabId: "t1", text: "排队二" })
    return ws
  }))

describe("workspace 生命周期 × prompt 队列（M2）", () => {
  it("delete → 队列行随 workspace 清空", async () => {
    const env = makeEnv()
    const ws = await setupActiveWithQueue(env)
    await env.ok(Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).delete(ws.id) }))
    const left = await env.ok(Effect.gen(function* () { return yield* (yield* QueueRepo).listQueued(ws.id) }))
    expect(left).toHaveLength(0)
  })
  it("archive → 队列行保留（tabs 行先例；unarchive 后续投）", async () => {
    const env = makeEnv()
    const ws = await setupActiveWithQueue(env)
    await env.ok(Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).archive(ws.id) }))
    const kept = await env.ok(Effect.gen(function* () { return yield* (yield* QueueRepo).listQueued(ws.id) }))
    expect(kept.map((q) => q.text)).toEqual(["排队一", "排队二"])
  })
})
```

- [ ] **Step 6: protocol 路由描述补队列语义（可选文字）**

`packages/protocol/src/routes.ts` 的 `/input` 描述（line 29）补一句：

```ts
  { method: "POST",   path: "/workspaces/:id/input",       description: "composer 投递 {text, mode: send|interrupt-send|insert|interrupt, skipStable?}；非 nativeQueue 引擎忙时 send 入队回 202 {queued,id,position}" },
```

- [ ] **Step 7: 跑测试确认通过 + 双 typecheck**

Run: `cd packages/server && bun run vitest run test/http.input.test.ts test/lifecycle-queue.test.ts && bun run typecheck && cd ../protocol && bun run typecheck`
Expected: PASS（M1 既有 `/input` 测试——claude 直投、interrupt 放行——行为不变；lifecycle 既有测试不提供 QueueRepo → serviceOption no-op 照常绿）；双 typecheck 清洁。

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/http/app.ts packages/server/src/main.ts packages/server/src/workspace/lifecycle.ts packages/protocol/src/routes.ts packages/server/test/http.input.test.ts packages/server/test/lifecycle-queue.test.ts
git commit -m "feat(server): /input 忙时入队回 202（替 F6 marker）+ delete 清队列/archive 保留（M2）"
```

---

### Task 6: queue drainer — turn-complete 后按 FIFO 投递下一条

**Files:**
- Create: `packages/server/src/engine/queue-drain.ts`
- Modify: `packages/server/src/main.ts`（装配 `startQueueDrainer`，shutdown 停）
- Test: `packages/server/test/engine.queue-drain.test.ts`

**Interfaces:**
- Consumes: `EventsBus`（`EventEmitter`，`EVENT_CHANNEL="event"` 上 `CoolieEvent`）；`QueueRepo.peekNext`/`remove`；`TabsRepo.findEngineTab`；`WorkspacesRepo.get`（拿 `ws.path` 建 tmux target）；`EngineRegistry`（查 `nativeQueue`）；`composerOps.input`。
- Produces:
  - `DrainDeps`：
    ```ts
    export interface DrainDeps {
      readonly resolveEngineTab: (wsId: string) => Promise<{ tab: Tab; wsPath: string; wsActive: boolean; nativeQueue: boolean } | null>
      readonly peekNext: (wsId: string) => Promise<QueuedPrompt | null>
      readonly deliver: (target: string, text: string) => Promise<void>
      readonly onDelivered: (queueId: number) => Promise<void>
    }
    ```
  - `drainWorkspace(deps: DrainDeps, wsId: string): Promise<boolean>`——纯逻辑：解析 engine tab，仅当 `wsActive && nativeQueue===false` 且 `peekNext` 非空**且 tab 非 working**（turn 已结束）时，投递 `composerOps.input(target, {text, mode:"send", skipStable:false})` 成功后 `onDelivered(queueId)`（=`QueueRepo.remove(id,"delivered")`），返回是否投递了一条。**每次只投一条**（投出即开新 turn，下个 turn-complete 再排下一条）。
  - `startQueueDrainer(bus: EventEmitter, deps: DrainDeps): (() => void)`——订阅 `EVENT_CHANNEL`，对 `type === "tab.status.changed" && payload.status ∈ {"awaiting-input","idle"}` 的事件按 `workspaceId` 触发 `drainWorkspace`；**per-workspace 串行锁**（一个 ws 的 drain in-flight 时后到事件不并发，用 `Map<wsId, Promise>` 链式排队）；返回 `stop`（`bus.off`）。
  - **M4 源门控（interrupt 绝不自动投队列）**：`tab.status.changed` 的 payload 带 `source`（tabs.ts `setStatus` 既有产出 `{tabId,status,source}`）。**`source === "interrupt"`（T8 的 N2 乐观收敛所标）→ 不触发 drain**——用户按 Esc 是「我要停」，此刻自动把下一条排队 prompt 砸进 pane 恰是用户不想要的。自然 turn-complete 源（`"hook"`/`"notify"`/`"poller"`）照常 drain。这是**无状态**门（读事件自带的 source），不需要 one-shot 抑制标志——interrupt 产生的 awaiting-input 恰好只有那一条事件，队列在下个**自然** turn-complete（用户手动再发一条并跑完）恢复 FIFO 投递。

- [ ] **Step 1: 写失败测试**

`packages/server/test/engine.queue-drain.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"
import { drainWorkspace, startQueueDrainer, type DrainDeps } from "../src/engine/queue-drain.js"
import { EVENT_CHANNEL } from "../src/events/bus.js"

const mkDeps = (over: Partial<DrainDeps> & { next?: any; nativeQueue?: boolean; status?: string; wsActive?: boolean }): DrainDeps => ({
  resolveEngineTab: async () => ({
    tab: { id: "t1", tmuxWindow: 0, status: over.status ?? "awaiting-input" } as any,
    wsPath: "/w", wsActive: over.wsActive ?? true, nativeQueue: over.nativeQueue ?? false,
  }),
  peekNext: async () => (over.next ?? null),
  deliver: over.deliver ?? (async () => {}),
  onDelivered: over.onDelivered ?? (async () => {}),
})

describe("drainWorkspace", () => {
  it("codex + turn 结束 + 队列非空 → 投一条并 onDelivered", async () => {
    const deliver = vi.fn(async () => {}); const onDelivered = vi.fn(async () => {})
    const deps = mkDeps({ next: { id: 7, text: "排队的话" }, deliver, onDelivered, status: "awaiting-input" })
    expect(await drainWorkspace(deps, "w1")).toBe(true)
    expect(deliver).toHaveBeenCalledWith("coolie-w1:0", "排队的话")
    expect(onDelivered).toHaveBeenCalledWith(7)
  })
  it("tab 仍 working → 不投（turn 未结束）", async () => {
    const deliver = vi.fn(async () => {})
    expect(await drainWorkspace(mkDeps({ next: { id: 1, text: "x" }, deliver, status: "working" }), "w1")).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })
  it("nativeQueue 引擎（claude）→ 不投（不归 server 队列管）", async () => {
    const deliver = vi.fn(async () => {})
    expect(await drainWorkspace(mkDeps({ next: { id: 1, text: "x" }, deliver, nativeQueue: true }), "w1")).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })
  it("队列空 → 不投", async () => {
    expect(await drainWorkspace(mkDeps({ next: null }), "w1")).toBe(false)
  })
  it("ws 非 active（归档）→ 不投", async () => {
    const deliver = vi.fn(async () => {})
    expect(await drainWorkspace(mkDeps({ next: { id: 1, text: "x" }, deliver, wsActive: false }), "w1")).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })
  it("deliver 抛 → 不 onDelivered（下个 turn 重试）", async () => {
    const onDelivered = vi.fn(async () => {})
    const deps = mkDeps({ next: { id: 1, text: "x" }, deliver: async () => { throw new Error("tmux") }, onDelivered })
    await expect(drainWorkspace(deps, "w1")).resolves.toBe(false)
    expect(onDelivered).not.toHaveBeenCalled()
  })
})

describe("startQueueDrainer", () => {
  it("订阅 tab.status.changed→awaiting-input 触发 drain；其它状态不触发", async () => {
    const calls: string[] = []
    const bus = new EventEmitter()
    const deps = mkDeps({ next: { id: 1, text: "x" }, deliver: async (_t, _x) => { calls.push("deliver") } })
    const stop = startQueueDrainer(bus, deps)
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "working", source: "hook" } })
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "awaiting-input", source: "hook" } })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual(["deliver"]) // 只 awaiting-input 触发
    stop()
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "awaiting-input", source: "hook" } })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual(["deliver"]) // stop 后不再触发
  })

  it("M4：source=interrupt 的 awaiting-input 不 drain；自然 turn-complete（hook/notify/poller）才 drain", async () => {
    const calls: string[] = []
    const bus = new EventEmitter()
    const deps = mkDeps({ next: { id: 1, text: "x" }, deliver: async () => { calls.push("deliver") } })
    const stop = startQueueDrainer(bus, deps)
    // interrupt 乐观收敛（T8）产生的事件：绝不自动把排队 prompt 砸进刚被打断的 pane
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "awaiting-input", source: "interrupt" } })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual([]) // interrupt → 不 dequeue
    // 自然 turn-complete：notify（codex ≤0.139 lane）与 poller（mtime 兜底）都恢复投递
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "awaiting-input", source: "notify" } })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual(["deliver"])
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "awaiting-input", source: "poller" } })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual(["deliver", "deliver"])
    stop()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.queue-drain.test.ts`
Expected: FAIL——`engine/queue-drain.js` 不存在。

- [ ] **Step 3: 实现 drainer**

`packages/server/src/engine/queue-drain.ts`：

```ts
import type { EventEmitter } from "node:events"
import type { Tab, CoolieEvent } from "@coolie/protocol"
import { tmuxSessionName } from "@coolie/protocol"
import { EVENT_CHANNEL } from "../events/bus.js"
import type { QueuedPrompt } from "../repo/queue.js"

export interface DrainDeps {
  readonly resolveEngineTab: (wsId: string) => Promise<{ tab: Tab; wsPath: string; wsActive: boolean; nativeQueue: boolean } | null>
  readonly peekNext: (wsId: string) => Promise<QueuedPrompt | null>
  readonly deliver: (target: string, text: string) => Promise<void>
  readonly onDelivered: (queueId: number) => Promise<void>
}

/** turn-complete 后投一条：仅 active + 非 nativeQueue + tab 非 working + 队列非空时投。投一条即返回
 * （投出开新 turn，下个 turn-complete 再排下一条，天然串行、零并发写 PTY）。deliver 抛 → 不 onDelivered。 */
export const drainWorkspace = async (deps: DrainDeps, wsId: string): Promise<boolean> => {
  const et = await deps.resolveEngineTab(wsId)
  if (!et || !et.wsActive || et.nativeQueue !== false) return false
  if (et.tab.status === "working") return false // turn 未真正结束（防抖动状态误触）
  const next = await deps.peekNext(wsId)
  if (!next) return false
  const target = `${tmuxSessionName(wsId)}:${et.tab.tmuxWindow ?? 0}`
  await deps.deliver(target, next.text) // 抛则整体作废：不 onDelivered，条目留队，下个 turn-complete 重试
  await deps.onDelivered(next.id)
  return true
}

export const startQueueDrainer = (bus: EventEmitter, deps: DrainDeps): (() => void) => {
  const chains = new Map<string, Promise<void>>() // per-ws 串行锁：同一 ws 的 drain 排队不并发
  const onEvent = (ev: CoolieEvent): void => {
    if (ev.type !== "tab.status.changed" || !ev.workspaceId) return
    const p = ev.payload as { status?: string; source?: string } | null
    const status = p?.status
    if (status !== "awaiting-input" && status !== "idle") return
    // M4：interrupt 乐观收敛（T8）不是自然 turn-complete——用户刚说「停」，绝不自动把下一条排队 prompt
    // 砸进 pane。队列在下个自然 turn-complete（hook/notify/poller 源）恢复 FIFO。
    if (p?.source === "interrupt") return
    const wsId = ev.workspaceId
    const prev = chains.get(wsId) ?? Promise.resolve()
    const nextChain = prev.then(() => drainWorkspace(deps, wsId).then(() => {}, () => {}))
    chains.set(wsId, nextChain)
    void nextChain.finally(() => { if (chains.get(wsId) === nextChain) chains.delete(wsId) })
  }
  bus.on(EVENT_CHANNEL, onEvent)
  return () => bus.off(EVENT_CHANNEL, onEvent)
}
```

- [ ] **Step 4: main.ts 装配 startQueueDrainer**

`packages/server/src/main.ts`——`const bus = Context.get(runtimeCtx, EventsBus)`（line 78）之后、`startTranscriptPoller` 装配附近，加：

```ts
  const stopDrainer = startQueueDrainer(bus, {
    resolveEngineTab: async (wsId) => {
      const exit = await runtime(Effect.gen(function* () {
        const ws = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
        if (Option.isNone(ws)) return null
        const tab = yield* (yield* TabsRepo).findEngineTab(wsId)
        if (!tab) return null
        const engine = (yield* EngineRegistry).get(tab.engineId ?? "claude") // L1：经 DI 取注册表（AppServices 已含 EngineRegistry）
        return { tab, wsPath: ws.value.path, wsActive: ws.value.status === "active", nativeQueue: engine?.capabilities.nativeQueue === true }
      }))
      return Exit.isSuccess(exit) ? exit.value : null
    },
    peekNext: async (wsId) => {
      const exit = await runtime(Effect.gen(function* () { return yield* (yield* QueueRepo).peekNext(wsId) }))
      return Exit.isSuccess(exit) ? exit.value : null
    },
    deliver: (target, text) => composerOps.input(target, { text, mode: "send", skipStable: false }),
    onDelivered: async (queueId) => {
      await runtime(Effect.gen(function* () { yield* (yield* QueueRepo).remove(queueId, "delivered") }))
    },
  })
```

`shutdown()`（line 121 `stopPoller()` 附近）加 `stopDrainer()`。顶部 import 加 `import { startQueueDrainer } from "./engine/queue-drain.js"`，effect import 补 `Option`（main.ts 现只有 `Context, Effect, Layer, Exit, Scope`）；`QueueRepo` 已随 T5 import。`composerOps`：main.ts:165 现是 `createApp` 参数里内联的 `makeComposerOps(tmuxSvc)`——上提为 `const composerOps = makeComposerOps(tmuxSvc)`（tmuxSvc 在 line 87 已建）置于 drainer 装配之前，`createApp` 改传该变量，复用同一实例。

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd packages/server && bun run vitest run test/engine.queue-drain.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/engine/queue-drain.ts packages/server/src/main.ts packages/server/test/engine.queue-drain.test.ts
git commit -m "feat(server): queue drainer——turn-complete 后按 FIFO 自动投递下一条"
```

---

### Task 7: 队列查看 + 撤回端点（`GET`/`DELETE /workspaces/:id/queue`）

**Files:**
- Modify: `packages/server/src/http/app.ts`（+GET/DELETE queue 路由）
- Modify: `packages/protocol/src/routes.ts`（append 两条路由）
- Test: `packages/server/test/http.queue.test.ts`

**Interfaces:**
- Consumes: `QueueRepo.listQueued`/`remove`；`send`/`err`；现有 http 路由匹配风格（`url.pathname.match`）。
- Produces:
  - `GET /workspaces/:id/queue` → `200 { queue: Array<{ id, text, mode, createdAt, position }> }`（position=1-based 顺位）。
  - `DELETE /workspaces/:id/queue/:queueId` → 撤回一条 queued：命中 `remove(id,"withdrawn")` → `200 { withdrawn: true }`；已不存在（drain 抢先/重复撤回）→ `404 { code:"NotFound", message }`。校验 `:queueId` 为数字，否则 `400 Validation`。

- [ ] **Step 1: 写失败测试**

`packages/server/test/http.queue.test.ts`：

```ts
it("GET /queue 列出 queued 附 1-based position", async () => {
  await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "send", text: "一" }, token) // working → 入队
  await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "send", text: "二" }, token)
  const r = await getRaw(base, `/workspaces/${codexWsId}/queue`, token)
  expect(r.status).toBe(200)
  expect(r.body.queue.map((q: any) => [q.position, q.text])).toEqual([[1, "一"], [2, "二"]])
})

it("DELETE /queue/:id 撤回一条 → 发 prompt.withdrawn；再撤同一条 → 404", async () => {
  const enq = await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "send", text: "撤我" }, token)
  const id = enq.body.id
  const r = await delRaw(base, `/workspaces/${codexWsId}/queue/${id}`, token)
  expect(r.status).toBe(200); expect(r.body.withdrawn).toBe(true)
  const evs = await getEvents(base, codexWsId, token)
  expect(evs.some((e: any) => e.type === "prompt.withdrawn")).toBe(true)
  const again = await delRaw(base, `/workspaces/${codexWsId}/queue/${id}`, token)
  expect(again.status).toBe(404)
})

it("DELETE /queue/:id 非数字 id → 400", async () => {
  const r = await delRaw(base, `/workspaces/${codexWsId}/queue/abc`, token)
  expect(r.status).toBe(400)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/http.queue.test.ts`
Expected: FAIL——路由不存在（回 404 `no route`）。

- [ ] **Step 3: 加 GET/DELETE queue 路由**

`packages/server/src/http/app.ts`——在 `/input` 路由匹配之前（或紧邻，`return err(res, 404, ...)` 兜底之前）加：

```ts
        const queueList = url.pathname.match(/^\/workspaces\/([^/]+)\/queue$/)
        if (req.method === "GET" && queueList) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const items = yield* (yield* QueueRepo).listQueued(queueList[1]!)
              return { queue: items.map((q, i) => ({ id: q.id, text: q.text, mode: q.mode, createdAt: q.createdAt, position: i + 1 })) }
            }),
            (body) => send(res, 200, body),
            onError,
          )
        }
        const queueDel = url.pathname.match(/^\/workspaces\/([^/]+)\/queue\/([^/]+)$/)
        if (req.method === "DELETE" && queueDel) {
          const qid = Number(queueDel[2])
          if (!Number.isInteger(qid)) return err(res, 400, "Validation", "queueId 必须是整数")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const removed = yield* (yield* QueueRepo).remove(qid, "withdrawn")
              if (removed === null) return yield* new NotFoundError({ message: "队列条目不存在（已投递或已撤回）" })
              return { withdrawn: true }
            }),
            (body) => send(res, 200, body),
            onError,
          )
        }
```

（`NotFoundError` → 404 由既有 `errorFromCause` 映射；`runRoute`/`onError` 沿用本文件既有帮手。）

- [ ] **Step 4: protocol 路由追加**

`packages/protocol/src/routes.ts` 的 `ROUTES` 数组末尾（`/input` 之后）追加：

```ts
  { method: "GET",    path: "/workspaces/:id/queue",          description: "列出 server 端 prompt 队列（非 nativeQueue 引擎忙时排队；含 1-based position）" },
  { method: "DELETE", path: "/workspaces/:id/queue/:queueId", description: "撤回队列中一条 prompt（仅 queued 状态可撤；已投递/不存在回 404）" },
```

- [ ] **Step 5: 跑测试确认通过 + 双 typecheck**

Run: `cd packages/server && bun run vitest run test/http.queue.test.ts && bun run typecheck && cd ../protocol && bun run typecheck`
Expected: PASS；双 typecheck 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/http/app.ts packages/protocol/src/routes.ts packages/server/test/http.queue.test.ts
git commit -m "feat(server): 队列查看 GET /queue + 撤回 DELETE /queue/:id（prompt.withdrawn）"
```

---

### Task 8: N2 + H1 — interrupt 乐观收敛 + monitor 授权窗按引擎能力门控

**Files:**
- Modify: `packages/server/src/repo/tabs.ts`（`TabStatusSource` + `"notify" | "interrupt"`——纯类型加宽）
- Modify: `packages/server/src/engine/monitor.ts`（H1：+`NOTIFY_AUTHORITY_MS`；`decideStatusFromMtime` 授权窗入参化；`pollOnce` 按 `engine.capabilities.hooks` 传窗）
- Modify: `packages/server/src/http/app.ts`（`/input` interrupt/interrupt-send 分支：codex working 时乐观置 awaiting-input，source=`"interrupt"`）
- Test: `packages/server/test/engine.monitor.test.ts`（H1 授权窗用例）、`packages/server/test/http.input.test.ts`（追加 N2 用例）

**Interfaces:**
- Consumes: `/input` 现有 `{ ws, tab, engine }` 解析；`TabsRepo.setStatus`/`touchHookAt`；`composerOps.input`；monitor 既有 `decideStatusFromMtime`/`pollOnce`（`pollOnce` 已解析 `engine`——monitor.ts:41）。
- Produces:
  - `TabStatusSource = "hook" | "poller" | "wrapper" | "heal" | "notify" | "interrupt"`（tabs.ts:21 加宽；`"notify"` 供 T9、`"interrupt"` 供本 task + T6 的 M4 门控）。
  - **H1 授权窗门控**（单一仲裁点纪律不破——推导逻辑仍只在 `decideStatusFromMtime` 一处，只是授权窗成为入参）：
    - `export const NOTIFY_AUTHORITY_MS = 5_000`——无真 hooks 引擎的 lastHookAt 授权窗：刚够护过「乐观置状后 rollout mtime 仍 fresh（≤3s ACTIVE 窗 + 2s 轮询周期）会把状态回翻」的抖动；**5s 后 mtime 全权接管**——30s 静默安全网、N2「没真停下则纠回 working」都在 5–7s 内生效，绝不被 `HOOK_AUTHORITY_MS`（10min）压制。
    - `decideStatusFromMtime` 入参加 `readonly hookAuthorityMs?: number`（缺省 `HOOK_AUTHORITY_MS`，既有调用/测试语义不变）。
    - `pollOnce` 传 `hookAuthorityMs: engine.capabilities.hooks ? HOOK_AUTHORITY_MS : NOTIFY_AUTHORITY_MS`——claude 与版本门控后的 codex≥0.144（T9）用 10min（真 hooks 信号可信），无-hooks codex（notify/interrupt 是 lastHookAt 唯二写入者）用 5s。
  - **N2 乐观收敛**：`mode ∈ {"interrupt","interrupt-send"}` 且 `engine.nativeQueue===false` 且 `tab.status==="working"` 时——投完 Esc 后 `touchHookAt(tab.id, Date.now())` + `setStatus(tab.id, "awaiting-input", "interrupt")`。`touchHookAt` 开 5s 短授权护住乐观值不被 fresh-mtime 立即回翻；5s 后 mtime 接管：codex 真没停 → mtime 持续 fresh → 纠回 `working`（≈5–7s，一个轮询周期内）；真停了 → mtime 静默落在 (3s,30s) 区间 → `decideStatusFromMtime` 返回 null → 乐观值留存。source=`"interrupt"` 让 T6 drainer 拒绝把队列 prompt 自动砸进刚被打断的 pane（M4）。

> **背景（roadmap N2 + 评审 H1）**：codex 无可用 hooks，裸 Esc 打断不产生回调 → tab 卡 `working` 到 mtime 静默满 30s。乐观收敛把「打断意图」立即反映到徽标。**H1 修正**：若 interrupt/notify 直接沿用 10min `HOOK_AUTHORITY_MS`（写 lastHookAt 后 monitor 让位 10min），一次 notify 就把 codex 的 30s mtime 安全网和 N2 自纠**压制 10 分钟**——mtime 主权名存实亡。故授权窗按能力分档：无真 hooks 的引擎只拿 5s 抖动保护，codex 保持 mtime-authoritative。

- [ ] **Step 1: 写失败测试（H1 monitor 授权窗）**

`packages/server/test/engine.monitor.test.ts` 追加（沿用该文件既有 `decideStatusFromMtime` 纯函数测试风格）：

```ts
import { decideStatusFromMtime, HOOK_AUTHORITY_MS, NOTIFY_AUTHORITY_MS, ACTIVE_THRESHOLD_MS, IDLE_THRESHOLD_MS } from "../src/engine/monitor.js"

describe("H1：授权窗按引擎能力门控", () => {
  const now = 10_000_000
  it("短窗（notify 打过 6s 前）：mtime 已接管——30s 静默照常 working→awaiting-input（安全网不被压制）", () => {
    expect(decideStatusFromMtime({
      nowMs: now, mtimeMs: now - IDLE_THRESHOLD_MS - 1_000, lastHookAtMs: now - 6_000,
      current: "working", hookAuthorityMs: NOTIFY_AUTHORITY_MS,
    })).toBe("awaiting-input")
  })
  it("短窗内（interrupt 乐观置状 2s 前 + mtime 仍 fresh）：让位 null——防抖动回翻", () => {
    expect(decideStatusFromMtime({
      nowMs: now, mtimeMs: now - 1_000, lastHookAtMs: now - 2_000,
      current: "awaiting-input", hookAuthorityMs: NOTIFY_AUTHORITY_MS,
    })).toBeNull()
  })
  it("短窗过后 codex 没真停：fresh mtime 纠回 working（N2 自纠 5–7s 内）", () => {
    expect(decideStatusFromMtime({
      nowMs: now, mtimeMs: now - 1_000, lastHookAtMs: now - NOTIFY_AUTHORITY_MS - 1_000,
      current: "awaiting-input", hookAuthorityMs: NOTIFY_AUTHORITY_MS,
    })).toBe("working")
  })
  it("缺省窗 = HOOK_AUTHORITY_MS：既有语义不变（hook 打过 6s 前 → 仍让位）", () => {
    expect(decideStatusFromMtime({
      nowMs: now, mtimeMs: now - IDLE_THRESHOLD_MS - 1_000, lastHookAtMs: now - 6_000, current: "working",
    })).toBeNull() // 6s < 10min：让位（无 hookAuthorityMs 入参时行为与 M1 逐字一致）
  })
})
```

- [ ] **Step 2: 写失败测试（N2 http 层）**

`packages/server/test/http.input.test.ts` 追加：

```ts
it("N2：codex working 时 interrupt → 乐观置 awaiting-input（source=interrupt）", async () => {
  await setTabStatus(codexWsId, "working")
  await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "interrupt", text: "" }, token)
  const tab = await getEngineTab(base, codexWsId, token)
  expect(tab.status).toBe("awaiting-input")
  const evs = await getEvents(base, codexWsId, token)
  const st = evs.filter((e: any) => e.type === "tab.status.changed").at(-1)
  expect((st.payload as any).source).toBe("interrupt") // M4：drainer 靠它拒绝 interrupt 后自动投队列
})

it("N2：claude interrupt 不乐观改状态（nativeQueue，交给 hooks）", async () => {
  await setTabStatus(claudeWsId, "working")
  await postRaw(base, `/workspaces/${claudeWsId}/input`, { mode: "interrupt", text: "" }, token)
  const tab = await getEngineTab(base, claudeWsId, token)
  expect(tab.status).toBe("working") // claude 靠 Stop hook 收敛，不乐观改
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.monitor.test.ts test/http.input.test.ts -t "H1|N2"`
Expected: FAIL——`NOTIFY_AUTHORITY_MS` 未导出（import 编译错）；interrupt 现只投 Esc 不改状态。

- [ ] **Step 4: 实现——tabs 源加宽 + monitor 授权窗 + interrupt 收敛**

`packages/server/src/repo/tabs.ts` line 21：

```ts
export type TabStatusSource = "hook" | "poller" | "wrapper" | "heal" | "notify" | "interrupt"
```

`packages/server/src/engine/monitor.ts`——常量区加一行、`decideStatusFromMtime` 与 `pollOnce` 改为：

```ts
export const HOOK_AUTHORITY_MS = 10 * 60_000
/** H1：无真 hooks 引擎（codex ≤0.139——notify/interrupt 是 lastHookAt 唯二写入者）的短授权窗：
 * 只护过「乐观置状后 mtime 仍 fresh（3s ACTIVE + 2s 轮询）」的回翻抖动；之后 mtime 全权接管，
 * 30s 静默安全网与 N2 自纠不被 10min 压制——codex 恒 mtime-authoritative。 */
export const NOTIFY_AUTHORITY_MS = 5_000
export const ACTIVE_THRESHOLD_MS = 3_000
export const IDLE_THRESHOLD_MS = 30_000

/** 纯仲裁（agent-deck sessionstatus 收敛教训：推导逻辑只此一处）：
 * hooks/notify 近期有信号 → 让位（窗长按引擎能力入参化，缺省 10min）；否则用转录 mtime 推断。 */
export const decideStatusFromMtime = (i: {
  readonly nowMs: number
  readonly mtimeMs: number | null
  readonly lastHookAtMs: number | null
  readonly current: TabStatus
  readonly hookAuthorityMs?: number
}): TabStatus | null => {
  const authorityMs = i.hookAuthorityMs ?? HOOK_AUTHORITY_MS
  if (i.lastHookAtMs !== null && i.nowMs - i.lastHookAtMs < authorityMs) return null
  if (i.mtimeMs === null) return null
  const age = i.nowMs - i.mtimeMs
  if (age <= ACTIVE_THRESHOLD_MS) return i.current === "working" ? null : "working"
  if (age >= IDLE_THRESHOLD_MS) return i.current === "working" ? "awaiting-input" : null
  return null
}
```

`pollOnce` 的 `decideStatusFromMtime` 调用（monitor.ts:45–47）改为：

```ts
    const next = decideStatusFromMtime({
      nowMs: now, mtimeMs: deps.statMtimeMs(p), lastHookAtMs: tab.lastHookAt, current: tab.status,
      hookAuthorityMs: engine.capabilities.hooks ? HOOK_AUTHORITY_MS : NOTIFY_AUTHORITY_MS,
    })
```

`packages/server/src/http/app.ts` `/input` success 回调——在 `composerOps.input(...)` 成功之后、`composer.delivered` append 之前加：

```ts
                await composerOps.input(target, { text: body.text, mode, skipStable: body.skipStable === true })
                // N2：codex（无 hooks）裸 Esc 打断不产生回调 → 徽标卡 working。interrupt 意图即「停」，乐观置
                // awaiting-input；touchHookAt 开 NOTIFY_AUTHORITY_MS(5s) 短窗护住乐观值不被 fresh-mtime 回翻；
                // 5s 后 mtime 接管——没真停会纠回 working（H1：窗短故安全网不被压制）。source="interrupt" 供
                // drainer 拒绝 interrupt 后自动投队列（M4）。
                if ((mode === "interrupt" || mode === "interrupt-send") &&
                    engine?.capabilities.nativeQueue === false && tab.status === "working") {
                  await runtime(Effect.gen(function* () {
                    yield* (yield* TabsRepo).touchHookAt(tab.id, Date.now())
                    yield* (yield* TabsRepo).setStatus(tab.id, "awaiting-input", "interrupt")
                  }))
                }
                await runtime(Effect.gen(function* () {
                  yield* (yield* EventsRepo).append({
                    workspaceId: ws.id, type: "composer.delivered",
                    payload: { mode, tabId: tab.id, chars: body.text.length },
                  })
                }))
```

（`engine`/`tab` 已在 Effect.gen 解析块的返回里——Task 5 的 `{ ws, tab, engine, queuedCount }` 已带 `engine`；直接用。）

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd packages/server && bun run vitest run test/engine.monitor.test.ts test/monitor.test.ts test/http.input.test.ts && bun run typecheck`
Expected: PASS（monitor 两个既有测试文件全绿——缺省窗语义未变；interrupt-send 也覆盖：先 Esc 收敛再投正文）；typecheck 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/repo/tabs.ts packages/server/src/engine/monitor.ts packages/server/src/http/app.ts packages/server/test/engine.monitor.test.ts packages/server/test/http.input.test.ts
git commit -m "fix(server): interrupt 乐观收敛（source=interrupt）+ monitor 授权窗按引擎能力门控（N2+H1）"
```

---

### Task 9: codex hooks 版本门控（≥0.144 走 hooks lane）+ `notify` 兜底 lane（≤0.139）+ `POST /notify/:engine`

**Files:**
- Create: `packages/server/src/engine/codex/version.ts`（`parseCodexVersion`/`codexVersionSupportsHooks`/`resolveCodexHooks`——版本探测 + `COOLIE_CODEX_HOOKS` 覆写）
- Modify: `packages/server/src/engine/registry.ts`（`EngineRegistryLive` 以 `resolveCodexHooks()` 门控 codex `capabilities.hooks`）
- Modify: `packages/server/src/engine/codex/adapter.ts`（`discoverCodexBinary` 加 `export`；launchCommand 注入 `-c notify=[...]`）
- Create: `packages/server/src/engine/codex/notify.ts`（`ensureNotifyScript`）
- Modify: `packages/server/src/engine/types.ts`（`LaunchCommandInput` +workspaceId?/home?）
- Modify: `packages/server/src/engine/session.ts`（launchCommand 调用点——仅 hooks off 引擎透传 workspaceId+home）
- Modify: `packages/server/src/engine/bootstrap.ts`（codex hooks off 时 `ensureNotifyScript`）
- Modify: `packages/server/src/http/app.ts`（+`POST /notify/:engine`）
- Modify: `packages/protocol/src/routes.ts`（append `/notify/:engine`）
- Test: `packages/server/test/engine.codex.version.test.ts`、`packages/server/test/engine.codex.notify.test.ts`、`packages/server/test/http.notify.test.ts`

**Interfaces:**
- Consumes: 探针报告 `.superpowers/sdd/codex-0144-hooks-probe.md`（0.144.1 实测：①features.hooks 默认开 ②项目级 `.codex/hooks.json` 被发现 ③`--dangerously-bypass-hook-trust` 直接激活未信任 hooks——三断点已修；**④ SessionStart 仍延迟到首 turn、rollout 仍懒落盘——未修**）；`TabsRepo.findEngineTab`/`setStatus`/`touchHookAt`；`EventsRepo.append`；`ensureHookScript` 三铁律范式（`claude/hooks.ts`）；`launchCommand` 调用点（session.ts:29）；既有 `/hooks/codex` + `injectCodexHooks` + `statusFromHookEvent`（M1 已就绪，仅被 `hooks:false` 挡住）。
- Produces（**双 lane，版本门控在 server 启动时定档，两 lane 都不是死代码**——本机 codex 版本决定走哪条，测试各自强制一条覆盖）：
  - `codex/version.ts`：
    - `parseCodexVersion(out: string): { major: number; minor: number } | null`——解析 `codex --version` 输出（`codex-cli 0.144.1` 形态）。
    - `codexVersionSupportsHooks(v): boolean`——`major > 0 || minor >= 144`。
    - `resolveCodexHooks(probe?: () => string | null): boolean`——`COOLIE_CODEX_HOOKS` env 覆写优先（`"1"/"true"` → true；`"0"/"false"` → false）；否则 `probe`（缺省 `execFileSync(discoverCodexBinary() ?? "codex", ["--version"], { timeout: 3000 })`，抛/超时 → `null`）→ 解析 → 判版本；探测失败**保守 false**（走 notify lane，功能不缺只是 turn-complete 靠 notify/mtime）。
  - `registry.ts`：`EngineRegistryLive` 构造时对 codex 打能力补丁——`resolveCodexHooks()` 为 true 则注册 `{ ...codexEngine, capabilities: { ...codexEngine.capabilities, hooks: true } }`，否则原样。**adapter 常量不改**（其 `hooks:false` 注释保留为 ≤0.139 事实记录）；server 启动一次定档。
  - **hooks lane（≥0.144，`capabilities.hooks=true`）**：bootstrap 既有 `engine.capabilities.hooks` 分支自动接管——`injectCodexHooks` 注入项目级 hooks.json、`--dangerously-bypass-hook-trust`（launchCommand 已带）激活、UserPromptSubmit/Stop 经 `/hooks/codex` 驱动状态 + `touchHookAt`（authority 窗 = `HOOK_AUTHORITY_MS`，T8 的 pollOnce 门控自动匹配）。**就绪门控不绑 SessionStart**（probe ④）——见 T10 的 gateOnHooks/armRolloutWatcher 调整。notify 注入在此 lane **不发生**（session.ts 只对 hooks-off 引擎透传 workspaceId/home）。
  - **notify lane（≤0.139 / 探测失败，`capabilities.hooks=false`）**：
    - `ensureNotifyScript(home: string, engineId: string): string`——写 `<home>/hooks/<engineId>-notify.sh`（0755），脚本 argv `$1=workspaceId $2=json`，读 `<home>/server.json` 拿 port/token，仅 `agent-turn-complete` 转发 `POST /notify/<engineId>?workspace=$1`，**永远 exit 0**、失败静默、绝不拉起 server（三铁律）。
    - `LaunchCommandInput` 加 `readonly workspaceId?: string; readonly home?: string`（可选，不破坏 claude/fake）。
    - codex `launchCommand`：非 resume 且 `workspaceId && home` 都在时，追加 `-c notify=["<home>/hooks/codex-notify.sh","<workspaceId>"]`（**per-session 注入，不污染全局 config.toml**）。
  - `POST /notify/:engine?workspace=<id>`（两 lane 共存的端点——hooks lane 下无人调用，无害）：读 body（codex agent-turn-complete JSON），`touchHookAt` + `setStatus(tab.id,"awaiting-input","notify")`（**source=`"notify"`，不是 `"hook"`**——H1：pollOnce 对 hooks-off 引擎只给 `NOTIFY_AUTHORITY_MS=5s` 授权窗，touchHookAt 护抖动而不压制 30s mtime 安全网；`"notify"` 源同时让事件可溯源、且属 T6 drainer 的放行源）+ append `engine.turn.finished`（payload 带 `source:"notify"`）。未知引擎/无 tab → 静默 `{ ok: true }`（同 hooks 端点）。**这条触发 T6 drainer + T12 通知/注意力**——codex 由此获得**即时** turn-complete（无需等 30s mtime）。

> **lane 定位**：hooks lane 是 ≥0.144 的主路（探针①②③实证可通）；notify lane 是 ≤0.139 的兜底主路；mtime 30s 是两 lane 共同的最终安全网——**核心不依赖任一即时信号**。`COOLIE_CODEX_HOOKS` 覆写供冒烟/回退：真机上强制切 lane 验证两条都活。

- [ ] **Step 1: 写失败测试（版本门控）**

`packages/server/test/engine.codex.version.test.ts`：

```ts
import { describe, it, expect, afterEach } from "vitest"
import { parseCodexVersion, codexVersionSupportsHooks, resolveCodexHooks } from "../src/engine/codex/version.js"

const ENV = "COOLIE_CODEX_HOOKS"
afterEach(() => { delete process.env[ENV] })

describe("codex hooks 版本门控（probe: 0.144 修复①②③，④仍延迟）", () => {
  it("parseCodexVersion 解析 codex-cli 0.144.1 形态", () => {
    expect(parseCodexVersion("codex-cli 0.144.1")).toEqual({ major: 0, minor: 144 })
    expect(parseCodexVersion("codex-cli 0.139.0\n")).toEqual({ major: 0, minor: 139 })
    expect(parseCodexVersion("garbage")).toBeNull()
  })
  it("codexVersionSupportsHooks：0.144 起 true、0.139 false、1.x true", () => {
    expect(codexVersionSupportsHooks({ major: 0, minor: 144 })).toBe(true)
    expect(codexVersionSupportsHooks({ major: 0, minor: 139 })).toBe(false)
    expect(codexVersionSupportsHooks({ major: 1, minor: 0 })).toBe(true)
  })
  it("resolveCodexHooks：env 覆写优先于探测", () => {
    process.env[ENV] = "1"
    expect(resolveCodexHooks(() => "codex-cli 0.139.0")).toBe(true)
    process.env[ENV] = "0"
    expect(resolveCodexHooks(() => "codex-cli 0.144.1")).toBe(false)
  })
  it("resolveCodexHooks：无覆写按探测版本；探测失败保守 false", () => {
    expect(resolveCodexHooks(() => "codex-cli 0.144.1")).toBe(true)
    expect(resolveCodexHooks(() => "codex-cli 0.139.0")).toBe(false)
    expect(resolveCodexHooks(() => null)).toBe(false)
  })
})
```

- [ ] **Step 2: 实现版本门控 + registry 接线**

`packages/server/src/engine/codex/version.ts`：

```ts
import { execFileSync } from "node:child_process"
import { discoverCodexBinary } from "./adapter.js"

/** probe（.superpowers/sdd/codex-0144-hooks-probe.md）：0.144.1 修复 hooks 三断点（默认开/项目级发现/
 * bypass flag 激活未信任 hooks）→ ≥0.144 可走 hooks lane。④（SessionStart 延迟到首 turn）未修——
 * 就绪门控不得绑 SessionStart（bootstrap 侧处理，见 T10）。 */
export const parseCodexVersion = (out: string): { major: number; minor: number } | null => {
  const m = /(\d+)\.(\d+)\.\d+/.exec(out)
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}

export const codexVersionSupportsHooks = (v: { major: number; minor: number }): boolean =>
  v.major > 0 || v.minor >= 144

const defaultProbe = (): string | null => {
  try {
    return execFileSync(discoverCodexBinary() ?? "codex", ["--version"], { encoding: "utf8", timeout: 3000 })
  } catch { return null } // 无 codex / 超时：保守走 notify lane
}

/** server 启动一次定档：COOLIE_CODEX_HOOKS 覆写（冒烟/回退开关）> `codex --version` 探测 > 保守 false。 */
export const resolveCodexHooks = (probe: () => string | null = defaultProbe): boolean => {
  const env = (process.env.COOLIE_CODEX_HOOKS ?? "").trim().toLowerCase()
  if (env === "1" || env === "true") return true
  if (env === "0" || env === "false") return false
  const out = probe()
  if (out === null) return false
  const v = parseCodexVersion(out)
  return v !== null && codexVersionSupportsHooks(v)
}
```

`packages/server/src/engine/codex/adapter.ts`：`const discoverCodexBinary` 加 `export`（无循环——version.ts→adapter.ts 单向）。

`packages/server/src/engine/registry.ts`：

```ts
import { resolveCodexHooks } from "./codex/version.js"

export const EngineRegistryLive = Layer.sync(EngineRegistry, () => {
  // 版本门控（probe ①②③已修）：≥0.144 或 COOLIE_CODEX_HOOKS=1 → hooks lane；否则 notify lane（T9）。
  // adapter 常量不改（≤0.139 事实记录），这里按运行环境打能力补丁，启动一次定档。
  const codex: Engine = resolveCodexHooks()
    ? { ...codexEngine, capabilities: { ...codexEngine.capabilities, hooks: true } }
    : codexEngine
  return new Map<string, Engine>([[claudeEngine.id, claudeEngine], [codex.id, codex]])
})
```

（`import type { Engine }` 该文件已有。既有 `engine.registry.test.ts` 若断言 codex `hooks:false`，在测试 beforeEach 设 `COOLIE_CODEX_HOOKS=0` 钉死 lane——测试机上有无 codex 都可判定。）

Run: `cd packages/server && bun run vitest run test/engine.codex.version.test.ts test/engine.registry.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 3: 写失败测试（notify 脚本）**

`packages/server/test/engine.codex.notify.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { ensureNotifyScript } from "../src/engine/codex/notify.js"

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-nf-"))

it("ensureNotifyScript 产 codex-notify.sh：读 server.json、只转发 agent-turn-complete、exit 0", () => {
  const home = mkTmp()
  const p = ensureNotifyScript(home, "codex")
  expect(p).toContain("codex-notify.sh")
  const body = fs.readFileSync(p, "utf8")
  expect(body).toContain("/notify/codex?workspace=")
  expect(body).toContain("agent-turn-complete")
  expect(body.trim().endsWith("exit 0")).toBe(true)
  expect((fs.statSync(p).mode & 0o111) !== 0).toBe(true) // 可执行
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.codex.notify.test.ts`
Expected: FAIL——`engine/codex/notify.js` 不存在。

- [ ] **Step 5: 实现 ensureNotifyScript**

`packages/server/src/engine/codex/notify.ts`：

```ts
import * as fs from "node:fs"
import * as path from "node:path"

/** codex `notify` 转发脚本（kobe 三铁律：绝不拉起 server、失败静默、永远 exit 0）。
 * codex agent-turn-complete 时 spawn `<script> <workspaceId> <json>`：$1=workspaceId、$2=payload JSON。
 * per-session 经 launchCommand `-c notify=[...]` 注入，不写全局 config.toml。 */
export const ensureNotifyScript = (home: string, engineId: string): string => {
  const p = path.join(home, "hooks", `${engineId}-notify.sh`)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const script = `#!/bin/sh
# Coolie ${engineId} notify forwarder（自动生成，勿手改）。
WS="$1"; JSON="$2"
INFO="${home}/server.json"
[ -n "$WS" ] || exit 0
[ -f "$INFO" ] || exit 0
# 只转发 turn 完成事件（codex notify 也会发别的类型）
printf '%s' "$JSON" | grep -q 'agent-turn-complete' || exit 0
PORT=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$INFO")
TOKEN=$(sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' "$INFO")
[ -n "$PORT" ] && [ -n "$TOKEN" ] || exit 0
curl -s -m 2 -X POST "http://127.0.0.1:$PORT/notify/${engineId}?workspace=$WS" \\
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  --data-binary "$JSON" >/dev/null 2>&1
exit 0
`
  fs.writeFileSync(p, script, { mode: 0o755 })
  return p
}
```

- [ ] **Step 6: launchCommand 透传 workspaceId+home（仅 hooks off lane）+ codex 注入 notify**

`packages/server/src/engine/types.ts`：`launchCommand` 的 opts（engine/types.ts:35–39 内联类型）加两可选字段：

```ts
    readonly workspaceId?: string
    readonly home?: string
```

`packages/server/src/engine/session.ts` line 29 调用点——**lane 分流点**：只有 hooks off 的引擎才拿到 workspaceId/home（→ codex adapter 才会注入 notify）；hooks lane（claude、codex≥0.144）不注入，turn-complete 走 hooks Stop：

```ts
    // T9 lane 分流：hooks off 的引擎（codex ≤0.139 / 探测失败）注入 notify 转发；真 hooks 引擎不注入。
    const engineCommand = i.engine.capabilities.hooks
      ? i.engine.launchCommand({ sessionId: i.sessionId ?? "", resume: i.resume })
      : i.engine.launchCommand({ sessionId: i.sessionId ?? "", resume: i.resume, workspaceId: i.ws.id, home: i.home })
```

`packages/server/src/engine/codex/adapter.ts` `launchCommand`——解构加 `workspaceId, home`，在 `--dangerously-bypass-hook-trust` 之前加：

```ts
    if (resume !== true && workspaceId && home)
      args.push("-c", `notify=["${home}/hooks/codex-notify.sh","${workspaceId}"]`)
```

（claude adapter 忽略这两字段，不受影响；fake engines 不设 → 可选字段零破坏。）

- [ ] **Step 7: bootstrap——hooks off 的 codex 才 ensureNotifyScript**

`packages/server/src/engine/bootstrap.ts`——在 `startEngineSession` 之前加（hooks lane 下**不**写 notify 脚本——launchCommand 也不会引用它，两 lane 互斥清晰）：

```ts
        // T9 notify lane（codex hooks off）：写转发脚本供 launchCommand 的 -c notify=[...] 引用。
        // hooks lane（capabilities.hooks=true，版本门控）走上方 injectCodexHooks 通路，不注入 notify。
        if (engine.id === "codex" && !engine.capabilities.hooks && !hooksDisabled())
          yield* Effect.sync(() => ensureNotifyScript(cfg.home, engine.id))
```

顶部 import 加 `import { ensureNotifyScript } from "./codex/notify.js"`。

- [ ] **Step 8: 写失败测试（/notify 端点）**

`packages/server/test/http.notify.test.ts`（沿用 hooks 端点测试装配；seed engineId=codex、engine tab status="working" 的 active workspace）：

```ts
it("POST /notify/codex（agent-turn-complete）→ 置 awaiting-input（source=notify）+ 发 engine.turn.finished", async () => {
  const r = await postRaw(base, `/notify/codex?workspace=${codexWsId}`,
    { type: "agent-turn-complete", "turn-id": "t1", "last-assistant-message": "done" }, token)
  expect(r.status).toBe(200)
  const tab = await getEngineTab(base, codexWsId, token)
  expect(tab.status).toBe("awaiting-input")
  const evs = await getEvents(base, codexWsId, token)
  expect(evs.some((e: any) => e.type === "engine.turn.finished")).toBe(true)
  const st = evs.filter((e: any) => e.type === "tab.status.changed").at(-1)
  expect((st.payload as any).source).toBe("notify") // H1：非 "hook"——短授权窗 + drainer 放行源 + 可溯源
})

it("POST /notify/codex 无 workspace 参 → 400", async () => {
  const r = await postRaw(base, `/notify/codex`, { type: "agent-turn-complete" }, token)
  expect(r.status).toBe(400)
})
```

- [ ] **Step 9: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/http.notify.test.ts`
Expected: FAIL——`/notify/:engine` 路由不存在。

- [ ] **Step 10: 加 POST /notify/:engine 路由**

`packages/server/src/http/app.ts`——在 `/hooks/:engine` 路由匹配附近（同风格），加（放在 hooks 正则之后，避免歧义；`notify` 与 `hooks` 前缀不同不会冲突）：

```ts
        const notifyRoute = url.pathname.match(/^\/notify\/([^/]+)$/)
        if (req.method === "POST" && notifyRoute) {
          const engineId = notifyRoute[1]!
          const wsId = url.searchParams.get("workspace")
          if (!wsId) return err(res, 400, "Validation", "workspace query param required")
          const body = await readJson(req)
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const registry = yield* EngineRegistry
              const engine = registry.get(engineId)
              const tab = engine ? yield* (yield* TabsRepo).findEngineTab(wsId) : null
              if (!engine || !tab) return { ok: true } // 未知引擎/无 tab：notify 永远成功、静默吞（同 hooks）
              // H1：touchHookAt 只买到 NOTIFY_AUTHORITY_MS(5s) 抖动保护（pollOnce 对 hooks-off 引擎的短窗，
              // T8）——绝不用 10min 压制 mtime；source="notify" 非 "hook"：可溯源 + T6 drainer 放行源。
              yield* (yield* TabsRepo).touchHookAt(tab.id, Date.now())
              yield* (yield* TabsRepo).setStatus(tab.id, "awaiting-input", "notify")
              yield* (yield* EventsRepo).append({
                workspaceId: wsId, type: "engine.turn.finished", payload: { tabId: tab.id, sessionId: tab.engineSessionId, source: "notify" },
              })
              return { ok: true }
            }),
            (r) => send(res, 200, r),
            onError,
          )
        }
```

- [ ] **Step 11: protocol 路由追加**

`packages/protocol/src/routes.ts` 追加：

```ts
  { method: "POST", path: "/notify/:engine", description: "engine turn-complete 通知转发（codex notify lane（hooks off 时）；?workspace= 必带）" },
```

- [ ] **Step 12: 跑测试确认通过 + 双 typecheck**

Run: `cd packages/server && bun run vitest run test/engine.codex.version.test.ts test/engine.codex.notify.test.ts test/http.notify.test.ts test/engine.registry.test.ts && bun run typecheck && cd ../protocol && bun run typecheck`
Expected: PASS；双 typecheck 清洁（launchCommand 新可选字段不破坏 M1 fake engines——它们不设 workspaceId/home）。

- [ ] **Step 13: Commit**

```bash
git add packages/server/src/engine/codex/version.ts packages/server/src/engine/registry.ts packages/server/src/engine/codex/notify.ts packages/server/src/engine/types.ts packages/server/src/engine/session.ts packages/server/src/engine/codex/adapter.ts packages/server/src/engine/bootstrap.ts packages/server/src/http/app.ts packages/protocol/src/routes.ts packages/server/test/engine.codex.version.test.ts packages/server/test/engine.codex.notify.test.ts packages/server/test/http.notify.test.ts
git commit -m "feat(server): codex hooks 版本门控（≥0.144 hooks lane）+ notify 兜底 lane + POST /notify/:engine"
```

---

### Task 10: codex 标题派生双 lane（hooks 活时用 hook-stdin transcript_path / 否则挂 rollout 回填）+ watcher 归档即停 + 就绪门控不绑 SessionStart

**Files:**
- Modify: `packages/server/src/engine/bootstrap.ts`（backfill `onFound` 派生标题；`shouldContinue` 归档即停；`gateOnHooks` 排除 serverGeneratedId 引擎——probe ④）
- Modify: `packages/server/src/http/app.ts`（hooks 路由 Stop 标题派生：优先 hook-stdin 的 `transcript_path`）
- Test: `packages/server/test/engine.bootstrap.test.ts`（backfill lane）、`packages/server/test/hooks-endpoint.test.ts`（追加 transcript_path 优先用例）、`packages/server/test/bootstrap-prompt-gate.test.ts`（追加 probe ④ 门控用例）

**Interfaces:**
- Consumes: backfill watcher `onFound(hit: { sessionId; path })`（rollout.ts：`hit.path` 已含命中的 rollout 文件路径）；`engine.deriveTitle(jsonl)`（codex adapter `codexDeriveTitle`）；`TabsRepo.setTitle`/`get`；`WorkspacesRepo.get`（拿 status 判 active）；探针报告（hook stdin **直接含 `transcript_path`**——rollout 全路径，无需反查日期树；④ SessionStart 结构性绑定首 turn）。
- Produces（**标题派生双 lane，与 T9 的 turn-complete 双 lane 同门控，两条都不是死代码**）：
  - **hooks lane（codex≥0.144）**：既有 app.ts hooks 路由的 Stop 标题派生（app.ts:283–295）**已可达**（`hooks:true` 后 `/hooks/codex` 有真流量），增强为**优先 `body.transcript_path`**（hook stdin 直给 rollout 全路径，比 `engine.transcriptPath` 反推更准）、无则回落既有反推。claude 同码路径受益（其 Stop hook 也带 transcript_path）。
  - **notify/rollout lane（≤0.139，`hooks:false`）**：原挂 hooks Stop 的派生对此 lane **不可达**（M2p1 残留）——在 backfill watcher `onFound` 里（已拿 `hit.path` + 回填 sessionId），读 `hit.path` → `engine.deriveTitle` → `setTitle`（仅当 `tab.title === null`）。watcher 本就只在 hooks off 时布防（bootstrap `armRolloutWatcher` 既有条件 `serverGeneratedId && !(hooks && !hooksDisabled())`），lane 互斥天然成立。
  - **backfill watcher 归档即停**：`shouldContinue` 现只查 `tab 存在 && engineSessionId===null`；归档保留 tab（archive-keeps-tabs）→ watcher 会空扫到 30min 上限。补查 **workspace 仍 active**——归档后 `shouldContinue` 返回 false，watcher 立即自停。
  - **就绪门控不绑 SessionStart（probe ④）**：`gateOnHooks` 补条件 `engine.serverGeneratedId !== true`——codex 即使 hooks:true，SessionStart 也要到**首 turn** 才触发（0.144.1 实测未修），等它 = 必然 90s 超时 + `prompt.delivery.degraded` 假警。codex 两 lane 的首条 prompt 投递都走强化 waitStable（RE-SMOKE 既定通路）；claude 的 SessionStart 门控逐字不变。

- [ ] **Step 1: 写失败测试**

`packages/server/test/engine.bootstrap.test.ts` 追加（构造一个 codex 起始 null-id tab + 一个含首条 user 消息的 rollout 文件，跑 watcher 的 onFound，断言标题被 setTitle；再把 workspace 置 archived，断言 shouldContinue 返回 false）。若既有 backfill 测试已装配 watcher，复用其 harness：

```ts
it("backfill onFound 派生并 setTitle（标题不再挂不可达的 hooks Stop）", async () => {
  const { runOnFound, rolloutPath, tabsRepo, tab } = await setupCodexBackfill({ firstUserMessage: "修登录 bug" })
  await runOnFound({ sessionId: "sid-x", path: rolloutPath })
  expect((await tabsRepo.get(tab.id)).title).toBe("修登录 bug")
})

it("shouldContinue：workspace 归档后返回 false（watcher 自停，不空扫到 30min）", async () => {
  const { shouldContinue, archiveWs } = await setupCodexBackfill({})
  expect(await shouldContinue()).toBe(true) // active + null-id
  await archiveWs()
  expect(await shouldContinue()).toBe(false) // 归档即停
})
```

> 若无现成 `setupCodexBackfill` harness，本 task 先建最小 harness（直接构造 `startRolloutBackfillWatcher` 的 deps + 一个 in-memory tabs/ws repo 双桩），或改为**直接单测 bootstrap 装配的 `onFound`/`shouldContinue` 闭包**——把这两个闭包从 bootstrap 内联提取为文件内命名函数 `codexBackfillOnFound(deps)`/`codexBackfillShouldContinue(deps)` 便于单测（提取是本 task 的一部分）。

`packages/server/test/hooks-endpoint.test.ts` 追加（hooks lane 标题：优先 hook-stdin transcript_path）：

```ts
it("Stop 标题派生优先 body.transcript_path（probe：hook stdin 直给 rollout 全路径）", async () => {
  // seed：engine tab（title=null）+ 一个只存在于 transcript_path 所指位置的转录文件（不放在 engine.transcriptPath 反推位置）
  const tp = path.join(tmpHome, "elsewhere", "rollout-x.jsonl")
  fs.mkdirSync(path.dirname(tp), { recursive: true })
  fs.writeFileSync(tp, JSON.stringify({ type: "user", message: { content: "修登录 bug" } }) + "\n")
  await postRaw(base, `/hooks/claude?workspace=${wsId}`,
    { hook_event_name: "Stop", session_id: "sid-1", transcript_path: tp }, token)
  const tab = await getEngineTab(base, wsId, token)
  expect(tab.title).toBe("修登录 bug") // 反推位置无文件仍派生成功 = 走了 stdin 路径
})
```

（转录 fixture 的 JSONL 形态照抄该测试文件既有标题派生用例的 seed——上面一行是 claude `deriveTitle` 能吃的最小形态，若既有用例已有 helper 直接复用。）

`packages/server/test/bootstrap-prompt-gate.test.ts` 追加（probe ④ 门控）：

```ts
it("serverGeneratedId 引擎（codex）即使 hooks:true 也不等 SessionStart（probe ④：绑首 turn，等=必超时）", async () => {
  // gatedEngine 变体：serverGeneratedId:true + hooks:true + 无过渡期（exec cat 立即接管）
  const engine: Engine = {
    ...gatedEngine(0), id: "codex-gate", serverGeneratedId: true,
    launchCommand: () => ["/bin/bash", "-c", "exec cat"],
  }
  const layer = buildLayer(engine, 3000)
  const t0 = Date.now()
  const ws = await createWsWithPrompt(layer, "你好") // 沿用本文件既有 create helper
  expect(Date.now() - t0).toBeLessThan(2500) // 没等 3000ms 门控超时
  const evs = await listEvents(layer, ws.id)
  expect(evs.some((e) => e.type === "prompt.delivery.degraded")).toBe(false) // 不再假警
})
```

（`createWsWithPrompt`/`listEvents` 对齐该文件既有 helper 名——若内联，照其既有用例的 create + `EventsRepo.listAfter` 写法展开。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.bootstrap.test.ts test/hooks-endpoint.test.ts test/bootstrap-prompt-gate.test.ts -t "backfill|transcript_path|serverGeneratedId"`
Expected: FAIL——onFound 现不派生标题；shouldContinue 现不查 workspace status；hooks 路由现无视 body.transcript_path；gateOnHooks 现对 serverGeneratedId+hooks 引擎会干等门控。

- [ ] **Step 3: onFound 派生标题**

`packages/server/src/engine/bootstrap.ts` backfill 装配（约 line 153–159 的 `onFound`）——在 `setEngineSessionId` + `engine.session.started` append 之后，补标题派生：

```ts
                onFound: (hit) => Effect.runPromise(Effect.gen(function* () {
                  yield* tabs.setEngineSessionId(tab.id, hit.sessionId)
                  yield* events.append({
                    workspaceId: ws.id, type: "engine.session.started",
                    payload: { tabId: tab.id, sessionId: hit.sessionId },
                  })
                  // 标题派生 notify/rollout lane（Plan 2）：hooks off 时原挂 hooks Stop 的派生不可达。
                  // 此刻已拿 rollout 命中路径 hit.path，读它派生首条 user 标题（仅当尚无标题）。
                  // hooks lane（≥0.144）走 app.ts hooks 路由的 Stop 派生（watcher 彼时不布防，lane 互斥）。
                  const cur = yield* tabs.get(tab.id).pipe(Effect.option)
                  if (Option.isSome(cur) && cur.value.title === null) {
                    const title = yield* Effect.sync(() => {
                      try { return engine.deriveTitle(fs.readFileSync(hit.path, "utf8")) } catch { return null }
                    })
                    if (title !== null) yield* tabs.setTitle(tab.id, title)
                  }
                })),
```

（顶部 `fs`/`Option` 已在 bootstrap import；`engine.deriveTitle` 即 codex adapter 的 `codexDeriveTitle`。）

- [ ] **Step 4: shouldContinue 归档即停**

同文件 backfill 装配的 `shouldContinue`（约 line 151–152）——补 workspace active 检查：

```ts
                shouldContinue: () => Effect.runPromise(Effect.gen(function* () {
                  const t = yield* tabs.get(tab.id).pipe(Effect.option)
                  if (Option.isNone(t) || t.value.engineSessionId !== null) return false // tab 删/已回填 → 停
                  const w = yield* wsRepo.get(ws.id).pipe(Effect.option) // 归档保留 tab，但 ws 非 active → 停
                  return Option.isSome(w) && w.value.status === "active"
                }).pipe(Effect.catchAll(() => Effect.succeed(false)))),
```

（`wsRepo`：bootstrap 现**未**注入 `WorkspacesRepo`——gen 块顶部补 `const wsRepo = yield* WorkspacesRepo` + 顶部 import `{ WorkspacesRepo } from "../repo/workspaces.js"`；生产 main.ts 的 appLayer 已提供该 Layer，零波及。catchAll 兜底：任何读失败当作「停」，防看护泄漏。）

- [ ] **Step 5: hooks 路由 Stop 标题派生优先 hook-stdin transcript_path（hooks lane）**

`packages/server/src/http/app.ts` hooks 路由的标题派生块（app.ts:283–295）替换为：

```ts
              // historyReader：首个 turn 完成且尚无标题 → 派生。优先 hook stdin 直给的 transcript_path
              //（probe：claude/codex hook payload 都带 rollout/转录全路径，比按 home/cwd/sessionId 反推更准——
              // codex 反推尤其依赖日期树扫描）；无则回落既有反推。
              if (evtName === "Stop" && tab.title === null && sid !== null) {
                const stdinTp = typeof (body as any)?.transcript_path === "string" && (body as any).transcript_path !== ""
                  ? (body as any).transcript_path as string : null
                let tp = stdinTp
                if (tp === null) {
                  const home = engineHome(engine.id, { claudeHome: claudeHome ?? "", codexHome: codexHome ?? "" })
                  if (home !== "") {
                    const ws = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
                    if (Option.isSome(ws)) tp = engine.transcriptPath({ home, cwd: ws.value.path, sessionId: sid })
                  }
                }
                if (tp !== null) {
                  const tpath = tp
                  const title = yield* Effect.sync(() => {
                    try { return engine.deriveTitle(fs.readFileSync(tpath, "utf8")) } catch { return null }
                  })
                  if (title !== null) yield* tabs.setTitle(tab.id, title)
                }
              }
```

- [ ] **Step 6: gateOnHooks 排除 serverGeneratedId 引擎（probe ④）**

`packages/server/src/engine/bootstrap.ts` 的 `gateOnHooks`（现 `wantsPrompt && engine.capabilities.hooks && !hooksDisabled() && Option.isSome(bus)`）改为：

```ts
        // probe ④（0.144.1 仍未修）：codex SessionStart 结构性绑定首个 turn——launch 后不触发。
        // serverGeneratedId 引擎即使 hooks:true 也不得等 SessionStart（等 = 必然 90s 超时 + degraded 假警）；
        // 其首条 prompt 投递走强化 waitStable（RE-SMOKE 既定通路）。claude 门控逐字不变。
        const gateOnHooks = wantsPrompt && engine.capabilities.hooks && !hooksDisabled()
          && Option.isSome(bus) && engine.serverGeneratedId !== true
```

（`armRolloutWatcher` 既有条件 `serverGeneratedId === true && !(hooks && !hooksDisabled())` **不动**——hooks lane 下 watcher 不布防，id 回填走 `/hooks/codex` 的 C4 既有路径：首 turn 的 UserPromptSubmit/Stop stdin 带 session_id。）

- [ ] **Step 7: 跑测试确认通过 + 全量回归**

Run: `cd packages/server && bun run vitest run && bun run typecheck`
Expected: 全绿（含既有 hooks-endpoint 标题用例——无 transcript_path 时回落反推，行为不变）；typecheck 清洁。

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/engine/bootstrap.ts packages/server/src/http/app.ts packages/server/test/engine.bootstrap.test.ts packages/server/test/hooks-endpoint.test.ts packages/server/test/bootstrap-prompt-gate.test.ts
git commit -m "fix(server): codex 标题派生双 lane（hook-stdin transcript_path / rollout 回填）+ watcher 归档即停 + 就绪门控不绑 SessionStart"
```

---

### Task 11: client — server 队列显示（「⏳ N 条排队中」）+ 撤回 + 202 处理

**Files:**
- Modify: `packages/client/src/stores/data.ts`（`queuedByWs` + `refreshQueue` + `withdrawQueued`；`applyEvent` 接 `prompt.*`；`sendInput` 处理 202）
- Modify: `packages/client/src/composer/Composer.tsx`（`QueueIndicator` 改读 server 队列 + 撤回走 DELETE）
- Test: `packages/client/test/stores.data.queue.test.ts`（若无则新建；沿用现有 store node 测试装配）

**Interfaces:**
- Consumes: `GET /workspaces/:id/queue`（Task 7）→ `{ queue: Array<{ id, text, mode, createdAt, position }> }`；`DELETE /workspaces/:id/queue/:id`；事件 `prompt.queued`/`prompt.delivered`/`prompt.withdrawn`（**QueueRepo 实产的全部三种**——L2：不写不存在的 `prompt.dequeued`，白名单与服务端产出一一对应）；`api.req`。
- Produces:
  - `DataState` 加 `queuedByWs: Record<string, Array<{ id: number; text: string; position: number }>>`、`refreshQueue(wsId): Promise<void>`、`withdrawQueued(wsId, id): Promise<void>`。
  - `applyEvent`：`e.type.startsWith("prompt.")` 分支——`prompt.queued`/`prompt.delivered`/`prompt.withdrawn` 且有 `workspaceId` → `refreshQueue(wsId)`（前缀分发 + refetch，与既有风格一致；保留现有 `prompt.delivery.degraded` → `pushWarning`）。
  - `sendInput`：`fetch` 响应 `r.status === 202`（入队）视为**成功**（不抛），可选把返回的 `{id,position}` 直接乐观并入 `queuedByWs`（也可只靠 `prompt.queued` 事件 refetch——二选一，避免双写抖动，推荐**仅靠事件 refetch**，`sendInput` 202 分支只是不抛）。
  - `Composer.tsx` `QueueIndicator` 改为读 `queuedByWs[wsId]`（server 真队列，文案「⏳ N 条排队中」），每条撤回按钮 `onClick` 调 `withdrawQueued(wsId, id)`（DELETE）。原 `pendingSends`（in-flight abort）保留但**仅**表示「正在发送中（未入队的即时投递）」，二者可叠加显示或合并——为不扩面，本 task 让 `QueueIndicator` 只渲染 server 队列，`pendingSends` 的即时 abort 逻辑不动（不再渲染其计数，避免「投递中」与「排队中」双 badge 混淆）。

- [ ] **Step 1: 写失败测试**

`packages/client/test/stores.data.queue.test.ts`（沿用现有 store 测试：注入 fake `api`，spy `req`）：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import { useData } from "../src/stores/data"

const fakeApi = (queue: any[]) => ({
  info: { port: 1, token: "t" },
  req: vi.fn(async (m: string, p: string) => {
    if (m === "GET" && p.endsWith("/queue")) return { queue }
    return {}
  }),
})

describe("data store server 队列", () => {
  beforeEach(() => { useData.setState({ queuedByWs: {} } as any) })

  it("refreshQueue 拉 /queue 存进 queuedByWs", async () => {
    useData.getState().setApi(fakeApi([{ id: 3, text: "一", position: 1 }]) as any)
    await useData.getState().refreshQueue("w1")
    expect(useData.getState().queuedByWs["w1"]).toEqual([{ id: 3, text: "一", position: 1 }])
  })

  it("applyEvent(prompt.queued) 触发 refreshQueue", async () => {
    const api = fakeApi([{ id: 9, text: "排", position: 1 }])
    useData.getState().setApi(api as any)
    useData.getState().applyEvent({ seq: 1, workspaceId: "w1", type: "prompt.queued", payload: {}, ts: 0 } as any)
    await new Promise((r) => setTimeout(r, 0))
    expect(api.req).toHaveBeenCalledWith("GET", "/workspaces/w1/queue")
  })

  it("withdrawQueued 调 DELETE 并刷新", async () => {
    const api = fakeApi([])
    useData.getState().setApi(api as any)
    await useData.getState().withdrawQueued("w1", 5)
    expect(api.req).toHaveBeenCalledWith("DELETE", "/workspaces/w1/queue/5")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client && bun run vitest run test/stores.data.queue.test.ts`
Expected: FAIL——`queuedByWs`/`refreshQueue`/`withdrawQueued` 未定义。

- [ ] **Step 3: 扩 data store**

`packages/client/src/stores/data.ts`：`DataState` interface 加：

```ts
  queuedByWs: Record<string, Array<{ id: number; text: string; position: number }>>
  refreshQueue(wsId: string): Promise<void>
  withdrawQueued(wsId: string, id: number): Promise<void>
```

初始 state 加 `queuedByWs: {},`。实现：

```ts
  refreshQueue: async (wsId) => {
    if (!api) return
    try {
      const r = await api.req("GET", `/workspaces/${wsId}/queue`)
      set((s) => ({ queuedByWs: { ...s.queuedByWs, [wsId]: r.queue } }))
    } catch { /* 非 active 等：保留旧值 */ }
  },
  withdrawQueued: async (wsId, id) => {
    if (!api) return
    try { await api.req("DELETE", `/workspaces/${wsId}/queue/${id}`) } catch { /* 已投递/已撤：事件会刷新 */ }
    swallow(get().refreshQueue(wsId))
  },
```

`applyEvent` 的 `else if (e.type.startsWith("prompt."))` 分支扩为：

```ts
    } else if (e.type.startsWith("prompt.")) {
      if (e.type === "prompt.delivery.degraded") {
        const p = (e.payload ?? {}) as { code?: string; reason?: string }
        pushWarning(p.code ?? "prompt.delivery.degraded", p.reason ?? "投递降级：prompt 可能未完整送达 engine")
      } else if (e.workspaceId && ["prompt.queued", "prompt.delivered", "prompt.withdrawn"].includes(e.type)) {
        swallow(get().refreshQueue(e.workspaceId)) // 队列变动 → 重拉该 ws 队列（三种 = QueueRepo 实产全集，L2）
      }
    }
```

`sendInput`——`if (!r.ok)` 前把 202 当成功放行（202 不在 `r.ok` 的 2xx？——`r.ok` 为 200–299 含 202，故 202 天然不进 `!r.ok` 分支，`sendInput` 已正确不抛）。补一行注释即可，无需逻辑改动；确认 `finally` 里从 `pendingSends` 移除仍成立。（若担心，显式 `if (r.status === 202) return` 早退。）

- [ ] **Step 4: Composer QueueIndicator 改读 server 队列**

`packages/client/src/composer/Composer.tsx` `QueueIndicator`：

```tsx
const QueueIndicator = ({ wsId }: { wsId: string }) => {
  const queued = useData((s) => s.queuedByWs[wsId]) // 稳定引用：store 存的即该 ws 的数组
  if (!queued || queued.length === 0) return null
  return (
    <div className="queue-ind">
      ⏳ {queued.length} 条排队中
      {queued.map((q) => (
        <button key={q.id} className="queue-cancel" title={`撤回：${q.text.slice(0, 40)}`}
          onClick={() => void useData.getState().withdrawQueued(wsId, q.id)}>×</button>
      ))}
    </div>
  )
}
```

（workspace 切换/挂载时拉一次队列：在 `Composer` 的 `useEffect(..., [wsId])` 里加 `void useData.getState().refreshQueue(wsId)`，使切到已有排队的 ws 立即显示。）

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd packages/client && bun run vitest run test/stores.data.queue.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/stores/data.ts packages/client/src/composer/Composer.tsx packages/client/test/stores.data.queue.test.ts
git commit -m "feat(client): server 队列显示「⏳ N 条排队中」+ 撤回（DELETE /queue）+ 202 入队"
```

---

### Task 12: client — 注意力管理（内建横幅 + title 角标为主）+ OS 通知渐进增强（能力探测）

**Files:**
- Create: `packages/client/src/stores/attention.ts`（注意力 store——通知/角标的必然可用真源）
- Create: `packages/client/src/chrome/notify.ts`（能力探测 + title 角标（内建主实现）+ OS Notification 渐进增强层）
- Modify: `packages/client/src/stores/data.ts`（`applyEvent`：turn-complete → 抬注意力 + 通知）
- Modify: `packages/client/src/chrome/Sidebar.tsx`（workspace 行注意力角标）
- Modify: `packages/client/src/App.tsx`（注意力横幅 + 通知权限请求 + 聚焦/选中即清）
- Test: `packages/client/test/stores.attention.test.ts`、`packages/client/test/chrome.notify.test.ts`

**Interfaces:**
- Consumes: 事件 `tab.status.changed`（payload `{ status }`）——turn-complete 信号（`awaiting-input`，两引擎统一）；`useUi` 的 selectedWsId（现有：`clearWsIfSelected` 等）；`workspaces`（拿 ws 名做通知标题）。
- Produces（**分层纪律（H2）**：主实现 = in-app 横幅 + 侧栏 `!` 角标 + `document.title` 前缀——纯 DOM/store，任何 webview 必然可用；OS 级 `Notification`/`setAppBadge` = 渐进增强，先过运行时能力探测，探测/授权不过则静默缺席、主实现不受影响。**不做任何「Tauri webview 内建可用」的假设**——WKWebView 的 web Notification 权限流未经证实，很可能 inert）：
  - `stores/attention.ts`：`useAttention` zustand store——`needsYou: Set<string>`（wsIds）、`raise(wsId)`、`clear(wsId)`、`count(): number`、selector `isRaised(wsId)`。
  - `chrome/notify.ts`：
    - `canOsNotify(): boolean` / `canAppBadge(): boolean`——运行时能力探测（`typeof Notification !== "undefined" && typeof Notification.requestPermission === "function"` / `typeof navigator.setAppBadge === "function"`）；一切 OS 级调用都在探测门内。
    - `requestNotifyPermission(): void`——`canOsNotify()` 且 permission="default" 才调 `Notification.requestPermission()`（幂等、不抛）。
    - `notifyTurnComplete(wsName: string, wsId: string): void`——渐进增强层：`canOsNotify()` 且 permission="granted" 才弹「{wsName} 需要你」；点通知 `window.focus()` + 选中该 ws。探测/授权不过 → 静默 return（in-app 横幅/角标已覆盖信息）。
    - `setBadge(n: number): void`——**title 前缀是主实现、无条件生效**（`document.title = n>0 ? "(n) Coolie" : "Coolie"`）；`canAppBadge()` 时**叠加** `setAppBadge/clearAppBadge`（Dock 角标锦上添花）。
  - `applyEvent`（data.ts）：`tab.status.changed` 且 `payload.status === "awaiting-input"` 且有 `workspaceId` → 若该 ws 非当前选中或 `document.hidden`：`useAttention.raise(wsId)` + `notifyTurnComplete(wsName, wsId)` + `setBadge(count)`。（当前选中且窗口聚焦 = 用户正看着，不打扰。）
  - `App.tsx`：挂载时 `requestNotifyPermission()`；顶部注意力横幅（`needsYou.size>0` 时「N 个 workspace 需要你」，点击跳第一个）——**这是通知的主 UI**；`window` `focus` 事件 + `useUi` selectedWs 变化 → `useAttention.clear(selectedWsId)` + 重算 `setBadge`。
  - `Sidebar.tsx`：workspace 行若 `useAttention((s)=>s.isRaised(wsId))` 显示注意力点（复用状态徽标位或加一个 `!` 角标）。

- [ ] **Step 1: 能力探测 spike（先于一切 OS 通知代码，钉死分层）**

两件事，都很便宜：

1. **探测函数先行**：`chrome/notify.ts` 的 `canOsNotify()`/`canAppBadge()`（Step 4 全码）是本 task 一切 OS 级调用的唯一入口——代码层面保证「探测不过 = 渐进增强层整体缺席、主实现照常」。
2. **真机手工探测清单（写进 T13 冒烟第 8 步执行，此处定义）**：Tauri dev 窗口 devtools console 跑：
   ```js
   typeof Notification                     // "undefined" → WKWebView 无此 API，渐进增强层永久缺席（预期内）
   Notification?.permission                // "default"/"denied"/"granted"
   await Notification?.requestPermission() // 观察是否有系统权限弹窗、返回值是否变 "granted"
   new Notification("coolie-spike")        // granted 后是否真弹系统通知
   typeof navigator.setAppBadge            // "function" 才有 Dock 角标增强
   ```
   把五行结果记进冒烟记录。**任何一步不通 = 预期内**（主实现不受影响）；全通 = 白赚 OS 通知。若确认 inert，`tauri-plugin-notification`（Rust 侧原生通知）作为 **M3 升级项**记入 README（T13），本计划不引。

- [ ] **Step 2: 写失败测试（attention store + notify util）**

`packages/client/test/stores.attention.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest"
import { useAttention } from "../src/stores/attention"

describe("attention store", () => {
  beforeEach(() => useAttention.setState({ needsYou: new Set() }))
  it("raise/clear/count/isRaised", () => {
    useAttention.getState().raise("w1"); useAttention.getState().raise("w2")
    expect(useAttention.getState().count()).toBe(2)
    expect(useAttention.getState().isRaised("w1")).toBe(true)
    useAttention.getState().clear("w1")
    expect(useAttention.getState().count()).toBe(1)
    expect(useAttention.getState().isRaised("w1")).toBe(false)
  })
  it("raise 幂等（同 ws 不重复计数）", () => {
    useAttention.getState().raise("w1"); useAttention.getState().raise("w1")
    expect(useAttention.getState().count()).toBe(1)
  })
})
```

`packages/client/test/chrome.notify.test.ts`（jsdom 环境；桩 `Notification`/`navigator.setAppBadge`）：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { setBadge, notifyTurnComplete, canOsNotify, canAppBadge } from "../src/chrome/notify"

describe("notify util（H2 分层：title 主实现 + OS 渐进增强）", () => {
  beforeEach(() => {
    document.title = "Coolie"
    delete (globalThis as any).Notification
    delete (navigator as any).setAppBadge; delete (navigator as any).clearAppBadge
  })
  it("setBadge：无任何 OS 能力 → title 前缀照常生效（主实现，不抛）", () => {
    setBadge(3); expect(document.title).toBe("(3) Coolie")
    setBadge(0); expect(document.title).toBe("Coolie")
  })
  it("setBadge：有 setAppBadge → title 仍生效（主实现不让位），Dock 角标叠加", () => {
    const setSpy = vi.fn(); const clearSpy = vi.fn()
    ;(navigator as any).setAppBadge = setSpy; (navigator as any).clearAppBadge = clearSpy
    setBadge(2)
    expect(document.title).toBe("(2) Coolie"); expect(setSpy).toHaveBeenCalledWith(2)
    setBadge(0)
    expect(document.title).toBe("Coolie"); expect(clearSpy).toHaveBeenCalled()
  })
  it("canOsNotify/canAppBadge：环境无 API → false（探测门关闭，不抛）", () => {
    expect(canOsNotify()).toBe(false)
    expect(canAppBadge()).toBe(false)
  })
  it("notifyTurnComplete：无 Notification（WKWebView 可能形态）→ 静默 no-op 不抛", () => {
    expect(() => notifyTurnComplete("usa", "w1")).not.toThrow()
  })
  it("notifyTurnComplete：有 API 但 permission!=granted → 不弹（不抛）", () => {
    ;(globalThis as any).Notification = Object.assign(vi.fn(), { permission: "default", requestPermission: vi.fn() })
    expect(() => notifyTurnComplete("usa", "w1")).not.toThrow()
    expect((globalThis as any).Notification).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/client && bun run vitest run test/stores.attention.test.ts test/chrome.notify.test.ts`
Expected: FAIL——两模块不存在。

- [ ] **Step 4: 实现 attention store + notify util**

`packages/client/src/stores/attention.ts`：

```ts
import { create } from "zustand"

interface AttentionState {
  needsYou: Set<string>
  raise(wsId: string): void
  clear(wsId: string): void
  count(): number
  isRaised(wsId: string): boolean
}

export const useAttention = create<AttentionState>((set, get) => ({
  needsYou: new Set(),
  raise: (wsId) => set((s) => (s.needsYou.has(wsId) ? s : { needsYou: new Set(s.needsYou).add(wsId) })),
  clear: (wsId) => set((s) => {
    if (!s.needsYou.has(wsId)) return s
    const next = new Set(s.needsYou); next.delete(wsId); return { needsYou: next }
  }),
  count: () => get().needsYou.size,
  isRaised: (wsId) => get().needsYou.has(wsId),
}))
```

`packages/client/src/chrome/notify.ts`：

```ts
import { useUi } from "../stores/ui"

/** H2 能力探测：Tauri WKWebView 的 web Notification 权限流未经证实、很可能 inert——
 * 一切 OS 级调用都在这两道门内；门不过 = 渐进增强层整体缺席，in-app 横幅 + title 角标（主实现）不受影响。 */
export const canOsNotify = (): boolean => {
  try {
    return typeof Notification !== "undefined" && typeof Notification.requestPermission === "function"
  } catch { return false }
}

export const canAppBadge = (): boolean => {
  try { return typeof (navigator as any).setAppBadge === "function" } catch { return false }
}

export const requestNotifyPermission = (): void => {
  try {
    if (canOsNotify() && Notification.permission === "default") void Notification.requestPermission()
  } catch { /* 权限流异常（WKWebView 可能形态）：静默，主实现照常 */ }
}

/** 渐进增强层：探测 + 已授权才弹 OS 通知；点通知聚焦并选中。任何失败静默——横幅/角标已覆盖信息。 */
export const notifyTurnComplete = (wsName: string, wsId: string): void => {
  try {
    if (!canOsNotify() || Notification.permission !== "granted") return
    const n = new Notification(`${wsName} 需要你`, { body: "engine 完成一轮，等待你的输入", tag: `coolie-${wsId}` })
    n.onclick = () => { try { window.focus() } catch { /* */ } ; useUi.getState().setSelectedWs?.(wsId) }
  } catch { /* 弹窗失败绝不影响主流程 */ }
}

/** 角标：title 前缀是主实现、无条件生效（任何 webview 必然可用）；setAppBadge 探测通过时叠加 Dock 角标。 */
export const setBadge = (n: number): void => {
  document.title = n > 0 ? `(${n}) Coolie` : "Coolie"
  if (canAppBadge()) {
    const nav = navigator as any
    try { if (n > 0) void nav.setAppBadge(n); else void nav.clearAppBadge?.() } catch { /* 增强层失败：静默 */ }
  }
}
```

> `useUi.setSelectedWs` 名称对齐现有 ui store（grep `setSelectedWs`/`selectWs`/`clearWsIfSelected`——用实际的 setter；若无单 setter，用现有选中 API）。

- [ ] **Step 5: applyEvent 抬注意力 + 通知**

`packages/client/src/stores/data.ts` `applyEvent` 的 `tab.status.changed` 命中处（现走 `e.type.startsWith("tab.")` → `refreshTabs`）——扩展该分支：在 `swallow(refreshTabs(e.workspaceId))` 之后加 turn-complete 处理：

```ts
    } else if (e.workspaceId && (e.type.startsWith("tab.") || e.type.startsWith("engine.") || e.type.startsWith("composer."))) {
      swallow(refreshTabs(e.workspaceId))
      if (e.type === "engine.turn.finished") swallow(refreshDiffstat(e.workspaceId))
      // 通知与注意力：turn-complete（awaiting-input，两引擎统一信号）且用户没在看该 ws → 抬注意力 + OS 通知 + 角标
      if (e.type === "tab.status.changed" && (e.payload as any)?.status === "awaiting-input") {
        const wsId = e.workspaceId
        const selected = useUi.getState().selectedWsId
        if (wsId !== selected || document.hidden) {
          useAttention.getState().raise(wsId)
          const ws = get().workspaces.find((w) => w.id === wsId)
          notifyTurnComplete(ws?.name ?? wsId, wsId)
          setBadge(useAttention.getState().count())
        }
      }
    }
```

顶部 import 加 `import { useAttention } from "./attention"`、`import { notifyTurnComplete, setBadge } from "../chrome/notify"`。（`useUi.getState().selectedWsId` 对齐 ui store 实际字段名。）

- [ ] **Step 6: App 横幅（主 UI）+ 权限请求 + 聚焦清注意力；Sidebar 角标**

`packages/client/src/App.tsx`：
- 挂载 `useEffect(() => { requestNotifyPermission() }, [])`。
- 顶部横幅：`const needs = useAttention((s) => s.needsYou); {needs.size > 0 && (<div className="attention-banner" onClick={() => useUi.getState().setSelectedWs?.([...needs][0])}>⚠ {needs.size} 个 workspace 需要你</div>)}`。
- 聚焦/选中即清：`useEffect` 订阅 `window` `focus` 事件 + 当前 `selectedWsId` 变化 → `useAttention.getState().clear(selectedWsId)`，并 `setBadge(useAttention.getState().count())`。

`packages/client/src/chrome/Sidebar.tsx`：workspace 行渲染处，`const raised = useAttention((s) => s.isRaised(w.id)); {raised && <span className="attn-dot" title="需要你">!</span>}`（放在状态徽标旁）。

（`packages/client/src/styles.css` 补 `.attention-banner`/`.attn-dot` 最小样式——沿用现有 `.toast-warn`/`.queue-ind` 的配色变量，勿新造设计 token。）

- [ ] **Step 7: 跑测试确认通过 + typecheck**

Run: `cd packages/client && bun run vitest run test/stores.attention.test.ts test/chrome.notify.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/stores/attention.ts packages/client/src/chrome/notify.ts packages/client/src/stores/data.ts packages/client/src/chrome/Sidebar.tsx packages/client/src/App.tsx packages/client/src/styles.css packages/client/test/stores.attention.test.ts packages/client/test/chrome.notify.test.ts
git commit -m "feat(client): 注意力管理（内建横幅+title 角标为主）+ OS 通知渐进增强（能力探测，H2）"
```

---

### Task 13: README + 全量回归 + 真机双引擎冒烟（真 claude 原生队列 + 真 codex server 队列）

**Files:**
- Modify: `README.md`（或 `packages/server/README.md`）——队列语义 + 通知/注意力（分层）+ codex 双 lane 版本门控运维说明
- Test: 全量 vitest（server + protocol + client）+ 三处 typecheck + 手工冒烟（含两 lane 各一轮 + 通知能力探测清单）

**Interfaces:**
- Consumes: 前 12 task 全部产物。
- Produces: 文档化 server 队列语义（谁入队/何时投/如何撤回/interrupt 不自动投/生命周期）、通知与注意力（主实现 vs 渐进增强、触发条件、探测边界）、codex 双 lane（版本门控 + `COOLIE_CODEX_HOOKS` 开关，替代 Plan 1 的手工重启清单——门控已代码化于 T9）；一份可复现的双引擎冒烟清单（codex 两 lane 各跑一轮）。

- [ ] **Step 1: 写 README 章节**

在 README「Engine 抽象 / 通知」附近新增小节：

- **server 端 prompt 队列**：能力位分流——`nativeQueue=true`（claude）忙时 send 直投 TUI（原生 mid-turn 队列）；`nativeQueue=false`（codex）忙时或队列非空时 send 入队（回 202 `{queued,id,position}`），turn-complete（`tab.status→awaiting-input`）后 drainer 按 FIFO 每轮投一条；`GET /workspaces/:id/queue` 查、`DELETE …/queue/:id` 撤回；interrupt/insert 不入队；**interrupt 产生的 awaiting-input（source=interrupt）不触发自动投递**——打断后队列暂停，下个自然 turn-complete 恢复（M4）。生命周期：delete 清队列、archive 保留（unarchive 续投）。
- **codex turn-complete 双 lane（版本门控）**：server 启动时 `codex --version` 探测（`COOLIE_CODEX_HOOKS=1/0` 可覆写）——**≥0.144 hooks lane**（项目级 hooks.json + bypass-trust flag，Stop hook 即时，probe 实证①②③已修）；**≤0.139/探测失败 notify lane**（per-session `-c notify=[...]` 转发脚本，agent-turn-complete 即时）；rollout mtime 静默 30s 是两 lane 共同安全网（无-hooks lane 的 lastHookAt 只有 5s 短授权，绝不压制安全网）。三源都收敛成 `tab.status.changed→awaiting-input`，驱动队列 + 通知 + 注意力。
- **通知与注意力**：主实现是 in-app 顶部横幅 + 侧栏 `!` 角标 + 标题 `(N) Coolie` 前缀（任何 webview 必然可用）；OS 通知/Dock 角标（web `Notification`/`navigator.setAppBadge`）是**渐进增强**，经运行时能力探测 + 用户授权才启用——Tauri WKWebView 上不保证可用（探测清单见冒烟第 8 步；确认 inert 则 `tauri-plugin-notification` 记为 M3 升级项）。仅当 turn-complete 且该 ws 非当前选中或窗口隐藏时提醒；聚焦/选中即清。
- **N1/N2/C7/C13 修复说明**：过长 `COOLIE_HOME` → socket 响亮报错 + doctor `socket` 检查；codex 裸 Esc interrupt 乐观收敛（5s 短授权 + mtime 自纠）；SSE-shutdown `<1.5s`；server.json claim 原子化（tmp+link）+ reader 重试。
- **【codex hooks lane 运维说明】**（替代 Plan 1 的手工重启清单——版本门控已代码化）：`coolie-server` 启动时自动探测 codex 版本定 lane；升级 codex ≥0.144 后**重启 server 即切 hooks lane**，无需改代码。`COOLIE_CODEX_HOOKS=0` 强制回 notify lane（回退开关）、`=1` 强制 hooks lane（提前验证）。**切 lane 后重验**：`engine.turn.finished` payload.source 从 `notify` 变为 hooks 路径产物、`tab.status.changed` source 从 `notify`/`poller` 变 `hook`；队列 drainer 与通知不受影响（都键 `tab.status.changed`）。已知边界（probe ④）：SessionStart 仍绑首 turn → 首条 prompt 投递恒走强化 waitStable、id 回填走首 turn hook stdin（hooks lane）或 rollout watcher（notify lane）。

- [ ] **Step 2: 全量回归 + 三处 typecheck**

Run: `cd packages/server && bun run vitest run && bun run typecheck && cd ../protocol && bun run typecheck && cd ../client && bun run vitest run && bun run typecheck`
Expected: 全量 vitest 绿；三处 typecheck 清洁。

- [ ] **Step 3: 真机双引擎冒烟（发版前清单，记录 PASS/FAIL）**

前置：本机 `claude` + `codex` 在 PATH、均已 login；用**临时** `COOLIE_HOME`/`COOLIE_CODEX_HOME`/`COOLIE_CODEX_CONFIG` 指 mkdtemp，绝不碰真实配置。

**真 codex（server 队列语义；本机 0.144.1 → 默认 hooks lane，另用 `COOLIE_CODEX_HOOKS=0` 起第二轮强制 notify lane——两 lane 都得跑）：**
1. 起 server（临时 home），`POST /projects`，`POST /workspaces {engineId:"codex", initialPrompt:"数到 3"}`。
2. codex 忙时（●working）composer 连发两条「A」「B」→ 观察各回 202、`GET /queue` 见 `[{position:1,text:A},{position:2,text:B}]`、GUI「⏳ 2 条排队中」。
3. codex turn-complete（hooks lane：Stop hook 即时；notify lane：agent-turn-complete 即时；都失灵时 mtime 30s 兜底）→ drainer 自动投「A」→ 起新 turn → 再 complete → 投「B」；队列清空、GUI badge 消。观察投递顺序严格 FIFO、无吞字、无并发写；检 `tab.status.changed` 的 source 与当前 lane 匹配（`hook` vs `notify`）。
4. 排队中撤回「B」（×）→ `DELETE /queue/:id` → `prompt.withdrawn` → 只投「A」。
5. 裸 Esc 打断 working turn → 徽标即时 →✓awaiting-input（N2 乐观；没真停则 5–7s 纠回 working——H1 短授权）；**且队列非空时打断后不自动投**（M4：source=interrupt 不触发 drainer），下条自然 turn-complete 才恢复投递。
6. 归档该 workspace → backfill watcher 若还在（notify lane、首 turn 前归档）立即停（不空扫 30min）。

**真 claude（原生队列，能力位分流）：**
7. `POST /workspaces {engineId:"claude", initialPrompt:"..."}`，忙时 send「X」→ 回 200 直投（**不**入队、`GET /queue` 空）——验证 `nativeQueue=true` 走 TUI 原生 mid-turn 队列。

**通知与注意力（任一引擎）：**
8. **先跑 T12 Step 1 的能力探测清单**（Tauri devtools 五行，逐项记录）。然后：切到别的 workspace 或隐藏窗口 → 让某 ws turn-complete → **必现**：顶部横幅「1 个 workspace 需要你」、侧栏 `!` 角标、标题 `(1) Coolie`；**探测通过才验**：OS 通知「{ws} 需要你」、Dock 角标。点横幅/选中该 ws → 全部即清。探测不过 → 在 README 的 M3 升级项（tauri-plugin-notification）打勾确认。

**零泄漏：** 退出后 `diff` 真实 `~/.codex/config.toml`/`~/.claude` 为空（全程临时 home）。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: server 队列 + 通知/注意力分层 + codex 双 lane 版本门控运维说明（M2 Plan 2 完成）"
```

---

## Self-Review

按 writing-plans skill 三项自检，对照 spec §7.2/§六/§九、roadmap §二分诊表与 Plan 2 定义、M2p1 残留复核；**adversarial round applied**（评审 H1/H2/M1–M4/L1–L3 + codex-0144 probe 对账，逐项落位见下方专节）。

**1. Spec coverage（L3 措辞纪律：以下 spec 条目是里程碑级 bullet，其下横幅/角标/撤回按钮/通知触发条件等具体交互是本计划的设计推导，非 spec 逐字规定——Architecture 段已声明）：**
- spec §7.2「无原生队列的 engine 走 server 端 queue（turn detector 触发投递）」→ Task 5（enqueue）+ Task 6（drainer 键 turn-complete）✓；「composer 显示⏳N 条排队中可撤回」→ Task 7（查/撤 API）+ Task 11（UI，交互细节为设计推导）✓；能力位分流（claude 原生 / codex server 队列）→ Task 5 `nativeQueue` 门 + Task 13 冒烟第 7 步 ✓。
- 「通知与注意力管理」里程碑条目 → Task 12（内建横幅/角标主实现 + OS 通知渐进增强——分层与触发条件均为设计推导）✓；turn-complete 三源统一收敛 `tab.status.changed→awaiting-input` → Task 6/9/12 共用 ✓。
- spec §六「turnDetector 徽标」→ 复用 monitor（未改推导），notify（T9）与 interrupt 乐观（T8）只喂状态不新增推导处 ✓。
- spec §九「doctor 只读」→ Task 4 doctor 加 socket 检查（只报告不改）✓。
- roadmap §二：C7→Task 2 ✓、C13→Task 3 ✓、N1→Task 4 ✓、N2→Task 8 ✓；C11（archive/delete µs-window 409）→ **本计划未加 daemon 生命周期乐观锁**，roadmap 标其为「延后（Plan 2 若顺手则闭）」——本计划队列/通知均不触碰 archive/delete 的 status TOCTOU 路径，故**顺手条件未出现，保持 explicit-defer**（记为有意不做，非遗漏）✓。
- M2p1 残留（progress.md line 105/106）：codex 标题派生挂不可达 hooks Stop→双 lane（hooks-off 挂回填 / hooks-on 用 hook-stdin transcript_path）→ Task 10 ✓；backfill watcher 归档即停 → Task 10 ✓；F6 409→enqueue（REMOVAL MARKER）→ Task 5 ✓；codex≥0.144 hooks 重启——**从「手工清单」升级为代码化版本门控**（T9 `resolveCodexHooks`）+ T13 README 运维说明（probe ①②③已修的实证支撑）✓。

**2. Placeholder scan：** 无 TBD/TODO/「类似 Task N」。各 code 步含完整可执行代码与真实断言。`QueueRepoLive` 的 DI 形态**已按仓库真实代码钉死**（`Layer.effect` + `Db` Tag + `serviceOption(EventsBus)`，与 `repo/tabs.ts:44` / `tabs-repo.test.ts:24` 逐字同构，非 grep-锚点式待定）。仅存的两个「对齐既有名」注记（Task 5 `runtime()` 解包、Task 12 ui store setter 名）指向已存在代码，行为契约固定，不构成 placeholder。

**3. Type consistency（逐条 grep 过，adversarial 轮后复核）：**
- `QueuedPrompt`（Task 1 定义 `{id,workspaceId,tabId,text,mode:"send",createdAt}`）在 Task 6 `DrainDeps.peekNext` 返回、Task 7 `listQueued` map、Task 11 client `{id,text,position}`（client 只取子集，server `GET /queue` Task 7 已投影出 `position`）一致 ✓。
- `QueueRepoShape` 五方法在 Task 5（enqueue/listQueued + lifecycle clearWorkspace）、Task 6（peekNext/remove via onDelivered）、Task 7（listQueued/remove）消费一致；`remove(id, "delivered"|"withdrawn")` reason 字面量一致；`clearWorkspace` 生产消费点 = lifecycle delete（T5 Step 5），archive 决定=保留（tabs 行先例，测试钉死）✓。
- 事件类型：`prompt.queued`/`prompt.delivered`/`prompt.withdrawn`（Task 1 产全集）与 Task 11 applyEvent 白名单**一一对应**（L2：`prompt.dequeued` 已删，白名单三种 = 实产三种）；Task 7 断言一致 ✓。
- `TabStatusSource` 全集 `"hook"|"poller"|"wrapper"|"heal"|"notify"|"interrupt"`（T8 加宽）：`"interrupt"` 产于 T8 N2、消费于 T6 drainer 源门控（M4，测试钉死拒投）与 http.input 断言；`"notify"` 产于 T9 `/notify`、属 drainer 放行源、http.notify 断言；`"hook"`（claude/codex hooks lane）与 `"poller"`（mtime）为既有产出、drainer 放行——跨 task 字面量三处（tabs.ts 类型、drainer 门控、两个测试）一致 ✓。
- `tab.status.changed` payload `{tabId,status,source}`（tabs.ts `setStatus` 真实产出）：Task 6 drainer 读 `status`+`source`、Task 12 读 `status`——字段名与真实代码一致 ✓。
- monitor：`NOTIFY_AUTHORITY_MS`（T8 产）消费于 pollOnce（能力门控）与 `/notify`/N2 注释、H1 测试 import；`decideStatusFromMtime` 新入参 `hookAuthorityMs?` 缺省 `HOOK_AUTHORITY_MS` → M1 既有测试（不传该参）语义逐字不变，T8 Step 1 末例钉死 ✓。
- 版本门控：`parseCodexVersion`/`codexVersionSupportsHooks`/`resolveCodexHooks`（T9 version.ts 产）消费于 registry.ts + version 测试；`discoverCodexBinary` 由 adapter.ts 加 export 供 version.ts（单向依赖，无环）；`COOLIE_CODEX_HOOKS` 出现于 version.ts、registry 测试注记、T13 冒烟/README——名一致 ✓。
- launchCommand 可选 `workspaceId?/home?`（T9）在 session.ts 分流调用点（hooks off 才传）、codex adapter 解构消费一致；claude/fake 不设 → 可选不破坏（M2p1 F4 纪律）✓。
- `assertSockPathFits`/`sockPathWarning`/`SUN_PATH_MAX`（Task 4）在 main.ts、cli doctor 消费一致；`cfg.sockPath` 替换 main.ts 旧内联拼接 ✓。
- `readServerInfoWithRetry`（Task 3）async，cli client.ts 调用点补 `await`（Step 4 明示）；`claimServerInfo` 签名/返回不变 → main.ts:193 调用点零改动，既有 `daemon-info.test.ts` 4 用例为回归护栏 ✓。
- drainer `resolveEngineTab` 返回 `{tab,wsPath,wsActive,nativeQueue}` 与 main.ts 装配（`yield* EngineRegistry`，L1）构造一致 ✓。
- main.ts 装配（M1 复核）：`QueueRepoLive` 进 repos `Layer.mergeAll`（main.ts:72 真实行，无裸 `db` 变量）；lifecycle `serviceOption(QueueRepo)` 在生产可解析（repos 层先于 lifecycle 提供）、单测缺省 no-op ✓。

**adversarial round applied（评审 H1/H2/M1–M4/L1–L3 + probe 对账，全部落位）：**
- **H1（notify 压制 mtime 主权）**：`/notify` 与 N2 interrupt 改 source=`"notify"`/`"interrupt"`（非 `"hook"`）；monitor 授权窗入参化——无-hooks 引擎只拿 `NOTIFY_AUTHORITY_MS=5s`（护 fresh-mtime 抖动），30s 安全网与自纠 5–7s 内恢复，绝无 10min 压制；T8 测试直接断言「notify 6s 后 mtime 静默 30s 照常翻 awaiting-input」。单一仲裁点纪律未破（推导仍只在 `decideStatusFromMtime`）。
- **H2（WKWebView Notification 未证实）**：T12 重构为「主实现 = in-app 横幅 + 侧栏角标 + title 前缀（必然可用），OS 通知/Dock 角标 = `canOsNotify()`/`canAppBadge()` 探测门内的渐进增强」；Step 1 spike 定义五行真机探测清单（T13 冒烟第 8 步执行）；「通吃/内建可用」措辞全数移除；`tauri-plugin-notification` 记 M3 升级项。
- **M1（QueueRepoLive 形态）**：改为与 `TabsRepoLive` 逐字同构的 `Layer.effect` + `Db` Tag；T1 测试 DI 照抄 `tabs-repo.test.ts`；main.ts 装配改进 repos mergeAll。
- **M2（clearWorkspace 无消费者）**：T5 接进 lifecycle `teardownRuntime` delete 分支（`serviceOption(QueueRepo)`，同 tabsOpt 先例）；决定并声明：delete 清、archive 保留（tabs 行先例）；`lifecycle-queue.test.ts` 两用例钉死。
- **M3（C13 原子写打在假目标）**：retarget 到真实生产写入点 `claimServerInfo`（main.ts:193）——tmp+`linkSync`（原子且独占，EEXIST 保 concede 语义，拒绝 rename 覆写防双赢家）；`writeServerInfo` 不动（仅测试 seed）；测试并入既有 `daemon-info.test.ts`，4 既有用例为回归护栏。
- **M4（interrupt 不得自动放队列）**：drainer 按事件 `source` 门控——`"interrupt"` 拒投（无状态，事件自带源），自然源（hook/notify/poller）放行；T6 测试三源对照钉死；T13 冒烟第 5 步真机复验。
- **L1**：main.ts drainer 用 `yield* EngineRegistry` ✓。**L2**：`prompt.dequeued` 从 client 白名单删除（白名单=实产全集）✓。**L3**：spec 引用软化——§7.2/§六/§九为里程碑条目，横幅/角标/撤回 affordance 等交互为本计划设计推导，已在 Architecture 声明 ✓。
- **probe 对账（codex-0144-hooks-probe.md）**：①②③已修 → T9 版本门控 `resolveCodexHooks`（`codex --version` ≥0.144 / `COOLIE_CODEX_HOOKS` 覆写）在 registry 层 flip `hooks:true`，hooks lane 走既有 injectCodexHooks + bypass flag + `/hooks/codex`（authority=10min，与 H1 门控自洽）；④未修 → T10 `gateOnHooks` 排除 serverGeneratedId 引擎（就绪不绑 SessionStart，防 90s 假降级）；notify（T9）明确为 hooks-off lane、标题回填（T10）双 lane 互斥（watcher 布防条件既有 `!(hooks…)` 即门控）——**两 lane 均有测试与冒烟覆盖（`COOLIE_CODEX_HOOKS=0/1` 强制切换），无死代码 lane**。
- **既有行为守恒复核**：monitor 缺省窗不变（M1 测试绿）；claude 门控/直投/interrupt 路径逐字不变；`claimServerInfo` 语义测试级不变；lifecycle 既有测试（不提供 QueueRepo）不受影响；hooks 路由标题派生无 transcript_path 时回落既有反推。

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-12-coolie-m2-plan2-queue-notify.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每 task 一个 fresh subagent，task 间两阶段评审，快速迭代；Wave A 四线并行、Wave C/D 跨包并行。
**2. Inline Execution** — 本会话内 executing-plans，批量执行带 checkpoint。

**Which approach?**
