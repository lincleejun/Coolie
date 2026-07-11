# Coolie M1 · Plan 3：tmux 链路 + Engine 抽象（claude adapter）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Plan 1/2 基座之上打通「workspace = worktree + tmux session + engine」的运行时全链路：专属 socket 上的 TmuxService（含持久 control-mode client）、prompt 投递流水线（稳定检测→消毒→bracketed paste→150ms→Enter）、node-pty + WS 二进制终端通道、Engine 抽象六件套的 claude 实现（launchCommand / hooks 注入 / turn detector / historyReader）、lifecycle 集成（create 建 session 启 engine 投首条 prompt；archive/delete 拆 session）、unix socket 监听与 `coolie enter/open`。

**Architecture:** tmux 是唯一的进程持久层——engine 进程只属于 tmux，server/CLI 死掉都不影响（Task 12 有生存测试钉死这条原则）。server 侧新增三个 Effect service：`TmuxService`（tmux CLI 封装：批量操作走 execFile、命名键走持久 `tmux -C` control-mode client、文本走 `load-buffer`+`paste-buffer -p` 字节保真路径）、`TabsRepo`（tabs 表 CRUD，tab 事件与写库同事务）、`EngineRegistry`（id→Engine 映射，M1 只注册 claude）。结构化状态**只**来自 claude hooks 回调（`POST /hooks/claude`）与转录文件 mtime 兜底轮询——绝不 scrape 终端画面。tmux/engine 启动经 Plan 2 预留的 `PostCreateHooks` 插拔点接入 create 流水线（本计划把 hook 签名扩展为 `(ws, ctx)` 以携带 `initialPrompt`）。终端字节走独立 WS 二进制通道（`node-pty` attach + `ws` 包，控制消息用 JSON 文本帧），与 REST/SSE 互不混用（设计文档 §2.3 三通道）。设计依据：`docs/superpowers/specs/2026-07-11-coolie-design.md` §五、§六、§2.1、§2.3、§八、§十二。

**Tech Stack:** 与主干落地代码一致：TypeScript ^5.x（strict + exactOptionalPropertyTypes）、Node ≥22 运行时（bun 仅装包/跑脚本）、Effect ^3.21.4（Context.Tag / Layer / Effect.gen / Data.TaggedError / runPromiseExit+Exit 解包）、better-sqlite3、vitest、commander；本计划新增 **node-pty**（原生模块，Task 1 先行冒烟）与 **ws**（纯 JS WebSocket server）；tmux 3.6a（本机已装，`/opt/homebrew/bin/tmux`）；claude CLI 在 PATH（`~/.local/bin/claude`，真启动只出现在最终手工冒烟）。

## Global Constraints

- server 与 CLI 的一切进程**必须以 Node 运行**（`node`/`tsx`），bun 只做 `bun install`/`bun run`（设计文档 §2.2：node-pty 不兼容 Bun）。
- Effect 锁 `^3.21.4`；代码按主干已合入代码的实际 API 风格书写（`Runtime` 返回 `Exit`、`errorFromCause` 按 `_tag` 映射状态码）；若个别 API 有出入以官方 docs 等价改写，**任务的行为契约（每步测试断言）不变**。
- **tmux 纪律（本计划新增，不可违背）**：一切 tmux 交互走专属 socket（生产 `-L coolie`，经 `CoolieConfig.tmuxSocket` / 环境变量 `COOLIE_TMUX_SOCKET` 注入；测试 `coolie-test-<pid>-<rand>`，afterAll 必 `kill-server`）；session 名 `coolie-<wsId>`、window 0 = engine；target 引用一律带 `=` 精确匹配前缀（由 TmuxService 内部统一加，调用方传裸名）。
- **绝不 scrape 终端画面 pattern 获取状态**（agent-deck 维护地狱教训）：`capturePane` 只允许两个用途——测试断言、`waitStable` 画面稳定检测。结构化状态只从 hooks 回调 / 转录 mtime / git 拿。
- **engine 进程只属于 tmux**：server 死亡不得杀 engine（Task 12 用「SIGKILL server 后 session 仍在」的真实测试钉死）；tmux 的 control-mode client、node-pty attach client 都只是 tmux 的客户端，它们死掉 session 无感。
- **prompt 消毒强制**：任何经 composer/API 投向 tmux pane 的文本必须先过 `sanitizePromptForPty`（CRLF 归一、剥 CSI/OSC/控制字符、tab 展开）。例外：WS 终端通道的输入字节是用户在终端里的真实键击，**原样透传不消毒**（它就是终端本身）。
- **Terminal Identity Boundary**（kobe）：所有进入 tmux/PTY 的环境统一 `TERM=xterm-256color` + `COLORTERM=truecolor`，剥 `TERM_PROGRAM`/`TERM_PROGRAM_VERSION`/`TERM_SESSION_ID`。
- **hooks 纪律**（kobe hook-cmd）：hook 脚本绝不拉起 server、任何失败静默、**永远 exit 0**；注入幂等、可 opt-out（`COOLIE_DISABLE_HOOKS=1`）；注入的 `.claude/settings.local.json` 必须进 `.git/info/exclude` 防脏树。
- 安全默认值不变：server 绑 `127.0.0.1` + unix socket（`<COOLIE_HOME>/coolie.sock`）；除 `GET /health` 外一切端点（含 `/hooks/claude` 与 WS upgrade）强制 token——WS upgrade 接受 `token` query param 或 `Authorization` header（浏览器 WebSocket 无法带 header）；日志绝不打印含 token 的完整 URL。
- SQLite 写库纪律不变：本计划**无 schema 变更**（tabs 表 m0001 已建，规模小不加索引——YAGNI）；migration 幂等、禁无 WHERE sweep；tab/project 的「写库 + 事件 append」在同一 `db.transaction` 内完成，bus 广播在 commit 后。
- git 纪律不变（Plan 2 全套：worktree remove 唯一删除入口、branch 永不删、默认拒绝 + 显式 force）。本计划不给 `runGit`/`runTmux` 加 `Effect.timeout`（`waitStable` 用 attempts 上限自带止损），故 ledger 的「runGit interrupt finalizer」carry-over 不触发，明确记录于此。
- 日志纪律不变（append-only、10MB 轮转一代 `.old`、fire-and-forget、crash net）。
- 所有测试经 `COOLIE_HOME`/`COOLIE_WORKSPACES_ROOT`/`COOLIE_TMUX_SOCKET`/`COOLIE_CLAUDE_HOME` 指向 mkdtemp 临时目录/专属测试 socket，绝不读写真实 `~/.coolie`、`~/coolie`、`~/.claude`，绝不碰生产 `-L coolie` socket；**零泄漏**：每个用了 tmux 的测试文件 afterAll `kill-server`，WS/pty 测试断言客户端归零。
- 真 claude 只出现在 Task 15 的手工冒烟清单；自动化测试中 engine 命令一律用 `COOLIE_CLAUDE_CMD=cat`（launchCommand 的用户覆盖 seam）或 fake Engine 注入。
- 每个 Task 结束必须 `git commit`，conventional commits（feat/fix/test/docs/chore）。
- 本计划**不做**（显式延后）：refcount 惰性退出（Plan 4）；tmux session 丢失的 ensure-or-heal 重建（Plan 4——TmuxService 的 hasSession/newSession/listWindows 已为其备好积木；M1 里 unarchive 后 session 不重建，`coolie enter` 给出明确提示）；engine keep-alive shell 包装与 `engine.exited` 事件（Plan 4，事件名先入词汇表占位）；GUI/xterm.js 客户端（Plan 5——WS 通道以 `ws` npm client 在测试中验收）；codex adapter 与 fan-out（M2）；**setup 输出可见 tab（M1 OUT）**——setup 在 create 流水线里先于 tmux session 存在而运行，输出维持现状（server.log 全量 + events outputTail），`SetupRunner` 的 log 回调 seam 已在，搬进 setup window 由 Plan 4/5 重估。

## File Structure（本计划新建/修改）

```
packages/protocol/src/
  domain.ts                       # 修改：+TabKind/TabStatus/Tab Schema + decodeTab
  routes.ts                       # 修改：+tabs/hooks/ws-terminal 三路由；POST /workspaces 描述加 initialPrompt
packages/server/
  package.json                    # 修改：+node-pty +ws +@types/ws
  src/config.ts                   # 修改：+tmuxSocket（COOLIE_TMUX_SOCKET）+claudeHome（COOLIE_CLAUDE_HOME）
  src/tmux/env.ts                 # 新建：sanitizedTmuxEnv（Terminal Identity Boundary）+ shellQuote
  src/tmux/service.ts             # 新建：TmuxService + TmuxError（has/new/kill/list/capture/paste/sendKey）
  src/tmux/control.ts             # 新建：持久 control-mode client（发键热路径，死了重连）
  src/tmux/sanitize.ts            # 新建：sanitizePromptForPty 纯函数
  src/tmux/delivery.ts            # 新建：waitStable（两帧稳定）+ deliverPrompt 投递流水线
  src/pty/attach.ts               # 新建：node-pty spawn `tmux attach`（字节保真）
  src/http/ws.ts                  # 新建：WS 终端通道（upgrade 鉴权 + 二进制帧 + JSON 控制帧 + resize 防抖）
  src/repo/tabs.ts                # 新建：TabsRepo（tabs 表 CRUD；tab 事件同事务）
  src/repo/events.ts              # 修改：抽出 appendEventRow 供各 repo 事务内复用
  src/repo/projects.ts            # 修改（Task 13）：add/remove 的 project.* 事件并入同一事务
  src/engine/types.ts             # 新建：Engine 接口（六件套裁剪版）+ EngineCapabilities
  src/engine/registry.ts          # 新建：EngineRegistry（id→Engine）+ EngineError
  src/engine/claude/binary.ts     # 新建：claude 二进制多路径发现（opcode 路线）
  src/engine/claude/transcript.ts # 新建：encodeCwd/transcriptPath/deriveTitle/resumeArgs
  src/engine/claude/hooks.ts      # 新建：hook 转发脚本生成 + settings.local.json 幂等注入
  src/engine/claude/adapter.ts    # 新建：claudeEngine（identity/capabilities/launchCommand/statusFromHookEvent）
  src/engine/monitor.ts           # 新建：转录 mtime 轮询兜底（纯决策 + poller）
  src/engine/bootstrap.ts         # 新建：EngineBootstrapHookLive（PostCreateHook：建 session→启 engine→投首条 prompt）
  src/workspace/lifecycle.ts      # 修改：PostCreateHook 签名 (ws, ctx)；archive/delete 先拆 tmux/tabs；名池跨项目 seeding
  src/http/app.ts                 # 修改：+/hooks/claude +/workspaces/:id/tabs +initialPrompt；query 校验、body cap、去 emitThenRespond
  src/daemon/info.ts              # 修改：ServerInfo +sock 字段
  src/main.ts                     # 修改：unix socket 监听、WS 装配、EventsBusLive、hook 脚本、poller、tmux 首启检测
packages/cli/src/
  client.ts                       # 修改：node:http 请求层，优先 unix socket（回退 TCP）
  main.ts                         # 修改：+enter/open、create --prompt、protocol schema 解码
packages/server/test/
  pty-smoke.test.ts  tmux-service.test.ts  tmux-control.test.ts  delivery.test.ts
  tabs-repo.test.ts  engine-claude.test.ts  hooks-endpoint.test.ts  monitor.test.ts
  ws-terminal.test.ts  lifecycle-tmux.test.ts
  config.test.ts / daemon.test.ts / http.test.ts / lifecycle-create.test.ts  # 追加/适配
packages/cli/test/workspace-e2e.test.ts  cli-e2e.test.ts   # 追加 enter/open/tail/prompt 用例
```

事件类型词汇表（本计划新增，lifecycle/engine 各步写 `events` 表，SSE/export/`events tail` 均可见）：

| type | payload | 产生点 |
|---|---|---|
| `workspace.tmux.created` | `{sessionName}` | bootstrap hook 建 session 后 |
| `workspace.tmux.killed` | `{sessionName, reason:"archive"\|"delete"}` | archive/delete 拆除时 |
| `tab.created` | `{tabId, kind, engineId, tmuxWindow}` | TabsRepo.insert（同事务） |
| `tab.status.changed` | `{tabId, status, source:"hook"\|"poller"}` | TabsRepo.setStatus（同事务；同值 no-op 不发） |
| `tab.title.changed` | `{tabId, title}` | TabsRepo.setTitle（同事务） |
| `engine.started` | `{tabId, engineId, sessionId, command}` | bootstrap hook 启 engine 后 |
| `engine.turn.started` | `{tabId, sessionId}` | hooks 端点收到 UserPromptSubmit |
| `engine.turn.finished` | `{tabId, sessionId}` | hooks 端点收到 Stop |
| `engine.notification` | `{tabId, sessionId}` | hooks 端点收到 Notification |
| `engine.session.ended` | `{tabId, sessionId}` | hooks 端点收到 SessionEnd |
| `prompt.delivered` | `{workspaceId, tabId, chars}` | 首条 prompt 投递成功后 |
| `engine.exited` | （保留） | **Plan 4** keep-alive 包装接入时启用，本计划只入词汇表 |

Tab 状态徽标映射（设计文档 §六）：`working`=●工作中、`awaiting-input`=✓等输入、`error`=!错误（M1 保留枚举值，产生点在 Plan 4 keep-alive）、`idle`=○空闲。

---

### Task 1: 原生依赖先行——node-pty + ws 安装与 pty 冒烟

node-pty 是全计划风险最高的原生依赖（node-gyp 构建；本机有 Xcode CLT + Python 3.14），第一个任务就把它装好、跑通，失败立刻暴露。

**Files:**
- Modify: `package.json`（根，+trustedDependencies）
- Modify: `packages/server/package.json`（+node-pty +ws +@types/ws）
- Test: `packages/server/test/pty-smoke.test.ts`

**Interfaces:**
- Produces: 可 import 的 `node-pty`（`pty.spawn` 原生构建可用）与 `ws`（`WebSocketServer`/`WebSocket`）。后续 Task 10 直接依赖。

- [ ] **Step 1: 写失败测试**

`packages/server/test/pty-smoke.test.ts`：
```ts
import { describe, it, expect } from "vitest"
import * as pty from "node-pty"

describe("node-pty smoke（原生构建验收）", () => {
  it("spawns a pty and captures output + exit code", async () => {
    const p = pty.spawn("/bin/sh", ["-c", "printf 'pty-ok-%s' 42"], {
      name: "xterm-256color", cols: 80, rows: 24,
      cwd: process.cwd(), env: process.env as Record<string, string>,
    })
    let out = ""
    p.onData((d) => { out += d })
    const code = await new Promise<number>((resolve) => p.onExit(({ exitCode }) => resolve(exitCode)))
    expect(code).toBe(0)
    expect(out).toContain("pty-ok-42")
  })

  it("resize does not throw and kill terminates", async () => {
    const p = pty.spawn("/bin/sh", [], {
      name: "xterm-256color", cols: 80, rows: 24,
      cwd: process.cwd(), env: process.env as Record<string, string>,
    })
    expect(() => p.resize(120, 40)).not.toThrow()
    const exited = new Promise<void>((resolve) => p.onExit(() => resolve()))
    p.kill()
    await exited // 泄漏守卫：kill 后必须真的退出
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test -- packages/server/test/pty-smoke.test.ts`
Expected: FAIL（`Cannot find module 'node-pty'` 或等价 resolve 错误）。

- [ ] **Step 3: 安装依赖**

根 `package.json` 加一行（bun 默认拦截未信任包的 postinstall；node-pty 必须跑 node-gyp 构建）：
```json
  "trustedDependencies": ["node-pty", "better-sqlite3"]
```
（放在 `"devDependencies"` 之后同级。）

然后：
```bash
cd packages/server && bun add node-pty ws && bun add -d @types/ws && cd ../.. && bun install
```

验证原生构建产物存在：
```bash
node -e "const p=require('node-pty');console.log(typeof p.spawn)"
```
Expected: `function`。若报 `.node` 找不到：`cd node_modules/node-pty && npm run install`（node-gyp 手动重建）后重试。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test -- packages/server/test/pty-smoke.test.ts` → PASS（2 用例）；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock packages/server/package.json packages/server/test/pty-smoke.test.ts
git commit -m "chore(server): add node-pty + ws deps with pty smoke test"
```

---

### Task 2: protocol——Tab/TabStatus Schema 与路由表扩展

**Files:**
- Modify: `packages/protocol/src/domain.ts`
- Modify: `packages/protocol/src/routes.ts`
- Test: `packages/protocol/test/domain.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 `Schema`（effect）、`ROUTES` 表结构。
- Produces（后续所有任务消费）:
  - `TabKind = "engine" | "setup" | "run" | "shell"`（Schema.Literal）
  - `TabStatus = "working" | "awaiting-input" | "error" | "idle"`（Schema.Literal）
  - `Tab`（Schema.Class）：`{ id: string; workspaceId: string; kind: TabKind; engineId: string | null; engineSessionId: string | null; tmuxWindow: number | null; title: string | null; status: TabStatus; lastHookAt: number | null }`
  - `decodeTab(u: unknown): Tab`
  - `tmuxSessionName(wsId: string): string`（`coolie-<wsId>`——session 命名的唯一真源，server 与 CLI 共用）
  - ROUTES 新增 3 条：`GET /workspaces/:id/tabs`、`POST /hooks/claude`、`GET /ws/terminal`

- [ ] **Step 1: 追加失败测试**

在 `packages/protocol/test/domain.test.ts` 的 describe 内追加（imports 行加入 `decodeTab, tmuxSessionName`）：
```ts
  it("round-trips a Tab", () => {
    const raw = {
      id: "t1", workspaceId: "w1", kind: "engine", engineId: "claude",
      engineSessionId: "3f0e8f7a-0000-4000-8000-000000000001", tmuxWindow: 0,
      title: null, status: "working", lastHookAt: null,
    }
    const t = decodeTab(raw)
    expect(t.kind).toBe("engine")
    expect(t.status).toBe("working")
    expect(t.tmuxWindow).toBe(0)
  })
  it("rejects a bad tab status", () => {
    expect(() => decodeTab({
      id: "t1", workspaceId: "w1", kind: "engine", engineId: null,
      engineSessionId: null, tmuxWindow: null, title: null, status: "busy", lastHookAt: null,
    })).toThrow()
  })
  it("tmuxSessionName is the single naming source", () => {
    expect(tmuxSessionName("01ABC")).toBe("coolie-01ABC")
  })
  it("ROUTES contains tabs/hooks/ws-terminal routes", () => {
    const paths = ROUTES.map(r => `${r.method} ${r.path}`)
    for (const p of ["GET /workspaces/:id/tabs", "POST /hooks/claude", "GET /ws/terminal"])
      expect(paths).toContain(p)
  })
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/protocol` → FAIL（`decodeTab` 无导出；ROUTES 缺条目）。

- [ ] **Step 3: 实现**

`packages/protocol/src/domain.ts` 追加（放在 `Workspace` 之后）：
```ts
export const TabKind = Schema.Literal("engine", "setup", "run", "shell")
export type TabKind = typeof TabKind.Type

/** 状态徽标（设计文档 §六）：working=●工作中 / awaiting-input=✓等输入 / error=!错误 / idle=○空闲 */
export const TabStatus = Schema.Literal("working", "awaiting-input", "error", "idle")
export type TabStatus = typeof TabStatus.Type

export class Tab extends Schema.Class<Tab>("Tab")({
  id: Schema.String,
  workspaceId: Schema.String,
  kind: TabKind,
  engineId: Schema.NullOr(Schema.String),
  engineSessionId: Schema.NullOr(Schema.String),
  tmuxWindow: Schema.NullOr(Schema.Number),
  title: Schema.NullOr(Schema.String),
  status: TabStatus,
  /** hooks 最近一次上报时间（turn detector 的 hook 优先仲裁用），无 hook 信号为 null */
  lastHookAt: Schema.NullOr(Schema.Number),
}) {}
export const decodeTab = Schema.decodeUnknownSync(Tab)

/** tmux session 命名唯一真源（设计文档 §五）：server bootstrap、CLI enter/open、WS resolveSession 共用。 */
export const tmuxSessionName = (wsId: string): string => `coolie-${wsId}`
```

`packages/protocol/src/routes.ts` 追加三条（数组末尾）；同时把 `POST /workspaces` 一条的 description 改为 `"创建 workspace {projectId, branchSlug?, name?, initialPrompt?}（同步跑完流水线才返回）"`：
```ts
  { method: "GET",  path: "/workspaces/:id/tabs", description: "列出 workspace 的 tabs（GUI tab ↔ tmux window 映射）" },
  { method: "POST", path: "/hooks/claude",        description: "claude hook 回调 ?workspace=（结构化 engine 状态唯一入口）" },
  { method: "GET",  path: "/ws/terminal",         description: "WS 终端通道 ?workspace=&window=&cols=&rows=&token=（二进制帧+JSON 控制帧）" },
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/protocol` → PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): Tab schema + tabs/hooks/ws-terminal routes"
```

---

### Task 3: TmuxService（专属 socket 上的 tmux CLI 封装，exec 路径）

**Files:**
- Modify: `packages/server/src/config.ts`
- Create: `packages/server/src/tmux/env.ts`
- Create: `packages/server/src/tmux/service.ts`
- Test: `packages/server/test/config.test.ts`（追加）、`packages/server/test/tmux-service.test.ts`

