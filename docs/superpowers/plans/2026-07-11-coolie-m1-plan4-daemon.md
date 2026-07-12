# Coolie M1 · Plan 4：daemon 完善（refcount 惰性退出 + ensure-or-heal + engine keep-alive/resume）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 daemon 补齐为可长期共处的伴侣进程：role 化 client 注册与 refcount 惰性退出（GUI 持有 server 生命周期、终端 pane/CLI 一次性命令不持有，最后持有者断开后宽限期自退）；tmux session 丢失的 ensure-or-heal 三段式重建（engine `--resume` 复活，unarchive 后重建也走这里）；engine keep-alive 包装（engine 退出落回 shell 不塌布局 + `engine.exited` 事件 + `POST /workspaces/:id/tabs/:tabId/resume` 的 Resume 语义）；以及 ledger 记账的 daemon 加固四件（post-listen 单实例 re-check、probeAlive pid 预检、awaited server.close、doctor stuck-creating 检查）。

**Architecture:** 三条主线互相独立、共用既有基座。（1）refcount：新模块 `daemon/clients.ts` 是纯内存注册表（Map + 单 grace timer），lease 与连接绑定——GUI 的 durable SSE 连接带 `role=gui` 即持有，连接断开（含崩溃）自动释放，杜绝「显式 register/unregister API + GUI 崩溃泄漏 lease → daemon 永生」这一类协议；宽限期届满走与 `POST /shutdown` 完全同一条 `shutdown()`（engine 归 tmux 在自退路径同样成立）。（2）keep-alive：window 0 从「直跑 engine」改为「`sh coolie-keepalive.sh <wsId> <engine cmd…>`」——engine 退出后脚本 best-effort 回报 `POST /hooks/engine-exit`（与 claude hook 转发脚本同款纪律：读 server.json、curl、失败静默）、打印横幅、`exec "$SHELL"` 落回交互 shell（pane pid 不变、布局不塌）；`error` 徽标的产生点（Plan 3 预留）由此启用。（3）ensure-or-heal：新 Effect service `SessionEnsurer`（`workspace/heal.ts`）按 observe（repo/tmux/转录文件）→ decide（纯函数 `decideHeal`，可单测）→ apply（`startEngineSession` 重建 / `respawn-window` 原地重启）三段执行；`--resume` 复活依赖 tabs 行里的 `engineSessionId` + 转录文件存在性，因此 **archive 改为保留 tabs 行**（只在 delete 时删除）——这是 unarchive 后能 resume 的钥匙，属于本计划的一个明确行为变更。设计依据：`docs/superpowers/specs/2026-07-11-coolie-design.md` §2.1、§十、§四、§六、§九。

**Tech Stack:** 与主干一致：TypeScript ^5.x（strict + exactOptionalPropertyTypes）、Node ≥22（bun 只装包/跑脚本）、Effect ^3.21.4、better-sqlite3、vitest、commander、node-pty、ws、tmux 3.6a。本计划**零新依赖**。CODEBASE 基线 = branch `feat/m1-plan3-tmux-engine`（Plan 3 全部任务已落地；执行本计划前它已并回 main）。

## Global Constraints

- Plan 1–3 的全部 Global Constraints 继续有效，逐条要点：server/CLI 一切进程以 Node 运行（bun 仅 install/run）；Effect 锁 `^3.21.4`，API 有出入以官方 docs 等价改写但**每步测试断言的行为契约不变**；tmux 纪律（专属 socket、session `coolie-<wsId>`、window 0 = engine、target 一律 `=` 前缀由 TmuxService 内部加）；**绝不 scrape 终端画面**（capturePane 仅限测试断言与 waitStable）；**engine 进程只属于 tmux**（server 死亡/自退都不得杀 engine）；prompt 消毒强制（本计划不新增投递路径）；Terminal Identity Boundary；hooks 纪律（脚本绝不拉起 server、失败静默、永远 exit 0、注入幂等可 opt-out）；安全默认值（loopback + unix socket、除 `GET /health` 外一律 token、日志不打印含 token 的 URL）；SQLite 写库纪律（本计划**无 schema 变更**；写库+事件同事务、commit 后广播）；git 纪律（worktree remove 唯一删除入口、branch 永不删）；日志纪律（append-only、10MB 轮转、fire-and-forget、crash net）。
- **不给 `CoolieConfig` 加字段**：5 个既有测试文件以 `Layer.succeed(CoolieConfig, {…})` 注入完整 shape，加必填字段会全体破坏。新配置 `COOLIE_LINGER_MS` 在 `main.ts` 边缘直接读 env（与 `cmd` 分发同层），不进 config service。
- **并行 fixer 假设**：一个并行修复正在加强首条 prompt 的就绪门控（`SessionStart` 进 `HOOK_EVENTS` → `engine.session.started` 事件 + 强化的 `waitStable`）。本计划**假设该形状已落地**；若实现细节有出入，按行为契约等价改写（各任务的「适配注记」标明了触点）。本计划不改 `tmux/delivery.ts`。
- **keep-alive 脚本纪律**（与 hook-cmd 同源）：回报 server 是 best-effort（`curl -m 2`、失败静默）、绝不拉起 server、横幅之后必 `exec` 交互 shell（脚本自身永不以非零码退出并带走 pane）。
- **惰性退出纪律**：宽限期 timer 只在「gui 持有数 >0 → 0」转变沿布防；**从未有过 gui 持有者则永不布防**（CLI 拉起的 server 驻留到显式 `coolie server stop`，M1 文档化决定）；自退全程不碰任何 tmux session。
- **respawn/heal 的会话环境**：`COOLIE_ROOT`/`COOLIE_WORKSPACE`/端口段经 `new-session -e` 写进 session environment，`respawn-window` 按 tmux 语义自动继承，不重复注入。
- 所有测试经 `COOLIE_HOME`/`COOLIE_WORKSPACES_ROOT`/`COOLIE_TMUX_SOCKET`/`COOLIE_CLAUDE_HOME` 指向 mkdtemp 临时目录/专属测试 socket（`coolie-test-<pid>-<rand>`，afterAll 必 `kill-server`），绝不读写真实 `~/.coolie`、`~/coolie`、`~/.claude`，绝不碰生产 `-L coolie`；**零泄漏**（tmux server、子进程、SSE/WS 客户端归零）。
- 自动化测试中 engine 一律 `COOLIE_CLAUDE_CMD`（`cat` / 临时脚本）或 fake Engine 注入；真 claude 只出现在 Task 12 手工冒烟。refcount 用真实 SSE 客户端连接/断开 + 短 grace（e2e）与 fake timers（单元）两层验收；keep-alive 用 `COOLIE_CLAUDE_CMD=cat` + 真杀 pane 内进程验收。
- 每个 Task 结束必须 `git commit`，conventional commits。**执行本计划的分支不做 push/PR 动作**（由 controller 决定集成方式）。
- 本计划**不做**（显式延后）：GUI 本体与 xterm.js/SSE 客户端实现（Plan 5 消费本计划的 `/clients`、`role=gui` lease、`ensure`/`resume` API、`engine.exited` 事件）；客户端指数退避重连（Plan 5，客户端侧）；codex adapter（M2）；server 端 prompt queue（M2）；headless 自渲染（M3+）。

## Ledger disposition（merge-review carry-over 分流）

上一轮 merge review 遗留 5 条 carry-over（M1–M5）+ 1 条测试卫生项，本计划逐条定夺：

- **M2（吸收进本计划）**：`packages/server/src/engine/claude/hooks.ts:47` 的 `sh ${opts.scriptPath}` 未加引号，`COOLIE_HOME` 含空格时 hook 命令断裂。**在 Task 6 顺手修为 `sh "${opts.scriptPath}"`**——本计划的 keep-alive 脚本命令组装（`engine/keepalive.ts`）复用同款 hook-cmd 纪律、就在隔壁，一并收口最省上下文。（见 Task 6 Step 7 的 1 行修复步。）
- **M1（延后）**：archive/delete 微秒窗内 409 → 自愈（下一次操作即恢复），留待 GUI 有重试 UX 时再议。
- **M3（延后）**：`ws.ts` 的 utf8 input mangling → 归 M2 的二进制 passthrough 一并改（本计划不碰 `ws.ts` 的数据编码路径）。
- **M4（延后）**：retry `{}` ctx 丢 `--prompt` → 归 M2 的 server 端 prompt queue 工作（本计划不新增投递路径）。
- **M5（延后）**：event vocab / 死 `HOOK_STATUS` 条目清理 → 部分由本计划 F6 的词汇表补录承接（`engine.session.started` / `prompt.delivery.degraded` 落表），余量留 M5。
- **delivery.test.ts 的 binary→fromCharCode 重写（延后）**：纯测试卫生，放 Plan 5 窗口或 M2（与 M3 的二进制 passthrough 同批）。

## File Structure（本计划新建/修改）

```
packages/protocol/src/
  domain.ts                       # 修改：+ClientRole/ClientInfo/ClientsStatus + HealAction/HealOutcome + decoders
  routes.ts                       # 修改：+GET /clients、POST /hooks/engine-exit、POST /workspaces/:id/ensure、
                                  #       POST /workspaces/:id/tabs/:tabId/resume；/events/stream 描述加 role=
packages/protocol/test/plan4-vocabulary.test.ts   # 新建
packages/server/src/
  daemon/info.ts                  # 修改：probeAlive pid 预检 + claimServerInfo（wx 独占写单实例收口）
  daemon/clients.ts               # 新建：ClientRegistry（role 化 refcount + grace timer）
  engine/keepalive.ts             # 新建：ensureKeepAliveScript + wrapEngineCommand
  engine/session.ts               # 新建：startEngineSession（bootstrap 与 heal 共用的建-session-启-engine）
  engine/types.ts                 # 修改：launchCommand 增加 resume?: boolean
  engine/claude/adapter.ts        # 修改：resume:true → [bin, --resume, sessionId]
  engine/bootstrap.ts             # 修改：window 0 改跑 keep-alive 包装（经 startEngineSession）
  workspace/heal.ts               # 新建：decideHeal 纯函数 + SessionEnsurer（ensure / resumeTab）
  workspace/lifecycle.ts          # 修改：archive 保留 tabs 行（delete 才删）；unarchive 后 best-effort heal
  repo/tabs.ts                    # 修改：setStatus source 扩为 hook|poller|wrapper|heal；+setEngineSessionId
  tmux/service.ts                 # 修改：+respawnWindow（-k 原地替换 window 进程）
  http/app.ts                     # 修改：+/clients +/hooks/engine-exit +ensure +resume；SSE role lease；
                                  #       hooks/claude 的 session_id 同步；AppServices += SessionEnsurer
  http/ws.ts                      # 修改：WS 终端连接登记为 role=terminal（永不持有）
  main.ts                         # 修改：claim 顺序（TCP listen→claim→unix listen）、awaited close、
                                  #       shutdown 幂等、ClientRegistry 接线、daemon.idle.exit
packages/cli/src/main.ts          # 修改：enter 走 ensure-or-heal、+resume 命令、doctor +stuck-creating +clients
packages/server/test/
  daemon-info.test.ts             # 新建（probeAlive/claim 单元）
  clients-registry.test.ts        # 新建（fake timers）
  keepalive.test.ts               # 新建（脚本内容 + stub-curl 行为）
  engine-exit.test.ts             # 新建（POST /hooks/engine-exit 端点）
  heal.test.ts                    # 新建（decideHeal 单元 + 真 tmux ensure/unarchive 集成）
  http-heal.test.ts               # 新建（ensure/resume 端点 × 真 tmux）
  daemon.test.ts                  # 追加：awaited-close/SSE、refcount e2e、keep-alive 闭环
  tmux-service.test.ts            # 追加：respawnWindow
  tabs-repo.test.ts               # 追加：setEngineSessionId
  engine-claude.test.ts           # 追加：launchCommand resume
  hooks-endpoint.test.ts          # 追加：session_id 同步
  lifecycle-tmux.test.ts          # 修改：keep-alive 语义适配（archive 保留 tabs；死 pane 注入换法）
packages/cli/test/
  cli-e2e.test.ts                 # 追加：resume 经 ensure 重建
  export-doctor.test.ts           # 追加：doctor stuck-creating
```

事件类型词汇表（本计划新增；`engine.exited` 是 Plan 3 预留位的启用；末两行 **pre-existing on branch**——由并行 fixer 引入，本计划不新增但依赖/记录，见 F6）：

| type | payload | 产生点 |
|---|---|---|
| `engine.exited` | `{tabId, sessionId, exitCode}` | `POST /hooks/engine-exit`（keep-alive 包装回报；exitCode≠0 → tab status=`error`，=0 → `idle`） |
| `tab.session.changed` | `{tabId, sessionId}` | `TabsRepo.setEngineSessionId`（同事务；resume fork / heal 换新 id） |
| `workspace.tmux.healed` | `{sessionName, resumed, sessionId, tabId}` | `SessionEnsurer.ensure` 重建 session 后 |
| `workspace.heal.failed` | `{id, error:{tag,message}}` | unarchive 后 best-effort heal 失败（unarchive 本身不失败） |
| `engine.resumed` | `{tabId, sessionId, resumed}` | `SessionEnsurer.resumeTab` respawn 后 |
| `daemon.idle.exit` | `{graceMs}` | refcount 宽限期届满、自退前（workspaceId=null） |
| `engine.session.started` | 分支既有（以 `app.ts` `/hooks/claude` 实现为准） | **pre-existing on branch**：并行 fixer 的首条 prompt 就绪门控（`SessionStart` → 事件）；本计划 keep-alive 门控消费之 |
| `prompt.delivery.degraded` | 分支既有（以 `bootstrap.ts` 实现为准） | **pre-existing on branch**：首条 prompt 投递降级回报（bootstrap.ts 发出） |

---

### Task 1: Protocol——role/clients/heal 词汇 + 四条新路由

**Files:**
- Modify: `packages/protocol/src/domain.ts`
- Modify: `packages/protocol/src/routes.ts`
- Test: `packages/protocol/test/plan4-vocabulary.test.ts`

**Interfaces:**
- Produces（后续任务全部消费这些名字，签名以此为准）:
  - `ClientRole = "gui" | "terminal" | "cli"`（Schema.Literal + type）
  - `class ClientInfo { id: string; role: ClientRole; label: string | null; connectedAt: number }`
  - `ClientsStatus = { clients: ClientInfo[]; guiHolders: number; lingerMs: number; idleExitArmed: boolean }` + `decodeClientsStatus`
  - `HealAction = "none" | "recreated" | "respawned"`；`HealOutcome = { action: HealAction; resumed: boolean; sessionName: string; tabId: string | null; sessionId: string | null }` + `decodeHealOutcome`
  - ROUTES 新增：`GET /clients`、`POST /hooks/engine-exit`、`POST /workspaces/:id/ensure`、`POST /workspaces/:id/tabs/:tabId/resume`

- [ ] **Step 1: 写失败测试**

`packages/protocol/test/plan4-vocabulary.test.ts`：
```ts
import { describe, it, expect } from "vitest"
import {
  ROUTES, ClientRole, decodeClientsStatus, decodeHealOutcome, decodeCoolieEvent,
} from "../src/index.js"
import { Schema } from "effect"

describe("Plan 4 protocol vocabulary", () => {
  it("ROUTES 含 daemon 完善四路由", () => {
    const heads = ROUTES.map((r) => `${r.method} ${r.path}`)
    expect(heads).toContain("GET /clients")
    expect(heads).toContain("POST /hooks/engine-exit")
    expect(heads).toContain("POST /workspaces/:id/ensure")
    expect(heads).toContain("POST /workspaces/:id/tabs/:tabId/resume")
  })

  it("ClientRole 只接受 gui|terminal|cli", () => {
    const decode = Schema.decodeUnknownSync(ClientRole)
    expect(decode("gui")).toBe("gui")
    expect(decode("terminal")).toBe("terminal")
    expect(decode("cli")).toBe("cli")
    expect(() => decode("browser")).toThrow()
  })

  it("ClientsStatus 往返", () => {
    const s = decodeClientsStatus({
      clients: [{ id: "c1", role: "gui", label: null, connectedAt: 1720000000000 }],
      guiHolders: 1, lingerMs: 60000, idleExitArmed: false,
    })
    expect(s.clients[0]!.role).toBe("gui")
    expect(s.guiHolders).toBe(1)
  })

  it("HealOutcome 往返（none 时 tabId/sessionId 可 null）", () => {
    const h = decodeHealOutcome({ action: "none", resumed: false, sessionName: "coolie-w1", tabId: null, sessionId: null })
    expect(h.action).toBe("none")
    const h2 = decodeHealOutcome({ action: "recreated", resumed: true, sessionName: "coolie-w1", tabId: "t1", sessionId: "s1" })
    expect(h2.resumed).toBe(true)
    expect(() => decodeHealOutcome({ action: "rebooted", resumed: false, sessionName: "x", tabId: null, sessionId: null })).toThrow()
  })

  it("承接 branch 既有事件词汇（engine.session.started / prompt.delivery.degraded 已在分支上）", () => {
    // 这两个类型由并行 fixer 在本分支引入（app.ts /hooks/claude 端点 / bootstrap.ts），
    // 本计划不新增但依赖：keep-alive 的就绪门控消费 engine.session.started。此处钉住
    // CoolieEvent 解码器接受它们（type 是开放字符串，断言仅确认词汇未被收窄破坏）。
    for (const type of ["engine.session.started", "prompt.delivery.degraded"] as const) {
      const e = decodeCoolieEvent({ seq: 1, ts: 1720000000000, workspaceId: "w1", type, payload: {} })
      expect(e.type).toBe(type)
    }
  })
})
```
（`decodeCoolieEvent` 是 protocol 既有导出——CLI `events tail` 已消费；若 `CoolieEvent` 必填字段与此处入参不符，按其现有 shape 补齐，断言 `e.type` 不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --cwd packages/protocol test -- plan4-vocabulary`
Expected: FAIL——`ClientRole`/`decodeClientsStatus`/`decodeHealOutcome` 无导出、ROUTES 缺路由。

- [ ] **Step 3: 实现**

`packages/protocol/src/domain.ts` 末尾追加：
```ts
/** role 化 client 注册（设计文档 §2.1）：gui 持有 server 生命周期 lease，terminal pane / cli 一次性命令不持有。 */
export const ClientRole = Schema.Literal("gui", "terminal", "cli")
export type ClientRole = typeof ClientRole.Type