**Interfaces:**
- Consumes: `CoolieConfig`（Plan 1）。
- Produces（后续任务消费的精确签名）:
  - `CoolieConfig` 新增字段：`tmuxSocket: string`（`COOLIE_TMUX_SOCKET` ?? `"coolie"`）、`claudeHome: string`（`COOLIE_CLAUDE_HOME` ?? `~/.claude`）
  - `sanitizedTmuxEnv(base?: NodeJS.ProcessEnv): Record<string, string>`、`shellQuote(argv: readonly string[]): string`（tmux/env.ts）
  - `class TmuxError extends Data.TaggedError("TmuxError")<{ op: string; message: string; exitCode: number | null; stderr: string }>`
  - `interface TmuxWindowInfo { index: number; name: string }`
  - `TmuxServiceShape`：`socket: string`；`version(): Effect<string, TmuxError>`；`hasSession(name): Effect<boolean, TmuxError>`；`newSession(opts: { name; cwd; windowName; command: readonly string[]; env?: Readonly<Record<string,string>> }): Effect<void, TmuxError>`；`newWindow(opts: { session; name; cwd; command?: readonly string[] }): Effect<number, TmuxError>`；`killSession(name): Effect<void, TmuxError>`（幂等）；`listSessions(): Effect<string[], TmuxError>`；`listWindows(session): Effect<TmuxWindowInfo[], TmuxError>`；`listClients(): Effect<string[], TmuxError>`；`capturePane(target): Effect<string, TmuxError>`；`pasteText(target, text): Effect<void, TmuxError>`；`sendKey(target, key): Effect<void, TmuxError>`
  - `TmuxService`（Context.Tag）、`makeTmuxService(socket: string, ctl?: ControlClient): TmuxServiceShape`（Task 4 前 ctl 恒缺省）、`TmuxServiceLive: Layer<TmuxService, never, CoolieConfig>`
  - 行为契约：所有 target/session 名由**调用方传裸名**，service 内部加 `=` 精确匹配前缀；tmux 不在 PATH（ENOENT）→ TmuxError 带 `brew install tmux` 提示（doctor 已警告，此处成为 load-bearing 错误）；`killSession`/`listSessions` 对「session 不存在 / no server」幂等（成功 / 空数组）。

- [ ] **Step 1: 写失败测试**

`packages/server/test/config.test.ts` describe 内追加（afterEach 的 delete 列表加 `COOLIE_TMUX_SOCKET`、`COOLIE_CLAUDE_HOME`）：
```ts
  it("respects COOLIE_TMUX_SOCKET and COOLIE_CLAUDE_HOME", () => {
    process.env.COOLIE_TMUX_SOCKET = "coolie-test-x"
    process.env.COOLIE_CLAUDE_HOME = "/tmp/fake-claude-home"
    const c = load()
    expect(c.tmuxSocket).toBe("coolie-test-x")
    expect(c.claudeHome).toBe("/tmp/fake-claude-home")
  })
  it("defaults tmuxSocket=coolie and claudeHome under homedir", () => {
    const c = load()
    expect(c.tmuxSocket).toBe("coolie")
    expect(c.claudeHome.endsWith("/.claude")).toBe(true)
  })
```

`packages/server/test/tmux-service.test.ts`：
```ts
import { describe, it, expect, afterAll } from "vitest"
import { Effect, Exit } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { makeTmuxService, TmuxError } from "../src/tmux/service.js"
import { sanitizedTmuxEnv, shellQuote } from "../src/tmux/env.js"

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const svc = makeTmuxService(SOCK)
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-tmux-"))

afterAll(() => { try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* 已无 server */ } })

const run = <A>(eff: Effect.Effect<A, TmuxError>) => Effect.runPromise(eff)
const waitFor = async (fn: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error("waitFor timeout")
}

describe("tmux env boundary（纯函数）", () => {
  it("strips TERM_PROGRAM* and pins TERM/COLORTERM", () => {
    const env = sanitizedTmuxEnv({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3", TERM_SESSION_ID: "x", PATH: "/bin", TERM: "screen" })
    expect(env.TERM_PROGRAM).toBeUndefined()
    expect(env.TERM_PROGRAM_VERSION).toBeUndefined()
    expect(env.TERM_SESSION_ID).toBeUndefined()
    expect(env.TERM).toBe("xterm-256color")
    expect(env.COLORTERM).toBe("truecolor")
    expect(env.PATH).toBe("/bin")
  })
  it("shellQuote survives single quotes and spaces", () => {
    expect(shellQuote(["echo", "it's a test"])).toBe(`'echo' 'it'\\''s a test'`)
  })
})

describe("TmuxService on dedicated test socket", () => {
  it("hasSession=false on fresh socket; listSessions=[]", async () => {
    expect(await run(svc.hasSession("coolie-none"))).toBe(false)
    expect(await run(svc.listSessions())).toEqual([])
  })

  it("newSession creates window 0 with given name and command", async () => {
    await run(svc.newSession({ name: "coolie-t1", cwd, windowName: "engine", command: ["cat"] }))
    expect(await run(svc.hasSession("coolie-t1"))).toBe(true)
    expect(await run(svc.listSessions())).toContain("coolie-t1")
    const wins = await run(svc.listWindows("coolie-t1"))
    expect(wins).toEqual([{ index: 0, name: "engine" }])
  })

  it("pasteText + sendKey(Enter) reach the pane (cat echo)", async () => {
    await run(svc.pasteText("coolie-t1:0", "hello-tmux-service"))
    await run(svc.sendKey("coolie-t1:0", "Enter"))
    await waitFor(async () => (await run(svc.capturePane("coolie-t1:0"))).includes("hello-tmux-service"))
  })

  it("newWindow appends and returns its index", async () => {
    const idx = await run(svc.newWindow({ session: "coolie-t1", name: "shell", cwd }))
    expect(idx).toBe(1)
    const wins = await run(svc.listWindows("coolie-t1"))
    expect(wins.map((w) => w.name)).toEqual(["engine", "shell"])
  })

  it("session env carries injected vars (COOLIE_PORT_0 visible in pane)", async () => {
    await run(svc.newSession({
      name: "coolie-t2", cwd, windowName: "engine",
      command: ["/bin/sh", "-c", "echo PORT0=$COOLIE_PORT_0; cat"],
      env: { COOLIE_PORT_0: "40000" },
    }))
    await waitFor(async () => (await run(svc.capturePane("coolie-t2:0"))).includes("PORT0=40000"))
  })

  it("killSession is idempotent", async () => {
    await run(svc.killSession("coolie-t2"))
    expect(await run(svc.hasSession("coolie-t2"))).toBe(false)
    await run(svc.killSession("coolie-t2")) // 第二次不抛
  })

  it("version() returns a tmux version string", async () => {
    expect(await run(svc.version())).toMatch(/tmux \d/)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/tmux-service.test.ts packages/server/test/config.test.ts` → FAIL（模块不存在 / config 缺字段）。

- [ ] **Step 3: 实现**

`packages/server/src/config.ts` 的 `CoolieConfigShape` 加两个字段、`CoolieConfigLive` 的返回对象加两行：
```ts
export interface CoolieConfigShape {
  readonly home: string
  readonly dbPath: string
  readonly serverInfoPath: string
  readonly workspacesRoot: string
  /** tmux 专属 socket 名（tmux -L <socket>）；测试注入 coolie-test-* 隔离 */
  readonly tmuxSocket: string
  /** claude 引擎自己的数据目录（转录所在）；测试注入临时目录 */
  readonly claudeHome: string
}
```
```ts
    tmuxSocket: process.env.COOLIE_TMUX_SOCKET ?? "coolie",
    claudeHome: process.env.COOLIE_CLAUDE_HOME ?? path.join(os.homedir(), ".claude"),
```

`packages/server/src/tmux/env.ts`：
```ts
/** Terminal Identity Boundary（kobe）：进 tmux/PTY 的环境统一 TERM，剥外层终端身份泄漏。 */
export const sanitizedTmuxEnv = (base: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (k === "TERM_PROGRAM" || k === "TERM_PROGRAM_VERSION" || k === "TERM_SESSION_ID") continue
    env[k] = v
  }
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  return env
}

/** POSIX 单引号 quoting：argv → 一条可交给 `sh -c` 的命令串（new-session/new-window 的 command 参数）。 */
export const shellQuote = (argv: readonly string[]): string =>
  argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")
```

`packages/server/src/tmux/service.ts`：
```ts
import { Context, Data, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { CoolieConfig } from "../config.js"
import { sanitizedTmuxEnv, shellQuote } from "./env.js"
import type { ControlClient } from "./control.js"

export class TmuxError extends Data.TaggedError("TmuxError")<{
  readonly op: string
  readonly message: string
  readonly exitCode: number | null
  readonly stderr: string
}> {}

export interface TmuxWindowInfo { readonly index: number; readonly name: string }

export interface TmuxServiceShape {
  readonly socket: string
  readonly version: () => Effect.Effect<string, TmuxError>
  readonly hasSession: (name: string) => Effect.Effect<boolean, TmuxError>
  readonly newSession: (opts: {
    readonly name: string; readonly cwd: string; readonly windowName: string
    readonly command: readonly string[]; readonly env?: Readonly<Record<string, string>>
  }) => Effect.Effect<void, TmuxError>
  readonly newWindow: (opts: {
    readonly session: string; readonly name: string; readonly cwd: string
    readonly command?: readonly string[]
  }) => Effect.Effect<number, TmuxError>
  /** 幂等：session 不存在视为成功（tmux 已达目标状态） */
  readonly killSession: (name: string) => Effect.Effect<void, TmuxError>
  /** 无 server 时返回 []（不视为错误） */
  readonly listSessions: () => Effect.Effect<string[], TmuxError>
  readonly listWindows: (session: string) => Effect.Effect<TmuxWindowInfo[], TmuxError>
  readonly listClients: () => Effect.Effect<string[], TmuxError>
  /** ⚠ 仅测试断言与 waitStable 稳定检测可用（Global Constraints：绝不 scrape 状态） */
  readonly capturePane: (target: string) => Effect.Effect<string, TmuxError>
  /** 文本投递：load-buffer(stdin) + paste-buffer -p —— 字节保真、可含换行、bracketed paste
   * （control-mode 行协议无法携带内嵌换行，故文本走 buffer 路径；见 Task 4 注释） */
  readonly pasteText: (target: string, text: string) => Effect.Effect<void, TmuxError>
  /** 命名键（Enter/Escape/C-c…）；Task 4 起走持久 control-mode client 热路径 */
  readonly sendKey: (target: string, key: string) => Effect.Effect<void, TmuxError>
}
export class TmuxService extends Context.Tag("TmuxService")<TmuxService, TmuxServiceShape>() {}

const runTmux = (
  socket: string, op: string, args: readonly string[], stdin?: string,
): Effect.Effect<string, TmuxError> =>
  Effect.async<string, TmuxError>((resume) => {
    const child = execFile(
      "tmux", ["-L", socket, ...args],
      { env: sanitizedTmuxEnv(), maxBuffer: 4 * 1024 * 1024 },
      (error: any, stdout, stderr) => {
        if (error) {
          const enoent = error?.code === "ENOENT"
          resume(Effect.fail(new TmuxError({
            op,
            message: enoent
              ? "tmux 不在 PATH（brew install tmux 后重试；coolie doctor 可检查）"
              : `tmux ${op} 失败：${String(stderr || error.message).trim()}`,
            exitCode: typeof error.code === "number" ? error.code : null,
            stderr: String(stderr ?? ""),
          })))
        } else resume(Effect.succeed(stdout))
      },
    )
    if (stdin !== undefined) { child.stdin?.write(stdin); child.stdin?.end() }
  })

/** exitCode 非 null = tmux 跑起来了但说「不」（session 不存在/no server）；null = 没跑起来（ENOENT 等），必须上抛 */
const benignFalse = (e: TmuxError): Effect.Effect<boolean, TmuxError> =>
  e.exitCode !== null ? Effect.succeed(false) : Effect.fail(e)

export const makeTmuxService = (socket: string, ctl?: ControlClient): TmuxServiceShape => ({
  socket,
  version: () => runTmux(socket, "version", ["-V"]).pipe(Effect.map((s) => s.trim())),
  hasSession: (name) =>
    runTmux(socket, "has-session", ["has-session", "-t", `=${name}`]).pipe(Effect.as(true), Effect.catchAll(benignFalse)),
  newSession: ({ name, cwd, windowName, command, env }) => {
    const envFlags = Object.entries(env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])
    return runTmux(socket, "new-session",
      ["new-session", "-d", "-s", name, "-n", windowName, "-c", cwd, "-x", "220", "-y", "50", ...envFlags, shellQuote(command)],
    ).pipe(Effect.asVoid)
  },
  newWindow: ({ session, name, cwd, command }) =>
    runTmux(socket, "new-window",
      ["new-window", "-t", `=${session}:`, "-n", name, "-c", cwd, "-P", "-F", "#{window_index}",
        ...(command && command.length > 0 ? [shellQuote(command)] : [])],
    ).pipe(Effect.map((out) => Number(out.trim()))),
  killSession: (name) =>
    runTmux(socket, "kill-session", ["kill-session", "-t", `=${name}`]).pipe(
      Effect.asVoid,
      Effect.catchAll((e) => e.exitCode !== null ? Effect.void : Effect.fail(e)),
    ),
  listSessions: () =>
    runTmux(socket, "list-sessions", ["list-sessions", "-F", "#{session_name}"]).pipe(
      Effect.map((out) => out.split("\n").filter((s) => s !== "")),
      Effect.catchAll((e) => e.exitCode !== null ? Effect.succeed([] as string[]) : Effect.fail(e)),
    ),
  listWindows: (session) =>
    runTmux(socket, "list-windows", ["list-windows", "-t", `=${session}`, "-F", "#{window_index}\t#{window_name}"]).pipe(
      Effect.map((out) => out.split("\n").filter((s) => s !== "").map((l) => {
        const [i, ...rest] = l.split("\t")
        return { index: Number(i), name: rest.join("\t") }
      })),
    ),
  listClients: () =>
    runTmux(socket, "list-clients", ["list-clients", "-F", "#{client_tty}"]).pipe(
      Effect.map((out) => out.split("\n").filter((s) => s !== "")),
      Effect.catchAll((e) => e.exitCode !== null ? Effect.succeed([] as string[]) : Effect.fail(e)),
    ),
  capturePane: (target) => runTmux(socket, "capture-pane", ["capture-pane", "-p", "-t", `=${target}`]),
  pasteText: (target, text) => {
    // F4：buffer 名带随机后缀——并发 create 的两次投递不会互踩同名 buffer；-d 用完即删
    const buf = `coolie-paste-${Math.random().toString(36).slice(2, 10)}`
    return runTmux(socket, "load-buffer", ["load-buffer", "-b", buf, "-"], text).pipe(
      Effect.andThen(runTmux(socket, "paste-buffer", ["paste-buffer", "-p", "-d", "-b", buf, "-t", `=${target}`])),
      Effect.asVoid,
    )
  },
  sendKey: (target, key) =>
    ctl
      ? Effect.tryPromise({
          try: () => ctl.exec(`send-keys -t =${target} ${key}`),
          catch: (e) => new TmuxError({ op: "send-keys", message: e instanceof Error ? e.message : String(e), exitCode: null, stderr: "" }),
        })
      : runTmux(socket, "send-keys", ["send-keys", "-t", `=${target}`, key]).pipe(Effect.asVoid),
})

export const TmuxServiceLive = Layer.effect(
  TmuxService,
  Effect.gen(function* () {
    const cfg = yield* CoolieConfig
    return makeTmuxService(cfg.tmuxSocket)
  }),
)
```

注意：`import type { ControlClient } from "./control.js"` 在 Task 4 才创建该文件——本任务先建一个只含类型的占位 `packages/server/src/tmux/control.ts`：
```ts
/** Task 4 实现真身：持久 tmux control-mode client。此处先立类型契约。 */
export interface ControlClient {
  readonly exec: (command: string) => Promise<void>
  readonly dispose: () => void
  readonly isAlive: () => boolean
  readonly childPid: () => number | null
}
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server/test/tmux-service.test.ts packages/server/test/config.test.ts` → PASS；随后跑 `tmux -L coolie list-sessions 2>&1 | head -1` 确认**没有**污染生产 socket（应输出 no server / error connecting）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/tmux packages/server/test/tmux-service.test.ts packages/server/test/config.test.ts
git commit -m "feat(server): TmuxService on dedicated socket (exec paths + terminal identity boundary)"
```

---

### Task 4: 持久 control-mode client（发键热路径 + 断线重连）

agent-deck 实测：macOS 上每次 `tmux send-keys` fork+exec 有 10–50ms 延迟；打断（Esc）与回车这类单键热路径必须走常驻 `tmux -C` 子进程（<1ms）。文本投递**不**走 control 行协议——control mode 一行一命令，内嵌换行会截断命令，所以 `pasteText` 维持 Task 3 的 `load-buffer`(stdin)+`paste-buffer -p` 字节保真路径（这是对设计文档 §五「send-keys -l --」的等价实现：`-p` 即 bracketed paste，literal 语义由 buffer 直通保证）。

**Files:**
- Modify: `packages/server/src/tmux/control.ts`（占位 → 真身）
- Modify: `packages/server/src/tmux/service.ts`（TmuxServiceLive 改 scoped，持有 control client）
- Test: `packages/server/test/tmux-control.test.ts`

**Interfaces:**
- Consumes: `sanitizedTmuxEnv`（Task 3）。
- Produces:
  - `makeControlClient(socket: string, opts?: { hubSession?: string; timeoutMs?: number }): ControlClient`
  - `ControlClient = { exec(command: string): Promise<void>; dispose(): void; isAlive(): boolean; childPid(): number | null }`
  - 行为契约：lazy spawn（首次 exec 才起子进程）；子进程 = `tmux -L <sock> -C -f /dev/null new-session -A -s coolie-ctl … "sleep 2147483647"`（hub session 是 control client 的落脚点，跑一个安静的 sleep 而非用户 shell；`-A` 让重连幂等）；每条命令按序对应一个 `%begin…%end/%error` 块（**连接守卫块除外**——每次 (re)spawn 后 `new-session -A` 自身的第一个回复块必须吞掉、不结算 pending，否则全部回复错位一格，F1 实证）；`%error` → reject；命令超时（默认 3s）→ 杀 child 令下次 exec 自动重连；`dispose()` 后 exec 恒 reject。hub session 会把 tmux server 钉活到 coolie-server 退出（无害，kill-server/正常退出即清）。
  - `TmuxServiceLive` 变为 `Layer.scoped`：acquire 建 control client，release `dispose()`（server 死 → client 死 → **tmux server 与全部 session 无感存活**）。

- [ ] **Step 1: 写失败测试**

`packages/server/test/tmux-control.test.ts`：
```ts
import { describe, it, expect, afterAll } from "vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { makeControlClient } from "../src/tmux/control.js"
import { makeTmuxService } from "../src/tmux/service.js"

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const ctl = makeControlClient(SOCK)
const svc = makeTmuxService(SOCK, ctl)
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ctl-"))

afterAll(() => {
  ctl.dispose()
  try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ }
})

const waitFor = async (fn: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error("waitFor timeout")
}

describe("persistent control-mode client", () => {
  it("execs send-keys through one persistent child", async () => {
    await Effect.runPromise(svc.newSession({ name: "coolie-c1", cwd, windowName: "engine", command: ["cat"] }))
    await ctl.exec("send-keys -t =coolie-c1:0 -l -- ctl-hello")
    await ctl.exec("send-keys -t =coolie-c1:0 Enter")
    await waitFor(async () => (await Effect.runPromise(svc.capturePane("coolie-c1:0"))).includes("ctl-hello"))
    expect(ctl.isAlive()).toBe(true)
    const pid1 = ctl.childPid()
    await ctl.exec("send-keys -t =coolie-c1:0 Enter")
    expect(ctl.childPid()).toBe(pid1) // 复用同一个子进程，不是每次 fork
  })

  it("rejects on %error but stays usable", async () => {
    // 依赖 F1 守卫：若连接守卫块被误结算，这个 %error 会错位挂到下一条命令上（旧实现在此必挂）
    await expect(ctl.exec("definitely-not-a-tmux-command")).rejects.toThrow()
    await ctl.exec("send-keys -t =coolie-c1:0 Enter") // 错误后继续可用
  })

  it("reconnects after the control child dies", async () => {
    const pid = ctl.childPid()
    expect(pid).not.toBeNull()
    process.kill(pid!, "SIGKILL")
    await waitFor(async () => !ctl.isAlive())
    await ctl.exec("send-keys -t =coolie-c1:0 -l -- after-reconnect")
    await ctl.exec("send-keys -t =coolie-c1:0 Enter")
    await waitFor(async () => (await Effect.runPromise(svc.capturePane("coolie-c1:0"))).includes("after-reconnect"))
    expect(ctl.childPid()).not.toBe(pid)
  })

  it("sendKey via TmuxService routes through the control client", async () => {
    await Effect.runPromise(svc.pasteText("coolie-c1:0", "via-service"))
    await Effect.runPromise(svc.sendKey("coolie-c1:0", "Enter"))
    await waitFor(async () => (await Effect.runPromise(svc.capturePane("coolie-c1:0"))).includes("via-service"))
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/tmux-control.test.ts` → FAIL（`makeControlClient` 无导出）。

- [ ] **Step 3: 实现**

`packages/server/src/tmux/control.ts` 全文替换为：
```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { sanitizedTmuxEnv } from "./env.js"

/**
 * 持久 tmux control-mode client（agent-deck keysender 同款动机：macOS 逐次 fork+exec
 * send-keys 有 10–50ms 延迟，打断/回车热路径要 <1ms）。
 * - 子进程：`tmux -C new-session -A -s coolie-ctl "sleep …"`（hub session 只是落脚点）
 * - 行协议：一行一命令，按序回 %begin…%end（成功）/ %begin…%error（失败）块
 * - ⚠ 连接守卫块（F1，实证）：new-session -A 自身的 %begin…%end/%error 回复块**永远最先到**
 *   （每次重连亦然）——必须吞掉、不结算 pending，否则所有回复整体错位一格
 * - 死了下次 exec 自动重连；命令超时杀 child（卡死的 client 不可信）
 * - 局限（文档化）：命令行不能携带内嵌换行 → 文本投递走 TmuxService.pasteText 的 buffer 路径
 */
export interface ControlClient {
  readonly exec: (command: string) => Promise<void>
  readonly dispose: () => void
  readonly isAlive: () => boolean
  readonly childPid: () => number | null
}

interface Pending { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export const makeControlClient = (
  socket: string,
  opts?: { readonly hubSession?: string; readonly timeoutMs?: number },
): ControlClient => {
  const hub = opts?.hubSession ?? "coolie-ctl"
  const timeoutMs = opts?.timeoutMs ?? 3000
  let child: ChildProcessWithoutNullStreams | null = null
  let pending: Pending[] = []
  let buf = ""
  let disposed = false
  /** F1：连接守卫——每次 (re)spawn 后的第一个 %end/%error 块属于 new-session -A 本身，必须吞掉 */
  let awaitingGuard = false

  const settle = (err: Error | null): void => {
    const p = pending.shift()
    if (!p) return // 杂散回复防御（守卫块另由 awaitingGuard 单独处理）
    clearTimeout(p.timer)
    err ? p.reject(err) : p.resolve()
  }
  const failAll = (why: string): void => { while (pending.length > 0) settle(new Error(why)) }

  const onLine = (line: string): void => {
    if (line.startsWith("%end") || line.startsWith("%error")) {
      if (awaitingGuard) { awaitingGuard = false; return } // F1：守卫块不结算 pending
      if (line.startsWith("%end")) settle(null)
      else settle(new Error(`tmux control error: ${line}`))
    }
    // %begin/%session-changed/%output 等其余通知：忽略
  }

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (child && child.exitCode === null && !child.killed) return child
    child = spawn(
      "tmux",
      ["-L", socket, "-C", "-f", "/dev/null", "new-session", "-A", "-s", hub, "-x", "40", "-y", "10", "sleep 2147483647"],
      { env: sanitizedTmuxEnv(), stdio: ["pipe", "pipe", "pipe"] },
    )
    awaitingGuard = true // F1：这个连接的第一个回复块是守卫块（重连同样成立）
    buf = ""
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString("utf8")
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
    })
    child.on("error", () => failAll("tmux control client spawn error"))
    child.on("exit", () => { failAll("tmux control client exited"); child = null })
    return child
  }

  return {
    exec: (command) => {
      if (disposed) return Promise.reject(new Error("control client disposed"))
      const c = ensureChild()
      return new Promise<void>((resolve, reject) => {
        const entry: Pending = {
          resolve, reject,
          timer: setTimeout(() => {
            // 超时：这个 client 不可信了。杀掉 → exit handler failAll 清队列（本 entry 的二次 reject 是 no-op）
            reject(new Error(`tmux control command timeout (${timeoutMs}ms): ${command}`))
            c.kill("SIGKILL")
          }, timeoutMs),
        }
        pending.push(entry)
        c.stdin.write(command + "\n")
      })
    },
    dispose: () => { disposed = true; failAll("control client disposed"); child?.kill(); child = null },
    isAlive: () => child !== null && child.exitCode === null && !child.killed,
    childPid: () => (child && child.exitCode === null ? child.pid ?? null : null),
  }
}
```

`packages/server/src/tmux/service.ts` 的 `TmuxServiceLive` 替换为 scoped 版本（imports 加 `makeControlClient`）：
```ts
import { makeControlClient, type ControlClient } from "./control.js"
```
```ts
export const TmuxServiceLive = Layer.scoped(
  TmuxService,
  Effect.gen(function* () {
    const cfg = yield* CoolieConfig
    const ctl = yield* Effect.acquireRelease(
      Effect.sync(() => makeControlClient(cfg.tmuxSocket)),
      (c) => Effect.sync(() => c.dispose()),
    )
    return makeTmuxService(cfg.tmuxSocket, ctl)
  }),
)
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server/test/tmux-control.test.ts packages/server/test/tmux-service.test.ts` → 全 PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tmux packages/server/test/tmux-control.test.ts
git commit -m "feat(server): persistent tmux control-mode client for key sending"
```

---

### Task 5: prompt 消毒 + 画面稳定检测 + 投递流水线

kobe 踩坑结晶（prompt-delivery.ts）+ Superset `sanitizePromptForPty` 语义（独立实现，Superset 是 ELv2 不可抄码）：稳定检测（连续两帧 capture 相同）→ 消毒 → bracketed paste → 停 150ms → Enter（否则 `\e[201~` 和 `\r` 合并进一次 tty read，回车被吞进粘贴内容）。

**Files:**
- Create: `packages/server/src/tmux/sanitize.ts`
- Create: `packages/server/src/tmux/delivery.ts`
- Test: `packages/server/test/delivery.test.ts`

**Interfaces:**
- Consumes: `TmuxServiceShape.capturePane/pasteText/sendKey`、`TmuxError`（Task 3/4）。
- Produces:
  - `sanitizePromptForPty(input: string): string` — CRLF/CR→LF；剥 OSC/CSI/其余 ESC 序列与除 `\n`/`\t` 外的 C0/C1 控制字符；最后 tab→2 空格
  - `waitStable(tmux: TmuxServiceShape, target: string, opts?: DeliveryOpts): Effect<string, TmuxError>` — 连续两帧相同返回该帧；`attempts`（默认 24）耗尽 → TmuxError（op:"wait-stable"）
  - `deliverPrompt(tmux: TmuxServiceShape, target: string, text: string, opts?: DeliveryOpts): Effect<void, TmuxError>`
  - `DeliveryOpts = { intervalMs?: number; attempts?: number; enterDelayMs?: number }`（默认 250 / 24 / 150）

- [ ] **Step 1: 写失败测试**

`packages/server/test/delivery.test.ts`：
```ts
import { describe, it, expect, afterAll } from "vitest"
import { Effect, Exit } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { sanitizePromptForPty } from "../src/tmux/sanitize.js"
import { waitStable, deliverPrompt } from "../src/tmux/delivery.js"
import { makeTmuxService } from "../src/tmux/service.js"

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const svc = makeTmuxService(SOCK)
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-dlv-"))
afterAll(() => { try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ } })

describe("sanitizePromptForPty（纯函数，Superset 语义）", () => {
  it("normalizes CRLF and bare CR to LF", () => {
    expect(sanitizePromptForPty("a\r\nb\rc")).toBe("a\nb\nc")
  })
  it("strips CSI sequences", () => {
    expect(sanitizePromptForPty("red\u001b[31mtext\u001b[0m!")).toBe("redtext!")
  })
  it("strips OSC sequences (BEL and ST terminated)", () => {
    expect(sanitizePromptForPty("t\u001b]0;title\u0007x")).toBe("tx")
    expect(sanitizePromptForPty("t\u001b]0;title\u001b\\x")).toBe("tx")
  })
  it("strips stray ESC and control chars but keeps newline", () => {
    expect(sanitizePromptForPty("a\u001bZ\u0000\u0007b\nc")).toBe("ab\nc")
  })
  it("expands tabs to two spaces (completion trigger)", () => {
    expect(sanitizePromptForPty("a\tb")).toBe("a  b")
  })
  it("passes CJK through untouched", () => {
    expect(sanitizePromptForPty("修复登录 bug")).toBe("修复登录 bug")
  })
})

describe("waitStable + deliverPrompt against a real cat pane", () => {
  it("waitStable settles on an idle pane", async () => {
    await Effect.runPromise(svc.newSession({ name: "coolie-d1", cwd, windowName: "engine", command: ["cat"] }))
    const frame = await Effect.runPromise(waitStable(svc, "coolie-d1:0", { intervalMs: 100 }))
    expect(typeof frame).toBe("string")
  })

  it("waitStable fails on a永不稳定的画面", async () => {
    await Effect.runPromise(svc.newSession({
      name: "coolie-d2", cwd, windowName: "engine",
      command: ["/bin/sh", "-c", "while true; do date +%s%N; sleep 0.05; done"],
    }))
    const exit = await Effect.runPromiseExit(waitStable(svc, "coolie-d2:0", { intervalMs: 100, attempts: 4 }))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("deliverPrompt: sanitize → paste → 150ms → Enter（cat 收到完整多行）", async () => {
    await Effect.runPromise(deliverPrompt(svc, "coolie-d1:0", "line-one\r\nline\u001b[31m-two\ttail"))
    const deadline = Date.now() + 5000
    let cap = ""
    while (Date.now() < deadline) {
      cap = await Effect.runPromise(svc.capturePane("coolie-d1:0"))
      if (cap.includes("line-one") && cap.includes("line-two  tail")) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(cap).toContain("line-one")
    expect(cap).toContain("line-two  tail") // CSI 剥掉、tab 变两空格、CRLF 归一为换行
  })

  it("empty-after-sanitize prompt is a no-op", async () => {
    await Effect.runPromise(deliverPrompt(svc, "coolie-d1:0", "\u001b[31m\u0007"))
    // 不抛即可；无新增内容断言由上一用例的画面对照隐含
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/delivery.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`packages/server/src/tmux/sanitize.ts`：
```ts
/**
 * Prompt 消毒（Superset sanitizePromptForPty 同语义，独立实现）：
 * 裸 CR 会提前提交、ESC 序列会触发 keybinding、tab 会触发补全。
 * 顺序敏感：先剥成型的 OSC/CSI（否则通用控制符剥掉 ESC 后残留序列体），再剥孤立 ESC，再剥控制符，最后展开 tab。
 */
export const sanitizePromptForPty = (input: string): string =>
  input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // OSC: ESC ] … (BEL 或 ESC\ 终止；未终止的也整段剥掉)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    // CSI: ESC [ 参数字节* 终止字节
    .replace(/\u001b\[[0-9;?:!"'#$%&*+,\-./<=>]*[A-Za-z@^_`{|}~]/g, "")
    // 其余两字节 ESC 序列与孤立 ESC
    .replace(/\u001b./g, "")
    .replace(/\u001b/g, "")
    // C0（保留 \n \t）、DEL、C1
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g, "")
    .replace(/\t/g, "  ")
```

`packages/server/src/tmux/delivery.ts`：
```ts
import { Effect } from "effect"
import { TmuxError, type TmuxServiceShape } from "./service.js"
import { sanitizePromptForPty } from "./sanitize.js"

export interface DeliveryOpts {
  readonly intervalMs?: number
  readonly attempts?: number
  readonly enterDelayMs?: number
}

/** 画面稳定检测（kobe prompt-delivery）：连续两帧 capture 相同才投递。
 * 这是 capturePane 除测试外唯一被允许的用途（不解析内容，只比对相等）。 */
export const waitStable = (
  tmux: TmuxServiceShape, target: string, opts?: DeliveryOpts,
): Effect.Effect<string, TmuxError> =>
  Effect.gen(function* () {
    const interval = opts?.intervalMs ?? 250
    const attempts = opts?.attempts ?? 24
    let prev: string | null = null
    for (let i = 0; i < attempts; i++) {
      const frame = yield* tmux.capturePane(target)
      if (prev !== null && frame === prev) return frame
      prev = frame
      yield* Effect.sleep(interval)
    }
    return yield* new TmuxError({
      op: "wait-stable", message: `画面 ${attempts} 帧内未稳定：${target}`, exitCode: null, stderr: "",
    })
  })

/** 投递流水线（设计文档 §五）：稳定检测 → 消毒 → bracketed paste → 停 150ms → Enter。
 * 150ms：否则 \e[201~ 与 \r 合并进同一次 tty read，回车被当粘贴内容（kobe 实测）。 */
export const deliverPrompt = (
  tmux: TmuxServiceShape, target: string, text: string, opts?: DeliveryOpts,
): Effect.Effect<void, TmuxError> =>
  Effect.gen(function* () {
    yield* waitStable(tmux, target, opts)
    const clean = sanitizePromptForPty(text)
    if (clean === "") return
    yield* tmux.pasteText(target, clean)
    yield* Effect.sleep(opts?.enterDelayMs ?? 150)
    yield* tmux.sendKey(target, "Enter")
  })
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server/test/delivery.test.ts` → PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tmux/sanitize.ts packages/server/src/tmux/delivery.ts packages/server/test/delivery.test.ts
git commit -m "feat(server): prompt sanitization + stability detection + delivery pipeline"
```

---

### Task 6: TabsRepo（tabs 表 CRUD，tab 事件与写库同事务）

tabs 表 m0001 已建（`id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data`），本任务给它配 repo。同时落实 ledger carry-over「single-txn mutation+emit」的 repo 侧机制：把 `events` 行的插入抽成可复用的 `appendEventRow(db, e)`，TabsRepo 的每个变更方法在**同一个 `db.transaction`** 里写 tabs 行 + events 行，commit 后才向 bus 广播（回滚时最多丢一次广播，绝不出现「事件在库里但数据不在」或反之）。

**Files:**
- Modify: `packages/server/src/repo/events.ts`（抽出 `appendEventRow`）
- Create: `packages/server/src/repo/tabs.ts`
- Test: `packages/server/test/tabs-repo.test.ts`

**Interfaces:**
- Consumes: `Db`（Plan 1）、`EventsBus`/`EVENT_CHANNEL`（Plan 2）、`Tab/TabKind/TabStatus`（Task 2）、`NotFoundError`（repo/errors.ts）。
- Produces:
  - `appendEventRow(db: Database.Database, e: { workspaceId: string | null; type: string; payload: unknown }): CoolieEvent`（**只写库不广播**，供事务内复用；EventsRepo.append 改为「appendEventRow + 广播」，行为不变）
  - `TabsRepoShape`：
    - `insert(t: { workspaceId: string; kind: TabKind; engineId?: string; engineSessionId?: string; tmuxWindow?: number; title?: string }): Effect<Tab>` — status 初始 `"idle"`；同事务发 `tab.created`
    - `get(id): Effect<Tab, NotFoundError>`
    - `listByWorkspace(workspaceId): Effect<Tab[]>`
    - `findEngineTab(workspaceId): Effect<Tab | null>`（第一个 kind=engine 的 tab）
    - `setStatus(id, status: TabStatus, source: "hook" | "poller"): Effect<Tab, NotFoundError>` — 同值 no-op 不发事件；变更同事务发 `tab.status.changed`
    - `setTitle(id, title: string): Effect<void, NotFoundError>` — 同事务发 `tab.title.changed`
    - `touchHookAt(id, ts: number): Effect<void, NotFoundError>` — 写 `data.lastHookAt`（无事件）
    - `listEngineTabs(): Effect<Array<{ tab: Tab; workspacePath: string }>>` — join workspaces，只取 `status='active'` 的 engine tab（Task 9 poller 用）
    - `removeByWorkspace(workspaceId): Effect<void>`
  - `TabsRepo`（Context.Tag）、`TabsRepoLive: Layer<TabsRepo, never, Db>`（EventsBus 经 `Effect.serviceOption` 可选）

- [ ] **Step 1: 写失败测试**

`packages/server/test/tabs-repo.test.ts`：
```ts
import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Layer, Exit } from "effect"
import Database from "better-sqlite3"
import { EventEmitter } from "node:events"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { EventsBus, EVENT_CHANNEL } from "../src/events/bus.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"

let db: Database.Database
let bus: EventEmitter
let live: Array<{ type: string; payload: any }>

beforeEach(() => {
  db = new Database(":memory:"); runMigrations(db)
  db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)`).run()
  db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
    VALUES ('w1','p1','usa-zion','/tmp/ws1','coolie/a','main','r','active',0,1,NULL,'{}')`).run()
  bus = new EventEmitter()
  live = []
  bus.on(EVENT_CHANNEL, (e: any) => live.push({ type: e.type, payload: e.payload }))
})

const layer = () => TabsRepoLive.pipe(
  Layer.provide(Layer.succeed(Db, db)),
  Layer.provide(Layer.succeed(EventsBus, bus)),
)
const run = <A, E>(eff: Effect.Effect<A, E, TabsRepo>) => Effect.runPromise(Effect.provide(eff, layer()))
const eventRows = () => db.prepare("SELECT type, payload FROM events ORDER BY seq").all() as Array<{ type: string; payload: string }>

describe("TabsRepo", () => {
  it("insert writes the row AND the tab.created event in one transaction, then broadcasts", async () => {
    const tab = await run(Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "s-1", tmuxWindow: 0 })
    }))
    expect(tab.status).toBe("idle")
    expect(tab.engineSessionId).toBe("s-1")
    const evs = eventRows()
    expect(evs.map((e) => e.type)).toContain("tab.created")
    expect(JSON.parse(evs.find((e) => e.type === "tab.created")!.payload).tabId).toBe(tab.id)
    expect(live.map((e) => e.type)).toContain("tab.created")
  })

  it("setStatus emits tab.status.changed once; same value is a no-op", async () => {
    const tab = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      const t = yield* repo.insert({ workspaceId: "w1", kind: "engine", engineId: "claude" })
      yield* repo.setStatus(t.id, "working", "hook")
      yield* repo.setStatus(t.id, "working", "hook") // no-op
      return yield* repo.get(t.id)
    }))
    expect(tab.status).toBe("working")
    expect(eventRows().filter((e) => e.type === "tab.status.changed")).toHaveLength(1)
    const p = JSON.parse(eventRows().find((e) => e.type === "tab.status.changed")!.payload)
    expect(p).toMatchObject({ status: "working", source: "hook" })
  })

  it("setTitle + touchHookAt round-trip", async () => {
    const tab = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      const t = yield* repo.insert({ workspaceId: "w1", kind: "engine" })
      yield* repo.setTitle(t.id, "Fix the login bug")
      yield* repo.touchHookAt(t.id, 1234)
      return yield* repo.get(t.id)
    }))
    expect(tab.title).toBe("Fix the login bug")
    expect(tab.lastHookAt).toBe(1234)
    expect(eventRows().map((e) => e.type)).toContain("tab.title.changed")
  })

  it("findEngineTab returns the engine tab, null when absent", async () => {
    const found = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      yield* repo.insert({ workspaceId: "w1", kind: "shell" })
      const none = yield* repo.findEngineTab("w1")
      yield* repo.insert({ workspaceId: "w1", kind: "engine", engineId: "claude" })
      const some = yield* repo.findEngineTab("w1")
      return { none, some }
    }))
    expect(found.none).toBeNull()
    expect(found.some?.kind).toBe("engine")
  })

  it("listEngineTabs joins active workspaces only", async () => {
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w2','p1','usa-arches','/tmp/ws2','coolie/b','main','r','archived',0,1,NULL,'{}')`).run()
    const rows = await run(Effect.gen(function* () {
      const repo = yield* TabsRepo
      yield* repo.insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "s-a" })
      yield* repo.insert({ workspaceId: "w2", kind: "engine", engineId: "claude", engineSessionId: "s-b" })
      return yield* repo.listEngineTabs()
    }))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.workspacePath).toBe("/tmp/ws1")
  })

  it("removeByWorkspace deletes all tabs; get then fails NotFound", async () => {
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      const repo = yield* TabsRepo
      const t = yield* repo.insert({ workspaceId: "w1", kind: "engine" })
      yield* repo.removeByWorkspace("w1")
      return yield* repo.get(t.id)
    }), layer()))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/tabs-repo.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`packages/server/src/repo/events.ts` 全文替换（行为不变，抽出 `appendEventRow`）：
```ts
import { Context, Effect, Layer, Option } from "effect"
import type Database from "better-sqlite3"
import type { CoolieEvent } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"

/** 只写 events 行、不广播——供各 repo 在自己的 db.transaction 里复用（写库与事件原子）。 */
export const appendEventRow = (
  db: Database.Database,
  e: { workspaceId: string | null; type: string; payload: unknown },
): CoolieEvent => {
  const ts = Date.now()
  const res = db
    .prepare("INSERT INTO events (workspace_id, type, payload, ts) VALUES (?,?,?,?)")
    .run(e.workspaceId, e.type, JSON.stringify(e.payload ?? null), ts)
  return { seq: Number(res.lastInsertRowid), workspaceId: e.workspaceId, type: e.type, payload: e.payload ?? null, ts }
}

export interface EventsRepoShape {
  readonly append: (e: { workspaceId: string | null; type: string; payload: unknown }) => Effect.Effect<number>
  readonly listAfter: (opts: { after: number; limit?: number; workspaceId?: string }) => Effect.Effect<CoolieEvent[]>
}
export class EventsRepo extends Context.Tag("EventsRepo")<EventsRepo, EventsRepoShape>() {}

export const EventsRepoLive = Layer.effect(
  EventsRepo,
  Effect.gen(function* () {
    const db = yield* Db
    const bus = yield* Effect.serviceOption(EventsBus)
    return {
      append: (e) => Effect.sync(() => {
        const ev = appendEventRow(db, e)
        if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, ev)
        return ev.seq
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

`packages/server/src/repo/tabs.ts`：
```ts
import { Context, Effect, Layer, Option } from "effect"
import { ulid } from "ulid"
import { Tab, type TabKind, type TabStatus, type CoolieEvent } from "@coolie/protocol"
import { Db } from "../db/sqlite.js"
import { NotFoundError } from "./errors.js"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { appendEventRow } from "./events.js"

const rowToTab = (r: any): Tab => {
  let data: any = {}
  try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 坏 JSON 视为无 data */ }
  return new Tab({
    id: r.id, workspaceId: r.workspace_id, kind: r.kind as TabKind,
    engineId: r.engine_id ?? null, engineSessionId: r.engine_session_id ?? null,
    tmuxWindow: r.tmux_window ?? null, title: r.title ?? null,
    status: (r.status ?? "idle") as TabStatus,
    lastHookAt: typeof data.lastHookAt === "number" ? data.lastHookAt : null,
  })
}

export interface TabsRepoShape {
  readonly insert: (t: {
    workspaceId: string; kind: TabKind
    engineId?: string; engineSessionId?: string; tmuxWindow?: number; title?: string
  }) => Effect.Effect<Tab>
  readonly get: (id: string) => Effect.Effect<Tab, NotFoundError>
  readonly listByWorkspace: (workspaceId: string) => Effect.Effect<Tab[]>
  readonly findEngineTab: (workspaceId: string) => Effect.Effect<Tab | null>
  readonly setStatus: (id: string, status: TabStatus, source: "hook" | "poller") => Effect.Effect<Tab, NotFoundError>
  readonly setTitle: (id: string, title: string) => Effect.Effect<void, NotFoundError>
  readonly touchHookAt: (id: string, ts: number) => Effect.Effect<void, NotFoundError>
  readonly listEngineTabs: () => Effect.Effect<Array<{ tab: Tab; workspacePath: string }>>
  readonly removeByWorkspace: (workspaceId: string) => Effect.Effect<void>
}
export class TabsRepo extends Context.Tag("TabsRepo")<TabsRepo, TabsRepoShape>() {}