export class ClientInfo extends Schema.Class<ClientInfo>("ClientInfo")({
  id: Schema.String,
  role: ClientRole,
  label: Schema.NullOr(Schema.String),
  connectedAt: Schema.Number,
}) {}

export const ClientsStatus = Schema.Struct({
  clients: Schema.Array(ClientInfo),
  guiHolders: Schema.Number,
  lingerMs: Schema.Number,
  idleExitArmed: Schema.Boolean,
})
export type ClientsStatus = typeof ClientsStatus.Type
export const decodeClientsStatus = Schema.decodeUnknownSync(ClientsStatus)

/** ensure-or-heal / resume 的统一结果（设计文档 §十）。 */
export const HealAction = Schema.Literal("none", "recreated", "respawned")
export type HealAction = typeof HealAction.Type
export const HealOutcome = Schema.Struct({
  action: HealAction,
  resumed: Schema.Boolean,
  sessionName: Schema.String,
  tabId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
})
export type HealOutcome = typeof HealOutcome.Type
export const decodeHealOutcome = Schema.decodeUnknownSync(HealOutcome)
```

`packages/protocol/src/routes.ts`：在数组末尾（`GET /ws/terminal` 行之后）追加四行，并把 `/events/stream` 一行的 description 改为 `"SSE：durable replay + live 推送 ?after=&workspace=&role=（role=gui 持有 server 生命周期 lease）"`：
```ts
  { method: "GET",  path: "/clients",                        description: "当前连接客户端（role/持有状态）与惰性退出状态" },
  { method: "POST", path: "/hooks/engine-exit",              description: "keep-alive 包装回报 engine 退出 ?workspace= {exitCode}" },
  { method: "POST", path: "/workspaces/:id/ensure",          description: "ensure-or-heal：tmux session 丢失则重建（engine --resume 复活）" },
  { method: "POST", path: "/workspaces/:id/tabs/:tabId/resume", description: "engine 退出后原地重启（--resume 优先；session 丢失自动转 heal）" },
```
若 `packages/protocol/src/index.ts` 非 `export *`，补上新符号的 re-export。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --cwd packages/protocol test && bun run typecheck`
Expected: 全绿（含既有 protocol 用例——ROUTES 既有断言只用 `toContain`，追加不破坏）。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/domain.ts packages/protocol/src/routes.ts packages/protocol/test/plan4-vocabulary.test.ts
git commit -m "feat(protocol): Plan 4 词汇——ClientRole/ClientsStatus/HealOutcome + clients/engine-exit/ensure/resume 路由"
```

---

### Task 2: daemon/info 加固——probeAlive pid 预检 + claimServerInfo 独占写

ledger carry-over 两件：`probeAlive` 只探 HTTP，pid 已死时白等 500ms 超时、且端口被别人复用会假阳；`cmdStart` 的 probe→write 之间是 TOCTOU 窗口，两个并发 start 都能写 server.json。收口手段：pid 预检（`process.kill(pid, 0)`）+ `wx` flag 独占创建（EEXIST 时读出既有者，活着就认输）。

**Files:**
- Modify: `packages/server/src/daemon/info.ts`
- Test: `packages/server/test/daemon-info.test.ts`

**Interfaces:**
- Consumes: `ServerInfo/readServerInfo/writeServerInfo`（既有）
- Produces:
  - `probeAlive(info: ServerInfo): Promise<boolean>`——行为强化：pid 不存活直接 false（不发 HTTP）；pid 活着再探 `/health`
  - `claimServerInfo(infoPath: string, info: ServerInfo): Promise<boolean>`——独占注册：赢返回 true 并落盘（mode 0600）；已有**别的活 server** 返回 false 且不动对方文件；陈旧/损坏文件清掉重试一次

- [ ] **Step 1: 写失败测试**

`packages/server/test/daemon-info.test.ts`：
```ts
import { describe, it, expect } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { probeAlive, claimServerInfo, readServerInfo, writeServerInfo } from "../src/daemon/info.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-claim-"))
const DEAD_PID = 2 ** 30 // macOS pid_max 远小于此，必不存在

const withHealthServer = async <T>(fn: (port: number) => Promise<T>): Promise<T> => {
  const srv = http.createServer((_q, s) => s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })))
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  try { return await fn((srv.address() as { port: number }).port) }
  finally { srv.close() }
}

describe("probeAlive pid 预检", () => {
  it("pid 已死 → false，且走快速路径（无 500ms fetch 超时）", async () => {
    const t0 = Date.now()
    expect(await probeAlive({ port: 1, token: "x", pid: DEAD_PID })).toBe(false)
    expect(Date.now() - t0).toBeLessThan(200)
  })
  it("pid 活着但端口无人听 → false（仍会 HTTP 探测）", async () => {
    expect(await probeAlive({ port: 1, token: "x", pid: process.pid })).toBe(false)
  })
  it("pid 活着且 /health ok → true", async () => {
    await withHealthServer(async (port) => {
      expect(await probeAlive({ port, token: "x", pid: process.pid })).toBe(true)
    })
  })
})

describe("claimServerInfo（post-listen 单实例收口）", () => {
  it("无既有文件 → 独占写入成功，mode 0600", async () => {
    const p = path.join(tmp(), "server.json")
    expect(await claimServerInfo(p, { port: 1234, token: "t", pid: process.pid })).toBe(true)
    expect(readServerInfo(p)?.port).toBe(1234)
    expect(fs.statSync(p).mode & 0o777).toBe(0o600)
  })
  it("既有文件的 pid 已死 → 视为陈旧，清掉重写成功", async () => {
    const p = path.join(tmp(), "server.json")
    writeServerInfo(p, { port: 9, token: "old", pid: DEAD_PID })
    expect(await claimServerInfo(p, { port: 1234, token: "new", pid: process.pid })).toBe(true)
    expect(readServerInfo(p)?.token).toBe("new")
  })
  it("既有 server 活着且不是自己 → 认输，不覆盖对方", async () => {
    await withHealthServer(async (port) => {
      const p = path.join(tmp(), "server.json")
      writeServerInfo(p, { port, token: "winner", pid: process.pid }) // 活 pid + 活 /health
      expect(await claimServerInfo(p, { port: 4321, token: "loser", pid: process.pid + 1 })).toBe(false)
      expect(readServerInfo(p)?.token).toBe("winner")
    })
  })
  it("坏 JSON（损坏残留）→ 清掉重写成功", async () => {
    const p = path.join(tmp(), "server.json")
    fs.writeFileSync(p, "{corrupt")
    expect(await claimServerInfo(p, { port: 7, token: "t", pid: process.pid })).toBe(true)
    expect(readServerInfo(p)?.port).toBe(7)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --cwd packages/server test -- daemon-info`
Expected: FAIL——`claimServerInfo` 无此导出，4 个 claim 用例全部失败（这是本任务的 RED 信号）。probeAlive 的 3 个用例对现实现可能已过（port 1 上 ECONNREFUSED 本来就快）——它们的价值是钉住 pid 预检引入后的行为不回退，照写。

- [ ] **Step 3: 实现**

`packages/server/src/daemon/info.ts` 全文替换为：
```ts
import * as fs from "node:fs"
import * as path from "node:path"

export interface ServerInfo { port: number; token: string; pid: number; sock?: string }

export const readServerInfo = (infoPath: string): ServerInfo | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(infoPath, "utf8"))
    if (typeof raw.port === "number" && typeof raw.token === "string" && typeof raw.pid === "number")
      return { port: raw.port, token: raw.token, pid: raw.pid, ...(typeof raw.sock === "string" ? { sock: raw.sock } : {}) }
    return null
  } catch { return null }
}

export const writeServerInfo = (infoPath: string, info: ServerInfo): void => {
  fs.mkdirSync(path.dirname(infoPath), { recursive: true })
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 })
}

/** pid 预检（ledger carry-over）：进程都不在了就别发 HTTP 了——也顺带挡住
 * 「server.json 陈旧 + 端口被无关进程复用」的假阳。pid 活着仍以 /health 为准。 */
export const probeAlive = async (info: ServerInfo): Promise<boolean> => {
  try { process.kill(info.pid, 0) } catch { return false }
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(500) })
    return r.ok
  } catch { return false }
}

/**
 * post-listen 单实例收口（ledger carry-over：cmdStart 的 probe→write TOCTOU）：
 * 用 O_EXCL（flag "wx"）独占创建 server.json。EEXIST 时读出既有者——
 * 别人且活着 → 认输（绝不覆盖赢家）；陈旧/损坏/自己的残留 → 清掉重试一次。
 */
export const claimServerInfo = async (infoPath: string, info: ServerInfo): Promise<boolean> => {
  const payload = JSON.stringify(info, null, 2)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(infoPath), { recursive: true })
      fs.writeFileSync(infoPath, payload, { mode: 0o600, flag: "wx" })
      return true
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e
      const existing = readServerInfo(infoPath)
      if (existing && existing.pid !== info.pid && (await probeAlive(existing))) return false
      fs.rmSync(infoPath, { force: true }) // 陈旧/损坏 → 清掉进入下一轮独占写
    }
  }
  return false
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --cwd packages/server test -- daemon-info`
Expected: 7/7 PASS。再跑 `bun run --cwd packages/server test -- daemon.test` 确认既有 daemon 用例不受 probeAlive 变化影响（其 pid 均真实存活）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/daemon/info.ts packages/server/test/daemon-info.test.ts
git commit -m "feat(server): probeAlive pid 预检 + claimServerInfo 独占写（单实例 TOCTOU 收口）"
```

---

### Task 3: main.ts daemon 加固——claim 接线 + awaited close + shutdown 幂等

三处结构性修改：（1）监听顺序改为 **TCP listen → claim → 赢家才清/绑 unix socket**——原顺序里两个竞态 start 会互删对方的 `coolie.sock`；（2）`shutdown` 改为真正 await 两个 server 的 close，并用 `closeAllConnections()` 断掉 SSE/WS 长连接（否则 close 永不完成），外加 2s 兜底；（3）`shutdown` 幂等（refcount 自退与 SIGTERM/POST /shutdown 可能并发触发）。

**Files:**
- Modify: `packages/server/src/main.ts`
- Test: `packages/server/test/daemon.test.ts`（追加）

**Interfaces:**
- Consumes: `claimServerInfo`（Task 2）
- Produces: `cmdStart` 内部形状（Task 5 在此基础上加 ClientRegistry）：`let shuttingDown`、`const closeHttp`、`const shutdown = async () => …`、listen 回调内 claim。

- [ ] **Step 1: 写失败测试**

`packages/server/test/daemon.test.ts` 追加（沿用该文件既有 `startServer`/`home`/`child` helper；本任务顺手把 `startServer` 改为可传额外 env——Task 5 也要用）：

先把 helper 签名改为：
```ts
const startServer = async (extraEnv: Record<string, string> = {}) => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-daemon-"))
  child = spawn(TSX, [MAIN, "start"], {
    env: { ...process.env, COOLIE_HOME: home, COOLIE_TMUX_SOCKET: DAEMON_TMUX_SOCK, COOLIE_DISABLE_HOOKS: "1", ...extraEnv },
    stdio: "pipe", detached: true,
  })
  // …（循环探活部分不变）
```

新增 describe：
```ts
describe("daemon 加固（Plan 4）", () => {
  it("shutdown：挂着 SSE 长连接也在时限内退出，server.json 与 coolie.sock 都清掉", async () => {
    const info = await startServer()
    // 一条保持打开的 SSE 连接——没有 closeAllConnections 时 server.close 永不完成
    const req = http.get({
      host: "127.0.0.1", port: info.port, path: "/events/stream?after=0",
      headers: { Authorization: `Bearer ${info.token}` },
    })
    await new Promise<void>((resolve, reject) => { req.on("response", () => resolve()); req.on("error", reject) })
    await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      method: "POST", headers: { Authorization: `Bearer ${info.token}` },
    })
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if (!fs.existsSync(path.join(home, "server.json")) && !fs.existsSync(path.join(home, "coolie.sock"))) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false)
    expect(fs.existsSync(path.join(home, "coolie.sock"))).toBe(false)
    // 进程真的退了：/health 不再应答
    expect((await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null))).toBe(null)
    req.destroy()
  })

  it("并发 shutdown（SIGTERM + POST /shutdown 同时到达）→ 恰好一次干净退出、无 double-rm/double-close 抛错", async () => {
    const info = await startServer()
    // 一条开着的 SSE 长连接：迫使 closeAllConnections 真正参与（否则 close 永不完成 → 只能靠兜底超时退）
    const sse = http.get({
      host: "127.0.0.1", port: info.port, path: "/events/stream?after=0",
      headers: { Authorization: `Bearer ${info.token}` },
    })
    await new Promise<void>((resolve, reject) => { sse.on("response", () => resolve()); sse.on("error", reject) })
    let stderr = ""
    child.stderr?.on("data", (b) => { stderr += String(b) })
    const exits: Array<number | null> = []
    child.on("exit", (code) => exits.push(code))
    // 两条自退路径并发触发同一个 shutdown()：POST /shutdown 与 SIGTERM 竞相进入
    await Promise.all([
      fetch(`http://127.0.0.1:${info.port}/shutdown`, {
        method: "POST", headers: { Authorization: `Bearer ${info.token}` },
      }).catch(() => {}),
      Promise.resolve().then(() => { try { process.kill(child.pid!, "SIGTERM") } catch { /* 已退 */ } }),
    ])
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && exits.length === 0) await new Promise((r) => setTimeout(r, 50))
    // 幂等 guard（shuttingDown）保证只跑一次：恰好退一次、且是干净码 0（非双次、非崩溃码）
    expect(exits).toEqual([0])
    // 第二次进入 shutdown 若无 guard：un-forced `fs.rmSync(sockPath)` 抛 ENOENT / Scope.close 二次关抛错 → 落 crash-net stderr
    expect(stderr).not.toMatch(/ENOENT|UnhandledPromiseRejection|Error:/)
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false)
    expect(fs.existsSync(path.join(home, "coolie.sock"))).toBe(false)
    sse.destroy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --cwd packages/server test -- daemon.test -t "并发 shutdown"`
Expected: FAIL（这是本任务的**真 RED**——上面那条纯 SSE-shutdown 用例在现实现下常已通过，仅作回归钉；并发用例才必红）。现实现的 `shutdown` 无 `shuttingDown` 幂等 guard：SIGTERM handler 与 `POST /shutdown` 各触发一次 `shutdown()`，第二次进入时 sock/server.json 已被第一次删掉——未 `force` 的 `fs.rmSync(sockPath)` 抛
`ENOENT: no such file or directory, unlink '<home>/coolie.sock'`（外加 `Scope.close(scope)` 二次关闭的 rejection），经 crash-net 落 stderr，进程以非零码退或退两次。断言链先挂在 `expect(exits).toEqual([0])`（值为 `[1]` 或 `[0, 0]` 之类）或 `expect(stderr).not.toMatch(/ENOENT.../)`。Step 3 的幂等 guard + `{ force: true }` 落地后转 GREEN。（`claimServerInfo` 接线的编译期 RED 由 daemon-info 单测 RED-first 覆盖。）

- [ ] **Step 3: 实现**

`packages/server/src/main.ts` 的 `cmdStart` 改为（只展示改动后的完整函数体骨架，省略号处代码不变）：
```ts
const cmdStart = async (): Promise<void> => {
  const logPath = path.join(cfg.home, "logs", "server.log")
  rotateLogIfNeeded(logPath)
  const logger = createLogger(logPath, "server")
  installCrashNet(logger)

  const existing = readServerInfo(cfg.serverInfoPath)
  if (existing && (await probeAlive(existing))) {
    console.error(`already running pid=${existing.pid} port=${existing.port}`); process.exit(1)
  }
  if (existing) fs.rmSync(cfg.serverInfoPath, { force: true }) // 陈旧文件（快速路径；claim 再兜一次）

  // …（scope/appLayer/runtimeCtx/bus/runtime/token/ensureHookScript/tmux 检测/poller —— 全部不变）…

  const sockPath = path.join(cfg.home, "coolie.sock")

  // ---- Plan 4：幂等 + awaited close 的 shutdown ----
  let shuttingDown = false
  const closeHttp = (s: http.Server): Promise<void> =>
    new Promise((resolve) => {
      s.close(() => resolve())            // 未 listen 的 server：回调带 err 也会触发 → 照样 resolve
      s.closeAllConnections()             // SSE/WS 长连接不断掉，close 永不完成（Node ≥18.2）
    })
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return              // POST /shutdown、SIGTERM、idle-exit 可能并发到达
    shuttingDown = true
    logger.info("shutdown")
    stopPoller()
    fs.rmSync(cfg.serverInfoPath, { force: true })
    await Promise.race([
      Promise.all([closeHttp(server), closeHttp(unixServer)]),
      new Promise((r) => setTimeout(r, 2000)), // 兜底：close 卡住也要退
    ])
    fs.rmSync(sockPath, { force: true })
    await Effect.runPromise(Scope.close(scope, Exit.void)) // control client dispose；tmux server/session 不动
    await Promise.race([logger.flush(), new Promise((r) => setTimeout(r, 2000))])
    process.exit(0)
  }

  const app = createApp({ /* …不变… */ })
  const server = http.createServer(app)
  attachTerminalWs(server, { /* …不变… */ })

  // ---- Plan 4：先 TCP listen，claim 赢了才碰 unix socket ----
  // 旧顺序（先 rm sock 再 listen sock 再 TCP）下，两个竞态 start 会互删对方的 sock。
  fs.mkdirSync(cfg.home, { recursive: true })
  const unixServer = http.createServer(app)

  server.listen(0, "127.0.0.1", () => {
    void (async () => {
      const port = (server.address() as { port: number }).port
      const won = await claimServerInfo(cfg.serverInfoPath, { port, token, pid: process.pid, sock: sockPath })
      if (!won) {
        logger.warn("单实例竞态落败：另一个 coolie-server 已注册 server.json，本进程退出（不碰对方的 sock）")
        server.close(); server.closeAllConnections()
        await Promise.race([logger.flush(), new Promise((r) => setTimeout(r, 1000))])
        process.exit(1)
      }
      fs.rmSync(sockPath, { force: true }) // 赢家清陈旧 sock
      unixServer.listen(sockPath, () => logger.info(`listening on unix socket ${sockPath}`))
      logger.info(`coolie-server listening on 127.0.0.1:${port}`)
    })()
  })
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}
```
import 行把 `writeServerInfo` 换成 `claimServerInfo`（`readServerInfo/probeAlive` 保留）：
```ts
import { readServerInfo, claimServerInfo, probeAlive } from "./daemon/info.js"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --cwd packages/server test -- daemon.test && bun run typecheck`
Expected: daemon.test 全绿（既有 start/stop/单实例/unix socket/engine 生存用例 + 新 SSE-shutdown 用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/main.ts packages/server/test/daemon.test.ts
git commit -m "feat(server): daemon 加固——post-listen claim、awaited close(closeAllConnections)、幂等 shutdown"
```