export const TabsRepoLive = Layer.effect(
  TabsRepo,
  Effect.gen(function* () {
    const db = yield* Db
    const bus = yield* Effect.serviceOption(EventsBus)
    const broadcast = (ev: CoolieEvent): void => { if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, ev) }
    const getRow = (id: string): any => db.prepare("SELECT * FROM tabs WHERE id = ?").get(id)
    const mustGetRow = (id: string) => Effect.gen(function* () {
      const r = getRow(id)
      if (!r) return yield* new NotFoundError({ message: `tab 不存在：${id}` })
      return r
    })

    return {
      insert: (t) => Effect.sync(() => {
        const id = ulid()
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare(`INSERT INTO tabs (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
            VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(id, t.workspaceId, t.kind, t.engineId ?? null, t.engineSessionId ?? null,
              t.tmuxWindow ?? null, t.title ?? null, "idle", "{}")
          ev = appendEventRow(db, {
            workspaceId: t.workspaceId, type: "tab.created",
            payload: { tabId: id, kind: t.kind, engineId: t.engineId ?? null, tmuxWindow: t.tmuxWindow ?? null },
          })
        })()
        broadcast(ev)
        return rowToTab(getRow(id))
      }),
      get: (id) => mustGetRow(id).pipe(Effect.map(rowToTab)),
      listByWorkspace: (wsId) => Effect.sync(() =>
        db.prepare("SELECT * FROM tabs WHERE workspace_id = ? ORDER BY tmux_window, id").all(wsId).map(rowToTab)),
      findEngineTab: (wsId) => Effect.sync(() => {
        const r = db.prepare("SELECT * FROM tabs WHERE workspace_id = ? AND kind = 'engine' ORDER BY id LIMIT 1").get(wsId)
        return r ? rowToTab(r) : null
      }),
      setStatus: (id, status, source) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        if (r.status === status) return rowToTab(r) // 同值 no-op：不写库不发事件
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE tabs SET status = ? WHERE id = ?").run(status, id)
          ev = appendEventRow(db, {
            workspaceId: r.workspace_id, type: "tab.status.changed", payload: { tabId: id, status, source },
          })
        })()
        broadcast(ev)
        return rowToTab(getRow(id))
      }),
      setTitle: (id, title) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("UPDATE tabs SET title = ? WHERE id = ?").run(title, id)
          ev = appendEventRow(db, { workspaceId: r.workspace_id, type: "tab.title.changed", payload: { tabId: id, title } })
        })()
        broadcast(ev)
      }),
      touchHookAt: (id, ts) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let data: any = {}
        try { data = r.data ? JSON.parse(r.data) : {} } catch { /* 重建 */ }
        data.lastHookAt = ts
        db.prepare("UPDATE tabs SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
      }),
      listEngineTabs: () => Effect.sync(() =>
        (db.prepare(`SELECT t.*, w.path AS ws_path FROM tabs t
          JOIN workspaces w ON w.id = t.workspace_id
          WHERE t.kind = 'engine' AND w.status = 'active'`).all() as any[])
          .map((r) => ({ tab: rowToTab(r), workspacePath: r.ws_path as string }))),
      removeByWorkspace: (wsId) => Effect.sync(() => {
        db.prepare("DELETE FROM tabs WHERE workspace_id = ?").run(wsId)
      }),
    }
  }),
)
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server/test/tabs-repo.test.ts packages/server/test/events.test.ts packages/server/test/sse.test.ts` → 全 PASS（events/sse 回归确认 append 重构无行为变化）；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repo/events.ts packages/server/src/repo/tabs.ts packages/server/test/tabs-repo.test.ts
git commit -m "feat(server): TabsRepo with transactional tab events"
```

---

### Task 7: Engine 抽象 + claude adapter（identity / launchCommand / 二进制发现 / historyReader）

Engine 接口一步到位（设计文档 §六 六件套裁剪版），M1 只有 claude 实现。promptDelivery 件由 Task 5 的通用流水线承担（engine 无需覆盖，M1）；hooksAdapter 件在 Task 8。codex（M2）的「服务端造 id 需先启动后回填」差异由 `newSessionId()` 的函数形态预留（claude 客户端造 id，codex 实现时可返回占位再回填 tabs.engine_session_id）。

**Files:**
- Create: `packages/server/src/engine/types.ts`
- Create: `packages/server/src/engine/registry.ts`
- Create: `packages/server/src/engine/claude/binary.ts`
- Create: `packages/server/src/engine/claude/transcript.ts`
- Create: `packages/server/src/engine/claude/adapter.ts`
- Test: `packages/server/test/engine-claude.test.ts`

**Interfaces:**
- Consumes: `TabStatus`（Task 2）。
- Produces:
  - `interface EngineCapabilities { nativeQueue: boolean; midSessionModelSwitch: boolean; resume: boolean; hooks: boolean; effort: boolean }`（能力位缺失 = Noop 降级，调用方必须 guard，UI 禁止硬编码 vendor 字符串）
  - `interface Engine { id: string; displayName: string; capabilities: EngineCapabilities; terminalTitle: "engine-owned" | "none"; newSessionId(): string; launchCommand(opts: { sessionId: string; model?: string; effort?: string }): string[]; statusFromHookEvent(evt: unknown): TabStatus | null; transcriptPath(opts: { home: string; cwd: string; sessionId: string }): string; deriveTitle(jsonl: string): string | null; resumeArgs(sessionId: string): string[] }`
  - `class EngineError extends Data.TaggedError("EngineError")<{ message: string }>`
  - `EngineRegistry`（Context.Tag，值 `ReadonlyMap<string, Engine>`）、`EngineRegistryLive`（只注册 claude）
  - `claudeEngine: Engine`；`discoverClaudeBinary(opts?): string | null`；`encodeCwd(cwd): string`；`transcriptPath(home, cwd, sessionId): string`；`deriveTitle(jsonl): string | null`；`resumeArgs(sessionId): string[]`
  - launchCommand 行为契约：环境变量 `COOLIE_CLAUDE_CMD` 非空 → 按空白切分**原样使用，不追加任何 flag**（用户覆盖 + 测试 seam，kobe engineCommand 同款）；否则 `[<发现的绝对路径|"claude">, "--session-id", <sessionId>]` + 可选 `["--model", model]`；effort 被 claude 忽略（capability=false）

- [ ] **Step 1: 写失败测试**

`packages/server/test/engine-claude.test.ts`：
```ts
import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { claudeEngine } from "../src/engine/claude/adapter.js"
import { discoverClaudeBinary } from "../src/engine/claude/binary.js"
import { encodeCwd, transcriptPath, deriveTitle, resumeArgs } from "../src/engine/claude/transcript.js"
import { EngineRegistryLive, EngineRegistry } from "../src/engine/registry.js"
import { Effect } from "effect"

afterEach(() => { delete process.env.COOLIE_CLAUDE_CMD; delete process.env.COOLIE_CLAUDE_BIN })

describe("claude identity/capabilities", () => {
  it("registry holds claude with expected capability bits", async () => {
    const reg = await Effect.runPromise(EngineRegistry.pipe(Effect.provide(EngineRegistryLive)))
    const e = reg.get("claude")!
    expect(e.displayName).toBe("Claude Code")
    expect(e.capabilities).toEqual({ nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: true, effort: false })
    expect(e.terminalTitle).toBe("engine-owned") // claude 自己管 OSC title（kobe: ownsStatus）
  })
  it("newSessionId is a fresh uuid each time", () => {
    const a = claudeEngine.newSessionId(); const b = claudeEngine.newSessionId()
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})

describe("launchCommand pipeline", () => {
  it("default: [bin, --session-id, id] (+ --model)", () => {
    const cmd = claudeEngine.launchCommand({ sessionId: "abc-123", model: "opus" })
    expect(cmd[0]!.endsWith("claude")).toBe(true)
    expect(cmd).toContain("--session-id")
    expect(cmd[cmd.indexOf("--session-id") + 1]).toBe("abc-123")
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("opus")
  })
  it("COOLIE_CLAUDE_CMD override is verbatim (no flags appended)", () => {
    process.env.COOLIE_CLAUDE_CMD = "cat"
    expect(claudeEngine.launchCommand({ sessionId: "abc" })).toEqual(["cat"])
  })
})

describe("binary discovery（opcode 路线，注入探针）", () => {
  it("COOLIE_CLAUDE_BIN wins when executable", () => {
    expect(discoverClaudeBinary({
      env: { COOLIE_CLAUDE_BIN: "/custom/claude" },
      probe: (p) => p === "/custom/claude",
      which: () => null,
    })).toBe("/custom/claude")
  })
  it("falls back which → standard candidates → null", () => {
    expect(discoverClaudeBinary({ env: {}, probe: () => false, which: () => "/from/which/claude" })).toBeNull()
    expect(discoverClaudeBinary({ env: {}, probe: (p) => p === "/from/which/claude", which: () => "/from/which/claude" }))
      .toBe("/from/which/claude")
    const local = path.join(os.homedir(), ".local", "bin", "claude")
    expect(discoverClaudeBinary({ env: {}, probe: (p) => p === local, which: () => null })).toBe(local)
  })
})

describe("historyReader（转录）", () => {
  it("encodeCwd folds every non-alphanumeric to '-'（实测 claude 编码）", () => {
    expect(encodeCwd("/Users/x/personal_ai/Coolie")).toBe("-Users-x-personal-ai-Coolie")
    expect(encodeCwd("/tmp/a.b")).toBe("-tmp-a-b")
  })
  it("transcriptPath = <home>/projects/<encoded>/<sessionId>.jsonl", () => {
    expect(transcriptPath("/h/.claude", "/tmp/ws", "s-1")).toBe("/h/.claude/projects/-tmp-ws/s-1.jsonl")
  })
  it("deriveTitle: first user message, string content", () => {
    const jsonl = [
      JSON.stringify({ type: "queue-operation", sessionId: "s" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Fix the login bug please" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "second message" } }),
    ].join("\n")
    expect(deriveTitle(jsonl)).toBe("Fix the login bug please")
  })
  it("deriveTitle: block-array content + command-tag stripping + 60-char cap", () => {
    const long = "x".repeat(80)
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `<command-name>/go</command-name> ${long}` }] } }),
    ].join("\n")
    const t = deriveTitle(jsonl)!
    expect(t.startsWith("x")).toBe(true)
    expect(t.length).toBe(60)
  })
  it("deriveTitle: empty/corrupt → null", () => {
    expect(deriveTitle("")).toBeNull()
    expect(deriveTitle("not-json\n{\"type\":\"summary\"}")).toBeNull()
  })
  it("resumeArgs", () => {
    expect(resumeArgs("s-9")).toEqual(["--resume", "s-9"])
  })
})

describe("turnDetector hook mapping（结构化状态唯一来源）", () => {
  it.each([
    ["UserPromptSubmit", "working"],
    ["PreToolUse", "working"],
    ["PostToolUse", "working"],
    ["Stop", "awaiting-input"],
    ["Notification", "awaiting-input"],
    ["SessionEnd", "idle"],
  ] as const)("%s → %s", (name, status) => {
    expect(claudeEngine.statusFromHookEvent({ hook_event_name: name })).toBe(status)
  })
  it("unknown/malformed → null", () => {
    expect(claudeEngine.statusFromHookEvent({ hook_event_name: "SubagentStop" })).toBeNull()
    expect(claudeEngine.statusFromHookEvent({})).toBeNull()
    expect(claudeEngine.statusFromHookEvent("garbage")).toBeNull()
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/engine-claude.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`packages/server/src/engine/types.ts`：
```ts
import type { TabStatus } from "@coolie/protocol"

/** 能力位（kobe registry 六件套裁剪版）：缺失能力 = Noop 降级，调用方必须 guard；UI 禁止硬编码 vendor 字符串。 */
export interface EngineCapabilities {
  /** engine TUI 原生支持 mid-turn 排队（claude ✓）——无此能力的 engine 走 server 端 queue（M2） */
  readonly nativeQueue: boolean
  readonly midSessionModelSwitch: boolean
  readonly resume: boolean
  readonly hooks: boolean
  /** reasoning effort 参数（codex ✓ / claude ✗） */
  readonly effort: boolean
}

export interface Engine {
  readonly id: string
  readonly displayName: string
  readonly capabilities: EngineCapabilities
  /** claude 自己写 OSC title（ownsStatus）→ "engine-owned"；无 title 行为的 engine → "none" */
  readonly terminalTitle: "engine-owned" | "none"
  /** 会话 id 生命周期差异进抽象（codex M2：服务端造 id 需先启动后回填——函数形态预留） */
  readonly newSessionId: () => string
  readonly launchCommand: (opts: { readonly sessionId: string; readonly model?: string; readonly effort?: string }) => string[]
  /** hook 事件 → tab 状态；未知事件返回 null（turnDetector 主路径） */
  readonly statusFromHookEvent: (evt: unknown) => TabStatus | null
  /** historyReader：engine 自己的转录文件位置（home = engine 数据目录，claude 为 ~/.claude） */
  readonly transcriptPath: (opts: { readonly home: string; readonly cwd: string; readonly sessionId: string }) => string
  readonly deriveTitle: (jsonl: string) => string | null
  readonly resumeArgs: (sessionId: string) => string[]
}
```

`packages/server/src/engine/claude/binary.ts`：
```ts
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

/**
 * claude 二进制多路径发现（opcode claude_binary.rs 路线，GUI 进程 PATH 极简的解药）：
 * COOLIE_CLAUDE_BIN 显式指定 > which > 标准安装位置（~/.local/bin、~/.claude/local、homebrew、nvm）。
 * 找不到返回 null，调用方降级用裸 "claude"（依赖 PATH）并由 doctor 提示。
 */
export const discoverClaudeBinary = (opts?: {
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: (p: string) => boolean
  readonly which?: () => string | null
}): string | null => {
  const env = opts?.env ?? process.env
  const probe = opts?.probe ?? ((p: string) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false }
  })
  const which = opts?.which ?? (() => {
    try { return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null } catch { return null }
  })
  const explicit = env.COOLIE_CLAUDE_BIN
  if (explicit && probe(explicit)) return explicit
  const w = which()
  if (w && probe(w)) return w
  const home = os.homedir()
  const candidates = [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]
  const nvm = path.join(home, ".nvm", "versions", "node")
  try { for (const v of fs.readdirSync(nvm)) candidates.push(path.join(nvm, v, "bin", "claude")) } catch { /* 无 nvm */ }
  for (const c of candidates) if (probe(c)) return c
  return null
}
```

`packages/server/src/engine/claude/transcript.ts`：
```ts
import * as path from "node:path"

/** claude 转录目录编码：cwd 每个非字母数字字符折叠为 '-'（本机实测：/a/b_c.d → -a-b-c-d）。 */
export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-")

export const transcriptPath = (home: string, cwd: string, sessionId: string): string =>
  path.join(home, "projects", encodeCwd(cwd), `${sessionId}.jsonl`)

/** 派生标题：首条 type=user 的 message.content（string 或 text blocks），剥 <tag>…</tag>，60 字截断。 */
export const deriveTitle = (jsonl: string): string | null => {
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type !== "user") continue
    const content = obj?.message?.content
    let text = ""
    if (typeof content === "string") text = content
    else if (Array.isArray(content)) text = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join(" ")
    text = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    if (text === "") continue
    return text.length > 60 ? text.slice(0, 60) : text
  }
  return null
}

export const resumeArgs = (sessionId: string): string[] => ["--resume", sessionId]
```

`packages/server/src/engine/claude/adapter.ts`：
```ts
import { randomUUID } from "node:crypto"
import type { TabStatus } from "@coolie/protocol"
import type { Engine } from "../types.js"
import { discoverClaudeBinary } from "./binary.js"
import { encodeCwd, transcriptPath, deriveTitle, resumeArgs } from "./transcript.js"

const HOOK_STATUS: Record<string, TabStatus> = {
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "awaiting-input",
  Notification: "awaiting-input",
  SessionEnd: "idle",
}

export const claudeEngine: Engine = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: { nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: true, effort: false },
  terminalTitle: "engine-owned",
  newSessionId: () => randomUUID(),
  launchCommand: ({ sessionId, model }) => {
    // 用户/测试覆盖 seam（kobe engineCommand.<vendor> 同款）：原样使用，绝不追加 flag
    const override = (process.env.COOLIE_CLAUDE_CMD ?? "").trim()
    if (override !== "") return override.split(/\s+/)
    const bin = discoverClaudeBinary() ?? "claude"
    const args = [bin, "--session-id", sessionId]
    if (model) args.push("--model", model)
    return args // effort：claude 无此参数（capabilities.effort=false，Noop 降级）
  },
  statusFromHookEvent: (evt) => {
    const name = (evt as any)?.hook_event_name
    return typeof name === "string" ? HOOK_STATUS[name] ?? null : null
  },
  transcriptPath: ({ home, cwd, sessionId }) => transcriptPath(home, cwd, sessionId),
  deriveTitle,
  resumeArgs,
}
export { encodeCwd }
```

`packages/server/src/engine/registry.ts`：
```ts
import { Context, Data, Effect, Layer } from "effect"
import type { Engine } from "./types.js"
import { claudeEngine } from "./claude/adapter.js"

export class EngineError extends Data.TaggedError("EngineError")<{ readonly message: string }> {}

export class EngineRegistry extends Context.Tag("EngineRegistry")<EngineRegistry, ReadonlyMap<string, Engine>>() {}

export const EngineRegistryLive = Layer.sync(EngineRegistry, () => new Map<string, Engine>([[claudeEngine.id, claudeEngine]]))

export const getEngine = (reg: ReadonlyMap<string, Engine>, id: string): Effect.Effect<Engine, EngineError> => {
  const e = reg.get(id)
  return e ? Effect.succeed(e) : Effect.fail(new EngineError({ message: `engine 未注册：${id}` }))
}
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server/test/engine-claude.test.ts` → PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engine packages/server/test/engine-claude.test.ts
git commit -m "feat(engines): engine abstraction + claude adapter (identity/launch/binary/history)"
```

---

### Task 8: hooksAdapter 注入 + `POST /hooks/claude` 端点 + 标题派生

hook 链路：claude 触发 hook → 我们注入的命令 `COOLIE_WORKSPACE=<id> sh <COOLIE_HOME>/hooks/claude-hook.sh` → 脚本读 `server.json` 拿 port/token → `curl POST /hooks/claude?workspace=<id>`（stdin 的 hook JSON 直转）→ server 把事件映射为 tab 状态 + events。纪律（kobe）：脚本绝不拉起 server、失败静默、永远 exit 0。注入目标是 worktree 级 `.claude/settings.local.json`（幂等 merge，保留用户已有 hooks），并把该文件加进 `.git/info/exclude` 防脏树。

**Files:**
- Create: `packages/server/src/engine/claude/hooks.ts`
- Modify: `packages/server/src/http/app.ts`（+`POST /hooks/claude`、+`GET /workspaces/:id/tabs`、AppServices 扩容、AppDeps +claudeHome）
- Test: `packages/server/test/hooks-endpoint.test.ts`

**Interfaces:**
- Consumes: `TabsRepo`（Task 6）、`claudeEngine/EngineRegistry`（Task 7）、`injectInfoExclude`（Plan 2 include.ts，签名 `(repoRoot: string, entry?: string) => void`）、`WorkspacesRepo/EventsRepo`。
- Produces:
  - `hookScriptPath(home: string): string`（`<home>/hooks/claude-hook.sh`）
  - `ensureHookScript(home: string): string` — 写脚本（0755）并返回路径；幂等重写
  - `injectClaudeHooks(opts: { worktreePath: string; workspaceId: string; scriptPath: string }): void` — 幂等 merge 进 `<worktree>/.claude/settings.local.json` 的 `hooks.{UserPromptSubmit,Stop,Notification,SessionEnd}`
  - `hooksDisabled(env?): boolean`（`COOLIE_DISABLE_HOOKS === "1"`，opt-out）
  - `HOOK_EVENTS: readonly ["UserPromptSubmit","Stop","Notification","SessionEnd"]`
  - HTTP 行为契约：`POST /hooks/claude?workspace=<id>`（token 必需）→ 缺 workspace param → 400；找不到 engine tab → `200 {ok:true}`（hook 永远成功语义）；否则 touchHookAt + statusFromHookEvent→setStatus(source:"hook") + 事件映射（UserPromptSubmit→`engine.turn.started`、Stop→`engine.turn.finished`、Notification→`engine.notification`、SessionEnd→`engine.session.ended`）；Stop 且 tab.title 为 null 时读转录 deriveTitle→setTitle（读不到静默跳过）。`GET /workspaces/:id/tabs` → 200 Tab[]
  - `AppServices` 扩为 `ProjectsRepo | EventsRepo | WorkspacesRepo | WorkspaceLifecycle | TabsRepo | EngineRegistry`；`AppDeps` 增 `claudeHome?: string`

- [ ] **Step 1: 写失败测试**

`packages/server/test/hooks-endpoint.test.ts`：
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
import { ensureHookScript, injectClaudeHooks, hookScriptPath, hooksDisabled } from "../src/engine/claude/hooks.js"
import { encodeCwd } from "../src/engine/claude/adapter.js"
import { createApp, newToken } from "../src/http/app.js"

describe("hook script + settings injection（纯 fs）", () => {
  let home: string, worktree: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hooks-home-"))
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hooks-wt-"))
  })

  it("ensureHookScript writes an executable sh forwarder that always exits 0", () => {
    const p = ensureHookScript(home)
    expect(p).toBe(hookScriptPath(home))
    const st = fs.statSync(p)
    expect(st.mode & 0o111).not.toBe(0)
    const body = fs.readFileSync(p, "utf8")
    expect(body).toContain("/hooks/claude?workspace=$COOLIE_WORKSPACE")
    expect(body.trim().endsWith("exit 0")).toBe(true)
    expect(body).toContain(`${home}/server.json`)
  })

  it("injectClaudeHooks is idempotent and preserves foreign hooks", () => {
    const script = ensureHookScript(home)
    const file = path.join(worktree, ".claude", "settings.local.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook" }] }] }, other: 1 }))
    injectClaudeHooks({ worktreePath: worktree, workspaceId: "w1", scriptPath: script })
    injectClaudeHooks({ worktreePath: worktree, workspaceId: "w1", scriptPath: script }) // 幂等
    const s = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(s.other).toBe(1)
    const stopCmds = s.hooks.Stop.flatMap((e: any) => e.hooks.map((h: any) => h.command))
    expect(stopCmds.filter((c: string) => c.includes(script))).toHaveLength(1) // 只有一条 coolie 条目
    expect(stopCmds).toContain("my-own-hook")                                   // 用户 hook 保留
    for (const evt of ["UserPromptSubmit", "Stop", "Notification", "SessionEnd"]) expect(s.hooks[evt]).toBeDefined()
    expect(stopCmds.find((c: string) => c.includes(script))).toContain("COOLIE_WORKSPACE=w1")
  })

  it("hooksDisabled honors COOLIE_DISABLE_HOOKS=1", () => {
    expect(hooksDisabled({ COOLIE_DISABLE_HOOKS: "1" })).toBe(true)
    expect(hooksDisabled({})).toBe(false)
  })
})

describe("POST /hooks/claude endpoint", () => {
  let server: http.Server, base: string, token: string, db: Database.Database
  let claudeHome: string, wsPath: string, tabId: string
  const SESSION_ID = "11111111-2222-4333-8444-555555555555"

  beforeEach(async () => {
    db = new Database(":memory:"); runMigrations(db)
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-claude-home-"))
    wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hooks-ws-"))
    db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)`).run()
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w1','p1','usa-zion',?,'coolie/a','main','r','active',0,1,NULL,'{}')`).run(wsPath)
    const layer = Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive, EngineRegistryLive)
      .pipe(Layer.provide(Layer.succeed(Db, db)))
    const runtime = (eff: any) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, never, never>)
    tabId = (await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: SESSION_ID, tmuxWindow: 0 })
    }), layer) as Effect.Effect<any, never, never>)).id
    token = newToken()
    server = http.createServer(createApp({ runtime, token, onShutdown: () => {}, claudeHome }))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => server.close())

  const post = (qs: string, body: unknown) => fetch(`${base}/hooks/claude${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const tabRow = () => db.prepare("SELECT * FROM tabs WHERE id = ?").get(tabId) as any
  const eventTypes = () => (db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type)

  it("UserPromptSubmit → status working + engine.turn.started + lastHookAt", async () => {
    const r = await post("?workspace=w1", { hook_event_name: "UserPromptSubmit", session_id: SESSION_ID })
    expect(r.status).toBe(200)
    expect(tabRow().status).toBe("working")
    expect(JSON.parse(tabRow().data).lastHookAt).toBeGreaterThan(0)
    expect(eventTypes()).toContain("engine.turn.started")
  })

  it("Stop → awaiting-input + engine.turn.finished + 转录标题派生", async () => {
    const dir = path.join(claudeHome, "projects", encodeCwd(wsPath))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`),
      JSON.stringify({ type: "user", message: { role: "user", content: "Summarize this repo" } }) + "\n")
    await post("?workspace=w1", { hook_event_name: "Stop", session_id: SESSION_ID })
    expect(tabRow().status).toBe("awaiting-input")
    expect(tabRow().title).toBe("Summarize this repo")
    expect(eventTypes()).toContain("engine.turn.finished")
    expect(eventTypes()).toContain("tab.title.changed")
  })

  it("missing workspace param → 400; unknown workspace → 200 ok（hook 永远成功）", async () => {
    expect((await post("", { hook_event_name: "Stop" })).status).toBe(400)
    const r = await post("?workspace=nope", { hook_event_name: "Stop" })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it("no token → 401", async () => {
    const r = await fetch(`${base}/hooks/claude?workspace=w1`, { method: "POST", body: "{}" })
    expect(r.status).toBe(401)
  })

  it("GET /workspaces/:id/tabs lists tabs", async () => {
    const r = await fetch(`${base}/workspaces/w1/tabs`, { headers: { Authorization: `Bearer ${token}` } })
    expect(r.status).toBe(200)
    const list = await r.json()
    expect(list).toHaveLength(1)
    expect(list[0].kind).toBe("engine")
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/hooks-endpoint.test.ts` → FAIL（hooks.ts 不存在；路由 404）。

- [ ] **Step 3: 实现**

`packages/server/src/engine/claude/hooks.ts`：
```ts
import * as fs from "node:fs"
import * as path from "node:path"

export const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "Notification", "SessionEnd"] as const

export const hookScriptPath = (home: string): string => path.join(home, "hooks", "claude-hook.sh")

/** hook 转发脚本（kobe hook-cmd 三铁律：绝不拉起 server、失败静默、永远 exit 0）。
 * 每次启动重写：home 变化/脚本升级自动生效。token/port 运行时从 server.json 读，脚本本身不含密钥。 */
export const ensureHookScript = (home: string): string => {
  const p = hookScriptPath(home)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const script = `#!/bin/sh
# Coolie claude hook forwarder（自动生成，勿手改）。
INFO="${home}/server.json"
[ -f "$INFO" ] || exit 0
PORT=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$INFO")
TOKEN=$(sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' "$INFO")
[ -n "$PORT" ] && [ -n "$TOKEN" ] || exit 0
curl -s -m 2 -X POST "http://127.0.0.1:$PORT/hooks/claude?workspace=$COOLIE_WORKSPACE" \\
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  --data-binary @- >/dev/null 2>&1
exit 0
`
  fs.writeFileSync(p, script, { mode: 0o755 })
  return p
}

export const hooksDisabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.COOLIE_DISABLE_HOOKS === "1"

/** 幂等注入 worktree 级 hooks（settings 层面）：
 * 先移除一切引用本脚本的旧条目再追加（wsId/脚本路径变更自动更新），用户自己的 hooks 原样保留。 */
export const injectClaudeHooks = (opts: {
  readonly worktreePath: string
  readonly workspaceId: string
  readonly scriptPath: string
}): void => {
  const dir = path.join(opts.worktreePath, ".claude")
  const file = path.join(dir, "settings.local.json")
  fs.mkdirSync(dir, { recursive: true })
  let settings: any = {}
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")) } catch { /* 无文件/坏 JSON → 重建 */ }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) settings = {}
  if (typeof settings.hooks !== "object" || settings.hooks === null) settings.hooks = {}
  const command = `COOLIE_WORKSPACE=${opts.workspaceId} sh ${opts.scriptPath}`
  for (const evt of HOOK_EVENTS) {
    const entries: any[] = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : []
    const kept = entries.filter((e) => !JSON.stringify(e).includes(opts.scriptPath))
    kept.push({ hooks: [{ type: "command", command }] })
    settings.hooks[evt] = kept
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")
}
```

`packages/server/src/http/app.ts` 修改（三处）：

(a) imports 与类型：
```ts
import * as fs from "node:fs"
import { TabsRepo } from "../repo/tabs.js"
import { EngineRegistry } from "../engine/registry.js"
```
```ts
export type AppServices = ProjectsRepo | EventsRepo | WorkspacesRepo | WorkspaceLifecycle | TabsRepo | EngineRegistry
```
`AppDeps` 增加一行：
```ts
  /** claude 转录根（标题派生用）；缺省跳过标题派生 */
  readonly claudeHome?: string
```
`createApp` 解构处加 `claudeHome`。

(b) 在 `GET /events` 分支之前插入 hooks 端点与 tabs 列表路由：
```ts
        if (route === "POST /hooks/claude") {
          const wsId = url.searchParams.get("workspace")
          if (!wsId) return err(res, 400, "Validation", "workspace query param required")
          const body = await readJson(req)
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const tabs = yield* TabsRepo
              const registry = yield* EngineRegistry
              const engine = registry.get("claude")
              const tab = engine ? yield* tabs.findEngineTab(wsId) : null
              if (!engine || !tab) return { ok: true } // hook 永远成功：无 tab（已归档/删除）静默吞掉
              yield* tabs.touchHookAt(tab.id, Date.now())
              const status = engine.statusFromHookEvent(body)
              if (status !== null) yield* tabs.setStatus(tab.id, status, "hook")
              const evtName = (body as any)?.hook_event_name
              const evType =
                evtName === "UserPromptSubmit" ? "engine.turn.started"
                : evtName === "Stop" ? "engine.turn.finished"
                : evtName === "Notification" ? "engine.notification"
                : evtName === "SessionEnd" ? "engine.session.ended" : null
              if (evType !== null)
                yield* (yield* EventsRepo).append({ workspaceId: wsId, type: evType, payload: { tabId: tab.id, sessionId: tab.engineSessionId } })
              // historyReader 兜底：首个 turn 完成且尚无标题 → 从转录派生
              if (evtName === "Stop" && tab.title === null && tab.engineSessionId !== null && claudeHome !== undefined) {
                const ws = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
                if (Option.isSome(ws)) {
                  const tp = engine.transcriptPath({ home: claudeHome, cwd: ws.value.path, sessionId: tab.engineSessionId })
                  const title = yield* Effect.sync(() => {
                    try { return engine.deriveTitle(fs.readFileSync(tp, "utf8")) } catch { return null }
                  })
                  if (title !== null) yield* tabs.setTitle(tab.id, title)
                }
              }
              return { ok: true }
            }),
            (r) => send(res, 200, r),
            onError,
          )
        }
        const tabsList = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs$/)
        if (req.method === "GET" && tabsList) {
          return await runRoute(
            res, runtime,
            Effect.gen(function* () { return yield* (yield* TabsRepo).listByWorkspace(tabsList[1]!) }),
            (list) => send(res, 200, list),
            onError,
          )
        }
```
（`Option` 已在 app.ts 顶部 import。`Effect.option` 把 NotFoundError 折成 `Option<Workspace>`。）

(c) `errorFromCause` 增加两行 `_tag` 映射（放 GitError 之后）：
```ts
    if (e._tag === "TmuxError") return { status: 500, body: { code: "TmuxError", message } }
    if (e._tag === "EngineError") return { status: 500, body: { code: "EngineError", message } }
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server/test/hooks-endpoint.test.ts packages/server/test/http.test.ts packages/server/test/http-workspaces.test.ts` → 全 PASS（既有 http 测试回归）；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engine/claude/hooks.ts packages/server/src/http/app.ts packages/server/test/hooks-endpoint.test.ts
git commit -m "feat(engines): claude hooks injection + /hooks/claude endpoint + title derivation"
```

---

### Task 9: 转录 mtime 轮询兜底（turnDetector 的第二信号源）

hooks 是主路径（准、实时）；mtime 轮询只在 hooks 沉默时兜底（用户 opt-out、注入失败、hook 链路断）。仲裁规则收敛成单一纯函数（agent-deck 教训：推导逻辑曾在 3 处重复实现后返工收敛）。

**Files:**
- Create: `packages/server/src/engine/monitor.ts`
- Test: `packages/server/test/monitor.test.ts`

**Interfaces:**
- Consumes: `TabStatus`/`Tab`（Task 2）、`Engine`（Task 7）、`TabsRepo.listEngineTabs/setStatus`（Task 6）。
- Produces:
  - 常量：`HOOK_AUTHORITY_MS = 600_000`、`ACTIVE_THRESHOLD_MS = 3_000`、`IDLE_THRESHOLD_MS = 30_000`
  - `decideStatusFromMtime(i: { nowMs: number; mtimeMs: number | null; lastHookAtMs: number | null; current: TabStatus }): TabStatus | null` — 纯决策：近 10 分钟有 hook 信号 → null（hooks 拥有状态）；无转录 → null；mtime ≤3s 新 → 非 working 时升 `"working"`；mtime ≥30s 旧且 current=working → 降 `"awaiting-input"`；其余 null
  - `pollOnce(deps: TranscriptPollerDeps): Promise<void>`、`startTranscriptPoller(deps, intervalMs=2000): () => void`（返回 stop；timer `unref` 不阻退出；异常吞掉——轮询失败绝不影响主流程）
  - `TranscriptPollerDeps = { listEngineTabs(): Promise<Array<{ tab: Tab; workspacePath: string }>>; statMtimeMs(p: string): number | null; setStatus(tabId: string, status: TabStatus): Promise<void>; engine: Engine; home: string; now?(): number }`

- [ ] **Step 1: 写失败测试**

`packages/server/test/monitor.test.ts`：
```ts
import { describe, it, expect } from "vitest"
import { Tab } from "@coolie/protocol"
import { decideStatusFromMtime, pollOnce, HOOK_AUTHORITY_MS, ACTIVE_THRESHOLD_MS, IDLE_THRESHOLD_MS } from "../src/engine/monitor.js"
import { claudeEngine } from "../src/engine/claude/adapter.js"

const NOW = 1_000_000_000

describe("decideStatusFromMtime（纯仲裁）", () => {
  it("hooks 近期有信号 → 让位（null），无论 mtime 多新", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW, lastHookAtMs: NOW - 5000, current: "idle" })).toBeNull()
  })
  it("hook 信号过期（>10min）→ mtime 接管", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - 1000, lastHookAtMs: NOW - HOOK_AUTHORITY_MS - 1, current: "idle" }))
      .toBe("working")
  })
  it("无转录 → null", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: null, lastHookAtMs: null, current: "working" })).toBeNull()
  })
  it("mtime 新鲜（≤3s）且非 working → working；已是 working → null（不重复写）", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - ACTIVE_THRESHOLD_MS, lastHookAtMs: null, current: "idle" })).toBe("working")
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - 1000, lastHookAtMs: null, current: "working" })).toBeNull()
  })
  it("mtime 陈旧（≥30s）且 working → awaiting-input；非 working → null", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - IDLE_THRESHOLD_MS, lastHookAtMs: null, current: "working" })).toBe("awaiting-input")
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - IDLE_THRESHOLD_MS, lastHookAtMs: null, current: "idle" })).toBeNull()
  })
  it("中间地带（3s < age < 30s）→ null（保持现状）", () => {
    expect(decideStatusFromMtime({ nowMs: NOW, mtimeMs: NOW - 10_000, lastHookAtMs: null, current: "working" })).toBeNull()
  })
})

describe("pollOnce（注入 fakes）", () => {
  const mkTab = (over: Partial<ConstructorParameters<typeof Tab>[0]> = {}) => new Tab({
    id: "t1", workspaceId: "w1", kind: "engine", engineId: "claude",
    engineSessionId: "s-1", tmuxWindow: 0, title: null, status: "idle", lastHookAt: null, ...over,
  })

  it("stats the engine transcript path and applies the decision", async () => {
    const statted: string[] = []
    const set: Array<[string, string]> = []
    await pollOnce({
      listEngineTabs: async () => [{ tab: mkTab(), workspacePath: "/tmp/wsx" }],
      statMtimeMs: (p) => { statted.push(p); return NOW - 1000 },
      setStatus: async (id, s) => { set.push([id, s]) },
      engine: claudeEngine, home: "/h/.claude", now: () => NOW,
    })
    expect(statted[0]).toBe(claudeEngine.transcriptPath({ home: "/h/.claude", cwd: "/tmp/wsx", sessionId: "s-1" }))
    expect(set).toEqual([["t1", "working"]])
  })

  it("skips tabs without engineSessionId and null decisions", async () => {
    const set: Array<[string, string]> = []
    await pollOnce({
      listEngineTabs: async () => [
        { tab: mkTab({ id: "t2", engineSessionId: null }), workspacePath: "/a" },
        { tab: mkTab({ id: "t3", status: "working" }), workspacePath: "/b" }, // fresh mtime + already working → null
      ],
      statMtimeMs: () => NOW - 1000,
      setStatus: async (id, s) => { set.push([id, s]) },
      engine: claudeEngine, home: "/h", now: () => NOW,
    })
    expect(set).toEqual([])
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/monitor.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`packages/server/src/engine/monitor.ts`：
```ts
import type { Tab, TabStatus } from "@coolie/protocol"
import type { Engine } from "./types.js"

export const HOOK_AUTHORITY_MS = 10 * 60_000
export const ACTIVE_THRESHOLD_MS = 3_000
export const IDLE_THRESHOLD_MS = 30_000

/** 纯仲裁（agent-deck sessionstatus 收敛教训：推导逻辑只此一处）：
 * hooks 近期有信号 → 让位；否则用转录 mtime 推断 working/awaiting-input。 */
export const decideStatusFromMtime = (i: {
  readonly nowMs: number
  readonly mtimeMs: number | null
  readonly lastHookAtMs: number | null
  readonly current: TabStatus
}): TabStatus | null => {
  if (i.lastHookAtMs !== null && i.nowMs - i.lastHookAtMs < HOOK_AUTHORITY_MS) return null
  if (i.mtimeMs === null) return null
  const age = i.nowMs - i.mtimeMs
  if (age <= ACTIVE_THRESHOLD_MS) return i.current === "working" ? null : "working"
  if (age >= IDLE_THRESHOLD_MS) return i.current === "working" ? "awaiting-input" : null
  return null
}

export interface TranscriptPollerDeps {
  readonly listEngineTabs: () => Promise<Array<{ tab: Tab; workspacePath: string }>>
  readonly statMtimeMs: (p: string) => number | null
  readonly setStatus: (tabId: string, status: TabStatus) => Promise<void>
  readonly engine: Engine
  readonly home: string
  readonly now?: () => number
}

export const pollOnce = async (deps: TranscriptPollerDeps): Promise<void> => {
  const now = (deps.now ?? Date.now)()
  for (const { tab, workspacePath } of await deps.listEngineTabs()) {
    if (tab.engineSessionId === null) continue
    const p = deps.engine.transcriptPath({ home: deps.home, cwd: workspacePath, sessionId: tab.engineSessionId })
    const next = decideStatusFromMtime({
      nowMs: now, mtimeMs: deps.statMtimeMs(p), lastHookAtMs: tab.lastHookAt, current: tab.status,
    })
    if (next !== null) await deps.setStatus(tab.id, next)
  }
}

/** 轮询失败绝不影响主流程（吞掉）；unref 不阻进程退出。返回 stop。 */
export const startTranscriptPoller = (deps: TranscriptPollerDeps, intervalMs = 2000): (() => void) => {
  const t = setInterval(() => { void pollOnce(deps).catch(() => {}) }, intervalMs)
  t.unref()
  return () => clearInterval(t)
}
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server/test/monitor.test.ts` → PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engine/monitor.ts packages/server/test/monitor.test.ts
git commit -m "feat(engines): transcript mtime poller fallback for turn detection"
```

---

### Task 10: WS 二进制终端通道（node-pty attach + upgrade 鉴权 + resize 防抖）

数据通路：`客户端 ↔ WS ↔ node-pty ↔ tmux attach ↔ pane`。**帧协议（本计划的最终决定，Plan 5 GUI 按此实现）**：
- 客户端→服务端：**二进制帧 = PTY 输入字节（原样写入，不消毒——这是终端本身）**；**文本帧 = JSON 控制消息**，当前仅 `{"type":"resize","cols":N,"rows":N}`。
- 服务端→客户端：**二进制帧 = PTY 输出字节（零解码直通）**；**文本帧 = `{"type":"exit","code":N}`** 后随 close。
- fit on attach：以 query 的 `cols/rows` 尺寸 spawn pty，tmux 默认 `window-size latest` 跟随最新客户端，无首帧 reflow；后续 resize 走控制帧，服务端 50ms trailing 防抖后 `pty.resize`（tmux 经 SIGWINCH 自己仲裁）。
- 鉴权：upgrade 时 `token` query param **或** `Authorization: Bearer` header（浏览器 WebSocket 无法带 header，query 为主路径；loopback + 每次启动新 token，风险受控；日志绝不打印完整 URL）。失败直接 401 关 socket。
- 生命周期：WS close → `pty.kill()`（attach client 死，session 无感）；pty exit → exit 帧 + close。

**Files:**
- Create: `packages/server/src/pty/attach.ts`
- Create: `packages/server/src/http/ws.ts`
- Test: `packages/server/test/ws-terminal.test.ts`

**Interfaces:**
- Consumes: `node-pty`/`ws`（Task 1）、`sanitizedTmuxEnv`（Task 3）、`tokenEquals`（Plan 1 token.ts）。
- Produces:
  - `spawnTmuxAttach(opts: { socket: string; session: string; window: number; cols: number; rows: number }): pty.IPty`
  - `TERMINAL_WS_PATH = "/ws/terminal"`
  - `attachTerminalWs(server: http.Server, deps: TerminalWsDeps): WebSocketServer`
  - `TerminalWsDeps = { token: string; tmuxSocket: string; resolveSession(workspaceId: string): Promise<string | null>; log?(msg: string): void }`
  - 关闭码约定：`4400` 参数缺失/非法、`4404` workspace/session 不存在、`4500` pty spawn 失败、`1000` pty 正常退出

- [ ] **Step 1: 写失败测试**

`packages/server/test/ws-terminal.test.ts`：
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as http from "node:http"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import WebSocket from "ws"
import { Effect } from "effect"
import { makeTmuxService } from "../src/tmux/service.js"
import { attachTerminalWs } from "../src/http/ws.js"
import { newToken } from "../src/http/app.js"

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const svc = makeTmuxService(SOCK)
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ws-"))
let server: http.Server, base: string
const token = newToken()