---

### Task 4: ClientRegistry——role 化 refcount 纯内存注册表

**Files:**
- Create: `packages/server/src/daemon/clients.ts`
- Test: `packages/server/test/clients-registry.test.ts`

**Interfaces:**
- Consumes: `ClientRole`（Task 1，from `@coolie/protocol`）
- Produces（Task 5/11 消费）:
  ```ts
  interface ClientLease { id: string; role: ClientRole; label: string | null; connectedAt: number }
  interface ClientRegistryOpts { graceMs: number; onIdleExpired: () => void; now?: () => number }
  interface ClientRegistry {
    register: (role: ClientRole, label?: string) => ClientLease
    release: (id: string) => void
    list: () => ClientLease[]
    guiCount: () => number
    idleExitArmed: () => boolean
    graceMs: number
    dispose: () => void
  }
  makeClientRegistry(opts: ClientRegistryOpts): ClientRegistry
  ```

- [ ] **Step 1: 写失败测试**

`packages/server/test/clients-registry.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeClientRegistry } from "../src/daemon/clients.js"

describe("ClientRegistry（role 化 refcount 惰性退出）", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("最后一个 gui 断开 → 布防；grace 届满触发 onIdleExpired 恰好一次", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 1000, onIdleExpired: fired })
    const a = reg.register("gui")
    expect(reg.guiCount()).toBe(1)
    expect(reg.idleExitArmed()).toBe(false)
    reg.release(a.id)
    expect(reg.idleExitArmed()).toBe(true)
    vi.advanceTimersByTime(999)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledTimes(1)
    expect(reg.idleExitArmed()).toBe(false)
  })

  it("宽限期内 gui 回归 → 取消退出", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 1000, onIdleExpired: fired })
    reg.release(reg.register("gui").id)
    expect(reg.idleExitArmed()).toBe(true)
    reg.register("gui") // 回来了
    expect(reg.idleExitArmed()).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(fired).not.toHaveBeenCalled()
  })

  it("terminal/cli 不持有：注册与断开都不布防", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 100, onIdleExpired: fired })
    reg.release(reg.register("terminal").id)
    reg.release(reg.register("cli").id)
    expect(reg.idleExitArmed()).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(fired).not.toHaveBeenCalled()
  })

  it("从未有过 gui 持有者 → 永不布防（CLI 拉起的 server 驻留到显式 stop）", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 100, onIdleExpired: fired })
    vi.advanceTimersByTime(60_000)
    expect(fired).not.toHaveBeenCalled()
    expect(reg.idleExitArmed()).toBe(false)
  })

  it("多个 gui：只有最后一个断开才布防", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 1000, onIdleExpired: fired })
    const a = reg.register("gui"); const b = reg.register("gui")
    reg.release(a.id)
    expect(reg.idleExitArmed()).toBe(false) // 还剩 b
    reg.release(b.id)
    expect(reg.idleExitArmed()).toBe(true)
  })

  it("已触发过一次后不再重复触发（shutdown 已在路上）", () => {
    const fired = vi.fn()
    const reg = makeClientRegistry({ graceMs: 100, onIdleExpired: fired })
    reg.release(reg.register("gui").id)
    vi.advanceTimersByTime(100)
    reg.release(reg.register("gui").id) // 触发后又来了一轮
    vi.advanceTimersByTime(1000)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it("release 未知 id 为 no-op；list/guiCount 反映当前连接；graceMs 暴露", () => {
    const reg = makeClientRegistry({ graceMs: 777, onIdleExpired: () => {} })
    reg.release("nope")
    const g = reg.register("gui", "tauri-main")
    const t = reg.register("terminal")
    expect(reg.list().map((c) => c.role).sort()).toEqual(["gui", "terminal"])
    expect(reg.list().find((c) => c.id === g.id)?.label).toBe("tauri-main")
    expect(reg.list().find((c) => c.id === t.id)?.label).toBe(null)
    expect(reg.guiCount()).toBe(1)
    expect(reg.graceMs).toBe(777)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --cwd packages/server test -- clients-registry`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`packages/server/src/daemon/clients.ts`：
```ts
import { randomUUID } from "node:crypto"
import type { ClientRole } from "@coolie/protocol"

/** 一条已连接客户端的登记（lease）。gui 是持有者；terminal/cli 只登记、不持有。 */
export interface ClientLease {
  readonly id: string
  readonly role: ClientRole
  readonly label: string | null
  readonly connectedAt: number
}

export interface ClientRegistryOpts {
  /** 最后一个 gui 持有者断开后的惰性退出宽限期（ms） */
  readonly graceMs: number
  /** 宽限期届满且期间无 gui 回归 → 触发（整个 registry 生命周期最多一次） */
  readonly onIdleExpired: () => void
  readonly now?: () => number
}

export interface ClientRegistry {
  readonly register: (role: ClientRole, label?: string) => ClientLease
  readonly release: (id: string) => void
  readonly list: () => ClientLease[]
  readonly guiCount: () => number
  readonly idleExitArmed: () => boolean
  readonly graceMs: number
  readonly dispose: () => void
}

/**
 * role 化 refcount（设计文档 §2.1，kobe 路线）：
 * - lease 与连接同生共死（调用方在连接 close 时 release），GUI 崩溃即自动释放——
 *   拒绝「显式 unregister API」协议：崩掉的 GUI 会把 daemon 钉成永生。
 * - 布防只发生在「gui 持有数 >0 → 0」转变沿；从未有过 gui → 永不布防（M1 决定：
 *   CLI 拉起的 server 驻留到显式 stop，`coolie server stop` 是它的退出面）。
 * - timer unref：不阻进程因其他原因退出。
 */
export const makeClientRegistry = (opts: ClientRegistryOpts): ClientRegistry => {
  const clients = new Map<string, ClientLease>()
  const now = opts.now ?? Date.now
  let timer: NodeJS.Timeout | null = null
  let fired = false

  const guiCount = (): number => {
    let n = 0
    for (const c of clients.values()) if (c.role === "gui") n++
    return n
  }
  const disarm = (): void => { if (timer !== null) { clearTimeout(timer); timer = null } }
  const arm = (): void => {
    if (fired) return
    disarm()
    timer = setTimeout(() => { timer = null; if (!fired) { fired = true; opts.onIdleExpired() } }, opts.graceMs)
    timer.unref?.()
  }

  return {
    graceMs: opts.graceMs,
    register: (role, label) => {
      const lease: ClientLease = { id: randomUUID(), role, label: label ?? null, connectedAt: now() }
      clients.set(lease.id, lease)
      if (role === "gui") disarm() // 宽限期内 GUI 回归：取消退出
      return lease
    },
    release: (id) => {
      const lease = clients.get(id)
      if (!lease) return
      clients.delete(id)
      if (lease.role === "gui" && guiCount() === 0) arm()
    },
    list: () => [...clients.values()],
    guiCount,
    idleExitArmed: () => timer !== null,
    dispose: disarm,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --cwd packages/server test -- clients-registry`
Expected: 7/7 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/daemon/clients.ts packages/server/test/clients-registry.test.ts
git commit -m "feat(server): ClientRegistry——role 化 refcount + grace timer（转变沿布防/回归取消/只触发一次）"
```

---

### Task 5: refcount 接线——SSE role lease + WS 登记 + GET /clients + idle 自退（e2e）

**Files:**
- Modify: `packages/server/src/http/app.ts`
- Modify: `packages/server/src/http/ws.ts`
- Modify: `packages/server/src/main.ts`
- Test: `packages/server/test/daemon.test.ts`（追加 e2e，用真实 SSE 客户端 + 短 grace）

**Interfaces:**
- Consumes: `makeClientRegistry/ClientRegistry`（Task 4）、`ClientRole`（Task 1）、Task 3 的 `shutdown`
- Produces:
  - `AppDeps` 增加 `readonly clients?: ClientRegistry`（未提供时 `/clients` 返回 500，SSE role 参数被忽略——既有测试零改动）
  - `GET /events/stream?role=gui|terminal|cli&label=<可选>`：合法 role 才登记；`role=gui` 的连接持有 lease，连接关闭自动释放；非法 role → 400
  - `GET /clients` → `ClientsStatus`（Task 1 shape）
  - `TerminalWsDeps` 增加 `readonly clients?: ClientRegistry`；WS 终端连接**一律登记为 `terminal`**（忽略 query 声明——终端 pane 永不持有是 §2.1 的硬语义，不给 GUI 误声明的机会）
  - main.ts：`COOLIE_LINGER_MS`（默认 60000）→ registry；届满 → `daemon.idle.exit` 事件 + `shutdown()`

- [ ] **Step 1: 写失败测试（daemon e2e）**

`packages/server/test/daemon.test.ts` 追加（`startServer` 已在 Task 3 支持 extraEnv）：
```ts
describe("refcount 惰性退出（真实 SSE 客户端 + 短 grace）", () => {
  const openSse = (info: { port: number; token: string }, role?: string): Promise<http.ClientRequest> =>
    new Promise((resolve, reject) => {
      const req = http.get({
        host: "127.0.0.1", port: info.port,
        path: `/events/stream?after=0${role ? `&role=${role}` : ""}`,
        headers: { Authorization: `Bearer ${info.token}` },
      })
      req.on("response", (res) => { res.resume(); resolve(req) })
      req.on("error", reject)
    })
  const serverGone = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!fs.existsSync(path.join(home, "server.json"))) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  it("最后一个 gui 断开 → grace 后 server 自退并清理 server.json/sock", async () => {
    const info = await startServer({ COOLIE_LINGER_MS: "400" })
    const gui = await openSse(info, "gui")
    const cs = await (await fetch(`http://127.0.0.1:${info.port}/clients`, {
      headers: { Authorization: `Bearer ${info.token}` },
    })).json()
    expect(cs.guiHolders).toBe(1)
    expect(cs.lingerMs).toBe(400)
    gui.destroy()
    expect(await serverGone(8_000)).toBe(true)
    expect(fs.existsSync(path.join(home, "coolie.sock"))).toBe(false)
  })

  it("宽限期内 gui 重连 → 不退", async () => {
    const info = await startServer({ COOLIE_LINGER_MS: "800" })
    const g1 = await openSse(info, "gui")
    g1.destroy()
    await new Promise((r) => setTimeout(r, 200))
    const g2 = await openSse(info, "gui") // 回归：取消退出
    await new Promise((r) => setTimeout(r, 1_500))
    expect((await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null))?.ok).toBe(true)
    g2.destroy()
  })

  it("无 role 的 SSE 连接不持有：断开后 server 不退（从未有 gui → 永不布防）", async () => {
    const info = await startServer({ COOLIE_LINGER_MS: "300" })
    const plain = await openSse(info)
    plain.destroy()
    await new Promise((r) => setTimeout(r, 1_000))
    expect((await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null))?.ok).toBe(true)
  })

  it("非法 role → 400；GET /clients 无 token → 401", async () => {
    const info = await startServer()
    const r = await fetch(`http://127.0.0.1:${info.port}/events/stream?after=0&role=browser`, {
      headers: { Authorization: `Bearer ${info.token}` },
    })
    expect(r.status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${info.port}/clients`)).status).toBe(401)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --cwd packages/server test -- daemon.test -t "refcount"`
Expected: FAIL——`/clients` 404、role 参数被忽略（400 用例挂）、断开后 server 永不退（第一用例 8s 超时判 false）。

- [ ] **Step 3: 实现——app.ts**

`packages/server/src/http/app.ts`：

import 区追加：
```ts
import type { ClientRegistry } from "../daemon/clients.js"
import type { ClientRole } from "@coolie/protocol"
```
`AppDeps` 追加一行：
```ts
  /** role 化 refcount（Plan 4）；未提供时 /clients 500、SSE role 参数忽略（测试友好） */
  readonly clients?: ClientRegistry
```
`createApp` 解构加 `clients`。`GET /events/stream` 分支改为：
```ts
        if (route === "GET /events/stream") {
          if (!bus) return err(res, 500, "Internal", "event bus unavailable")
          const after = intParam(url, "after", 0)
          if (after === null) return err(res, 400, "Validation", "after must be a non-negative integer")
          const roleRaw = url.searchParams.get("role")
          if (roleRaw !== null && !["gui", "terminal", "cli"].includes(roleRaw))
            return err(res, 400, "Validation", "role must be gui|terminal|cli")
          if (clients && roleRaw !== null) {
            // lease 与连接同生共死：GUI 崩溃 = 连接断 = 自动释放（绝不做显式 unregister API）
            const lease = clients.register(roleRaw as ClientRole, url.searchParams.get("label") ?? undefined)
            req.on("close", () => clients.release(lease.id))
          }
          const ws = url.searchParams.get("workspace")
          return await handleEventsStream(req, res,
            { runtime, bus, ...(sseHeartbeatMs !== undefined ? { heartbeatMs: sseHeartbeatMs } : {}) },
            { after, ...(ws ? { workspaceId: ws } : {}) })
        }
```
`POST /shutdown` 分支之后、`/events/stream` 之前插入：
```ts
        if (route === "GET /clients") {
          if (!clients) return err(res, 500, "Internal", "client registry unavailable")
          return send(res, 200, {
            clients: clients.list(),
            guiHolders: clients.guiCount(),
            lingerMs: clients.graceMs,
            idleExitArmed: clients.idleExitArmed(),
          })
        }
```

- [ ] **Step 4: 实现——ws.ts（终端连接登记，永不持有）**

`packages/server/src/http/ws.ts`：
```ts
import type { ClientRegistry } from "../daemon/clients.js"
```
`TerminalWsDeps` 追加：
```ts
  /** 登记进 /clients 视图；WS 终端一律 role=terminal——pane 永不持有 server 生命周期（§2.1） */
  readonly clients?: ClientRegistry
```
`handleConn` 里 pty spawn 成功之后、`let closed = false` 之前插入：
```ts
  const lease = deps.clients?.register("terminal")
```
既有 `ws.on("close", …)` 回调第一行加：
```ts
    if (lease) deps.clients?.release(lease.id)
```

- [ ] **Step 5: 实现——main.ts 接线**

`packages/server/src/main.ts`：
```ts
import { makeClientRegistry } from "./daemon/clients.js"
import { EventsRepo } from "./repo/events.js"
```
`cmdStart` 内、`const app = createApp(…)` 之前（`shutdown` 定义之后）插入：
```ts
  // refcount 惰性退出（设计文档 §2.1）：COOLIE_LINGER_MS 只在此边缘读取——
  // 不进 CoolieConfig（5 个测试 fixture 注入完整 config shape，加必填字段会全体破坏）
  const lingerRaw = Number(process.env.COOLIE_LINGER_MS ?? "")
  const lingerMs = Number.isFinite(lingerRaw) && lingerRaw > 0 ? lingerRaw : 60_000
  const clients = makeClientRegistry({
    graceMs: lingerMs,
    onIdleExpired: () => {
      logger.info(`refcount 惰性退出：最后一个 gui 持有者断开已超 ${lingerMs}ms`)
      void (async () => {
        await runtime(Effect.gen(function* () {
          yield* (yield* EventsRepo).append({ workspaceId: null, type: "daemon.idle.exit", payload: { graceMs: lingerMs } })
        }))
        await shutdown() // 与 POST /shutdown 同一条路：engine 归 tmux，session 分毫不动
      })()
    },
  })
```
`shutdown` 里 `stopPoller()` 之后加一行 `clients.dispose()`（注意：`clients` 声明在 `shutdown` 之后也可——`shutdown` 只在事件回调里执行，TDZ 已过；若 lint 报 use-before-define，把 registry 声明上移到 `shutdown` 之前并把 `onIdleExpired` 改为引用 `() => void idleExit()` 的后置函数，行为契约不变）。`createApp` 参数加 `clients`：
```ts
  const app = createApp({
    runtime, token, bus, claudeHome: cfg.claudeHome, clients,
    onShutdown: () => void shutdown(),
    onError: (e) => logger.error("http 500", e),
  })
```
`attachTerminalWs` 的 deps 加 `clients`。

- [ ] **Step 6: 跑测试确认通过**

Run: `bun run --cwd packages/server test -- daemon.test && bun run --cwd packages/server test -- sse.test http.test ws-terminal && bun run typecheck`
Expected: 新 4 用例 PASS；既有 SSE/http/WS 用例不受影响（它们不传 `clients`）。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/http/app.ts packages/server/src/http/ws.ts packages/server/src/main.ts packages/server/test/daemon.test.ts
git commit -m "feat(server): refcount 接线——SSE role=gui lease、WS terminal 登记、GET /clients、idle 自退 + daemon.idle.exit"
```

---

### Task 6: keep-alive 脚本 + POST /hooks/engine-exit 端点

engine 退出的回报链路：keep-alive 脚本（下一任务才接进 tmux）→ `POST /hooks/engine-exit` → tab status（`0→idle`、`≠0→error`，`error` 徽标产生点在此启用）+ `engine.exited` 事件。本任务先把两端做出来并各自单测；脚本行为用 **stub curl（PATH 注入）** 验证，不碰 tmux。

**Files:**
- Create: `packages/server/src/engine/keepalive.ts`
- Modify: `packages/server/src/repo/tabs.ts`（setStatus source 扩展）
- Modify: `packages/server/src/http/app.ts`（新端点）
- Modify: `packages/server/src/engine/claude/hooks.ts`（M2 carry-over 1 行修复：脚本路径加引号）
- Test: `packages/server/test/keepalive.test.ts`、`packages/server/test/engine-exit.test.ts`

**Interfaces:**
- Consumes: `TabsRepo.findEngineTab/setStatus`、`EventsRepo.append`（既有）
- Produces:
  - `keepAliveScriptPath(home: string): string`（= `<home>/hooks/coolie-keepalive.sh`）
  - `ensureKeepAliveScript(home: string): string`——幂等重写，mode 0755
  - `wrapEngineCommand(home: string, wsId: string, engineCmd: readonly string[]): string[]`（= `["/bin/sh", scriptPath, wsId, ...engineCmd]`）
  - `TabsRepo.setStatus` 的 `source` 形参类型改为 `export type TabStatusSource = "hook" | "poller" | "wrapper" | "heal"`（`"heal"` 供 Task 9/10 使用，一次定义到位）
  - `POST /hooks/engine-exit?workspace=<wsId>`，body `{exitCode: number}`（整数，否则 400）→ `{ok:true}`；无 engine tab 静默成功（与 /hooks/claude 同款——归档/删除竞态不算错）

- [ ] **Step 1: 写失败测试（脚本）**

`packages/server/test/keepalive.test.ts`：
```ts
import { describe, it, expect, beforeEach } from "vitest"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { ensureKeepAliveScript, keepAliveScriptPath, wrapEngineCommand } from "../src/engine/keepalive.js"

let home: string, stubDir: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka-home-"))
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka-stub-"))
  // stub curl：把参数记到文件，永远成功——脚本行为可断言且不发真网络
  fs.writeFileSync(path.join(stubDir, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${stubDir}/curl-args"\nexit 0\n`, { mode: 0o755 })
})

const runScript = (args: string[], extraEnv: Record<string, string> = {}) =>
  spawnSync("/bin/sh", [keepAliveScriptPath(home), ...args], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      SHELL: "/bin/true", // exec 的兜底 shell 立即退出，测试不悬挂
      ...extraEnv,
    },
    encoding: "utf8",
  })

describe("keep-alive 包装脚本", () => {
  it("生成：可执行、含 engine-exit 回报与 exec shell、勿手改标注", () => {
    const p = ensureKeepAliveScript(home)
    expect(p).toBe(keepAliveScriptPath(home))
    expect(fs.statSync(p).mode & 0o111).not.toBe(0)
    const body = fs.readFileSync(p, "utf8")
    expect(body).toContain("/hooks/engine-exit?workspace=$WS")
    expect(body).toContain(`${home}/server.json`)
    expect(body).toContain('exec "${SHELL:-/bin/sh}"')
  })

  it("engine 非零退出：curl 回报 exitCode + 横幅打印 + 落回 shell", () => {
    fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ port: 45678, token: "tok-1", pid: 1 }))
    ensureKeepAliveScript(home)
    const r = runScript(["wsX", "sh", "-c", "exit 3"])
    expect(r.status).toBe(0) // exec /bin/true → 脚本进程以 shell 的退出码结束，绝不因 engine 死而带走 pane
    const args = fs.readFileSync(path.join(stubDir, "curl-args"), "utf8")
    expect(args).toContain("/hooks/engine-exit?workspace=wsX")
    expect(args).toContain('{"exitCode":3}')
    expect(args).toContain("Bearer tok-1")
    expect(r.stdout).toContain("engine exited (code 3)")
    expect(r.stdout).toContain("coolie resume wsX")
  })

  it("server.json 缺席：跳过回报、仍打横幅落回 shell（回报是 best-effort）", () => {
    ensureKeepAliveScript(home)
    const r = runScript(["wsY", "sh", "-c", "exit 0"])
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(stubDir, "curl-args"))).toBe(false)
    expect(r.stdout).toContain("engine exited (code 0)")
  })

  it("engine 参数原样传递（含空格参数不经二次分词）", () => {
    ensureKeepAliveScript(home)
    const r = runScript(["wsZ", "printf", "%s", "a b"])
    expect(r.stdout.startsWith("a b")).toBe(true)
  })

  it("wrapEngineCommand 形状", () => {
    expect(wrapEngineCommand(home, "w1", ["cat"])).toEqual(["/bin/sh", keepAliveScriptPath(home), "w1", "cat"])
  })
})
```

- [ ] **Step 2: 跑脚本测试确认失败**

Run: `bun run --cwd packages/server test -- keepalive`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现脚本生成**

`packages/server/src/engine/keepalive.ts`：
```ts
import * as fs from "node:fs"
import * as path from "node:path"