beforeAll(async () => {
  await Effect.runPromise(svc.newSession({ name: "coolie-w1", cwd, windowName: "engine", command: ["/bin/sh"] }))
  server = http.createServer((_req, res) => { res.writeHead(404).end() })
  attachTerminalWs(server, {
    token, tmuxSocket: SOCK,
    resolveSession: async (id) => (id === "w1" ? "coolie-w1" : null),
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/terminal`
})
afterAll(() => {
  server.close()
  try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ }
})

const collectUntil = (ws: WebSocket, pred: (all: string) => boolean, ms = 8000): Promise<string> =>
  new Promise((resolve, reject) => {
    let all = ""
    const timer = setTimeout(() => reject(new Error(`timeout; got: ${all.slice(-200)}`)), ms)
    ws.on("message", (d: Buffer, isBinary: boolean) => {
      if (!isBinary) return
      all += d.toString("utf8")
      if (pred(all)) { clearTimeout(timer); resolve(all) }
    })
  })

describe("WS terminal channel", () => {
  it("streams pty bytes both ways as binary frames", async () => {
    const ws = new WebSocket(`${base}?workspace=w1&window=0&cols=100&rows=30&token=${token}`)
    await new Promise<void>((r) => ws.once("open", () => r()))
    ws.send(Buffer.from("printf 'MARK-%s\\n' okay\r"), { binary: true })
    const out = await collectUntil(ws, (s) => s.includes("MARK-okay"))
    expect(out).toContain("MARK-okay")
    ws.close()
  })

  it("resize control frame reaches tmux (window-size latest)", async () => {
    const ws = new WebSocket(`${base}?workspace=w1&window=0&cols=100&rows=30&token=${token}`)
    await new Promise<void>((r) => ws.once("open", () => r()))
    ws.send(JSON.stringify({ type: "resize", cols: 91, rows: 21 }))
    const deadline = Date.now() + 5000
    let width = ""
    while (Date.now() < deadline) {
      width = execFileSync("tmux", ["-L", SOCK, "display-message", "-p", "-t", "=coolie-w1:0", "#{window_width}"], { encoding: "utf8" }).trim()
      if (width === "91") break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(width).toBe("91")
    ws.close()
  })

  it("closing the WS kills the attach client (no leaked clients)", async () => {
    const ws = new WebSocket(`${base}?workspace=w1&window=0&cols=80&rows=24&token=${token}`)
    await new Promise<void>((r) => ws.once("open", () => r()))
    await collectUntil(ws, (s) => s.length > 0) // attach 已建立
    ws.close()
    const deadline = Date.now() + 5000
    let clients: string[] = ["pending"]
    while (Date.now() < deadline) {
      clients = await Effect.runPromise(svc.listClients())
      if (clients.length === 0) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(clients).toEqual([]) // 零泄漏：attach client 全部退场
  })

  it("bad token → 401 refusal; unknown workspace → close 4404", async () => {
    const bad = new WebSocket(`${base}?workspace=w1&token=wrong`)
    const err = await new Promise<any>((r) => { bad.once("unexpected-response", (_q, res) => r(res.statusCode)); bad.once("error", () => r(401)) })
    expect(err).toBe(401)
    const unknown = new WebSocket(`${base}?workspace=nope&token=${token}`)
    const code = await new Promise<number>((r) => unknown.once("close", (c) => r(c)))
    expect(code).toBe(4404)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/ws-terminal.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`packages/server/src/pty/attach.ts`：
```ts
import * as pty from "node-pty"
import * as os from "node:os"
import { sanitizedTmuxEnv } from "../tmux/env.js"

export interface AttachOpts {
  readonly socket: string
  readonly session: string
  readonly window: number
  readonly cols: number
  readonly rows: number
}

/** node-pty 里跑 `tmux attach`：pty 是 tmux 的客户端，杀它只断观看，session/engine 无感。
 * encoding:null = 字节保真直通（Superset byte-fidelity 教训：utf8 decode 会截断半个多字节字符）。 */
export const spawnTmuxAttach = ({ socket, session, window, cols, rows }: AttachOpts): pty.IPty =>
  pty.spawn("tmux", ["-L", socket, "attach", "-t", `=${session}:${window}`], {
    name: "xterm-256color", cols, rows, cwd: os.homedir(),
    env: sanitizedTmuxEnv(),
    // node-pty 支持 encoding:null（emit Buffer）；typings 只写 string，显式 cast 并在 onData 侧归一
    encoding: null as unknown as string,
  })
```

`packages/server/src/http/ws.ts`：
```ts
import { WebSocketServer, WebSocket } from "ws"
import type { Server } from "node:http"
import type { Duplex } from "node:stream"
import { tokenEquals } from "./token.js"
import { spawnTmuxAttach } from "../pty/attach.js"

export const TERMINAL_WS_PATH = "/ws/terminal"

export interface TerminalWsDeps {
  readonly token: string
  readonly tmuxSocket: string
  /** workspace id → tmux session 名；无效/非 active 返回 null */
  readonly resolveSession: (workspaceId: string) => Promise<string | null>
  readonly log?: (msg: string) => void
}

const clampInt = (raw: string | null, min: number, max: number, dflt: number): number => {
  if (raw === null) return dflt
  const n = Number(raw)
  if (!Number.isInteger(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

export const attachTerminalWs = (server: Server, deps: TerminalWsDeps): WebSocketServer => {
  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? "/", "http://local")
    if (url.pathname !== TERMINAL_WS_PATH) { socket.destroy(); return }
    // 鉴权先于 upgrade：query token（浏览器主路径）或 Bearer header。日志纪律：不打印 URL。
    const header = (req.headers.authorization ?? "").replace(/^Bearer /, "")
    const qp = url.searchParams.get("token") ?? ""
    const got = header !== "" ? header : qp
    if (got === "" || !tokenEquals(got, deps.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => { void handleConn(ws, url, deps) })
  })
  return wss
}

const handleConn = async (ws: WebSocket, url: URL, deps: TerminalWsDeps): Promise<void> => {
  const wsId = url.searchParams.get("workspace")
  const windowIdx = clampInt(url.searchParams.get("window"), 0, 999, 0)
  const cols = clampInt(url.searchParams.get("cols"), 20, 500, 120)
  const rows = clampInt(url.searchParams.get("rows"), 5, 300, 32)
  if (!wsId) { ws.close(4400, "workspace query param required"); return }
  const session = await deps.resolveSession(wsId).catch(() => null)
  if (session === null) { ws.close(4404, "workspace/session not found"); return }

  let p: import("node-pty").IPty
  try {
    p = spawnTmuxAttach({ socket: deps.tmuxSocket, session, window: windowIdx, cols, rows })
  } catch (e) {
    deps.log?.(`pty spawn failed: ${String(e)}`)
    ws.close(4500, "pty spawn failed")
    return
  }

  let closed = false
  p.onData((d: string | Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return
    // encoding:null → Buffer；类型兜底：万一是 string 用 latin1 保字节
    ws.send(Buffer.isBuffer(d) ? d : Buffer.from(d, "latin1"), { binary: true })
  })
  p.onExit(({ exitCode }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }))
      ws.close(1000, "pty exited")
    }
  })

  // resize 防抖：50ms trailing——GUI 拖窗时高频 resize 直通会让 tmux 布局抖动
  let pendingResize: { cols: number; rows: number } | null = null
  let resizeTimer: NodeJS.Timeout | null = null
  const applyResize = (): void => {
    if (pendingResize === null || closed) return
    try { p.resize(pendingResize.cols, pendingResize.rows) } catch { /* pty 可能已死 */ }
    pendingResize = null
  }
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // 终端输入字节：原样透传（这就是终端本身，不做 prompt 消毒）
      p.write(data.toString("utf8"))
      return
    }
    try {
      const msg = JSON.parse(data.toString("utf8"))
      if (msg?.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        pendingResize = {
          cols: Math.min(500, Math.max(20, msg.cols)),
          rows: Math.min(300, Math.max(5, msg.rows)),
        }
        if (resizeTimer !== null) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(applyResize, 50)
      }
    } catch { /* 坏控制帧：忽略 */ }
  })
  ws.on("close", () => {
    closed = true
    if (resizeTimer !== null) clearTimeout(resizeTimer)
    try { p.kill() } catch { /* 已退出 */ }
  })
}
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server/test/ws-terminal.test.ts` → PASS（4 用例）；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/pty packages/server/src/http/ws.ts packages/server/test/ws-terminal.test.ts
git commit -m "feat(server): WS binary terminal channel (node-pty attach to tmux)"
```

---

### Task 11: lifecycle 集成——engine bootstrap hook、archive/delete 拆除、initialPrompt

create 流水线末尾（Plan 2 预留的 PostCreateHooks 插拔点）接入：建 tmux session（window 0 = engine，注入 `COOLIE_ROOT`/`COOLIE_WORKSPACE`/端口段 env）→ 注入 hooks → 写 tabs 行 → 投递首条 prompt（若有）。hook 签名扩展为 `(ws, ctx)` 携带 `initialPrompt`。archive/delete 在脏树守卫通过后**先拆 tmux session + tabs 行**再删 worktree（`workspace.tmux.killed` 事件）。M1 决定（文档化）：`initialPrompt` 不持久化——只在首次 create 尝试投递，retry 不补投（避免 double-deliver 歧义）；unarchive 不重建 session（Plan 4 ensure-or-heal）。

**Files:**
- Modify: `packages/server/src/workspace/lifecycle.ts`
- Create: `packages/server/src/engine/bootstrap.ts`
- Modify: `packages/server/src/http/app.ts`（POST /workspaces +initialPrompt）
- Test: `packages/server/test/lifecycle-tmux.test.ts`、`packages/server/test/http-workspaces.test.ts`（追加 initialPrompt 校验用例）

**Interfaces:**
- Consumes: `TmuxService/TmuxError`（Task 3/4）、`deliverPrompt`（Task 5）、`TabsRepo`（Task 6）、`EngineRegistry/getEngine`（Task 7）、`ensureHookScript/injectClaudeHooks/hooksDisabled`（Task 8）、`injectInfoExclude/portEnv`（Plan 2）。
- Produces:
  - `interface PostCreateContext { readonly initialPrompt?: string }`；`PostCreateHook = (ws: Workspace, ctx: PostCreateContext) => Effect<void, HookError>`（**签名变更**，全仓 hook lambda 补第二参）
  - `WorkspaceLifecycleShape.create` opts 增 `initialPrompt?: string`
  - `sessionNameFor(wsId: string): string`（`coolie-<wsId>`，bootstrap.ts 导出，Task 12/14 复用）
  - `EngineBootstrapHookLive: Layer<PostCreateHooks, never, TmuxService | TabsRepo | EventsRepo | EngineRegistry | CoolieConfig | ProjectsRepo>`
  - lifecycle 行为契约：archive/delete = 状态门 → 脏树守卫（`guardClean`）→ `teardownRuntime`（serviceOption：有 TmuxService 才 killSession + 事件；有 TabsRepo 才删 tabs 行；两者均 `Effect.ignore` 容错）→ 删 worktree → 状态/记录；bootstrap hook 失败自动 `killSession` 清半成品（不留孤儿 session），错误经 HookError 走既有回滚（status=error 可 retry）。（名池跨项目 seeding 的修正在 Task 13，此处不动 taken 集合。）

- [ ] **Step 1: 写失败测试**

`packages/server/test/lifecycle-tmux.test.ts`（真 tmux + 真 git + 内存 db + fake engine）：
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Effect, Layer, Exit } from "effect"
import Database from "better-sqlite3"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
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

const fakeClaude: Engine = {
  id: "claude", displayName: "Fake Claude",
  capabilities: { nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: false, effort: false },
  terminalTitle: "none",
  newSessionId: () => "sess-fixed-1",
  launchCommand: () => ["cat"],
  statusFromHookEvent: () => null,
  transcriptPath: ({ home: h, cwd, sessionId }) => path.join(h, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`),
  deriveTitle: () => null,
  resumeArgs: (s) => ["--resume", s],
}

const buildLayer = (engines: ReadonlyArray<Engine>) => {
  const cfgLayer = Layer.succeed(CoolieConfig, {
    home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
    workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"),
  })
  return WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(EngineBootstrapHookLive),
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive, SetupRunnerLive,
      Layer.succeed(TmuxService, tmux),
      Layer.succeed(EngineRegistry, new Map(engines.map((e) => [e.id, e]))),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(cfgLayer),
  )
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lt-home-"))
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lt-ws-"))
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-lt-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repoRoot })
  db = new Database(":memory:"); runMigrations(db)
})
afterAll(() => { try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ } })

const eventTypes = () => (db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type)
const cap = (target: string) => Effect.runPromise(tmux.capturePane(target))
const waitFor = async (fn: () => Promise<boolean>, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error("waitFor timeout")
}

describe("lifecycle × tmux × engine bootstrap", () => {
  it("create 建 session/启 engine/写 tab/投首条 prompt；archive/delete 拆干净", async () => {
    const layer = buildLayer([fakeClaude])
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const tabs = yield* TabsRepo
      const project = yield* projects.add(repoRoot)
      const ws = yield* lc.create({ projectId: project.id, initialPrompt: "hello from coolie" })
      const tabList = yield* tabs.listByWorkspace(ws.id)
      return { ws, tabList }
    })
    const { ws, tabList } = await Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<any, never, never>)

    expect(ws.status).toBe("active")
    const session = sessionNameFor(ws.id)
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)
    expect(tabList).toHaveLength(1)
    expect(tabList[0].kind).toBe("engine")
    expect(tabList[0].tmuxWindow).toBe(0)
    expect(tabList[0].engineSessionId).toBe("sess-fixed-1")
    for (const t of ["workspace.tmux.created", "tab.created", "engine.started", "prompt.delivered", "workspace.created"])
      expect(eventTypes()).toContain(t)
    await waitFor(async () => (await cap(`${session}:0`)).includes("hello from coolie")) // cat 回显 = 投递成功

    // archive：先拆 session/tabs 再删 worktree
    const archived = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const lc = yield* WorkspaceLifecycle
      return yield* lc.archive(ws.id)
    }), layer) as Effect.Effect<any, never, never>)
    expect(archived.status).toBe("archived")
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(false)
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 0 })
    expect(eventTypes()).toContain("workspace.tmux.killed")
  })

  it("bootstrap 失败（registry 缺 claude）→ status=error，无孤儿 session/tab", async () => {
    const layer = buildLayer([]) // 空 registry
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      return yield* lc.create({ projectId: list[0]!.id, name: "broken-one" })
    }), layer) as Effect.Effect<any, any, never>)
    expect(Exit.isFailure(exit)).toBe(true)
    const row = db.prepare("SELECT * FROM workspaces WHERE name = 'broken-one'").get() as any
    expect(row.status).toBe("error")
    expect(db.prepare("SELECT COUNT(*) c FROM tabs WHERE workspace_id = ?").get(row.id)).toEqual({ c: 0 })
    const sessions = await Effect.runPromise(tmux.listSessions())
    expect(sessions.filter((s) => s === sessionNameFor(row.id))).toEqual([])
  })

  it("delete 拆 session + tabs + 记录", async () => {
    const layer = buildLayer([fakeClaude])
    const ws = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      return yield* lc.create({ projectId: list[0]!.id, name: "to-delete" })
    }), layer) as Effect.Effect<any, never, never>)
    const session = sessionNameFor(ws.id)
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(true)
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      yield* (yield* WorkspaceLifecycle).delete(ws.id)
    }), layer) as Effect.Effect<any, never, never>)
    expect(await Effect.runPromise(tmux.hasSession(session))).toBe(false)
    expect(db.prepare("SELECT COUNT(*) c FROM workspaces WHERE id = ?").get(ws.id)).toEqual({ c: 0 })
  })
})
```

`packages/server/test/http-workspaces.test.ts` describe 内追加：
```ts
  it("POST /workspaces rejects non-string initialPrompt", async () => {
    const r = await req("/workspaces", { method: "POST", body: JSON.stringify({ projectId: "p", initialPrompt: 42 }) })
    expect(r.status).toBe(400)
  })
```
（`req` 用该文件既有的鉴权 fetch 封装名；若名字不同按现有 helper 调整调用名，断言不变。）

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/lifecycle-tmux.test.ts` → FAIL（bootstrap.ts 不存在；create 不识别 initialPrompt）。

- [ ] **Step 3: 实现**

(a) `packages/server/src/workspace/lifecycle.ts` 修改。imports 增：
```ts
import { Context, Data, Effect, Layer, Option } from "effect"
import { Workspace, tmuxSessionName } from "@coolie/protocol"
import { TmuxService } from "../tmux/service.js"
import { TabsRepo } from "../repo/tabs.js"
```
hook 契约区替换为：
```ts
/** Plan 3 插拔点落地：tmux session / engine 启动 / 首条 prompt 投递以 hook 形式挂进 create 流水线末尾。 */
export class HookError extends Data.TaggedError("HookError")<{ readonly message: string }> {}
export interface PostCreateContext { readonly initialPrompt?: string }
export type PostCreateHook = (ws: Workspace, ctx: PostCreateContext) => Effect.Effect<void, HookError>
export class PostCreateHooks extends Context.Tag("PostCreateHooks")<PostCreateHooks, ReadonlyArray<PostCreateHook>>() {}
export const PostCreateHooksEmpty = Layer.succeed(PostCreateHooks, [])
```
`WorkspaceLifecycleShape.create` 签名改为：
```ts
  readonly create: (opts: {
    projectId: string; branchSlug?: string; name?: string; initialPrompt?: string
  }) => Effect.Effect<Workspace, CreateError>
```
Layer 的 `Effect.gen` 头部增加（在 `const hooks = yield* PostCreateHooks` 之后）：
```ts
    // 运行时拆除依赖：可选注入（生产 main.ts 提供；单测不提供时 teardown 自动 no-op）
    const tmuxOpt = yield* Effect.serviceOption(TmuxService)
    const tabsOpt = yield* Effect.serviceOption(TabsRepo)

    /** archive/delete 共用：杀 tmux session（engine 归 tmux，拆除是唯一合法杀点）+ 清 tabs 行。全程容错。 */
    const teardownRuntime = (ws: Workspace, reason: "archive" | "delete"): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (Option.isSome(tmuxOpt)) {
          yield* tmuxOpt.value.killSession(tmuxSessionName(ws.id)).pipe(Effect.ignore)
          yield* emit(ws.id, "workspace.tmux.killed", { sessionName: tmuxSessionName(ws.id), reason }).pipe(Effect.ignore)
        }
        if (Option.isSome(tabsOpt)) yield* tabsOpt.value.removeByWorkspace(ws.id).pipe(Effect.ignore)
      })
```
`provision` 签名改为 `(ws, repoRoot, ctx: PostCreateContext)`，hooks 循环改：
```ts
        const fresh = yield* repo.get(ws.id)
        for (const hook of hooks) yield* hook(fresh, ctx)
```
`create` 末尾的 provision 调用改为携带 ctx：
```ts
        return yield* provision(ws, project.repoRoot, { ...(opts.initialPrompt !== undefined ? { initialPrompt: opts.initialPrompt } : {}) }).pipe(
          Effect.catchAll((e) => rollbackToError(ws, project.repoRoot, e)),
        )
```
`retry` 的 provision 调用改为 `provision(ws, project.repoRoot, {})`（M1 决定：initialPrompt 不持久化，retry 不补投）。

`removeWorktreeGuarded` 拆出守卫，archive/delete 改造：
```ts
    /** 脏树守卫（不删任何东西）：worktree 在且脏且未 force → 409 */
    const guardClean = (
      repoRoot: string, ws: Workspace, force: boolean, action: string,
    ): Effect.Effect<void, ConflictError | GitError> =>
      Effect.gen(function* () {
        if (!(yield* worktreePresent(repoRoot, ws.path))) return
        if (!force && (yield* git.isDirty(ws.path)))
          return yield* new ConflictError({ message: `worktree 有未提交改动，拒绝${action}；确认丢弃请带 force 重试` })
      })

    /** archive/delete 共用：唯一删除入口（git worktree remove）+ prune。不存在则只 prune。 */
    const removeWorktreeGuarded = (
      repoRoot: string, ws: Workspace, force: boolean, action: string,
    ): Effect.Effect<void, ConflictError | GitError> =>
      Effect.gen(function* () {
        if (!(yield* worktreePresent(repoRoot, ws.path))) {
          yield* git.worktreePrune(repoRoot)
          return
        }
        yield* guardClean(repoRoot, ws, force, action)
        yield* git.worktreeRemove(repoRoot, ws.path, { force })
        yield* git.worktreePrune(repoRoot)
      })

    const archive: WorkspaceLifecycleShape["archive"] = (id, opts) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(id)
        if (ws.status !== "active")
          return yield* new ConflictError({ message: `只能归档 active 的 workspace（当前 ${ws.status}）` })
        const project = yield* projects.get(ws.projectId)
        const force = opts?.force === true
        // 顺序：先守卫（脏树 409 时 session 不能已被杀）→ 拆 tmux/tabs → 删 worktree。
        // 守卫与删除之间 engine 理论上可再写文件——窗口极小，且 removeWorktreeGuarded 内层守卫兜底（二次 409 可重试）。
        yield* guardClean(project.repoRoot, ws, force, "归档")
        yield* teardownRuntime(ws, "archive")
        yield* removeWorktreeGuarded(project.repoRoot, ws, force, "归档")
        const out = yield* repo.setStatus(id, "archived")
        yield* emit(id, "workspace.archived", { id, force })
        return out
      })

    const del: WorkspaceLifecycleShape["delete"] = (id, opts) =>
      Effect.gen(function* () {
        const ws = yield* repo.get(id)
        const project = yield* projects.get(ws.projectId)
        const force = opts?.force === true
        yield* guardClean(project.repoRoot, ws, force, "删除")
        yield* teardownRuntime(ws, "delete")
        yield* removeWorktreeGuarded(project.repoRoot, ws, force, "删除")
        yield* repo.remove(id)
        yield* emit(id, "workspace.deleted", { id, branch: ws.branch }) // branch 保留，事件记下名字便于追溯
      })
```
（unarchive 原样不动——M1 不重建 session。）

(b) `packages/server/src/engine/bootstrap.ts`：
```ts
import { Effect, Layer } from "effect"
import { PostCreateHooks, HookError, type PostCreateHook } from "../workspace/lifecycle.js"
import { TmuxService } from "../tmux/service.js"
import { TabsRepo } from "../repo/tabs.js"
import { EventsRepo } from "../repo/events.js"
import { ProjectsRepo } from "../repo/projects.js"
import { EngineRegistry } from "./registry.js"
import { CoolieConfig } from "../config.js"
import { deliverPrompt } from "../tmux/delivery.js"
import { portEnv } from "../workspace/ports.js"
import { injectInfoExclude } from "../workspace/include.js"
import { ensureHookScript, injectClaudeHooks, hooksDisabled } from "./claude/hooks.js"
import { tmuxSessionName } from "@coolie/protocol"

/** 命名唯一真源在 protocol（tmuxSessionName）；此别名只为 server 侧调用点可读性。 */
export const sessionNameFor = tmuxSessionName

/**
 * PostCreateHook 落地（设计文档 §四 create 流水线末段）：
 * 建 tmux session（window 0 = engine，M1 直跑 engine，keep-alive 包装 Plan 4）→
 * hooks 注入（幂等、可 opt-out）→ tabs 行 + engine.started → 首条 prompt（若有）。
 * 失败自动 killSession 清半成品，经 HookError 走 lifecycle 的既有回滚（status=error 可 retry）。
 */