export const keepAliveScriptPath = (home: string): string => path.join(home, "hooks", "coolie-keepalive.sh")

/**
 * engine keep-alive 包装（设计文档 §十）：engine 退出后 pane 不塌——
 * 回报 server（best-effort，hook-cmd 三铁律：绝不拉起 server、失败静默、绝不带走 pane）→
 * 打印横幅 → exec 交互 shell（布局保留、pane pid 不变）。
 * 每次 server 启动重写（home/版本变更自动生效）；token/port 运行时从 server.json 读，脚本不含密钥。
 */
export const ensureKeepAliveScript = (home: string): string => {
  const p = keepAliveScriptPath(home)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const script = `#!/bin/sh
# Coolie engine keep-alive 包装（自动生成，勿手改）。
# 用法：coolie-keepalive.sh <workspaceId> <engine command...>
WS="$1"; shift
"$@"
CODE=$?
INFO="${home}/server.json"
if [ -f "$INFO" ]; then
  PORT=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$INFO")
  TOKEN=$(sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' "$INFO")
  if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
    curl -s -m 2 -X POST "http://127.0.0.1:$PORT/hooks/engine-exit?workspace=$WS" \\
      -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
      --data "{\\"exitCode\\":$CODE}" >/dev/null 2>&1
  fi
fi
printf '\\n[coolie] engine exited (code %s) — GUI Resume 按钮或 coolie resume %s 重启\\n' "$CODE" "$WS"
exec "\${SHELL:-/bin/sh}"
`
  fs.writeFileSync(p, script, { mode: 0o755 })
  return p
}

/** engine 命令 → window 0 实际运行的包装命令。 */
export const wrapEngineCommand = (home: string, wsId: string, engineCmd: readonly string[]): string[] =>
  ["/bin/sh", keepAliveScriptPath(home), wsId, ...engineCmd]
```
（注意 TS 模板字面量里的转义：写进文件的最终脚本中应是 `sed -n 's/.*"port": *\([0-9][0-9]*\).*/\1/p'`、`--data "{\"exitCode\":$CODE}"`、`exec "${SHELL:-/bin/sh}"`——与 `engine/claude/hooks.ts` 的既有转义手法一致，实现后用测试的 `body` 断言核对。）

- [ ] **Step 4: 跑脚本测试确认通过**

Run: `bun run --cwd packages/server test -- keepalive`
Expected: 5/5 PASS。

- [ ] **Step 5: 写失败测试（端点）**

`packages/server/test/engine-exit.test.ts`（harness 与 `hooks-endpoint.test.ts` 的 endpoint describe 同构）：
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { createApp, newToken } from "../src/http/app.js"

describe("POST /hooks/engine-exit（keep-alive 回报）", () => {
  let server: http.Server, base: string, token: string, db: Database.Database, tabId: string

  beforeEach(async () => {
    db = new Database(":memory:"); runMigrations(db)
    const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ee-ws-"))
    db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)`).run()
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w1','p1','usa-zion',?,'coolie/a','main','r','active',0,1,NULL,'{}')`).run(wsPath)
    const layer = Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive, EngineRegistryLive)
      .pipe(Layer.provide(Layer.succeed(Db, db)))
    const runtime = (eff: any) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, never, never>)
    tabId = (await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "sess-1", tmuxWindow: 0 })
    }), layer) as Effect.Effect<any, never, never>)).id
    token = newToken()
    server = http.createServer(createApp({ runtime, token, onShutdown: () => {} }))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => server.close())

  const post = (qs: string, body: unknown) => fetch(`${base}/hooks/engine-exit${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const tabRow = () => db.prepare("SELECT * FROM tabs WHERE id = ?").get(tabId) as any
  const events = () => db.prepare("SELECT type, payload FROM events ORDER BY seq").all() as any[]

  it("exitCode≠0 → status=error + engine.exited（error 徽标产生点）", async () => {
    const r = await post("?workspace=w1", { exitCode: 137 })
    expect(r.status).toBe(200)
    expect(tabRow().status).toBe("error")
    const ev = events().find((e) => e.type === "engine.exited")
    expect(ev).toBeDefined()
    expect(JSON.parse(ev!.payload)).toEqual({ tabId, sessionId: "sess-1", exitCode: 137 })
    const st = events().find((e) => e.type === "tab.status.changed")
    expect(JSON.parse(st!.payload).source).toBe("wrapper")
  })

  it("exitCode=0 → status=idle + engine.exited", async () => {
    await post("?workspace=w1", { exitCode: 0 })
    expect(tabRow().status).toBe("idle")
    expect(events().some((e) => e.type === "engine.exited")).toBe(true)
  })

  it("无 workspace → 400；无 engine tab 的 workspace → 200 静默；非整数 exitCode → 400；无 token → 401", async () => {
    expect((await post("", { exitCode: 1 })).status).toBe(400)
    expect((await post("?workspace=ghost", { exitCode: 1 })).status).toBe(200)
    expect((await post("?workspace=w1", { exitCode: "boom" })).status).toBe(400)
    expect((await fetch(`${base}/hooks/engine-exit?workspace=w1`, { method: "POST", body: "{}" })).status).toBe(401)
  })
})
```

- [ ] **Step 6: 跑端点测试确认失败**

Run: `bun run --cwd packages/server test -- engine-exit`
Expected: FAIL——路由 404。

- [ ] **Step 7: 实现——tabs.ts source 扩展 + app.ts 端点**

`packages/server/src/repo/tabs.ts`：接口处
```ts
export type TabStatusSource = "hook" | "poller" | "wrapper" | "heal"
```
并把
```ts
  readonly setStatus: (id: string, status: TabStatus, source: "hook" | "poller") => Effect.Effect<Tab, NotFoundError>
```
改为
```ts
  readonly setStatus: (id: string, status: TabStatus, source: TabStatusSource) => Effect.Effect<Tab, NotFoundError>
```
（实现体不变——source 只进事件 payload。）

`packages/server/src/http/app.ts`：`POST /hooks/claude` 分支之后插入：
```ts
        if (route === "POST /hooks/engine-exit") {
          const wsId = url.searchParams.get("workspace")
          if (!wsId) return err(res, 400, "Validation", "workspace query param required")
          const body = await readJson(req)
          if (!Number.isInteger(body.exitCode)) return err(res, 400, "Validation", "exitCode must be an integer")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const tabs = yield* TabsRepo
              const tab = yield* tabs.findEngineTab(wsId)
              if (!tab) return { ok: true } // 已归档/删除的竞态回报：与 /hooks/claude 同款静默
              yield* tabs.setStatus(tab.id, body.exitCode === 0 ? "idle" : "error", "wrapper")
              yield* (yield* EventsRepo).append({
                workspaceId: wsId, type: "engine.exited",
                payload: { tabId: tab.id, sessionId: tab.engineSessionId, exitCode: body.exitCode },
              })
              return { ok: true }
            }),
            (r) => send(res, 200, r),
            onError,
          )
        }
```

**M2 carry-over（1 行修复，就近收口）**：`packages/server/src/engine/claude/hooks.ts:47` 的 hook 命令组装未给脚本路径加引号，`COOLIE_HOME` 含空格时命令断裂——keep-alive 脚本命令组装（本任务 `keepalive.ts`）复用同款 hook-cmd 纪律、就在隔壁，一并修：
```ts
// hooks.ts:47（当前）
const command = `COOLIE_WORKSPACE=${opts.workspaceId} sh ${opts.scriptPath}`
// 改为（脚本路径加双引号，含空格路径不被二次分词）
const command = `COOLIE_WORKSPACE=${opts.workspaceId} sh "${opts.scriptPath}"`
```
（既有 `hooks-endpoint.test.ts` / 注入用例断言的是「脚本被 HOOK_EVENTS 各事件挂上」，`toContain(scriptPath)` 子串不受引号影响——回归零破坏；`wrapEngineCommand` 走 argv 数组不经 shell 分词，本就无此问题，此处只对齐 hooks.ts 的字符串命令。）

- [ ] **Step 8: 跑测试确认通过**

Run: `bun run --cwd packages/server test -- engine-exit keepalive tabs-repo hooks-endpoint monitor && bun run typecheck`
Expected: 全绿（source 扩展是加宽，既有 `"hook"/"poller"` 调用点零改动）。

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/engine/keepalive.ts packages/server/src/repo/tabs.ts packages/server/src/http/app.ts packages/server/src/engine/claude/hooks.ts packages/server/test/keepalive.test.ts packages/server/test/engine-exit.test.ts
git commit -m "feat(server): keep-alive 包装脚本 + POST /hooks/engine-exit（engine.exited 事件 + error 徽标产生点）+ M2 hook 路径引号修复"
```

---

### Task 7: keep-alive 接入 create——launchCommand resume 选项 + startEngineSession 抽取 + bootstrap 改造

window 0 从「直跑 engine」变为「keep-alive 包装的 engine」。同时把「建 session + 启 engine」抽为 `startEngineSession`（heal 在 Task 9 复用），并给 `Engine.launchCommand` 加 `resume?: boolean`（claude → `[bin, --resume, sessionId]`，`resumeArgs` 是它的实现件）。

**⚠ 语义变更与并行 fixer 适配注记**：包装后 engine 退出**不再**导致 window/session 消亡。`lifecycle-tmux.test.ts` 里「死 pane 注入」用例靠「engine 秒退 → session 消失 → waitStable 报错」触发 mid-hook 失败——该注入方式失效，本任务改用「画面永不稳定」注入（死循环打印）。若并行 fixer 已把首条 prompt 门控改为 `engine.session.started` 事件等待，则该用例按 fixer 形状等价改写，**行为契约不变：hook 中途失败 → session+tabs 拆干净 + status=error**。

**Files:**
- Modify: `packages/server/src/engine/types.ts`
- Modify: `packages/server/src/engine/claude/adapter.ts`
- Create: `packages/server/src/engine/session.ts`
- Modify: `packages/server/src/engine/bootstrap.ts`
- Test: `packages/server/test/engine-claude.test.ts`（追加）、`packages/server/test/lifecycle-tmux.test.ts`（追加+适配）、`packages/server/test/daemon.test.ts`（追加闭环）

**Interfaces:**
- Consumes: `wrapEngineCommand/ensureKeepAliveScript`（Task 6）、`tmuxSessionName`、`portEnv`
- Produces:
  - `Engine.launchCommand(opts: { sessionId: string; model?: string; effort?: string; resume?: boolean }): string[]`
  - `startEngineSession(tmux: TmuxServiceShape, i: { ws: Workspace; repoRoot: string; engine: Engine; sessionId: string; resume: boolean; home: string }): Effect<{ sessionName: string; engineCommand: string[] }, TmuxError>`
  - `engine.started` 事件 payload 增加 `wrapped: true`

- [ ] **Step 1: 写失败测试（launchCommand resume）**

`packages/server/test/engine-claude.test.ts` 追加（沿用该文件既有的 env 保存/恢复手法；若无则用 beforeEach/afterEach 存取 `process.env.COOLIE_CLAUDE_CMD`）：
```ts
describe("launchCommand resume（Plan 4 heal/resume 消费）", () => {
  const saved = process.env.COOLIE_CLAUDE_CMD
  afterEach(() => { if (saved === undefined) delete process.env.COOLIE_CLAUDE_CMD; else process.env.COOLIE_CLAUDE_CMD = saved })

  it("resume:true → [bin, --resume, sessionId]，不带 --session-id", () => {
    delete process.env.COOLIE_CLAUDE_CMD
    const cmd = claudeEngine.launchCommand({ sessionId: "s-1", resume: true })
    expect(cmd.slice(1, 3)).toEqual(["--resume", "s-1"])
    expect(cmd).not.toContain("--session-id")
  })
  it("resume + model 仍追加 --model", () => {
    delete process.env.COOLIE_CLAUDE_CMD
    const cmd = claudeEngine.launchCommand({ sessionId: "s-1", resume: true, model: "opus" })
    expect(cmd).toContain("--model")
    expect(cmd).toContain("opus")
  })
  it("COOLIE_CLAUDE_CMD 覆盖时 resume 也原样使用（测试 seam 铁律：绝不追加 flag）", () => {
    process.env.COOLIE_CLAUDE_CMD = "cat"
    expect(claudeEngine.launchCommand({ sessionId: "s-1", resume: true })).toEqual(["cat"])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --cwd packages/server test -- engine-claude`
Expected: FAIL——resume 选项被忽略，`--session-id` 仍在。

- [ ] **Step 3: 实现 types + adapter**

`packages/server/src/engine/types.ts` 的 `launchCommand` 行改为：
```ts
  readonly launchCommand: (opts: {
    readonly sessionId: string; readonly model?: string; readonly effort?: string
    /** true = 复活既有会话（claude: --resume <sessionId>）；缺省/false = 新会话（--session-id） */
    readonly resume?: boolean
  }) => string[]
```
`packages/server/src/engine/claude/adapter.ts` 的 `launchCommand` 改为：
```ts
  launchCommand: ({ sessionId, model, resume }) => {
    // 用户/测试覆盖 seam（kobe engineCommand.<vendor> 同款）：原样使用，绝不追加 flag
    const override = (process.env.COOLIE_CLAUDE_CMD ?? "").trim()
    if (override !== "") return override.split(/\s+/)
    const bin = discoverClaudeBinary() ?? "claude"
    const args = resume === true ? [bin, ...resumeArgs(sessionId)] : [bin, "--session-id", sessionId]
    if (model) args.push("--model", model)
    return args // effort：claude 无此参数（capabilities.effort=false，Noop 降级）
  },
```

- [ ] **Step 4: 写失败测试（keep-alive 集成，真 tmux + cat + 杀 pane 内进程）**

`packages/server/test/lifecycle-tmux.test.ts` 追加用例（沿用该文件 `buildLayer/fakeClaude/waitFor/cap/SOCK` 等既有 helper）：
```ts
  it("keep-alive：杀掉 engine（cat）后 pane 落回 shell，session/window/pane 不塌", async () => {
    const layer = buildLayer([fakeClaude])
    const ws = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      return yield* lc.create({ projectId: list[0]!.id, name: "keepalive-one" })
    }), layer) as Effect.Effect<any, never, never>)
    const session = sessionNameFor(ws.id)
    const panePid = execFileSync("tmux", ["-L", SOCK, "list-panes", "-t", `=${session}:0`, "-F", "#{pane_pid}"])
      .toString().trim() // = 包装脚本的 /bin/sh
    // cat 是包装 sh 的子进程；等它出现再杀（构成「杀 pane 内进程」的验收）
    let catPid = ""
    await waitFor(async () => {
      try { catPid = execFileSync("pgrep", ["-P", panePid]).toString().trim().split("\n")[0] ?? ""; return catPid !== "" }
      catch { return false }
    })
    process.kill(Number(catPid), "SIGKILL")
    await waitFor(async () => (await cap(`${session}:0`)).includes("engine exited"))
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)
    // exec 落回 shell：pane pid 不变 = 布局与 pane 完整保留
    const panePid2 = execFileSync("tmux", ["-L", SOCK, "list-panes", "-t", `=${session}:0`, "-F", "#{pane_pid}"]).toString().trim()
    expect(panePid2).toBe(panePid)
    // 清场
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      yield* (yield* WorkspaceLifecycle).delete(ws.id, { force: true })
    }), layer) as Effect.Effect<any, never, never>)
  })
```
同文件里「bootstrap 中途失败（死 pane）」用例的注入方式替换（deadPaneClaude 定义改为画面永不稳定；断言不变）：
```ts
    const deadPaneClaude: Engine = {
      ...fakeClaude,
      // 包装后秒退不再塌 session；改用「画面永不稳定」让 waitStable 用尽 attempts 报 TmuxError，
      // 同样练到 tabs.insert 之后的 tapError 清理路径。运行时长 ≈ waitStable 预算（默认 24×250ms）。
      launchCommand: () => ["sh", "-c", "while true; do date +%s%N; sleep 0.05; done"],
    }
```
（适配注记：若并行 fixer 已把首条 prompt 改为等 `engine.session.started`，此注入按 fixer 的失败路径等价改写——例如「hooks 永不上报 → 门控超时」；断言保持：status=error、tabs=0、session 不在、worktree 已回滚。）

daemon 级闭环追加到 `packages/server/test/daemon.test.ts`（wrapper → curl → 端点 → 事件，全链真进程）：
```ts
describe("keep-alive 闭环（wrapper → /hooks/engine-exit → engine.exited）", () => {
  it("engine 非零退出：事件落库 + tab=error + session 不塌", async () => {
    const sock = `coolie-test-${process.pid}-ka`
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka2-home-"))
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka2-ws-"))
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka2-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: repo })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
    // engine 替身：先睡 1s（保证 tabs 行已插入）再以 7 退出——COOLIE_CLAUDE_CMD 是空白分词，
    // 不能写 "sh -c 'exit 7'"（引号不解析），用脚本文件。
    const exit7 = path.join(home2, "exit7.sh")
    fs.mkdirSync(home2, { recursive: true })
    fs.writeFileSync(exit7, "#!/bin/sh\nsleep 1\nexit 7\n", { mode: 0o755 })
    const env = {
      ...process.env, COOLIE_HOME: home2, COOLIE_WORKSPACES_ROOT: wsRoot,
      COOLIE_TMUX_SOCKET: sock, COOLIE_CLAUDE_CMD: exit7, COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_HOME: path.join(home2, "claude-home"),
    }
    const srv = spawn(TSX, [MAIN, "start"], { env, stdio: "pipe", detached: true })
    try {
      let info: ReturnType<typeof readServerInfo> = null
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        info = readServerInfo(path.join(home2, "server.json"))
        if (info && (await fetch(`http://127.0.0.1:${info.port}/health`).catch(() => null))?.ok) break
        await new Promise((r) => setTimeout(r, 100))
      }
      if (!info) throw new Error("server did not become healthy")
      const auth = { "content-type": "application/json", Authorization: `Bearer ${info.token}` }
      const proj = await (await fetch(`http://127.0.0.1:${info.port}/projects`, {
        method: "POST", headers: auth, body: JSON.stringify({ repoRoot: repo }),
      })).json()
      const created = await fetch(`http://127.0.0.1:${info.port}/workspaces`, {
        method: "POST", headers: auth, body: JSON.stringify({ projectId: proj.id }),
      })
      expect(created.status).toBe(201)
      const ws: any = await created.json()
      // 等 engine.exited(exitCode=7) 经 wrapper curl 回报落库
      let exited: any = null
      const d2 = Date.now() + 10_000
      while (Date.now() < d2 && !exited) {
        const evs: any[] = await (await fetch(`http://127.0.0.1:${info.port}/events?after=0`, { headers: auth })).json()
        exited = evs.find((e) => e.type === "engine.exited" && e.payload?.exitCode === 7) ?? null
        if (!exited) await new Promise((r) => setTimeout(r, 200))
      }
      expect(exited).not.toBeNull()
      const tabs: any[] = await (await fetch(`http://127.0.0.1:${info.port}/workspaces/${ws.id}/tabs`, { headers: auth })).json()
      expect(tabs[0].status).toBe("error")
      // 不塌布局：session 仍在（wrapper 已 exec 成 shell）
      expect(spawnSync("tmux", ["-L", sock, "has-session", "-t", `=coolie-${ws.id}`]).status).toBe(0)
    } finally {
      try { process.kill(-srv.pid!, "SIGKILL") } catch { /* dead */ }
      try { execFileSync("tmux", ["-L", sock, "kill-server"]) } catch { /* gone */ }
    }
  })
})
```

- [ ] **Step 5: 跑集成测试确认失败**

Run: `bun run --cwd packages/server test -- lifecycle-tmux daemon.test -t "keep-alive"`
Expected: FAIL——window 0 直跑 cat：杀 cat 后 session 消失（hasSession false）；daemon 闭环里 engine 秒退带走 session、无 engine.exited。

- [ ] **Step 6: 实现 session.ts + bootstrap 改造**

`packages/server/src/engine/session.ts`：
```ts
import { Effect } from "effect"
import { tmuxSessionName, type Workspace } from "@coolie/protocol"
import { TmuxError, type TmuxServiceShape } from "../tmux/service.js"
import type { Engine } from "./types.js"
import { ensureKeepAliveScript, wrapEngineCommand } from "./keepalive.js"
import { portEnv } from "../workspace/ports.js"

export interface StartEngineSessionInput {
  readonly ws: Workspace
  readonly repoRoot: string
  readonly engine: Engine
  readonly sessionId: string
  readonly resume: boolean
  readonly home: string
}

/**
 * 建 tmux session + window 0 = keep-alive 包装的 engine（bootstrap 的 create 与
 * SessionEnsurer 的 heal 共用；env 经 new-session -e 进 session environment，
 * 之后的 respawn-window 自动继承，不重复注入）。
 */
export const startEngineSession = (
  tmux: TmuxServiceShape, i: StartEngineSessionInput,
): Effect.Effect<{ sessionName: string; engineCommand: string[] }, TmuxError> =>
  Effect.gen(function* () {
    const sessionName = tmuxSessionName(i.ws.id)
    const engineCommand = i.engine.launchCommand({ sessionId: i.sessionId, resume: i.resume })
    yield* Effect.try({
      try: () => ensureKeepAliveScript(i.home),
      catch: (e) => new TmuxError({ op: "keepalive-script", message: `keep-alive 脚本写入失败：${String(e)}`, exitCode: null, stderr: "" }),
    })
    yield* tmux.newSession({
      name: sessionName, cwd: i.ws.path, windowName: "engine",
      command: wrapEngineCommand(i.home, i.ws.id, engineCommand),
      env: { COOLIE_ROOT: i.repoRoot, COOLIE_WORKSPACE: i.ws.id, ...portEnv(i.ws.portBase) },
    })
    return { sessionName, engineCommand }
  })
```

`packages/server/src/engine/bootstrap.ts`：删掉 `portEnv` import，加 `import { startEngineSession } from "./session.js"`；hook 体内把
```ts
        const command = engine.launchCommand({ sessionId })
        yield* tmux.newSession({
          name: session, cwd: ws.path, windowName: "engine", command,
          env: { COOLIE_ROOT: project.repoRoot, COOLIE_WORKSPACE: ws.id, ...portEnv(ws.portBase) },
        }).pipe(Effect.mapError((e) => new HookError({ message: `tmux session 创建失败：${e.message}` })))
```
替换为
```ts
        const { engineCommand } = yield* startEngineSession(tmux, {
          ws, repoRoot: project.repoRoot, engine, sessionId, resume: false, home: cfg.home,
        }).pipe(Effect.mapError((e) => new HookError({ message: `tmux session 创建失败：${e.message}` })))
```
`engine.started` 事件 payload 改为：
```ts
          payload: { tabId: tab.id, engineId: engine.id, sessionId, command: engineCommand, wrapped: true },
```

- [ ] **Step 7: 跑测试确认通过**

Run: `bun run --cwd packages/server test -- lifecycle-tmux engine-claude daemon.test && bun run typecheck`
Expected: 全绿。特别核对：既有「create 建 session/投首条 prompt」用例仍过（cat 在包装下照常回显 prompt——waitStable/deliverPrompt 对 pane 内跑什么无感知）。

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/engine/types.ts packages/server/src/engine/claude/adapter.ts packages/server/src/engine/session.ts packages/server/src/engine/bootstrap.ts packages/server/test/engine-claude.test.ts packages/server/test/lifecycle-tmux.test.ts packages/server/test/daemon.test.ts
git commit -m "feat(server): engine keep-alive 包装接入 create（launchCommand resume 选项 + startEngineSession 抽取 + 闭环测试）"
```

---

### Task 8: resume/heal 地基——TabsRepo.setEngineSessionId + hooks session_id 同步 + archive 保留 tabs 行

三件为 heal/resume 铺路的存量修改：（1）`TabsRepo.setEngineSessionId`（同事务发 `tab.session.changed`）；（2）`/hooks/claude` 同步 hook 报来的 `session_id`——claude `--resume` 会 fork 出新 session id，不同步的话转录 mtime 轮询与标题派生会盯着旧文件；（3）**archive 不再删 tabs 行**（只 delete 删）——tabs 行里的 `engineSessionId` 是 unarchive 后 `--resume` 复活的唯一钥匙（行为变更，见 Architecture）。

**Files:**
- Modify: `packages/server/src/repo/tabs.ts`
- Modify: `packages/server/src/http/app.ts`（hooks/claude 分支）
- Modify: `packages/server/src/workspace/lifecycle.ts`（teardownRuntime）
- Test: `packages/server/test/tabs-repo.test.ts`、`packages/server/test/hooks-endpoint.test.ts`、`packages/server/test/lifecycle-tmux.test.ts`（各追加/适配）

**Interfaces:**
- Produces:
  - `TabsRepo.setEngineSessionId(id: string, sessionId: string): Effect<void, NotFoundError>`——同值 no-op；变更时同事务 append `tab.session.changed {tabId, sessionId}` 并 broadcast
  - `teardownRuntime` 语义：`reason==="archive"` 保留 tabs 行；`reason==="delete"` 删除

- [ ] **Step 1: 写失败测试**

`packages/server/test/tabs-repo.test.ts` 追加（沿用该文件既有 db/layer helper）：
```ts
  it("setEngineSessionId：更新 + 同事务 tab.session.changed；同值 no-op 不发事件", async () => {
    const tab = await run(Effect.gen(function* () {
      const tabs = yield* TabsRepo
      const t = yield* tabs.insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "old-id", tmuxWindow: 0 })
      yield* tabs.setEngineSessionId(t.id, "new-id")
      yield* tabs.setEngineSessionId(t.id, "new-id") // 同值：不写库不发事件
      return yield* tabs.get(t.id)
    }))
    expect(tab.engineSessionId).toBe("new-id")
    const evs = (db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type)
    expect(evs.filter((t) => t === "tab.session.changed")).toHaveLength(1)
  })
  it("setEngineSessionId：不存在的 tab → NotFoundError", async () => {
    const exit = await runExit(Effect.gen(function* () {
      yield* (yield* TabsRepo).setEngineSessionId("ghost", "x")
    }))
    expect(Exit.isFailure(exit)).toBe(true)
  })
```
（`run/runExit` 为该文件既有跑法：`Effect.runPromise(Effect.provide(…, layer))` 的封装；若命名不同按现名替换，断言不变。）

`packages/server/test/hooks-endpoint.test.ts` 的 endpoint describe 追加：
```ts
  it("hook 报来新 session_id（--resume fork）→ engineSessionId 同步 + tab.session.changed", async () => {
    const NEW_ID = "99999999-8888-4777-a666-555555555555"
    await post("?workspace=w1", { hook_event_name: "UserPromptSubmit", session_id: NEW_ID })
    expect(tabRow().engine_session_id).toBe(NEW_ID)
    expect(eventTypes()).toContain("tab.session.changed")
  })
  it("session_id 与在册一致 → 不发 tab.session.changed", async () => {
    await post("?workspace=w1", { hook_event_name: "UserPromptSubmit", session_id: SESSION_ID })
    expect(eventTypes()).not.toContain("tab.session.changed")
  })
```

`packages/server/test/lifecycle-tmux.test.ts`：首个用例中 archive 后的断言由
```ts
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 0 })
```
改为（RED：现实现 archive 删行，此断言先挂）：
```ts
    // Plan 4 行为变更：archive 保留 tabs 行——engineSessionId 是 unarchive 后 --resume 复活的钥匙
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 1 })
    expect((db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s).toBe("sess-fixed-1")
```
并**新增**一个专门的 delete 用例，钉住「archive 保留 / delete 清空」的分野（`lifecycle-tmux.test.ts` 现有三处 `c:0` 断言分别是 archive 用例 L105 + 两条 create-失败清理路径，**没有** delete 用例可追加，故独立补一条；沿用该文件既有 `buildLayer/fakeClaude/ProjectsRepo/WorkspaceLifecycle/sessionNameFor/tmux/db` helper）：
```ts
  it("delete 仍删 tabs 行（与 archive 保留分野：engineSessionId 复活钥匙只在 delete 时丢弃）", async () => {
    const layer = buildLayer([fakeClaude])
    const ws = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      return yield* lc.create({ projectId: list[0]!.id, name: "delete-tabs" })
    }), layer) as Effect.Effect<any, never, never>)
    // create 落一行 engine tab
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 1 })
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      yield* (yield* WorkspaceLifecycle).delete(ws.id, { force: true })
    }), layer) as Effect.Effect<any, never, never>)
    // delete 清空 tabs 行 + 拆 session（archive 保留 tabs、delete 才删——teardownRuntime reason 分野）
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 0 })
    expect(await Effect.runPromise(tmux.hasSession(sessionNameFor(ws.id)))).toBe(false)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --cwd packages/server test -- tabs-repo hooks-endpoint lifecycle-tmux`
Expected: FAIL——`setEngineSessionId` 不存在；session_id 无同步；archive 后 tabs 行数为 0。

- [ ] **Step 3: 实现**

`packages/server/src/repo/tabs.ts`：接口追加
```ts
  readonly setEngineSessionId: (id: string, sessionId: string) => Effect.Effect<void, NotFoundError>
```
实现体（`setTitle` 之后）追加：
```ts
      setEngineSessionId: (id, sessionId) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.engine_session_id === sessionId) return // 同值 no-op
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE tabs SET engine_session_id = ? WHERE id = ?").run(sessionId, id)
          ev = appendEventRow(db, { workspaceId: r.workspace_id, type: "tab.session.changed", payload: { tabId: id, sessionId } })
        })()
        broadcast(ev)
      }),
```

`packages/server/src/http/app.ts` 的 `POST /hooks/claude` 分支，`yield* tabs.touchHookAt(tab.id, Date.now())` 之后插入（**适配注记**：并行 fixer 也在改这个分支——若其已引入 `SessionStart` 处理，把本段并入其后的公共路径；行为契约：任何 hook 事件携带的 `session_id` 与在册不一致即同步，后续标题派生用新 id）：
```ts
              // --resume 会 fork 新 session id：以 hook 上报为真源同步，否则 mtime 轮询/标题派生盯旧转录
              const hookSid = typeof (body as any)?.session_id === "string" && (body as any).session_id !== ""
                ? (body as any).session_id as string : null
              const sid = hookSid ?? tab.engineSessionId
              if (hookSid !== null && tab.engineSessionId !== null && hookSid !== tab.engineSessionId)
                yield* tabs.setEngineSessionId(tab.id, hookSid)
```
并把该分支后续两处 `tab.engineSessionId` 换成 `sid`：事件 payload `payload: { tabId: tab.id, sessionId: sid }`；标题派生条件与转录路径 `if (evtName === "Stop" && tab.title === null && sid !== null && claudeHome !== undefined)`、`transcriptPath({ home: claudeHome, cwd: ws.value.path, sessionId: sid })`。

`packages/server/src/workspace/lifecycle.ts` 的 `teardownRuntime` 改为：
```ts
    /** archive/delete 共用：杀 tmux session（engine 归 tmux，拆除是唯一合法杀点）。
     * tabs 行是 engine 会话记忆（engineSessionId → unarchive 后 --resume 复活的钥匙，设计文档 §十）：
     * archive 保留，仅 delete 删除。全程容错。 */
    const teardownRuntime = (ws: Workspace, reason: "archive" | "delete"): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (Option.isSome(tmuxOpt)) {
          yield* tmuxOpt.value.killSession(tmuxSessionName(ws.id)).pipe(Effect.ignore)
          yield* emit(ws.id, "workspace.tmux.killed", { sessionName: tmuxSessionName(ws.id), reason }).pipe(Effect.ignore)
        }
        if (reason === "delete" && Option.isSome(tabsOpt)) yield* tabsOpt.value.removeByWorkspace(ws.id).pipe(Effect.ignore)
      })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --cwd packages/server test -- tabs-repo hooks-endpoint lifecycle-tmux lifecycle-archive && bun run typecheck`