export const EngineBootstrapHookLive = Layer.effect(
  PostCreateHooks,
  Effect.gen(function* () {
    const tmux = yield* TmuxService
    const tabs = yield* TabsRepo
    const events = yield* EventsRepo
    const registry = yield* EngineRegistry
    const projects = yield* ProjectsRepo
    const cfg = yield* CoolieConfig

    const hook: PostCreateHook = (ws, ctx) =>
      Effect.gen(function* () {
        const engine = registry.get("claude")
        if (!engine) return yield* new HookError({ message: "claude engine 未注册" })
        const project = yield* projects.get(ws.projectId).pipe(
          Effect.mapError((e) => new HookError({ message: e.message })),
        )
        const session = sessionNameFor(ws.id)
        const sessionId = engine.newSessionId()

        if (engine.capabilities.hooks && !hooksDisabled()) {
          yield* Effect.try({
            try: () => {
              const scriptPath = ensureHookScript(cfg.home)
              injectClaudeHooks({ worktreePath: ws.path, workspaceId: ws.id, scriptPath })
              // settings.local.json 是我们写进 worktree 的：必须排除，否则 isDirty 守卫误伤 archive/delete
              injectInfoExclude(project.repoRoot, ".claude/settings.local.json")
            },
            catch: (e) => new HookError({ message: `hooks 注入失败：${String(e)}` }),
          })
        }

        const command = engine.launchCommand({ sessionId })
        yield* tmux.newSession({
          name: session, cwd: ws.path, windowName: "engine", command,
          env: { COOLIE_ROOT: project.repoRoot, COOLIE_WORKSPACE: ws.id, ...portEnv(ws.portBase) },
        }).pipe(Effect.mapError((e) => new HookError({ message: `tmux session 创建失败：${e.message}` })))
        yield* events.append({ workspaceId: ws.id, type: "workspace.tmux.created", payload: { sessionName: session } })

        const tab = yield* tabs.insert({
          workspaceId: ws.id, kind: "engine", engineId: engine.id, engineSessionId: sessionId, tmuxWindow: 0,
        })
        yield* events.append({
          workspaceId: ws.id, type: "engine.started",
          payload: { tabId: tab.id, engineId: engine.id, sessionId, command },
        })

        if (ctx.initialPrompt !== undefined && ctx.initialPrompt.trim() !== "") {
          yield* deliverPrompt(tmux, `${session}:0`, ctx.initialPrompt).pipe(
            Effect.mapError((e) => new HookError({ message: `首条 prompt 投递失败：${e.message}` })),
          )
          yield* events.append({
            workspaceId: ws.id, type: "prompt.delivered",
            payload: { workspaceId: ws.id, tabId: tab.id, chars: ctx.initialPrompt.length },
          })
        }
      }).pipe(
        // 不留孤儿 session：hook 内任何一步失败都拆掉刚建的 session（tabs 行由 rollback 前的事务保证一致）
        Effect.tapError(() => tmux.killSession(sessionNameFor(ws.id)).pipe(Effect.ignore)),
        Effect.tapError(() => tabs.removeByWorkspace(ws.id).pipe(Effect.ignore)),
      )

    return [hook]
  }),
)
```

(c) `packages/server/src/http/app.ts` 的 `POST /workspaces` 分支：body 校验后追加：
```ts
          if (body.initialPrompt !== undefined && typeof body.initialPrompt !== "string")
            return err(res, 400, "Validation", "initialPrompt must be a string")
```
`lc.create` 调用对象追加：
```ts
                ...(typeof body.initialPrompt === "string" && body.initialPrompt !== "" ? { initialPrompt: body.initialPrompt } : {}),
```

(d) 既有测试**无需适配**：`lifecycle-create.test.ts` 等处的自定义 hook lambda（`(ws) => …` / `() => …`）是低元数函数，TypeScript 结构化类型下天然满足新的 `(ws, ctx) => …` 签名——不会出现编译错，该文件零改动。

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server` → 全 PASS（lifecycle-tmux 3 用例 + 全部既有 lifecycle/http 回归）；`bun run typecheck` → 通过；`tmux -L coolie list-sessions 2>&1 | head -1` 确认生产 socket 未被污染。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/workspace/lifecycle.ts packages/server/src/engine/bootstrap.ts packages/server/src/http/app.ts packages/server/test/lifecycle-tmux.test.ts packages/server/test/http-workspaces.test.ts
git commit -m "feat(server): engine bootstrap post-create hook + tmux teardown on archive/delete + initialPrompt"
```

---

### Task 12: 装配——unix socket 监听、WS/hook/poller 接线、EventsBusLive、engine 生存测试

main.ts 全量重排；`ServerInfo` 增加 `sock` 字段；ledger carry-over「EventsBusLive dead export」清掉（main 改用它）。本任务的**灵魂测试**：SIGKILL server 后 tmux session 仍活着（engine 进程只属于 tmux）。同时必须给 CLI 既有 e2e 套上 tmux 测试环境——否则 Task 11 之后真 daemon 的 create 会往**生产 socket** 建 session、启真 claude。

**Files:**
- Modify: `packages/server/src/daemon/info.ts`（ServerInfo +sock）
- Modify: `packages/server/src/main.ts`
- Modify: `packages/cli/test/workspace-e2e.test.ts`、`packages/cli/test/cli-e2e.test.ts`（测试环境加 `COOLIE_TMUX_SOCKET`/`COOLIE_CLAUDE_CMD=cat`/`COOLIE_DISABLE_HOOKS=1`/`COOLIE_CLAUDE_HOME` + afterAll kill-server）
- Test: `packages/server/test/daemon.test.ts`（追加 unix socket + 生存两用例）

**Interfaces:**
- Consumes: Task 3–11 全部装配件；`EventsBusLive`（Plan 2 遗留 dead export，今起转正）。
- Produces:
  - `ServerInfo = { port: number; token: string; pid: number; sock?: string }`（sock = `<home>/coolie.sock`；旧 server.json 无 sock 仍可读）
  - server 行为契约：启动时额外监听 unix socket（同一 app handler、同一 token；先 `rm -f` 陈旧 sock，shutdown 时关闭并删除）；`ensureHookScript(cfg.home)`；tmux 首启检测（`version()` 失败 → `logger.warn` 带 brew 提示，不阻启动——doctor 同口径）；`attachTerminalWs` 挂 TCP server（resolveSession：active workspace → `tmuxSessionName(id)`）；`startTranscriptPoller` 常驻（shutdown 时 stop）；layer 用 `EventsBusLive`，bus 经 `Context.get(runtimeCtx, EventsBus)` 取出交给 createApp

- [ ] **Step 1: 写失败测试**

`packages/server/test/daemon.test.ts` 追加（顶部 import 增加 `import * as http from "node:http"`、`import { spawn, spawnSync, execFileSync } from "node:child_process"`——与现有 import 合并去重）：
```ts
const unixGet = (sockPath: string, p: string, token?: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: sockPath, path: p, method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let b = ""; res.on("data", (c) => { b += c }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b })) },
    )
    req.on("error", reject)
    req.end()
  })

describe("unix socket listener", () => {
  it("serves the same app on <home>/coolie.sock with the same token", async () => {
    const info = await startServer()
    const sockPath = path.join(home, "coolie.sock")
    expect(info.sock).toBe(sockPath)
    expect(fs.existsSync(sockPath)).toBe(true)
    expect((await unixGet(sockPath, "/health")).status).toBe(200)
    expect((await unixGet(sockPath, "/projects")).status).toBe(401)          // unix socket 不豁免 token
    expect((await unixGet(sockPath, "/projects", info.token)).status).toBe(200)
  })
})

describe("engine ownership（不可违背原则）", () => {
  it("tmux session survives server SIGKILL", async () => {
    const sock = `coolie-test-${process.pid}-srv`
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-surv-home-"))
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-surv-ws-"))
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-surv-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: repo })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
    const env = {
      ...process.env, COOLIE_HOME: home2, COOLIE_WORKSPACES_ROOT: wsRoot,
      COOLIE_TMUX_SOCKET: sock, COOLIE_CLAUDE_CMD: "cat", COOLIE_DISABLE_HOOKS: "1",
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
      const session = `coolie-${ws.id}`
      expect(spawnSync("tmux", ["-L", sock, "has-session", "-t", `=${session}`]).status).toBe(0)

      // ★ 杀 server（整个进程组，Plan 1 tsx 孙进程教训）——engine 归 tmux，session 必须活着
      try { process.kill(-srv.pid!, "SIGKILL") } catch { srv.kill("SIGKILL") }
      await new Promise((r) => setTimeout(r, 500))
      expect(spawnSync("tmux", ["-L", sock, "has-session", "-t", `=${session}`]).status).toBe(0)
    } finally {
      try { process.kill(-srv.pid!, "SIGKILL") } catch { /* already dead */ }
      try { execFileSync("tmux", ["-L", sock, "kill-server"]) } catch { /* gone */ }
    }
  })
})
```
（`startServer/home/TSX/MAIN` 沿用该文件既有 helper；若 `startServer` 的 spawn env 不含 `COOLIE_TMUX_SOCKET`，给它加上 `COOLIE_TMUX_SOCKET: \`coolie-test-${process.pid}-d\`` 与 `COOLIE_DISABLE_HOOKS: "1"`，并在该文件 afterAll 里 `kill-server` 这个 socket——注意 control client 是**惰性 spawn**（首次 sendKey 才建 hub session `coolie-ctl`），daemon 裸启动不会创建任何 tmux server；这里的 kill-server 只是 best-effort 兜底。）

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/daemon.test.ts`
Expected: FAIL（`info.sock` undefined；POST /workspaces 后无 session——bootstrap 未接线）。

- [ ] **Step 3: 实现**

`packages/server/src/daemon/info.ts` 替换 `ServerInfo` 与 `readServerInfo`：
```ts
export interface ServerInfo { port: number; token: string; pid: number; sock?: string }

export const readServerInfo = (infoPath: string): ServerInfo | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(infoPath, "utf8"))
    if (typeof raw.port === "number" && typeof raw.token === "string" && typeof raw.pid === "number")
      return { port: raw.port, token: raw.token, pid: raw.pid, ...(typeof raw.sock === "string" ? { sock: raw.sock } : {}) }
    return null
  } catch { return null }
}
```
（`writeServerInfo`/`probeAlive` 不变——写入端传入含 sock 的对象即可。）

`packages/server/src/main.ts` 的 `cmdStart` 替换为（imports 相应增删；`cmdStatus`/`cmdStop`/argv 分发不变）：
```ts
import { Context, Effect, Layer, Exit, Scope } from "effect"
import { tmuxSessionName } from "@coolie/protocol"
import { TabsRepoLive, TabsRepo } from "./repo/tabs.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "./repo/workspaces.js"
import { EventsBus, EventsBusLive } from "./events/bus.js"
import { TmuxService, TmuxServiceLive } from "./tmux/service.js"
import { EngineRegistry, EngineRegistryLive } from "./engine/registry.js"
import { EngineBootstrapHookLive } from "./engine/bootstrap.js"
import { ensureHookScript } from "./engine/claude/hooks.js"
import { startTranscriptPoller } from "./engine/monitor.js"
import { attachTerminalWs } from "./http/ws.js"
```
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
  if (existing) fs.rmSync(cfg.serverInfoPath, { force: true }) // 陈旧文件

  const scope = Effect.runSync(Scope.make())
  const appLayer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(EngineBootstrapHookLive),
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive,
      makeSetupRunnerLive((chunk) => logger.info(`setup: ${chunk.trimEnd()}`)),
      TmuxServiceLive,
      EngineRegistryLive,
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
    Layer.provideMerge(EventsBusLive), // Plan 2 的 dead export 转正：单一构造点
    Layer.provideMerge(DbLive),
    Layer.provideMerge(CoolieConfigLive),
  )
  const runtimeCtx = await Effect.runPromise(Layer.buildWithScope(appLayer, scope))
  const bus = Context.get(runtimeCtx, EventsBus)
  const runtime = <A, E>(eff: Effect.Effect<A, E, AppServices>) =>
    Effect.runPromiseExit(Effect.provide(eff, runtimeCtx) as Effect.Effect<A, E, never>)

  const token = newToken()
  ensureHookScript(cfg.home) // hook 转发脚本：每次启动重写（home/版本变更自动生效）

  // tmux 首启检测（设计文档 §十二）：不阻启动，warn 进日志；doctor 同口径
  const tmuxSvc = Context.get(runtimeCtx, TmuxService)
  void Effect.runPromise(tmuxSvc.version()).then(
    (v) => logger.info(`tmux ok: ${v}`),
    (e) => logger.warn(`tmux 不可用：${String(e)}（brew install tmux；coolie doctor 检查）`),
  )

  // turn detector 兜底：转录 mtime 轮询（hooks 沉默时接管）
  const registry = Context.get(runtimeCtx, EngineRegistry)
  const claude = registry.get("claude")
  const stopPoller = claude
    ? startTranscriptPoller({
        listEngineTabs: async () => {
          const exit = await runtime(Effect.gen(function* () { return yield* (yield* TabsRepo).listEngineTabs() }))
          return Exit.isSuccess(exit) ? exit.value : []
        },
        statMtimeMs: (p) => { try { return fs.statSync(p).mtimeMs } catch { return null } },
        setStatus: async (tabId, status) => {
          await runtime(Effect.gen(function* () { yield* (yield* TabsRepo).setStatus(tabId, status, "poller") }))
        },
        engine: claude,
        home: cfg.claudeHome,
      })
    : () => {}

  const sockPath = path.join(cfg.home, "coolie.sock")
  const shutdown = async () => {
    logger.info("shutdown")
    stopPoller()
    fs.rmSync(cfg.serverInfoPath, { force: true })
    server.close()
    unixServer.close()
    fs.rmSync(sockPath, { force: true })
    await Effect.runPromise(Scope.close(scope, Exit.void)) // scope 关闭 → control client dispose；tmux server/session 不动
    await Promise.race([logger.flush(), new Promise((r) => setTimeout(r, 2000))])
    process.exit(0)
  }

  const app = createApp({
    runtime, token, bus, claudeHome: cfg.claudeHome,
    onShutdown: () => void shutdown(),
    onError: (e) => logger.error("http 500", e),
  })
  const server = http.createServer(app)

  // WS 终端通道（挂 TCP server；GUI/浏览器从 TCP 连）
  attachTerminalWs(server, {
    token, tmuxSocket: cfg.tmuxSocket,
    resolveSession: async (wsId) => {
      const exit = await runtime(Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(wsId) }))
      return Exit.match(exit, {
        onSuccess: (ws) => (ws.status === "active" ? tmuxSessionName(ws.id) : null),
        onFailure: () => null,
      })
    },
    log: (m) => logger.warn(m),
  })

  // unix socket 监听（设计文档 §2.1）：同一 app、同一 token；先清陈旧 sock
  fs.mkdirSync(cfg.home, { recursive: true })
  fs.rmSync(sockPath, { force: true })
  const unixServer = http.createServer(app)
  unixServer.listen(sockPath, () => logger.info(`listening on unix socket ${sockPath}`))

  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port
    writeServerInfo(cfg.serverInfoPath, { port, token, pid: process.pid, sock: sockPath })
    logger.info(`coolie-server listening on 127.0.0.1:${port}`)
  })
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}
```

CLI 既有 e2e 环境隔离（**必须与 main.ts 同一提交**，否则 e2e 会污染生产 socket / 启真 claude）——`packages/cli/test/workspace-e2e.test.ts` 与 `packages/cli/test/cli-e2e.test.ts` 顶部：
```ts
const TMUX_SOCK = `coolie-test-${process.pid}-cli`
```
`coolie()` helper 的 env 扩为：
```ts
  env: {
    ...process.env, COOLIE_HOME: home, COOLIE_WORKSPACES_ROOT: wsRoot,
    COOLIE_TMUX_SOCKET: TMUX_SOCK, COOLIE_CLAUDE_CMD: "cat", COOLIE_DISABLE_HOOKS: "1",
    COOLIE_CLAUDE_HOME: path.join(home, "claude-home"),
  },
```
（workspace-e2e 已有 `COOLIE_WORKSPACES_ROOT`；cli-e2e 若无则不加 wsRoot，其余四个都加。）两文件 afterAll 追加：
```ts
  try { execFileSync("tmux", ["-L", TMUX_SOCK, "kill-server"]) } catch { /* gone */ }
```

- [ ] **Step 4: 确认通过** — Run: `bun run test`（全量）→ 全 PASS；`tmux -L coolie list-sessions 2>&1 | head -1` → no server（生产 socket 零污染）；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/daemon/info.ts packages/server/src/main.ts packages/server/test/daemon.test.ts packages/cli/test
git commit -m "feat(server): unix socket listener + full daemon wiring (engine survives server death)"
```

---

### Task 13: HTTP 卫生（query 校验、body cap、projects 事件单事务）+ 名池跨项目 seeding

Ledger carry-overs 收口：`/events` 的 `after/limit` NaN 直落 SQLite（曾 500）→ 400；`readJson` 无编码声明、无体积上限 → `setEncoding("utf8")` + 1MB cap（超限 413）；`POST/DELETE /projects` 的「先写库、再单独 append 事件」两段式 → repo 内单事务（复用 Task 6 的 `appendEventRow`，app.ts 的 `emit/emitThenRespond` 删除）；`pickName` 的 taken 集只看本项目 → 跨项目（同名项目共享 `workspacesRoot/<project.name>/` 目录，name 必须全局唯一，否则路径唯一索引撞车）。

**Files:**
- Modify: `packages/server/src/http/app.ts`
- Modify: `packages/server/src/repo/projects.ts`
- Modify: `packages/server/src/workspace/lifecycle.ts`（一行：taken 全量）
- Test: `packages/server/test/http.test.ts`（追加）、`packages/server/test/projects-repo.test.ts`（追加）、`packages/server/test/names-seeding.test.ts`（新建）

**Interfaces:**
- Consumes: `appendEventRow`（Task 6）、`EventsBus`（serviceOption）、`NATIONAL_PARKS/pickName`（Plan 2 names.ts）。
- Produces:
  - `MAX_BODY_BYTES = 1_048_576`；`class BodyTooLargeError extends Error`；readJson 超限 → 413 `{code:"Validation"}`
  - `intParam(url: URL, name: string, dflt: number): number | null`（缺省→默认；非 `/^\d+$/` 或超 safe int → null）；`GET /events`、`GET /events/stream` 的 after/limit 非法 → 400（limit 另 clamp ≤1000）
  - `ProjectsRepo.add/remove` 行为不变（同样的返回与错误），但 `project.added`/`project.removed` 事件行与主写在同一 `db.transaction`，bus 广播在 commit 后
  - lifecycle.create 的 `taken` 改为全部 workspace 名（跨项目）

- [ ] **Step 1: 写失败测试**

`packages/server/test/http.test.ts` describe 内追加：
```ts
  it("rejects non-numeric events query params with 400 (not 500)", async () => {
    expect((await req("/events?after=abc")).status).toBe(400)
    expect((await req("/events?limit=-1")).status).toBe(400)
    expect((await req("/events?after=1e3")).status).toBe(400)
    expect((await req("/events?after=5&limit=10")).status).toBe(200)
  })
  it("caps request body at 1MB with 413", async () => {
    const big = JSON.stringify({ repoRoot: "/x".repeat(700_000) }) // >1MB
    const r = await req("/projects", { method: "POST", body: big })
    expect(r.status).toBe(413)
    expect((await r.json()).code).toBe("Validation")
  })
```

`packages/server/test/projects-repo.test.ts` describe 内追加：
```ts
  it("add/remove write project.* events in the same transaction", async () => {
    const db = new Database(":memory:"); runMigrations(db)
    const layer = ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
    const p = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const repo = yield* ProjectsRepo
      const proj = yield* repo.add(repoRoot)
      yield* repo.remove(proj.id)
      return proj
    }), layer) as Effect.Effect<any, never, never>)
    const evs = (db.prepare("SELECT type, payload FROM events ORDER BY seq").all() as any[])
    expect(evs.map((e) => e.type)).toEqual(["project.added", "project.removed"])
    expect(JSON.parse(evs[0].payload).id).toBe(p.id)
  })
```
（该文件已有 `Database/runMigrations/Db/Layer/Effect` 等 import 与 `repoRoot` fixture；沿用。）

`packages/server/test/names-seeding.test.ts`（新建；真 git、无 tmux、PostCreateHooksEmpty）：
```ts
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
    workspacesRoot: wsRoot, tmuxSocket: "coolie-test-unused", claudeHome: path.join(home, "ch"),
  })),
)

describe("名池跨项目 seeding（路径撞车防护）", () => {
  it("project B 的自动命名避开 project A 已占用的全部园名", async () => {
    const ws = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
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
    // 修正前：pickName 只看 B 自己的（空）→ 撞 A 的路径 → ConflictError。
    // 修正后：taken 全量 → 取 -2 后缀。
    expect(ws.name).toMatch(/-2$/)
    expect(ws.status).toBe("active")
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/server/test/http.test.ts packages/server/test/projects-repo.test.ts packages/server/test/names-seeding.test.ts` → 新用例全 FAIL（after=abc 得 200/500 而非 400；大 body 非 413；无 project.* 事件行；seeding 用例 ConflictError）。

- [ ] **Step 3: 实现**

(a) `packages/server/src/http/app.ts`：

readJson 替换为（`BadJsonError` 保留）：
```ts
export const MAX_BODY_BYTES = 1_048_576
export class BodyTooLargeError extends Error {
  constructor() { super(`request body exceeds ${MAX_BODY_BYTES} bytes`); this.name = "BodyTooLargeError" }
}

const readJson = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    req.setEncoding("utf8")
    let buf = ""
    let bytes = 0
    req.on("data", (c: string) => {
      bytes += Buffer.byteLength(c)
      if (bytes > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError())
        // T1：不能 req.destroy()——撕掉 socket 后 413 无处可写（客户端只见 ECONNRESET）。
        // 卸掉 data 监听并 resume 排空余量；之后 end 的 resolve 在已 reject 的 promise 上是 no-op。
        req.removeAllListeners("data")
        req.resume()
        return
      }
      buf += c
    })
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}) }
      catch (e) { reject(new BadJsonError(e instanceof Error ? e.message : String(e))) }
    })
    req.on("error", reject) // 传输层错误：已 reject 后的二次 reject 为 no-op
  })
```

新增 helper（send/err 之后）：
```ts
/** 非负整数 query param：缺省→默认值；非法→null（调用方 400）。ledger carry-over：NaN 曾直落 SQLite。 */
const intParam = (url: URL, name: string, dflt: number): number | null => {
  const raw = url.searchParams.get(name)
  if (raw === null) return dflt
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}
```

`GET /events/stream` 分支的 after 解析替换为：
```ts
          const after = intParam(url, "after", 0)
          if (after === null) return err(res, 400, "Validation", "after must be a non-negative integer")
```
`GET /events` 分支替换为：
```ts
          const after = intParam(url, "after", 0)
          const limitRaw = intParam(url, "limit", 200)
          if (after === null || limitRaw === null)
            return err(res, 400, "Validation", "after/limit must be non-negative integers")
          const limit = Math.min(limitRaw, 1000)
```
（后续 `listAfter({ after, limit, … })` 引用改名后的变量。）

删除 `emit` 与 `emitThenRespond` 两个 helper；`POST /projects` 成功分支改为 `(p) => send(res, 201, p)`；`DELETE /projects/:id` 成功分支改为 `() => send(res, 204)`。

route 外层 catch 增加一行（BadJsonError 判断之前）：
```ts
        if (e instanceof BodyTooLargeError) return err(res, 413, "Validation", e.message)