Expected: 全绿（`lifecycle-archive.test.ts` 不注 TabsRepo，serviceOption 路径无感）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repo/tabs.ts packages/server/src/http/app.ts packages/server/src/workspace/lifecycle.ts packages/server/test/tabs-repo.test.ts packages/server/test/hooks-endpoint.test.ts packages/server/test/lifecycle-tmux.test.ts
git commit -m "feat(server): resume 地基——setEngineSessionId + hooks session_id 同步 + archive 保留 tabs 行（复活钥匙）"
```

---

### Task 9: SessionEnsurer——observe→decide→apply 的 ensure + unarchive 接 heal

ensure-or-heal 三段式（设计文档 §十，kobe 路线）：observe（repo 状态 / tmux hasSession / engine tab / 转录文件存在性）→ decide（纯函数 `decideHeal`，独立单测）→ apply（`startEngineSession` 重建，`--resume` 优先）。unarchive 在 worktree 恢复后 best-effort 调 ensure（失败只记 `workspace.heal.failed` 事件，不阻塞 unarchive——`coolie enter`/GUI attach 会再触发）。

**Files:**
- Create: `packages/server/src/workspace/heal.ts`
- Modify: `packages/server/src/workspace/lifecycle.ts`（unarchive）
- Modify: `packages/server/src/main.ts`（appLayer 提供 SessionEnsurerLive）
- Test: `packages/server/test/heal.test.ts`

**Interfaces:**
- Consumes: `startEngineSession`（Task 7）、`getEngine/EngineError`（既有 registry.ts）、`TabsRepo.setEngineSessionId`（Task 8）、`HealOutcome`（Task 1）
- Produces（Task 10/11 消费）:
  ```ts
  type HealPlan =
    | { kind: "none" }
    | { kind: "recreate"; resume: boolean; sessionId: string; needsTabRow: boolean }
  decideHeal(obs: {
    hasSession: boolean
    engineTab: { id: string; engineSessionId: string | null } | null
    transcriptExists: boolean
    freshSessionId: string
  }): HealPlan
  type EnsureError = NotFoundError | ConflictError | TmuxError | EngineError
  class SessionEnsurer extends Context.Tag(...)<SessionEnsurer, SessionEnsurerShape>
  interface SessionEnsurerShape { ensure: (wsId: string) => Effect<HealOutcome, EnsureError> }  // Task 10 增补 resumeTab
  SessionEnsurerLive: Layer<SessionEnsurer, never, CoolieConfig|WorkspacesRepo|ProjectsRepo|TabsRepo|EventsRepo|TmuxService|EngineRegistry>
  ```

- [ ] **Step 1: 写失败测试（decideHeal 纯函数）**

`packages/server/test/heal.test.ts`（第一段）：
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Effect, Layer, Exit } from "effect"
import Database from "better-sqlite3"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { decideHeal, SessionEnsurer, SessionEnsurerLive } from "../src/workspace/heal.js"

describe("decideHeal（observe→decide 纯决策）", () => {
  const tab = { id: "t1", engineSessionId: "s1" }
  it("session 在 → none（有无 tab/转录都一样）", () => {
    expect(decideHeal({ hasSession: true, engineTab: tab, transcriptExists: true, freshSessionId: "f" })).toEqual({ kind: "none" })
    expect(decideHeal({ hasSession: true, engineTab: null, transcriptExists: false, freshSessionId: "f" })).toEqual({ kind: "none" })
  })
  it("session 丢 + 有 tab + 转录在 → resume 旧 id", () => {
    expect(decideHeal({ hasSession: false, engineTab: tab, transcriptExists: true, freshSessionId: "f" }))
      .toEqual({ kind: "recreate", resume: true, sessionId: "s1", needsTabRow: false })
  })
  it("session 丢 + 有 tab + 转录不在 → 全新 id（不 resume）", () => {
    expect(decideHeal({ hasSession: false, engineTab: tab, transcriptExists: false, freshSessionId: "f" }))
      .toEqual({ kind: "recreate", resume: false, sessionId: "f", needsTabRow: false })
  })
  it("session 丢 + tab 无 sessionId → 全新 id", () => {
    expect(decideHeal({ hasSession: false, engineTab: { id: "t1", engineSessionId: null }, transcriptExists: false, freshSessionId: "f" }))
      .toEqual({ kind: "recreate", resume: false, sessionId: "f", needsTabRow: false })
  })
  it("session 丢 + 无 tab → 全新 id + 补 tab 行", () => {
    expect(decideHeal({ hasSession: false, engineTab: null, transcriptExists: false, freshSessionId: "f" }))
      .toEqual({ kind: "recreate", resume: false, sessionId: "f", needsTabRow: true })
  })
})
```

- [ ] **Step 2: 写失败测试（真 tmux 集成：kill-session → ensure 重建 / unarchive 自愈）**

`heal.test.ts` 第二段（layer 组装与 `lifecycle-tmux.test.ts` 同构 + `SessionEnsurerLive`；fake engine 记录 launch 入参以断言 resume）：
```ts
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { GitServiceLive } from "../src/git/service.js"
import { SetupRunnerLive } from "../src/workspace/setup.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive } from "../src/workspace/lifecycle.js"
import { EngineRegistry } from "../src/engine/registry.js"
import type { Engine } from "../src/engine/types.js"
import { EngineBootstrapHookLive, sessionNameFor } from "../src/engine/bootstrap.js"
import { makeTmuxService, TmuxService } from "../src/tmux/service.js"

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const tmux = makeTmuxService(SOCK)
let home: string, wsRoot: string, repoRoot: string, db: Database.Database
const launches: Array<{ sessionId: string; resume?: boolean }> = []
let nextId = 0

const recordingClaude: Engine = {
  id: "claude", displayName: "Recording Claude",
  capabilities: { nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: false, effort: false },
  terminalTitle: "none",
  newSessionId: () => `sess-${++nextId}`,
  launchCommand: (o) => { launches.push({ sessionId: o.sessionId, ...(o.resume !== undefined ? { resume: o.resume } : {}) }); return ["cat"] },
  statusFromHookEvent: () => null,
  transcriptPath: ({ home: h, cwd, sessionId }) => path.join(h, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`),
  deriveTitle: () => null,
  resumeArgs: (s) => ["--resume", s],
}

const buildLayer = () => {
  const cfgLayer = Layer.succeed(CoolieConfig, {
    home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
    workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"),
  })
  return WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(EngineBootstrapHookLive, SessionEnsurerLive)),
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive, SetupRunnerLive,
      Layer.succeed(TmuxService, tmux),
      Layer.succeed(EngineRegistry, new Map([[recordingClaude.id, recordingClaude]])),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(cfgLayer),
  )
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-heal-home-"))
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-heal-ws-"))
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-heal-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repoRoot })
  db = new Database(":memory:"); runMigrations(db)
})
afterAll(() => { try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ } })

const runIn = <A>(layer: ReturnType<typeof buildLayer>, eff: Effect.Effect<A, any, any>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<A, never, never>)
const eventTypes = () => (db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type)

describe("SessionEnsurer.ensure（真 tmux）", () => {
  it("session 在 → action=none，零副作用", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const project = yield* (yield* ProjectsRepo).add(repoRoot)
      return yield* (yield* WorkspaceLifecycle).create({ projectId: project.id, name: "heal-alive" })
    }))
    const before = eventTypes().length
    const out = await runIn(layer, Effect.gen(function* () { return yield* (yield* SessionEnsurer).ensure(ws.id) }))
    expect(out.action).toBe("none")
    expect(eventTypes().length).toBe(before) // 无新事件
  })

  it("session 被外力清理 + 转录在 → 重建并 --resume 旧 id + workspace.tmux.healed", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const list = yield* (yield* ProjectsRepo).list()
      return yield* (yield* WorkspaceLifecycle).create({ projectId: list[0]!.id, name: "heal-resume" })
    }))
    const session = sessionNameFor(ws.id)
    const oldSid = (db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s as string
    // 伪造转录文件（historyReader 的 observe 依据）
    const tp = recordingClaude.transcriptPath({ home: path.join(home, "claude-home"), cwd: ws.path, sessionId: oldSid })
    fs.mkdirSync(path.dirname(tp), { recursive: true })
    fs.writeFileSync(tp, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n")
    execFileSync("tmux", ["-L", SOCK, "kill-session", "-t", `=${session}`]) // 外力清理
    launches.length = 0

    const out = await runIn(layer, Effect.gen(function* () { return yield* (yield* SessionEnsurer).ensure(ws.id) }))
    expect(out).toMatchObject({ action: "recreated", resumed: true, sessionName: session, sessionId: oldSid })
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)
    expect(launches).toEqual([{ sessionId: oldSid, resume: true }])
    expect(eventTypes()).toContain("workspace.tmux.healed")
  })

  it("session 丢 + 无转录 → 全新 id 重建 + tab.session.changed", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const list = yield* (yield* ProjectsRepo).list()
      return yield* (yield* WorkspaceLifecycle).create({ projectId: list[0]!.id, name: "heal-fresh" })
    }))
    const session = sessionNameFor(ws.id)
    const oldSid = (db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s as string
    execFileSync("tmux", ["-L", SOCK, "kill-session", "-t", `=${session}`])
    const out = await runIn(layer, Effect.gen(function* () { return yield* (yield* SessionEnsurer).ensure(ws.id) }))
    expect(out.action).toBe("recreated")
    expect(out.resumed).toBe(false)
    expect(out.sessionId).not.toBe(oldSid)
    expect((db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s).toBe(out.sessionId)
    expect(eventTypes()).toContain("tab.session.changed")
  })

  it("非 active（archived）→ ConflictError；未知 ws → NotFoundError", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const list = yield* (yield* ProjectsRepo).list()
      const created = yield* (yield* WorkspaceLifecycle).create({ projectId: list[0]!.id, name: "heal-gate" })
      return yield* (yield* WorkspaceLifecycle).archive(created.id, { force: true })
    }))
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      return yield* (yield* SessionEnsurer).ensure(ws.id)
    }), layer) as Effect.Effect<any, any, never>)
    expect(Exit.isFailure(exit)).toBe(true)
    const exit2 = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      return yield* (yield* SessionEnsurer).ensure("ghost")
    }), layer) as Effect.Effect<any, any, never>)
    expect(Exit.isFailure(exit2)).toBe(true)
  })

  it("unarchive → worktree 恢复 + session 自动重建（--resume 复活，archive 保留的 tabs 行是钥匙）", async () => {
    const layer = buildLayer()
    const ws = await runIn(layer, Effect.gen(function* () {
      const list = yield* (yield* ProjectsRepo).list()
      return yield* (yield* WorkspaceLifecycle).create({ projectId: list[0]!.id, name: "heal-unarchive" })
    }))
    const session = sessionNameFor(ws.id)
    const sid = (db.prepare("SELECT engine_session_id s FROM tabs WHERE workspace_id = ?").get(ws.id) as any).s as string
    const tp = recordingClaude.transcriptPath({ home: path.join(home, "claude-home"), cwd: ws.path, sessionId: sid })
    fs.mkdirSync(path.dirname(tp), { recursive: true })
    fs.writeFileSync(tp, "{}\n")
    await runIn(layer, Effect.gen(function* () { yield* (yield* WorkspaceLifecycle).archive(ws.id, { force: true }) }))
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(false)
    launches.length = 0
    const back = await runIn(layer, Effect.gen(function* () { return yield* (yield* WorkspaceLifecycle).unarchive(ws.id) }))
    expect(back.status).toBe("active")
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)   // 重建了
    expect(launches).toEqual([{ sessionId: sid, resume: true }])            // 且是 --resume 复活
    expect(eventTypes()).toContain("workspace.tmux.healed")
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run --cwd packages/server test -- heal`
Expected: FAIL——模块不存在。

- [ ] **Step 4: 实现 heal.ts**

`packages/server/src/workspace/heal.ts`：
```ts
import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
import { tmuxSessionName, type HealOutcome } from "@coolie/protocol"
import { CoolieConfig } from "../config.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { ProjectsRepo } from "../repo/projects.js"
import { TabsRepo } from "../repo/tabs.js"
import { EventsRepo } from "../repo/events.js"
import { TmuxService, TmuxError } from "../tmux/service.js"
import { EngineRegistry, EngineError, getEngine } from "../engine/registry.js"
import { NotFoundError, ConflictError } from "../repo/errors.js"
import { startEngineSession } from "../engine/session.js"

/** observe→decide 的纯决策（设计文档 §十）：apply 之外可独立单测。 */
export type HealPlan =
  | { readonly kind: "none" }
  | { readonly kind: "recreate"; readonly resume: boolean; readonly sessionId: string; readonly needsTabRow: boolean }

export const decideHeal = (obs: {
  readonly hasSession: boolean
  readonly engineTab: { readonly id: string; readonly engineSessionId: string | null } | null
  readonly transcriptExists: boolean
  readonly freshSessionId: string
}): HealPlan => {
  if (obs.hasSession) return { kind: "none" }
  if (obs.engineTab !== null && obs.engineTab.engineSessionId !== null && obs.transcriptExists)
    return { kind: "recreate", resume: true, sessionId: obs.engineTab.engineSessionId, needsTabRow: false }
  return { kind: "recreate", resume: false, sessionId: obs.freshSessionId, needsTabRow: obs.engineTab === null }
}

export type EnsureError = NotFoundError | ConflictError | TmuxError | EngineError

export interface SessionEnsurerShape {
  /** ensure-or-heal：session 在则 no-op；丢失则重建（--resume 优先）。 */
  readonly ensure: (wsId: string) => Effect.Effect<HealOutcome, EnsureError>
}
export class SessionEnsurer extends Context.Tag("SessionEnsurer")<SessionEnsurer, SessionEnsurerShape>() {}

export const SessionEnsurerLive = Layer.effect(
  SessionEnsurer,
  Effect.gen(function* () {
    const cfg = yield* CoolieConfig
    const repo = yield* WorkspacesRepo
    const projects = yield* ProjectsRepo
    const tabs = yield* TabsRepo
    const events = yield* EventsRepo
    const tmux = yield* TmuxService
    const registry = yield* EngineRegistry

    const transcriptExists = (engine: { transcriptPath: (o: { home: string; cwd: string; sessionId: string }) => string },
      cwd: string, sessionId: string | null): boolean =>
      sessionId !== null && fs.existsSync(engine.transcriptPath({ home: cfg.claudeHome, cwd, sessionId }))

    const ensure: SessionEnsurerShape["ensure"] = (wsId) =>
      Effect.gen(function* () {
        // ---- observe ----
        const ws = yield* repo.get(wsId)
        if (ws.status !== "active")
          return yield* new ConflictError({ message: `只能 ensure active 的 workspace（当前 ${ws.status}）` })
        const sessionName = tmuxSessionName(ws.id)
        const hasSession = yield* tmux.hasSession(sessionName)
        const tab = yield* tabs.findEngineTab(wsId)
        const engine = yield* getEngine(registry, tab?.engineId ?? "claude")
        // ---- decide ----
        const plan = decideHeal({
          hasSession,
          engineTab: tab,
          transcriptExists: yield* Effect.sync(() => transcriptExists(engine, ws.path, tab?.engineSessionId ?? null)),
          freshSessionId: engine.newSessionId(),
        })
        if (plan.kind === "none")
          return { action: "none", resumed: false, sessionName, tabId: tab?.id ?? null, sessionId: tab?.engineSessionId ?? null } satisfies HealOutcome
        // ---- apply ----
        const project = yield* projects.get(ws.projectId)
        yield* startEngineSession(tmux, {
          ws, repoRoot: project.repoRoot, engine, sessionId: plan.sessionId, resume: plan.resume, home: cfg.home,
        })
        let tabId = tab?.id ?? null
        if (plan.needsTabRow) {
          const t = yield* tabs.insert({ workspaceId: ws.id, kind: "engine", engineId: engine.id, engineSessionId: plan.sessionId, tmuxWindow: 0 })
          tabId = t.id
        } else if (tab !== null && !plan.resume) {
          yield* tabs.setEngineSessionId(tab.id, plan.sessionId) // 换新会话：钥匙同步
        }
        if (tabId !== null) yield* tabs.setStatus(tabId, "idle", "heal").pipe(Effect.ignore)
        yield* events.append({
          workspaceId: ws.id, type: "workspace.tmux.healed",
          payload: { sessionName, resumed: plan.resume, sessionId: plan.sessionId, tabId },
        })
        return { action: "recreated", resumed: plan.resume, sessionName, tabId, sessionId: plan.sessionId } satisfies HealOutcome
      })

    return { ensure }
  }),
)
```
（`satisfies HealOutcome` 若与 Schema.Struct 推导的 readonly 类型别扭，退为显式 `const out: HealOutcome = {…}; return out`——契约不变。）

- [ ] **Step 5: 实现 unarchive 接线 + main.ts layer**

`packages/server/src/workspace/lifecycle.ts`：
```ts
import { SessionEnsurer } from "./heal.js"
```
service 组装区（`tabsOpt` 之后）加：
```ts
    const ensurerOpt = yield* Effect.serviceOption(SessionEnsurer)
```
`unarchive` 的 `const out = yield* repo.setStatus(id, "active")` 之后、`emit` 之前插入：
```ts
        // ensure-or-heal（设计文档 §十）：worktree 已恢复，session best-effort 重建——
        // 失败不阻塞 unarchive（enter/GUI attach 会再触发 ensure），只记事件供排查
        if (Option.isSome(ensurerOpt))
          yield* ensurerOpt.value.ensure(id).pipe(
            Effect.tapError((e) => emit(id, "workspace.heal.failed", { id, error: { tag: e._tag, message: e.message } }).pipe(Effect.ignore)),
            Effect.ignore,
          )
```
（循环依赖检查：`heal.ts` 不 import `lifecycle.ts`——`PostCreateHooks`/`HookError` 都不需要；`lifecycle.ts` import `heal.ts` 单向成立。）

`packages/server/src/main.ts`：
```ts
import { SessionEnsurerLive } from "./workspace/heal.js"
```
appLayer 的第一段改为：
```ts
  const appLayer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(EngineBootstrapHookLive, SessionEnsurerLive)),
```
（其余 provideMerge 层不变；SessionEnsurer 由此同时进入 runtimeCtx，Task 10 的路由直接可用。）

- [ ] **Step 6: 跑测试确认通过**

Run: `bun run --cwd packages/server test -- heal lifecycle-tmux lifecycle-archive daemon.test && bun run typecheck`
Expected: 全绿。既有 unarchive 用例（不注 SessionEnsurer）走 serviceOption None 路径无感。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/workspace/heal.ts packages/server/src/workspace/lifecycle.ts packages/server/src/main.ts packages/server/test/heal.test.ts
git commit -m "feat(server): SessionEnsurer ensure-or-heal（observe/decide/apply + --resume 复活）+ unarchive 自愈"
```

---

### Task 10: respawnWindow + resumeTab + ensure/resume HTTP 端点

Resume 按钮的 server 端语义：engine 退出后 pane 是 keep-alive 落回的 shell——`respawn-window -k` 原地替换 window 进程为「keep-alive 包装的 engine（`--resume` 优先）」，布局零变动；若整个 session 已丢，自动降级走 `ensure`。

**Files:**
- Modify: `packages/server/src/tmux/service.ts`（+respawnWindow）
- Modify: `packages/server/src/workspace/heal.ts`（+resumeTab）
- Modify: `packages/server/src/http/app.ts`（两条路由 + AppServices）
- Test: `packages/server/test/tmux-service.test.ts`（追加）、`packages/server/test/http-heal.test.ts`（新建）

**Interfaces:**
- Consumes: Task 9 全部产物、`wrapEngineCommand/ensureKeepAliveScript`（Task 6）
- Produces:
  - `TmuxServiceShape.respawnWindow(opts: { session: string; window: number; cwd: string; command: readonly string[] }): Effect<void, TmuxError>`（内部 `respawn-window -k -c <cwd> -t =<session>:<window> <quoted cmd>`）
  - `SessionEnsurerShape.resumeTab(wsId: string, tabId: string): Effect<HealOutcome, EnsureError>`（action=`respawned`；session 丢失时返回 ensure 的 `recreated`）
  - `POST /workspaces/:id/ensure` → 200 `HealOutcome`；`POST /workspaces/:id/tabs/:tabId/resume` → 200 `HealOutcome`
  - `AppServices` 并入 `SessionEnsurer`

- [ ] **Step 1: 写失败测试（respawnWindow）**

`packages/server/test/tmux-service.test.ts` 追加（沿用该文件的测试 socket 与 afterAll kill-server 纪律；`S4` 换成文件内不冲突的 session 名）：
```ts
  it("respawnWindow -k 原地替换 window 进程（窗口数不变）", async () => {
    const S4 = "coolie-respawn-test"
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-respawn-"))
    await Effect.runPromise(svc.newSession({ name: S4, cwd, windowName: "w", command: ["sleep", "30"] }))
    await Effect.runPromise(svc.respawnWindow({ session: S4, window: 0, cwd, command: ["sh", "-c", "printf respawn-ok; sleep 30"] }))
    const deadline = Date.now() + 5000
    let seen = false
    while (Date.now() < deadline && !seen) {
      seen = (await Effect.runPromise(svc.capturePane(`${S4}:0`))).includes("respawn-ok")
      if (!seen) await new Promise((r) => setTimeout(r, 100))
    }
    expect(seen).toBe(true)
    expect(await Effect.runPromise(svc.listWindows(S4))).toHaveLength(1)
    await Effect.runPromise(svc.killSession(S4))
  })
```

- [ ] **Step 2: 实现 respawnWindow**

`packages/server/src/tmux/service.ts`：`TmuxServiceShape` 接口 `newWindow` 之后加：
```ts
  /** -k 原地替换 window 进程（Resume 语义）：布局/窗口序号零变动；session env 自动继承 */
  readonly respawnWindow: (opts: {
    readonly session: string; readonly window: number; readonly cwd: string
    readonly command: readonly string[]
  }) => Effect.Effect<void, TmuxError>
```
`makeTmuxService` 里 `newWindow` 之后加：
```ts
  respawnWindow: ({ session, window, cwd, command }) =>
    runTmux(socket, "respawn-window",
      ["respawn-window", "-k", "-c", cwd, "-t", `=${session}:${window}`, shellQuote(command)],
    ).pipe(Effect.asVoid),
```
Run: `bun run --cwd packages/server test -- tmux-service` → 先 RED（方法不存在，编译失败）后 GREEN。

- [ ] **Step 3: 写失败测试（端点 × 真 tmux）**

`packages/server/test/http-heal.test.ts`（layer 组装同 `heal.test.ts`，外加 http server；fake engine 同 `recordingClaude` 形状——此处只贴与 heal.test 不同的关键段，layer/beforeAll/afterAll 逐行同构复制，SOCK 换 `-hh` 后缀避免冲突）：
```ts
import { createApp, newToken } from "../src/http/app.js"
// …（与 heal.test.ts 相同的 imports/layer/beforeAll/afterAll，SOCK = `coolie-test-${process.pid}-hh`）…

describe("ensure/resume HTTP 端点（真 tmux）", () => {
  let server: http.Server, base: string, token: string, layer: ReturnType<typeof buildLayer>, ws: any

  beforeAll(async () => {
    layer = buildLayer()
    ws = await runIn(layer, Effect.gen(function* () {
      const project = yield* (yield* ProjectsRepo).add(repoRoot)
      return yield* (yield* WorkspaceLifecycle).create({ projectId: project.id, name: "http-heal" })
    }))
    token = newToken()
    const runtime = (eff: any) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, never, never>)
    server = http.createServer(createApp({ runtime, token, onShutdown: () => {} }))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => server.close())

  const post = (p: string) => fetch(`${base}${p}`, {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: "{}",
  })
  const engineTabId = () => (db.prepare("SELECT id FROM tabs WHERE workspace_id = ? AND kind='engine'").get(ws.id) as any).id as string

  it("ensure：session 在 → 200 action=none", async () => {
    const r = await post(`/workspaces/${ws.id}/ensure`)
    expect(r.status).toBe(200)
    expect((await r.json()).action).toBe("none")
  })

  it("resume：session 在 → 200 action=respawned，pane 进程被替换、窗口数不变", async () => {
    const session = sessionNameFor(ws.id)
    const pidBefore = execFileSync("tmux", ["-L", SOCK, "list-panes", "-t", `=${session}:0`, "-F", "#{pane_pid}"]).toString().trim()
    const r = await post(`/workspaces/${ws.id}/tabs/${engineTabId()}/resume`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.action).toBe("respawned")
    const pidAfter = execFileSync("tmux", ["-L", SOCK, "list-panes", "-t", `=${session}:0`, "-F", "#{pane_pid}"]).toString().trim()
    expect(pidAfter).not.toBe(pidBefore) // respawn -k 换了 pane 进程
    expect(execFileSync("tmux", ["-L", SOCK, "list-windows", "-t", `=${session}`]).toString().trim().split("\n")).toHaveLength(1)
    expect(eventTypes()).toContain("engine.resumed")
  })

  it("resume：session 丢失 → 自动降级 ensure（action=recreated）", async () => {
    execFileSync("tmux", ["-L", SOCK, "kill-session", "-t", `=${sessionNameFor(ws.id)}`])
    const r = await post(`/workspaces/${ws.id}/tabs/${engineTabId()}/resume`)
    expect(r.status).toBe(200)
    expect((await r.json()).action).toBe("recreated")
    expect(await Effect.runPromise(tmux.hasSession(sessionNameFor(ws.id)))).toBe(true)
  })

  it("resume：非 engine tab → 409；未知 tab → 404；未知 ws 的 ensure → 404", async () => {
    const shellTab = await runIn(layer, Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: ws.id, kind: "shell", tmuxWindow: 9 })
    }))
    expect((await post(`/workspaces/${ws.id}/tabs/${shellTab.id}/resume`)).status).toBe(409)
    expect((await post(`/workspaces/${ws.id}/tabs/ghost/resume`)).status).toBe(404)
    expect((await post(`/workspaces/ghost/ensure`)).status).toBe(404)
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `bun run --cwd packages/server test -- http-heal`
Expected: FAIL——两条路由 404、`resumeTab` 不存在（编译失败先出现）。

- [ ] **Step 5: 实现 resumeTab + 路由**

`packages/server/src/workspace/heal.ts`：`SessionEnsurerShape` 追加
```ts
  /** Resume 按钮语义：engine 已退出（pane=keep-alive 落回的 shell）→ respawn-window 原地重启 engine；
   * session 整个丢失 → 降级 ensure。 */
  readonly resumeTab: (wsId: string, tabId: string) => Effect.Effect<HealOutcome, EnsureError>
```
Layer 内 `ensure` 之后实现（同函数作用域，可引用 ensure）：
```ts
    const resumeTab: SessionEnsurerShape["resumeTab"] = (wsId, tabId) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(wsId)
        if (ws.status !== "active")
          return yield* new ConflictError({ message: `只能 resume active 的 workspace（当前 ${ws.status}）` })
        const tab = yield* tabs.get(tabId)
        if (tab.workspaceId !== wsId || tab.kind !== "engine")
          return yield* new ConflictError({ message: `tab ${tabId} 不是该 workspace 的 engine tab` })
        const sessionName = tmuxSessionName(ws.id)
        if (!(yield* tmux.hasSession(sessionName))) return yield* ensure(wsId) // session 整个没了 → heal
        const engine = yield* getEngine(registry, tab.engineId ?? "claude")
        const canResume = yield* Effect.sync(() => transcriptExists(engine, ws.path, tab.engineSessionId))
        const resume = canResume && tab.engineSessionId !== null
        const sessionId = resume ? tab.engineSessionId! : engine.newSessionId()
        const engineCommand = engine.launchCommand({ sessionId, resume })
        yield* Effect.try({
          try: () => ensureKeepAliveScript(cfg.home),
          catch: (e) => new TmuxError({ op: "keepalive-script", message: `keep-alive 脚本写入失败：${String(e)}`, exitCode: null, stderr: "" }),
        })
        yield* tmux.respawnWindow({
          session: sessionName, window: tab.tmuxWindow ?? 0, cwd: ws.path,
          command: wrapEngineCommand(cfg.home, ws.id, engineCommand),
        })
        if (!resume) yield* tabs.setEngineSessionId(tab.id, sessionId)
        yield* tabs.setStatus(tab.id, "idle", "heal").pipe(Effect.ignore)
        yield* events.append({ workspaceId: ws.id, type: "engine.resumed", payload: { tabId: tab.id, sessionId, resumed: resume } })
        return { action: "respawned", resumed: resume, sessionName, tabId: tab.id, sessionId } satisfies HealOutcome
      })

    return { ensure, resumeTab }
```
import 区补：
```ts
import { ensureKeepAliveScript, wrapEngineCommand } from "../engine/keepalive.js"
```

`packages/server/src/http/app.ts`：
```ts
import { SessionEnsurer } from "../workspace/heal.js"
```
`AppServices` 改为：
```ts
export type AppServices = ProjectsRepo | EventsRepo | WorkspacesRepo | WorkspaceLifecycle | TabsRepo | EngineRegistry | SessionEnsurer
```
`wsAction`（archive|unarchive|retry）分支之后插入两段：
```ts
        const wsEnsure = url.pathname.match(/^\/workspaces\/([^/]+)\/ensure$/)
        if (req.method === "POST" && wsEnsure) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* SessionEnsurer).ensure(wsEnsure[1]!) }),
            (out) => send(res, 200, out),
            onError,
          )
        }
        const tabResume = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/resume$/)
        if (req.method === "POST" && tabResume) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* SessionEnsurer).resumeTab(tabResume[1]!, tabResume[2]!) }),
            (out) => send(res, 200, out),
            onError,
          )
        }
```
（错误映射零新增：`NotFoundError→404`、`ConflictError→409`、`TmuxError/EngineError→500` 已在 `errorFromCause`。注意 `tabResume` 匹配要放在 `GET /workspaces/:id/tabs` 之后无妨——method 不同不抢路。既有 http 测试的 runtime 类型若因 `AppServices` 扩容报错，与 Plan 3 同法：它们统一 cast `as Effect.Effect<any, never, never>`，无需改动。）

- [ ] **Step 6: 跑测试确认通过**

Run: `bun run --cwd packages/server test -- http-heal tmux-service heal && bun run typecheck && bun run --cwd packages/server test`
Expected: 新用例全绿 + server 全量回归绿。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/tmux/service.ts packages/server/src/workspace/heal.ts packages/server/src/http/app.ts packages/server/test/tmux-service.test.ts packages/server/test/http-heal.test.ts
git commit -m "feat(server): respawnWindow + resumeTab + POST ensure / tabs/:id/resume 端点（Resume 语义）"
```

---

### Task 11: CLI——enter 走 ensure-or-heal、resume 命令、doctor stuck-creating + clients

**Files:**
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/cli-e2e.test.ts`（追加）、`packages/cli/test/export-doctor.test.ts`（追加）

**Interfaces:**
- Consumes: `decodeHealOutcome`（Task 1）、`POST /workspaces/:id/ensure`、`POST /workspaces/:id/tabs/:tabId/resume`、`GET /clients`（Task 5/10）、`api/home`（既有 client.ts）
- Produces:
  - `coolie enter <wsId>`：session 不存在 → 先 `POST /workspaces/:id/ensure`（自动拉起 server）再 attach；heal 也救不了（如已归档）→ 报错 exit 1
  - `coolie resume <wsId>`：找 engine tab → resume API → 打印 `resumed <id> (action=… resumed=…)`
  - `coolie doctor` 追加：`workspaces` 行（卡 creating >10 分钟 → warn，只读不修）；`clients` 行（server 在跑时显示 gui/总数/linger/armed）

**既有 helper 核对（已对照 `packages/cli/src/main.ts`，行号为该文件当前实况）**——本任务 Step 4 复用的名字全部实名存在，直接可用，无需改写：
- `api(method, path, body?)`：`main.ts:9` `import { api, home } from "./client.js"`（`home()` 同源，doctor/server 段已在用）。
- `fail(e): never`：`main.ts:13` 顶层 `const fail = ...`（打印 message 后 `process.exit(1)`）。
- `tmuxSocketName()`：`main.ts:83` `const tmuxSocketName = () => process.env.COOLIE_TMUX_SOCKET ?? "coolie"`。
- `Database`：`main.ts:8` `import Database from "better-sqlite3"`（doctor 的 db 检查已用其 `readonly` 打开）。
- `tmuxSessionName`：`main.ts:3` 从 `@coolie/protocol` 导入（`enter`/`open` 已用）；本任务 import 行仅在同一解构里追加 `decodeHealOutcome`（protocol 既有导出）。

- [ ] **Step 1: 写失败测试（doctor stuck-creating，daemon-free）**

`packages/cli/test/export-doctor.test.ts` 追加（沿用该文件既有的 home/db fixture 手法；若其 db 构造不同，以下面自建 db 为准）：
```ts
describe("doctor stuck-creating（只读诊断）", () => {
  it("creating 超过 10 分钟 → warn 行；新鲜 creating 不告警", () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-doc-stuck-"))
    const db = new Database(path.join(h, "coolie.db"))
    db.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, project_id TEXT, name TEXT, path TEXT, branch TEXT,
      base_branch TEXT, base_ref TEXT, status TEXT, pinned INTEGER,
      created_at INTEGER, archived_at INTEGER, data TEXT)`)
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('stuck1','p','old-one','/tmp/x','coolie/x','main','','creating',0,?,NULL,'{}')`).run(Date.now() - 30 * 60_000)
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('fresh1','p','new-one','/tmp/y','coolie/y','main','','creating',0,?,NULL,'{}')`).run(Date.now())
    db.close()
    const out = execFileSync(TSX, [CLI, "doctor"], { env: { ...process.env, COOLIE_HOME: h }, encoding: "utf8" })
    const wsLine = out.split("\n").find((l) => l.includes("workspaces"))
    expect(wsLine).toBeDefined()
    expect(wsLine).toContain("warn")
    expect(wsLine).toContain("stuck1")
    expect(wsLine).not.toContain("fresh1")
  })
  it("无卡死行 → 无 workspaces warn", () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-doc-clean-"))
    const out = execFileSync(TSX, [CLI, "doctor"], { env: { ...process.env, COOLIE_HOME: h }, encoding: "utf8" })
    expect(out.split("\n").some((l) => l.includes("workspaces") && l.includes("warn"))).toBe(false)
  })
})
```
（`TSX`/`CLI` 常量沿用该文件既有定义；`Database` 需 import `better-sqlite3`——文件里 export 测试已有。doctor 是只读诊断：测试自建含 `workspaces` 表的 db，schema 列与 server migration 对齐。）

- [ ] **Step 2: 写失败测试（resume e2e，真 daemon + 真 tmux + cat）**

`packages/cli/test/cli-e2e.test.ts` 追加（沿用该文件 `coolie()`/`TMUX_SOCK`/`repo` helper；`repo` 需要至少一个 commit——若既有 beforeAll 只 `git init`，在本用例开头补一个 `--allow-empty` commit）：
```ts
  it("resume：session 被外力清理 → 经 ensure 重建（enter 的 heal 同一条 server 路径）", () => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
    const created = coolie("create", repo, "--name", "heal-me")
    const id = /\(([^)]+)\)/.exec(created)![1]!
    execFileSync("tmux", ["-L", TMUX_SOCK, "kill-session", "-t", `=coolie-${id}`])
    const out = coolie("resume", id)
    expect(out).toContain("action=recreated")
    const has = spawnSync("tmux", ["-L", TMUX_SOCK, "has-session", "-t", `=coolie-${id}`])
    expect(has.status).toBe(0) // session 回来了
    coolie("delete", id, "--force") // 清场
  })
```
（该文件若未 import `spawnSync`，在 import 行补上。）

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run --cwd packages/cli test`
Expected: FAIL——`resume` 未知命令（commander exit 1）；doctor 无 `workspaces` 行。

- [ ] **Step 4: 实现 CLI**

`packages/cli/src/main.ts`：

import 行把 `decodeCoolieEvent` 一组扩为：
```ts
import { ROUTES, decodeProject, decodeWorkspace, decodeCoolieEvent, decodeHealOutcome, tmuxSessionName } from "@coolie/protocol"
```

`enter` 命令替换为：
```ts
program.command("enter <wsId>")
  .description("attach 进 workspace 的 tmux session（丢失自动重建；Ctrl-b d 返回）")
  .action(async (id: string) => {
    const sock = tmuxSocketName()
    const session = tmuxSessionName(id)
    const has = spawnSync("tmux", ["-L", sock, "has-session", "-t", `=${session}`], { stdio: "ignore" })
    if (has.status !== 0) {
      // ensure-or-heal（设计文档 §十）：session 丢失 → 经 server 重建（--resume 复活），失败才报错
      try {
        const out = decodeHealOutcome(await api("POST", `/workspaces/${id}/ensure`, {}))
        console.error(`[coolie] session 已重建（resumed=${out.resumed}）`)
      } catch (e) { fail(e) }
    }
    const r = spawnSync("tmux", ["-L", sock, "attach", "-t", `=${session}`], { stdio: "inherit" })
    process.exit(r.status ?? 0)
  })
```

`open` 命令之后新增：
```ts
program.command("resume <wsId>")
  .description("engine 退出后原地重启（--resume 续会话；GUI Resume 按钮同款 API）")
  .action(async (id: string) => {
    try {
      const tabs: any[] = await api("GET", `/workspaces/${id}/tabs`)
      const engineTab = tabs.find((t) => t.kind === "engine")
      if (!engineTab) return fail(`workspace ${id} 没有 engine tab`)
      const out = decodeHealOutcome(await api("POST", `/workspaces/${id}/tabs/${engineTab.id}/resume`, {}))
      console.log(`resumed ${id} (action=${out.action} resumed=${out.resumed} session=${out.sessionId})`)
    } catch (e) { fail(e) }
  })
```

`doctor` 命令：db 检查段替换为（打开一次连查带关，仍然只读）：
```ts
  const dbPath = path.join(h, "coolie.db")
  if (!fs.existsSync(dbPath)) check("warn", "db", "尚无数据库")
  else {
    try {
      const d = new Database(dbPath, { readonly: true })
      check("ok", "db", dbPath)
      // stuck-creating（ledger carry-over）：create 是同步流水线，creating + 无活 server = server 崩溃残留。
      // doctor 只读纪律：只报告，绝不改库、绝不杀进程。
      try {
        const STUCK_MS = 10 * 60_000
        const rows = d.prepare("SELECT id, created_at AS createdAt FROM workspaces WHERE status = 'creating'").all() as any[]
        const stuck = rows.filter((r) => Date.now() - r.createdAt > STUCK_MS)
        if (stuck.length > 0)
          check("warn", "workspaces", `${stuck.length} 个卡在 creating 超过 10 分钟（server 崩溃残留？）：${stuck.map((r) => r.id).join(",")}——用 coolie 的 retry 或 delete 处理`)
      } catch { /* workspaces 表还没建（新库）：跳过 */ }
      d.close()
    } catch (e) { check("fail", "db", `无法打开：${String(e)}`) }
  }
```
server 检查段的 `if (alive) check("ok", "server", …)` 分支追加 clients 行：
```ts
    if (alive) {
      check("ok", "server", `running pid=${info.pid} port=${info.port}`)
      try {
        const cs: any = await (await fetch(`http://127.0.0.1:${info.port}/clients`, {
          headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1000),
        })).json()
        check("ok", "clients", `gui=${cs.guiHolders} total=${cs.clients.length} linger=${cs.lingerMs}ms armed=${cs.idleExitArmed}`)
      } catch { check("warn", "clients", "无法读取 /clients") }
    }
    else check(pidAlive ? "fail" : "warn", "server", pidAlive ? "pid 活着但 /health 不通" : "server.json 陈旧（进程已死）")
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run --cwd packages/cli test && bun run typecheck`
Expected: 全绿（既有 doctor 用例断言 ok/warn/fail 行仍成立——新行只增不改）。

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/test/cli-e2e.test.ts packages/cli/test/export-doctor.test.ts
git commit -m "feat(cli): enter ensure-or-heal + resume 命令 + doctor stuck-creating/clients 行"
```