```

(b) `packages/server/src/repo/projects.ts`：imports 增加
```ts
import { Option } from "effect"
import type { CoolieEvent } from "@coolie/protocol"
import { EventsBus, EVENT_CHANNEL } from "../events/bus.js"
import { appendEventRow } from "./events.js"
```
Layer 的 `Effect.gen` 头部加：
```ts
    const bus = yield* Effect.serviceOption(EventsBus)
    const broadcast = (ev: CoolieEvent): void => { if (Option.isSome(bus)) bus.value.emit(EVENT_CHANNEL, ev) }
```
`add` 的 INSERT 段替换为（校验/Conflict 检查不变）：
```ts
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
            .run(p.id, p.name, p.repoRoot, p.defaultBaseBranch, p.createdAt)
          ev = appendEventRow(db, { workspaceId: null, type: "project.added", payload: { id: p.id, repoRoot: p.repoRoot } })
        })()
        broadcast(ev)
        return p
```
`remove` 替换为：
```ts
      remove: (id) => Effect.gen(function* () {
        let ev: CoolieEvent | null = null
        const changes = db.transaction(() => {
          const res = db.prepare("DELETE FROM projects WHERE id = ?").run(id)
          if (res.changes > 0)
            ev = appendEventRow(db, { workspaceId: null, type: "project.removed", payload: { id } })
          return res.changes
        })()
        if (changes === 0) return yield* new NotFoundError({ message: `项目不存在：${id}` })
        if (ev !== null) broadcast(ev)
      }),
```
（其余方法 `get/list` 与错误类不动。）

(c) `packages/server/src/workspace/lifecycle.ts` 的 create 内一行替换：
```ts
        const existing = yield* repo.list({}) // 跨项目全量：同名项目共享路径名字空间，name 必须全局唯一（ledger carry-over）
        const taken = new Set(existing.map((w) => w.name))
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/server`（events.test.ts / sse.test.ts / http-workspaces.test.ts 全回归）→ 全 PASS；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/app.ts packages/server/src/repo/projects.ts packages/server/src/workspace/lifecycle.ts packages/server/test/http.test.ts packages/server/test/projects-repo.test.ts packages/server/test/names-seeding.test.ts
git commit -m "fix(server): http hygiene (query validation, body cap, transactional project events) + cross-project name seeding"
```

---

### Task 14: CLI——unix socket 客户端、enter/open、create --prompt、protocol 解码、events tail e2e

**Files:**
- Modify: `packages/cli/src/client.ts`（fetch → node:http，unix socket 优先）
- Modify: `packages/cli/src/main.ts`（+enter/open、create --prompt、schema 解码）
- Test: `packages/cli/test/workspace-e2e.test.ts`、`packages/cli/test/cli-e2e.test.ts`（追加用例）

**Interfaces:**
- Consumes: `ServerInfo.sock`（Task 12）、`tmuxSessionName/decodeProject/decodeWorkspace/decodeCoolieEvent`（protocol）、Task 12 建好的 e2e tmux 测试环境（`TMUX_SOCK`/`COOLIE_CLAUDE_CMD=cat`）。
- Produces（用户可见 CLI 面）:
  - `api()` 走 node:http：`info.sock` 存在且文件在 → unix socket；连接错误自动回退 TCP 重试一次；响应经 status/JSON 同旧契约
  - `coolie create <projectIdOrPath> [--slug --name --prompt <text>]` — `--prompt` 转 `initialPrompt`；输出行不变
  - `coolie enter <wsId>` — session 不存在 → stderr 提示（含 Plan 4 heal 预告）exit 1；存在 → `tmux -L <socket> attach -t =coolie-<wsId>`（`spawnSync` stdio inherit，退出码透传）
  - `coolie open <wsId>` — stdout 打印 `tmux -L <socket> attach -t coolie-<wsId>`（iTerm2 逃生舱一等公民；GUI 按钮 Plan 5 直接复用这行命令）
  - list/create/project list/events tail 的响应经 protocol schema 解码（坏形状快速失败，ledger carry-over）

- [ ] **Step 1: 写失败测试**

`packages/cli/test/workspace-e2e.test.ts` describe 内追加：
```ts
  it("open prints the attach command for the test socket", () => {
    const out = coolie("open", "someid")
    expect(out.trim()).toBe(`tmux -L ${TMUX_SOCK} attach -t coolie-someid`)
  })

  it("enter exits non-zero with guidance when the session is missing", () => {
    let failed = false
    try { coolie("enter", "no-such-ws") } catch (e: any) {
      failed = true
      expect(String(e.stderr)).toContain("tmux session")
    }
    expect(failed).toBe(true)
  })

  it("create --prompt delivers the first prompt into the engine window", () => {
    const out = coolie("create", repo, "--name", "prompted-ws", "--slug", "prompted", "--prompt", "hello-e2e-prompt")
    const id = out.match(/created \S+ \(([^)]+)\)/)![1]!
    // create 是同步流水线：返回时 prompt 已投递（cat 引擎回显）
    const cap = execFileSync("tmux", ["-L", TMUX_SOCK, "capture-pane", "-p", "-t", `=coolie-${id}:0`], { encoding: "utf8" })
    expect(cap).toContain("hello-e2e-prompt")
    coolie("delete", id, "--force") // 清理：session + worktree + 记录
  })
```
（`repo` 为该文件既有的 git fixture 变量名；不同则替换为现有名，断言不变。）

`packages/cli/test/cli-e2e.test.ts` describe 内追加：
```ts
  it("events tail prints structured events (e2e, non-follow)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-tail-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    coolie("project", "add", dir)
    const out = coolie("events", "tail", "--after", "0")
    expect(out).toContain("project.added")
    expect(out).toMatch(/^\d+\t\d{4}-\d{2}-\d{2}T/m) // seq \t ISO 时间戳开头
  })
```

- [ ] **Step 2: 确认失败** — Run: `bun run test -- packages/cli` → 新用例 FAIL（`open`/`enter` 未知命令；`--prompt` 未知选项）。

- [ ] **Step 3: 实现**

(a) `packages/cli/src/client.ts` 全文替换：
```ts
import { spawn } from "node:child_process"
import * as http from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"; import * as path from "node:path"
import { createRequire } from "node:module"
import { readServerInfo, probeAlive, type ServerInfo } from "@coolie/server"

const require_ = createRequire(import.meta.url)
export const home = () => process.env.COOLIE_HOME ?? path.join(os.homedir(), ".coolie")
const infoPath = () => path.join(home(), "server.json")

const spawnServer = (): void => {
  // @coolie/server 的 exports map 只有 "."；解析包根再取同级 main.ts（Plan 1 注释保留）
  const serverMain = path.join(path.dirname(require_.resolve("@coolie/server")), "main.ts")
  const tsx = path.resolve(path.dirname(require_.resolve("tsx/package.json")), "../.bin/tsx")
  const child = spawn(tsx, [serverMain, "start"], { detached: true, stdio: "ignore", env: process.env })
  child.on("error", () => {}) // ensureServer 的轮询超时兜底启动失败
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

interface RawResponse { status: number; text: string }

/** unix socket 优先（设计文档 §2.1：本地零端口依赖）；sock 缺席/失联回退 TCP。token 两路一致。 */
const rawRequest = (
  info: ServerInfo, method: string, p: string, body: string | undefined, forceTcp: boolean,
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const viaSock = !forceTcp && info.sock !== undefined && fs.existsSync(info.sock)
    const base = viaSock ? { socketPath: info.sock! } : { host: "127.0.0.1", port: info.port }
    const req = http.request({
      ...base, path: p, method,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${info.token}`,
        ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", (c) => { buf += c })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: buf }))
    })
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })

export const api = async (method: string, p: string, body?: unknown): Promise<any> => {
  const info = await ensureServer()
  const payload = body === undefined ? undefined : JSON.stringify(body)
  let r: RawResponse
  try {
    r = await rawRequest(info, method, p, payload, false)
  } catch {
    r = await rawRequest(info, method, p, payload, true) // 陈旧 sock → TCP 重试一次
  }
  if (r.status === 204) return undefined
  let json: any = {}
  try { json = r.text ? JSON.parse(r.text) : {} } catch { /* 非 JSON 保持 {} */ }
  if (r.status < 200 || r.status >= 300) throw new Error(`${json.code ?? r.status}: ${json.message ?? "request failed"}`)
  return json
}
```

(b) `packages/cli/src/main.ts`：imports 增改：
```ts
import { ROUTES, decodeProject, decodeWorkspace, decodeCoolieEvent, tmuxSessionName } from "@coolie/protocol"
```
`create` 命令增加 option 与 body 字段、返回解码：
```ts
  .option("--prompt <text>", "workspace 就绪后投递给 engine 的首条 prompt")
```
action 参数类型 `{ slug?: string; name?: string; prompt?: string }`，`api("POST", "/workspaces", …)` 的对象追加：
```ts
        ...(opts.prompt ? { initialPrompt: opts.prompt } : {}),
```
且结果行改为：
```ts
      const ws = decodeWorkspace(await api("POST", "/workspaces", { /* …同上… */ }))
```
`list` 循环改 `for (const w of ((await api("GET", "/workspaces")) as unknown[]).map(decodeWorkspace))`；`project list` 循环改 `.map(decodeProject)`；`events tail` 的 printBatch 改：
```ts
      const batch = ((await api("GET", `/events?after=${cursor}`)) as unknown[]).map(decodeCoolieEvent)
```

新增命令（`delete` 命令之后）：
```ts
const tmuxSocketName = () => process.env.COOLIE_TMUX_SOCKET ?? "coolie"

program.command("enter <wsId>")
  .description("attach 进 workspace 的 tmux session（Ctrl-b d 返回）")
  .action((id: string) => {
    const sock = tmuxSocketName()
    const session = tmuxSessionName(id)
    const has = spawnSync("tmux", ["-L", sock, "has-session", "-t", `=${session}`], { stdio: "ignore" })
    if (has.status !== 0)
      fail(`tmux session ${session} 不存在（workspace 可能已归档/尚未创建，或 session 被外力清理；M1 不自动重建——Plan 4 ensure-or-heal）`)
    const r = spawnSync("tmux", ["-L", sock, "attach", "-t", `=${session}`], { stdio: "inherit" })
    process.exit(r.status ?? 0)
  })

program.command("open <wsId>")
  .description("打印 iTerm2 逃生舱命令（GUI 的 Open in iTerm2 按钮复用此命令）")
  .action((id: string) => {
    console.log(`tmux -L ${tmuxSocketName()} attach -t ${tmuxSessionName(id)}`)
  })
```

- [ ] **Step 4: 确认通过** — Run: `bun run test -- packages/cli` → 全 PASS（含既有 e2e 回归——它们现在经 unix socket 走通）；`bun run typecheck` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat(cli): enter/open + initial prompt + unix-socket client + protocol decoding + events tail e2e"
```

---

### Task 15: README 更新 + 全量回归 + 手工 claude 冒烟清单

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README 追加 Plan 3 能力**

在 README 的能力/使用章节后追加（若已有对应小节则合并）：
```markdown
## tmux 链路与 engine（M1 Plan 3）

- workspace = worktree + **tmux session**（`coolie-<wsId>`，专属 socket `tmux -L coolie`）+ engine（window 0，M1 = Claude Code）。
- engine 进程只属于 tmux：server/CLI 死掉不影响正在跑的 engine，重连即恢复。
- `coolie create <repo|projectId> [--slug --name --prompt <text>]`：`--prompt` 在 workspace 就绪后作为首条消息投递（稳定检测→消毒→bracketed paste→Enter）。
- `coolie enter <wsId>`：attach 进 session（Ctrl-b d 返回）；`coolie open <wsId>`：打印 iTerm2 逃生舱命令。
- 结构化状态（tab 徽标 working / awaiting-input / idle）来自 claude hooks 回调 + 转录 mtime 兜底，绝不解析终端画面。
- WS 终端通道：`GET /ws/terminal?workspace=&window=&cols=&rows=&token=`——二进制帧 = PTY 字节，文本帧 = JSON 控制（`{"type":"resize",cols,rows}` / `{"type":"exit",code}`）。
- server 同时监听 `127.0.0.1:<random>` 与 `~/.coolie/coolie.sock`（同一 token；CLI 优先 unix socket）。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `COOLIE_TMUX_SOCKET` | tmux socket 名（`-L`） | `coolie` |
| `COOLIE_CLAUDE_HOME` | claude 数据目录（转录） | `~/.claude` |
| `COOLIE_CLAUDE_BIN` | claude 二进制显式路径 | 多路径自动发现 |
| `COOLIE_CLAUDE_CMD` | engine 启动命令整体覆盖（原样使用，测试/调试用） | 无 |
| `COOLIE_DISABLE_HOOKS` | `1` = 不注入 claude hooks | 注入 |
```

- [ ] **Step 2: 全量回归**

```bash
bun run typecheck && bun run test
```
Expected: typecheck 通过；vitest 全绿（Plan 1/2 存量 + 本计划新增全部用例，0 fail 0 skip）。

随后零泄漏核查：
```bash
tmux -L coolie list-sessions 2>&1 | head -1   # 期望：no server running / error connecting（生产 socket 干净）
ps aux | grep -E "tmux -L coolie-test|tmux attach" | grep -v grep   # 期望：空
```

- [ ] **Step 3: 手工 claude 冒烟清单（真引擎唯一出场点，逐项记录结果）**

1. `bun run --cwd packages/cli . server stop 2>/dev/null; coolie doctor`（经 `npx tsx packages/cli/src/main.ts` 或既有别名）：git/tmux/claude 三行 ok。
2. `coolie create <某个真实 repo 路径> --prompt "用一句话总结这个 repo 的结构"` → `created <园名> (<id>) …`，status active。（若报「首条 prompt 投递失败（画面未稳定）」——claude 首启含版本检查，可能超过 waitStable 的 24×250ms≈6s 预算——`coolie delete <id> --force` 清掉后重跑本步一次即可。）
3. `tmux -L coolie list-sessions` → 看到 `coolie-<id>` 与 `coolie-ctl`（control hub 是**惰性 spawn**，首次发键才出现——step 2 的 --prompt 投递已触发过 sendKey，故此时应在；若 step 2 未带 --prompt 则只见 `coolie-<id>`）。
4. `coolie enter <id>` → 真 claude TUI，首条 prompt 已在输入历史中投递、claude 正在/已经回答；`Ctrl-b d` detach。
5. `coolie events tail --after 0` → 依次看到 `workspace.creating … workspace.tmux.created / tab.created / engine.started / prompt.delivered / engine.turn.started / engine.turn.finished`（后两条 = hooks 注入生效）。
6. `curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/workspaces/<id>/tabs`（token/port 取自 `~/.coolie/server.json`）→ engine tab `status` 在回答中为 `working`、答毕为 `awaiting-input`，`title` 非空（转录派生）。
7. WS 通道：`node -e '
const WebSocket=require("ws");const i=require(process.env.HOME+"/.coolie/server.json");
const ws=new WebSocket(`ws://127.0.0.1:${i.port}/ws/terminal?workspace=<id>&window=0&cols=120&rows=30&token=${i.token}`);
ws.on("message",(d,b)=>b&&process.stdout.write(d));ws.on("open",()=>setTimeout(()=>ws.close(),3000))
'` → 3 秒内滚出 claude TUI 画面字节。
8. `coolie server stop` → `tmux -L coolie has-session -t =coolie-<id>; echo $?` → 0（**engine 归 tmux**）；再 `coolie enter <id>` 自动拉起 server 且画面无损。
9. `coolie archive <id>`（脏树则 `--force`）→ session 消失、branch 保留；`coolie unarchive <id>` 后 `coolie enter <id>` → 明确提示 Plan 4 heal；`coolie delete <id> --force` 清场。
10. 清理验证：`tmux -L coolie list-sessions` 只剩 `coolie-ctl`（或 no server）；`~/.coolie/logs/server.log` 无 ERROR 级意外。

任何一项不符 → 按 superpowers:systematic-debugging 排查后修复再走 Step 2。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README Plan 3 (tmux/engine/WS/unix socket) + manual claude smoke results"
```

---

## Self-Review 记录（writing-plans 自检，作者已跑）

**1. Spec 覆盖对照**

| Spec 要求 | 任务 |
|---|---|
| §五 专属 socket `-L coolie` / session `coolie-<wsId>` / window 布局 | Task 3、11（tabs 表接线 Task 6） |
| §五 node-pty attach + fit/heal + resize 防抖 | Task 10（fit=按客户端初始尺寸 spawn + `window-size latest`；深度 heal 归 Plan 4） |
| §五 持久 control-mode 发键（agent-deck 10–50ms） | Task 4（文本走 load-buffer/paste-buffer -p 的原因已文档化：control 行协议不能携带换行） |
| §五 投递流水线（稳定检测→消毒→bracketed paste→150ms→Enter） | Task 5、11 |
| §五 TERM 环境 / Terminal Identity Boundary | Task 3（sanitizedTmuxEnv，pty/exec/control 三路共用） |
| §五 Open in iTerm2 命令面 | Task 14 `coolie open`（GUI 按钮 Plan 5 复用） |
| §六 identity/capabilities + Noop 降级 | Task 7 |
| §六 launchCommand（model/effort/`--session-id` 客户端造 id/title） | Task 7（claude title=engine-owned；effort=能力位降级） |
| §六 hooksAdapter（幂等/opt-out/POST 回 server/exit 0） | Task 8 |
| §六 turnDetector（hooks 主 + mtime 兜底 → 四态徽标） | Task 7/8/9（error 态产生点=Plan 4 keep-alive，已声明） |
| §六 historyReader（标题派生 + `--resume`） | Task 7（resumeArgs 供 Plan 4 heal 消费）、Task 8（标题落 tabs） |
| §2.3 WS 二进制终端通道 | Task 10（帧协议逐字文档化） |
| §2.1 unix socket 监听（保 token） | Task 12（CLI 侧 Task 14） |
| §八 coolie enter | Task 14 |
| §十二 tmux 首启检测 | Task 3（ENOENT typed error）+ Task 12（启动 version 检测 warn）+ doctor 既有 |
| lifecycle 集成（create 建 session/投 prompt；archive/delete 先拆） | Task 11 |
| ledger carry-overs 九项 | query/body/tail-e2e/decode/seeding/单事务=Task 13、14、6；EventsBusLive=Task 12；runGit finalizer=不适用（Global Constraints 记录）；setup-tab seam=OUT 决定（Global Constraints 记录） |

**2. Placeholder 扫描**：无 TBD/TODO/“类似 Task N”；两处「沿用该文件既有 helper」（daemon.test.ts 的 `startServer`、workspace-e2e 的 repo fixture）为对既有代码的引用而非占位，均给出了引用名与失配时的调整规则。README 为追加块非全文替换（现有内容未知，全文替换反而危险）。

**3. 类型一致性抽查（已修正项如实记录）**：
- session 命名曾在 bootstrap/CLI/main 三处各写一份模板字符串 → 收敛为 protocol 的 `tmuxSessionName`（Task 2 产出，Task 11/12/14 消费），bootstrap 的 `sessionNameFor` 是其 re-export 别名。
- 名池跨项目 seeding 最初写进 Task 11 实现但测试在 Task 13（违反 RED-first）→ 已整体移到 Task 13。
- sanitize 的测试/实现最初含裸控制字符字面量 → 全部改为 `\uXXXX` 显式转义（文档可安全 diff/复制）。
- `PostCreateHook` 二参签名：Task 11 定义，lifecycle 调用点、bootstrap 实现、既有测试适配三处对齐；`PostCreateHooksEmpty` 不受影响。
- `Engine.transcriptPath({home,cwd,sessionId})`：Task 7 定义，Task 8（endpoint）/9（poller）/11（fake engine）消费处签名一致。
- `TmuxServiceShape` 的 target 一律裸名、内部加 `=`：Task 3 定义；Task 4/5/10/11 调用处（`pasteText/sendKey/capturePane` 传 `session:window`）已逐一核对；测试里直接调 tmux CLI 的地方显式写 `=`。
- `AppServices` 两次扩容（Task 8 +TabsRepo/EngineRegistry）后 Runtime 类型在 main.ts（Task 12）同步；既有测试的 `as Effect.Effect<any, never, never>` cast 不受影响。
- CLI e2e 的 tmux 环境隔离放在 Task 12（main.ts 接 bootstrap 的同一提交）而非 Task 14——否则 Task 12 全量回归会污染生产 socket。

**4. Adversarial review 修订（verdict READY-WITH-FIXES，均已折入正文）**：
- F1（Task 4，CRITICAL，审阅者实证复现）：control-mode 的连接守卫块（`new-session -A` 自身的 %begin…%end/%error，每次连接/重连恒最先到）此前只写在注释、代码未处理——settle() 会把它错记给 exec #1，此后全部回复错位一格。已加 `awaitingGuard` 标志：(re)spawn 置位，连接的首个 %end/%error 吞掉不结算；"rejects on %error" 用例由此确定性通过（旧实现必挂）。
- T1（Task 13，CRITICAL）：body-cap 路径原 `reject(...); req.destroy()` 会在 413 写出前撕掉 socket（客户端只见 ECONNRESET，测试断言 413 必挂）。改为卸 data 监听 + `req.resume()` 排空丢弃，连接保持完好让 413 送达；end 的 resolve 在已 reject 后是 no-op。
- Task 11 (d)：低元数 hook lambda（`(ws)=>…`/`()=>…`）在 TS 结构化类型下天然满足 `(ws, ctx)=>…`，lifecycle-create.test.ts 零改动（原「编译错会逐个指出来」说法已删，Files/commit 清单同步移除该文件）。
- Task 12/15：明确 control hub `coolie-ctl` **惰性 spawn**（首次 sendKey 才出现），daemon 裸启动不创建任何 tmux server；冒烟 step 3 的 coolie-ctl 断言标注了触发前提（step 2 的 --prompt 投递）。
- F4（Task 3）：paste buffer 名 `coolie-paste` → `coolie-paste-<random>`（每次投递独立命名 + `-d` 即删），并发 create 的投递互不踩踏。
- Task 15 step 2：补充 claude 首启慢于 waitStable 预算（≈6s）时的操作者重试指引。