---

### Task 12: README + 全量回归 + 手工冒烟清单

**Files:**
- Modify: `README.md`（追加 Plan 4 段落）

- [ ] **Step 1: README 追加**

在 Plan 3 段落（「tmux 链路与 engine（M1 Plan 3）」）之后追加：
```markdown
## daemon 生命周期与自愈（M1 Plan 4）

- **refcount 惰性退出**：GUI 的 SSE 连接带 `role=gui` 即持有 server 生命周期；终端 WS/CLI 一次性命令不持有。
  最后一个 gui 断开后过 `COOLIE_LINGER_MS`（默认 60000）server 自退（`daemon.idle.exit` 事件，tmux/engine 分毫不动）。
  从未有过 gui 持有者的 server（纯 CLI 使用）驻留到 `coolie server stop`。`GET /clients` 可观测当前持有状态。
- **engine keep-alive**：window 0 跑 `~/.coolie/hooks/coolie-keepalive.sh`——engine 退出后回报
  `POST /hooks/engine-exit`（`engine.exited` 事件；非零退出 → tab 徽标 `!错误`）、打印横幅、落回交互 shell（布局不塌）。
- **ensure-or-heal**：`coolie enter` / `POST /workspaces/:id/ensure` 发现 session 丢失 → observe→decide→apply 重建，
  转录还在则 `claude --resume <sessionId>` 复活；unarchive 后自动重建（archive 保留 tabs 行作为复活钥匙）。
- **Resume**：`coolie resume <wsId>` / `POST /workspaces/:id/tabs/:tabId/resume`——engine 退出后原地
  `respawn-window` 重启（`--resume` 优先）；session 整个丢失自动降级 ensure。
- **daemon 加固**：post-listen 单实例独占注册（竞态输家自退且不碰赢家的 sock）、probeAlive pid 预检、
  shutdown await 两个 listener 关闭（SSE 长连接主动断开）、`coolie doctor` 报告卡在 creating 的残留 workspace。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `COOLIE_LINGER_MS` | 最后一个 gui 断开后的惰性退出宽限期 | `60000` |
```

- [ ] **Step 2: 全量回归**

```bash
bun run typecheck && bun run test
```
Expected: typecheck 通过；vitest 全绿（Plan 1–3 存量 + 本计划新增，0 fail 0 skip）。

随后零泄漏核查：
```bash
tmux -L coolie list-sessions 2>&1 | head -1   # 期望：no server running / error connecting（生产 socket 干净）
ps aux | grep -E "tmux -L coolie-test|tmux attach" | grep -v grep   # 期望：空
ls /tmp/tmux-$(id -u)/ 2>/dev/null | grep coolie-test               # 期望：空或仅残留 socket 文件（无进程）
```

- [ ] **Step 3: 手工冒烟清单（真 claude 唯一出场点，逐项记录结果）**

1. `coolie doctor` → git/tmux/claude ok；无 `workspaces` warn；server stopped。
2. `coolie create <真实 repo> --prompt "一句话总结这个 repo"` → active；`coolie enter <id>` 看到真 claude 在包装下正常运行（TUI 无异样）；`Ctrl-b d`。
3. **keep-alive**：在 claude 里 `/exit` → pane 打出 `[coolie] engine exited (code 0) …` 横幅并落回 shell，`tmux -L coolie list-windows -t =coolie-<id>` 仍 1 个 window；`coolie events tail --after 0` 出现 `engine.exited`，tabs API 里 status=`idle`。
4. **resume**：`coolie resume <id>` → `action=respawned resumed=true`；`coolie enter <id>` → claude 带着先前对话回来了（`--resume` 生效）；events 出现 `engine.resumed`。
5. **heal**：`tmux -L coolie kill-session -t =coolie-<id>` 模拟外力清理 → `coolie enter <id>` → stderr 打印 `session 已重建（resumed=true）` 且 attach 进来还是原对话。
6. **unarchive 复活**：`coolie archive <id>`（脏树加 `--force`）→ `coolie unarchive <id>` → 不用 enter 先看 `tmux -L coolie has-session -t =coolie-<id>; echo $?` = 0；enter 确认对话仍在。
7. **refcount**：先 `coolie server stop`，再 `COOLIE_LINGER_MS=3000 npx tsx packages/server/src/main.ts start &` 手动拉起短 grace 的 server；`curl -N -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/events/stream?after=0&role=gui"`（token/port 取自 `~/.coolie/server.json`），另开终端看 `coolie doctor` 的 clients 行显示 `gui=1`；Ctrl-C 断掉 curl → ~3 秒后 `coolie server status` = stopped，且 `tmux -L coolie has-session -t =coolie-<id>` 仍为 0（engine 归 tmux，惰性退出不碰 session）。
8. **单实例**：server 在跑时再 `… main.ts start` → `already running` exit 1。
9. `coolie doctor`（server 已被 7 退掉）→ server stopped/warn 陈旧行为正确；`coolie delete <id> --force` 清场。
10. 清理验证：`tmux -L coolie list-sessions` 只剩 `coolie-ctl`（或 no server）；`~/.coolie/logs/server.log` 无 ERROR 级意外。

任何一项不符 → 按 superpowers:systematic-debugging 排查后修复再回 Step 2。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README Plan 4（refcount 惰性退出/keep-alive/ensure-or-heal/resume/daemon 加固）+ 冒烟结果"
```

---

## Self-Review 记录（writing-plans 自检，作者已跑）

**0. Adversarial review round：6 findings applied**（READY-WITH-FIXES）——F1 Ledger disposition 块（Global Constraints 后）+ M2 hook 引号修复吸收进 Task 6；F2 Task 3 新增并发-shutdown 真 RED 用例（幂等 guard 未落地时 double-rm ENOENT）；F3 Task 8 delete 断言改为独立 delete 用例（原引用的 delete 用例不存在）；F4 §4 增补 onIdleExpired 一次性 latch 重连窗口取舍；F5 Task 11 helper 名对照 `cli/main.ts` 实况行号（api:9/fail:13/tmuxSocketName:83/Database:8/tmuxSessionName:3）；F6 词汇表补 `engine.session.started`/`prompt.delivery.degraded`（pre-existing on branch）+ Task 1 vocab 测试覆盖。

**1. Spec 覆盖对照**

| Spec/任务书要求 | 任务 |
|---|---|
| §2.1 role 化 refcount：GUI 持有、终端 pane 不持有、最后持有者断开惰性退出 | Task 4（registry）+ Task 5（SSE lease/WS 登记/自退接线） |
| §2.1 「/clients 注册」server 侧配套 | Task 5（`GET /clients`；lease 绑连接的设计取舍见下） |
| §十 ensure-or-heal 三段式（observe→decide→apply） | Task 9（`decideHeal` 纯函数 + `SessionEnsurer.ensure`） |
| §十 engine `--resume` 复活（historyReader 转录为据） | Task 7（launchCommand resume）+ Task 9（transcriptExists 判据） |
| §十/§四 unarchive 后重建 session | Task 9（unarchive best-effort heal；钥匙=Task 8 archive 保留 tabs 行） |
| §十 engine 退出 keep-alive 不塌布局 + 非零退出语义 | Task 6（脚本+端点+error 徽标产生点）+ Task 7（接入 create + cat/kill 与 daemon 闭环测试） |
| §十 Resume 按钮 server 端 API `POST /workspaces/:id/tabs/:tabId/resume` | Task 10（respawn-window -k；session 丢失降级 ensure） |
| §十 server 崩客户端指数退避重连 | OUT（Plan 5 客户端侧）；server 侧配套=/clients、`engine.exited`、durable SSE（已有）——Global Constraints 记录 |
| `engine.exited` 词汇占位启用（Plan 3 预留） | Task 6（payload `{tabId, sessionId, exitCode}`） |
| ledger：post-listen 单实例 re-check | Task 2（claimServerInfo）+ Task 3（listen→claim→sock 顺序，输家不碰赢家 sock） |
| ledger：probeAlive pid 预检 | Task 2 |
| ledger：awaited server.close | Task 3（closeAllConnections + 2s 兜底 + 幂等） |
| ledger：doctor stuck-creating | Task 11（只读、>10min 才 warn） |
| §九 doctor 只读纪律 / 事件流可观测 | Task 11（不杀进程不删文件）；6 个新事件类型进词汇表（File Structure 节） |
| §八 CLI（enter 自愈提示兑现 Plan 3 的「Plan 4 heal 预告」） | Task 11（enter ensure→attach、resume 命令） |

**2. Placeholder 扫描**：无 TBD/TODO/“类似 Task N”。三处「沿用该文件既有 helper」（daemon.test 的 `startServer`（本计划顺手参数化）、tabs-repo 的 `run/runExit`、cli-e2e 的 `coolie()`）为对既有代码的引用而非占位，均标注了失配时的调整规则。`http-heal.test.ts` 的 layer 段声明「与 heal.test.ts 逐行同构复制」并给出了差异点（SOCK 后缀、http server 段全文在列）——复制源在同一计划 Task 9 内，实现者可独立完成。

**3. 类型一致性抽查（已修正项如实记录）**：
- `HealOutcome` 曾在 server 侧另定义一份 → 收敛为 protocol 单一真源（Task 1 产出，Task 9/10/11 消费；server 侧仅 `HealPlan/decideHeal` 是内部决策类型）。
- `TabStatusSource` 四值（`hook|poller|wrapper|heal`）在 Task 6 一次定义到位，Task 9/10 直接用 `"heal"`，避免两次改签名。
- `startEngineSession` 返回 `{sessionName, engineCommand}`：Task 7 定义，bootstrap（Task 7）与 ensure（Task 9）消费处一致；resumeTab（Task 10）不走它（respawn 不建 session）而是复用 `wrapEngineCommand`，已核对两处 command 组装形状相同。
- `ClientRegistry.graceMs` 暴露为字段：Task 4 定义、Task 5 `/clients` 响应与 daemon e2e 断言（`lingerMs: 400`）消费一致。
- `claimServerInfo` 的 `sock` 字段随 `ServerInfo` 走（Task 2 不改 shape），Task 3 传入 `{port, token, pid, sock}` 与 CLI `client.ts` 的 unix-socket 优先逻辑兼容（sock 文件晚于 server.json 出现的窗口内，client 自动回退 TCP——既有行为，已在 Task 3 注明）。
- fake engine 更新：`recordingClaude.launchCommand` 接收 `(o)` 并记录 `resume`——与 Task 7 的新 `launchCommand` 签名结构兼容；`lifecycle-tmux.test.ts` 的 `fakeClaude` 零元数 lambda 天然满足新签名（TS 结构化类型），无需改动。

**4. 设计取舍与风险（作者定夺，实现者不必再议）**：
- **lease 绑连接而非显式 POST/DELETE**：崩溃的 GUI 必须自动释放持有，否则 daemon 永生——`role=gui` 的 SSE 连接即 lease，`GET /clients` 提供观测面。这是对「/clients 注册」表述的落地解释，Plan 5 GUI 侧零额外协议。
- **WS 终端强制 role=terminal**：§2.1「终端 pane 不持有」是硬语义，不给声明面（防 GUI 把每个 pane 都声明成 gui 造成持有泄漏）。
- **从未持有 → 永不布防**：纯 CLI 用户的 server 驻留到显式 stop；「谁先用谁拉起」的按需语义靠 `ensureServer` 已成立，M1 不做「CLI 用完即退」。
- **onIdleExpired 一次性 latch 的窗口**：`makeClientRegistry` 的 `fired` 是不可逆闩——一旦宽限期届满触发 `onIdleExpired`，`arm/disarm` 即失效。故 GUI 在「`onIdleExpired` 已触发、但异步 `shutdown()` 尚未跑完」的窄窗内重连，仍会随即失去 server（新连接 register 无法取消已在路上的自退）。M1 接受此语义（客户端指数退避重连是 Plan 5 的活，重连自会把 server 再拉起来）。
- **archive 保留 tabs 行**（行为变更）：`engineSessionId` 是 unarchive 后 `--resume` 的唯一钥匙；Plan 3 的「archive 删 tabs」与 §十 复活语义冲突，本计划裁决为保留（delete 仍删）。受影响断言已在 Task 8 逐处更新。
- **hooks session_id 同步**：claude `--resume` fork 新 id，转录路径随之变化——不同步则 mtime 兜底与标题派生失明。与并行 fixer 的 `/hooks/claude` 改动有触点，Task 8 已给适配注记（行为契约优先）。
- **keep-alive 与「秒退 engine」**：包装后 engine 立死不再塌 session，首条 prompt 有被投进 fallback shell 的理论窗口——由并行 fixer 的就绪门控（`engine.session.started`）承接；本计划把受影响的死-pane 测试注入换为「画面永不稳定」，并在 Task 7 留了 fixer 形状的等价改写规则。
- **COOLIE_LINGER_MS 不进 CoolieConfig**：5 个测试 fixture 注入完整 config shape，加必填字段全体破坏；env 在 main.ts 边缘读取即可（refcount 只存在于真 daemon 进程）。
- **respawn 的 env 继承**：`new-session -e` 写进 session environment，`respawn-window` 按 tmux 语义继承——冒烟 step 4 验证真 claude 下 `COOLIE_*` 仍在（`launchCommand` 不依赖它们，风险仅限用户脚本）。
- **测试时长**：Task 7 的「画面永不稳定」用例耗时 ≈ waitStable 预算（~6s）；Task 5 的 e2e 用短 grace（300–800ms）控制在秒级。全量回归预计 +30s 内。
