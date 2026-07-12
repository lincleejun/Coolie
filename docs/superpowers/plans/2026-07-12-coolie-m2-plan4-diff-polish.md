# Coolie M2 · Plan 4：行级 diff 视图 + 评论写回 PTY + client 打磨 + web client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把右栏 Changes 从「文件级四分区」升级为「行级 unified diff 视图 + 选行评论 → 组装 prompt → 经 composer 消毒管道写回 engine PTY」，并落地 M1 削减获批的 client 打磨清单（GUI 引擎选择器、409 EngineBusy toast、用户键位 JSON 覆盖、⌘K 命令面板、footer cheatsheet、主题、i18n、附件/图片）与 web client 壳。

**Architecture:** 服务端新增一个只读 unified-diff 端点（复用 `git/inspect.ts` 的 `execFile` 门面，按 section+单文件 pathspec 出 `git diff --unified`）；客户端用一个纯函数 diff 解析器 + 轻量 React 渲染器（**不引入 `@pierre/diffs`**——见决策 D1），行选择 → 纯函数 `formatLineComment` 组装成 markdown 片段，**追加到该 workspace 的 composer 草稿**（复用现有 `@<path>` 注入手法：`drafts.save` + `focusComposer`），最终经既有 `composer→sanitizePromptForPty→PTY` 管道投递——写回不新造投递路径。打磨项各自独立、纯函数优先、可在 node 环境单测；web client 复用 M1 三通道 client，仅把 Tauri 专有面（iTerm2/native titlebar drag/spawn）用 `hasTauri()` 守卫掉，新增一个 `vite build` web 目标。

**Tech Stack:** TypeScript · Node `execFile`（server git 观察面）· React 18 + zustand 5（client）· vitest（`environment: "node"`，纯函数 + store 单测）· Vite（web client 构建目标）· Tauri 2.x（桌面壳，本 plan 只做守卫不新增原生命令）。

## Global Constraints

以下为 spec/roadmap 项目级硬约束，**每个 task 隐含遵守**：

- **绝不自渲染 engine 对话流**（spec §一原则 2）：diff 视图渲染的是 **git diff 文本**（静态文件变更），不是 engine 输出流；composer 仍是 **写-only surface**，回答由 TUI 在终端渲染。
- **写回复用既有管道**：评论写回 **不新造 PTY 写入路径**，一律经 composer 的 `sendInput`（server 侧 `composerOps.input` → `sanitizePromptForPty` → tmux paste-buffer）。消毒是 spec §7.1「diff 行评论 → **消毒** → 写回」的强制环节，由既有 `sanitizePromptForPty` 承担。
- **单一 `HOTKEYS_REGISTRY` 三处同源**（spec §7.3）：绑定 / footer / ⌘/ cheatsheet 三处渲染必须读同一真源；用户 JSON 覆盖后仍须三处同源。
- **引擎能力位驱动 UI**（spec §六）：模型/effort/nativeQueue 等一律读 `config.engines[].capabilities`，禁止在 client 硬编码引擎名做分支。
- **生产数据零污染**：所有测试走临时目录（`COOLIE_*_HOME` / `os.tmpdir()` mkdtemp），套件后真实 `~/.coolie`/`~/.claude`/`~/.codex` 字节级 diff 为空。
- **client 不 import server 包**：只读端点响应形状在 `packages/client/src/stores/types.ts` 里与 `packages/server/src/git/inspect.ts` **同形复制**（既有约定，见 types.ts 头注）。
- **测试环境**：`vitest.config.ts` 已配 `environment: "node"`、`include: packages/*/test/**/*.test.ts`、`testTimeout: 30_000`。client 测试是**纯 node 单测**（无 jsdom）——只测纯函数与 store，不挂载 React DOM。所有 import 用 `.js` 后缀（NodeNext）。
- **视觉自验接缝（Chrome dev seam）**：GUI 视觉工作用 M1 的浏览器接缝 `?server=<port>:<token>`（`packages/client/src/api/discovery.ts`：非 Tauri 环境只 probe 不 spawn）——`bunx vite`（`npm --prefix packages/client run dev:vite`）起前端，Chrome 打开 `http://localhost:5173/?server=<port>:<token>` 连一个已跑的隔离 server，截图自查。凡涉及 UI 的 task 的最后一步都包含「Chrome 截图自验」。

---

## 决策记录（Decisions）

- **D1 · diff 渲染方案选型 → 自撸纯函数解析器 + 极简渲染器，不引入 `@pierre/diffs`。** spec §7.1 把 `@pierre/diffs` 标为「候选（许可需复核）」。裁定不引入，理由：(1) 许可未复核、bundle/CSP 未知——Tauri webview 与 web client 都跑严格环境，新增外部渲染库风险大于收益；(2) 我们只需要「把 `git diff --unified` 解析成 hunk/line + 按 +/−/context 上色 + 支持选行」，这是 ~60 行纯函数 + ~80 行渲染组件，可在 node 环境单测（契合本仓 `sanitize`/`parseNumstat` 的纯函数测试文化）；(3) **载荷是写回语义，不是渲染华丽度**——渲染保持 DRY/极简，解析器与渲染分离，未来要换 `@pierre/diffs` 只需替换 `DiffView` 组件，`parseUnifiedDiff` 契约不动。
- **D2 · 评论写回 prompt 组装格式 → 追加到 composer 草稿，用户复核后再发。** 不直接投 PTY。格式（`formatLineComment` 纯函数产出，`«…»` 为占位符）：
  - `关于 \`<相对路径>\` 第 <start>–<end> 行：`
  - 一段 ` ```diff ` 代码块，逐行 verbatim 选中的 diff 行（含 `+`/`−`/空格前缀）
  - `<用户评论>`

  多条评论在 composer 里累积（复用现有 `@<path>` 注入的 `drafts.save` 追加手法），用户可编辑/删改后按 Enter 走三档发送。理由：复用整条 `sanitize+deliver+queue+skipStable` 机制（DRY）；让用户 batch 多处评论成一条 prompt（Superset 的 review-comments-compose-into-one-prompt 模型）；消毒环节天然由 composer 投递路径承担。
- **D3 · GUI 引擎选择器（Plan 4 第一优先 carry-over）→ Dispatch.tsx 去 `engines[0]` 硬编码 + effort 贯通 create。** 现状 `Dispatch.tsx` 取 `engines[0]` 硬取 claude，导致 codex 已可用但 GUI 造不出 codex workspace。修：加引擎 `<select>` 遍历 `config.engines`；模型/effort 选择器随选中引擎的 `models`/`efforts` 变化；`POST /workspaces` 已接受 `engineId`（Plan 1 落地，见 app.ts:405），本 plan **additively** 把 `effort` 也贯通 create 流水线（`POST /workspaces` 解析 → `create` opts → `PostCreateContext` → `bootstrap` 读 → `startEngineSession` → `launchCommand`；当前 session.ts:29 **丢弃了 effort**，一并修）。effort 是 codex 启动参数（`-c model_reasoning_effort=`，adapter.ts:64），只能创建时定，故必须走 create。
- **D4 · i18n 范围 → 建基础设施 + 转换 Plan 4 新增面与关键 chrome，全量 M1 retranslation 显式延后。** spec/roadmap 要「i18n 文案外置」。全量把每个 M1 组件的中文抽走既巨大又与其它组件改动撞车。裁定：落地 `t(key)` + `zh`/`en` 字典 + 语言 store + 切换 UI，并把**本 plan 新增的全部 UI 文案**与一组代表性 chrome 文案（titlebar/cheatsheet/composer placeholder/offline banner）走 `t()`；其余 M1 文案的迁移沿用同一 `t()` 模式增量补（文档标注）。
- **D5 · web client → 独立末段 task，可降级。** roadmap 明言「web client 是 Plan 4 内最大风险/工作量，若超载可拆末段为 M2.5」。放在 T13（README 前），做成「`hasTauri()` 守卫原生面 + web vite 构建目标 + Chrome 冒烟」的薄壳；若执行时超载，T13 可整体延 M2.5 而不阻塞 T1–T12 与 T14 回归。

---

## File Structure（本计划新建/修改）

**服务端（git 观察面 + create effort 贯通）**
- 修改 `packages/server/src/git/inspect.ts`：新增 `parseSectionArgs`、`fileDiff`，`GitReadOps` 加 `diff`。
- 修改 `packages/server/src/http/app.ts`：git 只读路由正则加 `git/diff` 分支；`POST /workspaces` 解析 `effort`。
- 修改 `packages/server/src/workspace/lifecycle.ts`：`PostCreateContext` 与 `create` opts 加 `effort?`；createCtx/provision 透传。
- 修改 `packages/server/src/repo/workspaces.ts`：`setCreateCtx`/`getCreateCtx` 的形状加 `effort?`（否则 error→retry 会丢 effort，T1 的 retry 集成断言会红）。
- 修改 `packages/server/src/engine/bootstrap.ts`：`startEngineSession` 调用传 `effort: ctx.effort`。
- 修改 `packages/server/src/engine/session.ts`：`StartEngineSessionInput` 加 `effort?`；`launchCommand` 调用传 `effort`（顺带传 `model` 占位，保持与类型一致）。

**客户端（diff + 打磨）**
- 新建 `packages/client/src/rightpanel/diff.ts`：`parseUnifiedDiff`（纯）。
- 新建 `packages/client/src/rightpanel/comment.ts`：`formatLineComment`（纯）+ `injectComment`（草稿追加 wiring）。
- 新建 `packages/client/src/rightpanel/DiffView.tsx`：行级 diff 渲染 + 选行 + 评论输入。
- 修改 `packages/client/src/rightpanel/RightPanel.tsx`：文件行可点开 DiffView。
- 修改 `packages/client/src/stores/types.ts`：加 `FileDiff`、`EngineInfo.efforts?`。
- 修改 `packages/client/src/stores/data.ts`：`sendInput` 识别 409 EngineBusy → toast（不 throw 到 alert）。
- 修改 `packages/client/src/composer/Composer.tsx`：`deliver` 的 catch 分流 EngineBusy。
- 修改 `packages/client/src/composer/Dispatch.tsx`：引擎/模型/effort 选择器（D3）。
- 新建 `packages/client/src/settings/keybindings.ts`：用户 JSON 覆盖 → 有效 registry（纯）。
- 修改 `packages/client/src/hotkeys/registry.ts`：`byChord`/`resolveHotkey` 读有效 registry；加 `app.commandPalette`、`app.settings`。
- 修改 `packages/client/src/hotkeys/useGlobalHotkeys.ts`：绑定 `app.commandPalette`。
- 新建 `packages/client/src/chrome/CommandPalette.tsx`：⌘K 面板。
- 新建 `packages/client/src/chrome/Footer.tsx`：底部 cheatsheet 条。
- 新建 `packages/client/src/settings/theme.ts`：`applyTheme`（纯）+ store 接线。
- 新建 `packages/client/src/i18n/index.ts` + `packages/client/src/i18n/dict.ts`：`t()` + zh/en 字典 + 语言 store。
- 新建 `packages/client/src/settings/settings.ts`：统一 settings store（theme + lang + 已加载的 keybinding 覆盖）。
- 新建 `packages/client/src/composer/attachments.ts`：图片 → base64 → POST → 插路径（纯组装 + wiring）。
- 修改 `packages/server/src/http/app.ts`：新增 `POST /workspaces/:id/attachments`（写临时目录，回 `{ path }`）。
- 修改 `packages/client/src/App.tsx`、`packages/client/src/chrome/Titlebar.tsx`、`packages/client/src/styles.css`：挂载 palette/footer、主题切换按钮、样式（**App.tsx / styles.css 为共享文件，见波次纪律**）。
- 新建 `packages/client/vite.web.config.ts`：web 构建配置（**复用既有 `index.html` + `src/main.tsx` 为入口**——见 MED-2 决策，不新造 `web.tsx`；web 与桌面唯一实质差异是 `__COOLIE_SERVER_CMD__` define 置空，web 永不 spawn daemon）。
- 修改 `packages/client/package.json`：加 `build:web`/`dev:web` 脚本。

**测试（新建）**
- `packages/server/test/git-inspect.test.ts`（加 `fileDiff` 用例）、`packages/server/test/http-gitread.test.ts`（加 `git/diff` 路由用例）。
- `packages/client/test/diff-parse.test.ts`、`comment-format.test.ts`、`keybindings.test.ts`、`theme.test.ts`、`i18n.test.ts`、`attachments.test.ts`、`engine-select.test.ts`、`command-palette.test.ts`、`engine-busy-toast.test.ts`。

**文档**
- 修改 `README.md`：diff 评论写回 + 打磨清单 + web client 运行说明。

---

## Task Order / 波次并行

```
Wave A（文件不相交，可并行）  T1 引擎/effort 选择器   T2 server unified-diff 端点   T3 409 EngineBusy toast
Wave B（diff 流水线，顺序）    T4 diff 解析器(纯) → T5 DiffView+RightPanel → T6 评论写回组装
Wave C（chrome 打磨；registry/App.tsx/styles.css 串行）
                              T7 键位 JSON 覆盖 → T8 ⌘K 面板 → T9 footer → T10 主题 → T11 i18n → T12 附件
Wave D                        T13 web client 壳 → T14 README+回归+GUI 冒烟
```

**波次纪律（承 M1 P5「共享文件串行段」）**：
- `packages/client/src/App.tsx` 由 T8/T9/T10/T13 触碰 → **严格串行**，每个 task 只加自己那一行挂载/守卫，改前先 `git pull`/rebase 到最新。
- `packages/client/src/styles.css` 由 T5/T8/T9/T10/T11 追加样式 → **只追加不改行**，各 task 样式块加显式注释头（`/* T5 diff */` 等）。
- `packages/client/src/hotkeys/registry.ts` 由 T7（覆盖机制）、T8（新 chord）触碰 → T7 先 T8 后。
- `packages/server/src/http/app.ts` 由 T1（POST effort）、T2（git/diff 路由）、T12（attachments 路由）触碰——三处互不相邻的代码块，Wave A 的 T1/T2 并行时注意 rebase；T12 在 Wave C，届时前二者已合。
- **`packages/client/src/composer/Dispatch.tsx` 是跨-plan 共享文件（本 plan T1 ⨯ Plan 3 fan-out T11）——BINDING controller 裁定：**
  - **本 plan 的 T1 是 Dispatch.tsx 的 canonical owner**：T1 对 `DispatchPanel` 做**整体重写**（去 `engines[0]` 硬编码 → 引擎/模型/effort 选择器）并**导出纯函数 `buildCreateBody`**。
  - **Plan 3 的 fan-out T11 在 T1 合并之后执行**，在 T1 重写后的 `DispatchPanel` 形状上叠加（fan-out 目标多选等），**不得**基于 M1 旧 `engines[0]` 形状改，改前必 rebase 到含 T1 的分支。
  - **`buildCreateBody` 的导出签名保持稳定**（`(i: CreateBodyInput) => Record<string, string>`，`CreateBodyInput = { projectId; engineId; prompt; effort; model }`）——**Plan 3 消费它**组装 fan-out 各子 workspace 的 create body；T1 若后续要动这个签名，须先同步 Plan 3。

---

### Task 1: GUI 引擎选择器 + effort 贯通 create（carry-over 第一优先）

> **⚠️ 跨-plan 共享文件 · BINDING controller 裁定（读「波次纪律」Dispatch.tsx 条）：本 T1 是 `packages/client/src/composer/Dispatch.tsx` 的 canonical owner，对 `DispatchPanel` 做整体重写并导出 `buildCreateBody`。Plan 3 的 fan-out T11 在本 T1 合并之后、在重写后的形状上叠加——不得基于 M1 旧 `engines[0]` 形状动手。`buildCreateBody` 的导出签名（`(i: CreateBodyInput) => Record<string, string>`）保持稳定，Plan 3 消费它组装 fan-out 子 workspace 的 create body。**

**Files:**
- Modify: `packages/server/src/engine/session.ts`（`StartEngineSessionInput` 加 `effort?`；launchCommand 传 effort）
- Modify: `packages/server/src/engine/bootstrap.ts:125-127`（startEngineSession 传 `effort: ctx.effort`）
- Modify: `packages/server/src/workspace/lifecycle.ts:21,30-31,169-177`（`PostCreateContext`/opts/createCtx/provision 加 `effort`）
- Modify: `packages/server/src/repo/workspaces.ts:36-37,100-114`（`setCreateCtx`/`getCreateCtx` 形状加 `effort?` + 存/取——retry 保 effort）
- Modify: `packages/server/src/http/app.ts:396-420`（`POST /workspaces` 校验/解析 `effort`）
- Modify: `packages/server/src/engine/session.ts`（见下 Step 3）
- Modify: `packages/server/src/engine/bootstrap.ts:125-127`（`startEngineSession` 传 `effort`）
- Modify: `packages/client/src/stores/types.ts`（`EngineInfo` 加 `efforts?: string[]`）
- Modify: `packages/client/src/composer/Dispatch.tsx`（**整体重写 `DispatchPanel`** + 导出 `buildCreateBody`——canonical owner，见上方裁定）
- Test: `packages/client/test/engine-select.test.ts`、`packages/server/test/http-create-effort.test.ts`（**真集成测试**：HTTP `POST /workspaces {engineId,effort}` → create → bootstrap → fake engine 记录 `launchCommand({effort})`，含 retry 保 effort，见 Step 1）

**Interfaces:**
- Consumes: `config.engines[]`（`GET /config` 已下发 `{id,displayName,capabilities,models,efforts?}`，app.ts:475-482）；`POST /workspaces` 已接受 `engineId`（app.ts:405）。
- Produces:
  - Server `StartEngineSessionInput.effort?: string`；`PostCreateContext.effort?: string`；`create(opts: {..., effort?: string})`。
  - Client `EngineInfo.efforts?: readonly string[]`。

- [ ] **Step 1: Write the failing INTEGRATION test（HTTP + lifecycle 全链贯通 + retry）**

Create `packages/server/test/http-create-effort.test.ts`. **这是真集成测试**（不是纯贯通点单测）：起真 http server + 真 lifecycle 层（真 git worktree、真 tmux socket、fake codex），`POST /workspaces {engineId:"codex", effort:"high"}` 走 `createApp → WorkspaceLifecycle.create → provision → EngineBootstrapHook → startEngineSession → engine.launchCommand({effort})`，fake codex 的 `launchCommand` 把收到的 effort 记进 `launchEfforts` 断言 `"high"` 落到底。retry 分支用「首启 tmux newSession 失败一次」把 create 打到 `error`，再 `POST /retry`，断言 effort 熬过 `data.createCtx` round-trip 仍到 launchCommand。harness 结构镜像 `bootstrap-prompt-gate.test.ts`。

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Effect, Layer } from "effect"
import { EventEmitter } from "node:events"
import * as http from "node:http"
import Database from "better-sqlite3"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { TabsRepoLive } from "../src/repo/tabs.js"
import { GitServiceLive } from "../src/git/service.js"
import { SetupRunnerLive } from "../src/workspace/setup.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive } from "../src/workspace/lifecycle.js"
import { EngineRegistry } from "../src/engine/registry.js"
import type { Engine } from "../src/engine/types.js"
import { EngineBootstrapHookLive } from "../src/engine/bootstrap.js"
import { makeTmuxService, TmuxService, TmuxError } from "../src/tmux/service.js"
import { EventsBus } from "../src/events/bus.js"
import { createApp, newToken } from "../src/http/app.js"

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-eff`
const realTmux = makeTmuxService(SOCK)
let home: string, wsRoot: string, repoRoot: string, db: Database.Database, projectId: string
let port = 0, token = "", server: http.Server
const bus = new EventEmitter(); bus.setMaxListeners(0)

// launchCommand 每次调用记下收到的 effort（含首启失败尝试与 retry 尝试）
const launchEfforts: Array<string | undefined> = []
const fakeCodex: Engine = {
  id: "codex", displayName: "Fake Codex (effort-recording)",
  capabilities: { nativeQueue: false, midSessionModelSwitch: true, resume: true, hooks: true, effort: true },
  terminalTitle: "engine-owned",
  efforts: ["low", "medium", "high"],
  newSessionId: () => `codex-${Math.random().toString(36).slice(2, 8)}`,
  launchCommand: (o: { effort?: string }) => { launchEfforts.push(o.effort); return ["/bin/bash", "-c", "exec cat"] },
  statusFromHookEvent: () => null,
  transcriptPath: ({ home: h, sessionId }) => path.join(h, `${sessionId}.jsonl`),
  deriveTitle: () => null,
  resumeArgs: (s) => ["resume", s],
}

// 首启失败注入：failNextNewSession=true 时下一次 newSession 返回 TmuxError（→ HookError → create 落 error）
let failNextNewSession = false
const recordingTmux: TmuxService = {
  ...realTmux,
  newSession: (opts) =>
    failNextNewSession
      ? ((failNextNewSession = false), Effect.fail(new TmuxError({ op: "new-session", message: "injected fail", exitCode: 1, stderr: "" })))
      : realTmux.newSession(opts),
}

const buildRuntimeLayer = () => {
  const cfgLayer = Layer.succeed(CoolieConfig, {
    home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
    workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"), codexHome: path.join(home, "codex-home"),
    promptReadyTimeoutMs: 4000,
  })
  return WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(EngineBootstrapHookLive),
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive, SetupRunnerLive,
      Layer.succeed(TmuxService, recordingTmux),
      Layer.succeed(EngineRegistry, new Map([[fakeCodex.id, fakeCodex]])),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
    Layer.provideMerge(Layer.succeed(EventsBus, bus)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(cfgLayer),
  )
}

const req = async (method: string, pathname: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-eff-home-"))
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-eff-ws-"))
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-eff-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repoRoot })
  db = new Database(":memory:"); runMigrations(db)
  const layer = buildRuntimeLayer()
  const runtime = (eff: any) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, never, never>)
  // 种一个 project（repo 直插；workspace 走 HTTP）
  projectId = await Effect.runPromise(Effect.provide(
    Effect.gen(function* () { return (yield* (yield* ProjectsRepo).add(repoRoot)).id }),
    ProjectsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db))),
  ) as Effect.Effect<string, never, never>)
  token = newToken()
  server = http.createServer(createApp({ runtime, token, onShutdown: () => {}, codexHome: path.join(home, "codex-home") }))
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  port = (server.address() as { port: number }).port
})
afterAll(() => {
  server?.close()
  try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ }
})

describe("effort 经 HTTP+lifecycle 全链贯通到 engine.launchCommand", () => {
  it("POST /workspaces {engineId:codex, effort:high} → launchCommand 收到 effort:high", async () => {
    launchEfforts.length = 0
    const r = await req("POST", "/workspaces", { projectId, engineId: "codex", effort: "high", name: "eff-happy" })
    expect(r.status).toBe(201)
    expect(launchEfforts).toContain("high")
  })

  it("effort 缺省 → launchCommand 收到 undefined（不硬塞）", async () => {
    launchEfforts.length = 0
    const r = await req("POST", "/workspaces", { projectId, engineId: "codex", name: "eff-none" })
    expect(r.status).toBe(201)
    expect(launchEfforts).toContain(undefined)
    expect(launchEfforts).not.toContain("high")
  })

  it("effort 非字符串 → 400（校验早于 create）", async () => {
    const r = await req("POST", "/workspaces", { projectId, engineId: "codex", effort: 3, name: "eff-bad" })
    expect(r.status).toBe(400)
  })

  it("retry 保 effort：首启失败落 error → POST /retry，launchCommand 仍见 high（effort 熬过 createCtx round-trip）", async () => {
    failNextNewSession = true
    launchEfforts.length = 0
    const c = await req("POST", "/workspaces", { projectId, engineId: "codex", effort: "high", name: "eff-retry" })
    expect(c.status).toBeGreaterThanOrEqual(400)              // create 失败（HookError → 5xx）
    expect(launchEfforts).toContain("high")                   // 首启已把 effort 交给 launchCommand（在 newSession 失败之前）
    const wsId = (db.prepare("SELECT id FROM workspaces WHERE name = 'eff-retry'").get() as any).id
    expect((db.prepare("SELECT status FROM workspaces WHERE id = ?").get(wsId) as any).status).toBe("error")

    launchEfforts.length = 0                                  // 只看 retry 这次是否仍带 effort
    const rr = await req("POST", `/workspaces/${wsId}/retry`, {})
    expect(rr.status).toBe(200)
    expect(launchEfforts).toContain("high")                   // getCreateCtx 回填 effort → launchCommand 再见 high
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/http-create-effort.test.ts`
Expected: FAIL —（`effort` 未在 `StartEngineSessionInput`/`PostCreateContext`/createCtx/app 校验里贯通 → `launchEfforts` 不含 `"high"`，非字符串用例也不 400；typecheck 亦报 `effort` 不在类型）。

- [ ] **Step 3: Thread effort through session.ts**

在 `packages/server/src/engine/session.ts` 的 `StartEngineSessionInput` 加字段，并把 effort/model 交给 launchCommand：

```typescript
export interface StartEngineSessionInput {
  readonly ws: Workspace
  readonly repoRoot: string
  readonly engine: Engine
  readonly sessionId: string | null   // F7：codex=null（服务端造 id）；claude=uuid
  readonly resume: boolean
  readonly home: string
  readonly effort?: string            // 创建时 reasoning effort（codex；claude launchCommand 忽略）
  readonly model?: string             // 预留：创建时模型（当前 GUI 走 /model 后置切换，此处占位保持类型完整）
}
```

把 session.ts:29 改为：

```typescript
    const engineCommand = i.engine.launchCommand({
      sessionId: i.sessionId ?? "", resume: i.resume,
      ...(i.effort !== undefined ? { effort: i.effort } : {}),
      ...(i.model !== undefined ? { model: i.model } : {}),
    })
```

> 注：集成测试此时仍红——effort 尚未从 create opts 贯通到 ctx/createCtx/bootstrap。继续 Step 4 把整条流水线接通。

- [ ] **Step 4: Thread effort through create pipeline（lifecycle + repo createCtx + bootstrap + app）**

`packages/server/src/workspace/lifecycle.ts`：

- L21：`export interface PostCreateContext { readonly initialPrompt?: string; readonly engineId?: string; readonly effort?: string }`
- L30-31 create 签名：`projectId: string; branchSlug?: string; name?: string; initialPrompt?: string; engineId?: string; effort?: string`
- L170-173 setCreateCtx spread 加：`...(opts.effort !== undefined ? { effort: opts.effort } : {}),`
- L175-177 provision spread 加：`...(opts.effort !== undefined ? { effort: opts.effort } : {}),`

`packages/server/src/engine/bootstrap.ts:125-127`，startEngineSession 调用加 effort：

```typescript
        const { engineCommand } = yield* startEngineSession(tmux, {
          ws, repoRoot: project.repoRoot, engine, sessionId, resume: false, home: cfg.home,
          ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
        }).pipe(Effect.mapError((e) => new HookError({ message: `tmux session 创建失败：${e.message}` })))
```

`packages/server/src/http/app.ts` `POST /workspaces`（L396-420）：校验加

```typescript
          if (body.effort !== undefined && typeof body.effort !== "string")
            return err(res, 400, "Validation", "effort must be a string")
```

create 调用 spread 加：`...(body.effort ? { effort: body.effort } : {}),`

`packages/server/src/repo/workspaces.ts`（**retry 保 effort 的关键**——不改这里 effort 会在 error→retry 时被 createCtx 丢弃，集成测试 retry 用例会红）：

- L36-37 接口形状加 `effort?`：

```typescript
  readonly setCreateCtx: (id: string, ctx: { initialPrompt?: string; engineId?: string; effort?: string }) => Effect.Effect<void, NotFoundError>
  readonly getCreateCtx: (id: string) => Effect.Effect<{ initialPrompt?: string; engineId?: string; effort?: string }, NotFoundError>
```

- L100-103 `setCreateCtx` 的 `data.createCtx` spread 加：

```typescript
          ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
```

- L110 `getCreateCtx` 的 cast 与 return spread 加 effort：

```typescript
        const c = (data.createCtx ?? {}) as { initialPrompt?: unknown; engineId?: unknown; effort?: unknown }
        return {
          ...(typeof c.initialPrompt === "string" ? { initialPrompt: c.initialPrompt } : {}),
          ...(typeof c.engineId === "string" ? { engineId: c.engineId } : {}),
          ...(typeof c.effort === "string" ? { effort: c.effort } : {}),
        }
```

- [ ] **Step 5: Run integration test to verify it passes**

Run: `npx vitest run packages/server/test/http-create-effort.test.ts`
Expected: PASS（happy/缺省/非字符串-400/retry-保-effort 四用例全绿）。

- [ ] **Step 6: Write the failing test（client 引擎选择器纯逻辑）**

`Dispatch.tsx` 的选择器逻辑抽一个纯 helper 到组件内不便单测——改为在 `Dispatch.tsx` 顶部导出一个纯函数并单测它：

Create `packages/client/test/engine-select.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { buildCreateBody } from "../src/composer/Dispatch.js"

describe("buildCreateBody（引擎/模型/effort → POST body）", () => {
  it("默认引擎无 effort → body 只含 projectId+engineId+prompt", () => {
    expect(buildCreateBody({ projectId: "p1", engineId: "claude", prompt: "hi", effort: "default", model: "default" }))
      .toEqual({ projectId: "p1", engineId: "claude", initialPrompt: "hi" })
  })
  it("codex + effort=high → body 带 effort", () => {
    expect(buildCreateBody({ projectId: "p1", engineId: "codex", prompt: "go", effort: "high", model: "default" }))
      .toEqual({ projectId: "p1", engineId: "codex", initialPrompt: "go", effort: "high" })
  })
  it("effort/model=default（哨兵）不进 body", () => {
    const b = buildCreateBody({ projectId: "p1", engineId: "codex", prompt: "x", effort: "default", model: "default" })
    expect("effort" in b).toBe(false)
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run packages/client/test/engine-select.test.ts`
Expected: FAIL —「buildCreateBody is not a function」。

- [ ] **Step 8: Implement Dispatch selectors + buildCreateBody**

在 `packages/client/src/composer/Dispatch.tsx` 顶部（`import` 后）加导出纯函数：

```typescript
export interface CreateBodyInput { projectId: string; engineId: string; prompt: string; effort: string; model: string }
export const buildCreateBody = (i: CreateBodyInput): Record<string, string> => ({
  projectId: i.projectId,
  engineId: i.engineId,
  initialPrompt: i.prompt,
  ...(i.effort !== "default" ? { effort: i.effort } : {}),
  // model=default 走引擎默认；非 default 由创建后 /model 切换（midSessionModelSwitch），不进 create body
})
```

改 `DispatchPanel`：把 `const claude = engines[0]` 换成 engine 选择态，并渲染引擎/模型/effort 三个 `<select>`（engine 决定后两者的可选项与可见性）：

```typescript
export const DispatchPanel = () => {
  const projects = useData((s) => s.projects)
  const engines = useData((s) => s.config?.engines ?? [])
  const projectId = useUi((s) => s.dispatchProjectId) ?? projects[0]?.id ?? null
  const [engineId, setEngineId] = useState(engines[0]?.id ?? "claude")
  const engine = engines.find((e) => e.id === engineId) ?? engines[0]
  const [model, setModel] = useState("default")
  const [effort, setEffort] = useState("default")
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = (prompt: string): void => {
    const api = useData.getState().getApi()
    if (!api || !projectId || !engine || creating) return
    setCreating(true); setErr(null)
    void (async () => {
      try {
        const body = buildCreateBody({ projectId, engineId: engine.id, prompt, effort, model })
        const ws = await api.req("POST", "/workspaces", body)
        useUi.getState().selectWs(ws.id)
        if (model !== "default" && engine.capabilities.midSessionModelSwitch)
          void deliverModelSwitch(ws.id, model, true).catch(() => {})
      } catch (e: any) {
        setErr(e?.message ?? String(e))
      } finally { setCreating(false) }
    })()
  }

  return (
    <div className="dispatch">
      <div className="dispatch-head">
        <h2>新 Workspace</h2>
        <button className="dim" onClick={() => useUi.getState().setDispatchMode(false)}>Esc 取消</button>
      </div>
      <div className="dispatch-row">
        <label>项目</label>
        <select value={projectId ?? ""} onChange={(e) => {
          drafts.carry(`dispatch:${projectId ?? "none"}`, `dispatch:${e.target.value}`)
          useUi.getState().setDispatchMode(true, e.target.value)
        }}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label>引擎</label>
        <select value={engineId} onChange={(e) => { setEngineId(e.target.value); setModel("default"); setEffort("default") }}>
          {engines.map((en) => <option key={en.id} value={en.id}>{en.displayName}</option>)}
        </select>
        {engine && engine.models.length > 0 && (
          <>
            <label>模型</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="default">默认</option>
              {engine.models.map((m) => <option key={m} value={m}>{engine.displayName}·{m}</option>)}
            </select>
          </>
        )}
        {engine && engine.capabilities.effort && engine.efforts && engine.efforts.length > 0 && (
          <>
            <label>effort</label>
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="default">默认</option>
              {engine.efforts.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </>
        )}
      </div>
      {err && <div className="dispatch-err">创建失败：{err}（左栏 error 项可 Retry）</div>}
      {creating
        ? <div className="dispatch-busy">◌ 创建中…（fetch worktree → setup → tmux → engine → 投递首条 prompt）</div>
        : <Composer wsId={`dispatch:${projectId ?? "none"}`} onSubmitOverride={submit}
            placeholder="描述任务… Enter 创建 workspace 并作为首条 prompt 投递" />}
    </div>
  )
}
```

在 `packages/client/src/stores/types.ts` 的 `EngineInfo` 加 `efforts?: readonly string[]`：

```typescript
export interface EngineInfo {
  id: string; displayName: string
  capabilities: { nativeQueue: boolean; midSessionModelSwitch: boolean; resume: boolean; hooks: boolean; effort: boolean }
  models: string[]
  efforts?: readonly string[]
}
```

- [ ] **Step 9: Run tests + typecheck**

Run: `npx vitest run packages/client/test/engine-select.test.ts packages/server/test/http-create-effort.test.ts`
Expected: PASS
Run: `npm run typecheck`（或 `npx tsc -b`）
Expected: 双 typecheck 清洁。

- [ ] **Step 10: Chrome 截图自验（引擎选择器）**

起隔离 server + vite，Chrome 打开 `?server=<port>:<token>`，`Cmd+N` 开 dispatch，确认引擎下拉含 claude+codex，切到 codex 后出现 effort 下拉。截图存 scratchpad。

- [ ] **Step 11: Commit**

```bash
git add packages/server/src/engine/session.ts packages/server/src/engine/bootstrap.ts packages/server/src/workspace/lifecycle.ts packages/server/src/repo/workspaces.ts packages/server/src/http/app.ts packages/client/src/composer/Dispatch.tsx packages/client/src/stores/types.ts packages/client/test/engine-select.test.ts packages/server/test/http-create-effort.test.ts
git commit -m "feat(client): GUI 引擎选择器 + effort 贯通 create（codex 可 GUI 创建，含 retry 保 effort）"
```

---

### Task 2: server unified-diff 端点（`GET /workspaces/:id/git/diff`）

**Files:**
- Modify: `packages/server/src/git/inspect.ts`（`FileDiff`、`sectionDiffArgs`、`fileDiff`、`isSafeRelPath`、`GitReadOps.diff`）
- Modify: `packages/server/src/http/app.ts:488-513`（git 只读路由加 `git/diff` + query 解析；**param-400 早于 ws-active-409**）
- Test: `packages/server/test/git-inspect.test.ts`、`packages/server/test/http-gitread.test.ts`

**Interfaces:**
- Consumes: `run(cwd, args)`（inspect.ts:15）、`ws.path`、`ws.baseRef`。
- Produces:
  - `interface FileDiff { path: string; section: DiffSection; unified: string; binary: boolean }`
  - `type DiffSection = "againstBase" | "committed" | "staged" | "unstaged"`
  - `GitReadOps.diff(worktree, baseRef, section, path): Promise<FileDiff>`
  - 路由 `GET /workspaces/:id/git/diff?section=<...>&path=<relpath>` → 200 `FileDiff`。

- [ ] **Step 1: Write the failing test（sectionDiffArgs + fileDiff）**

在 `packages/server/test/git-inspect.test.ts` 追加：

```typescript
import { sectionDiffArgs, fileDiff, isSafeRelPath } from "../src/git/inspect.js"

describe("sectionDiffArgs（section → git diff 参数）", () => {
  it("四个 section 各自映射（单文件 pathspec 在 -- 后）", () => {
    expect(sectionDiffArgs("againstBase", "BASE", "src/a.ts")).toEqual(["diff", "--unified=3", "BASE", "--", "src/a.ts"])
    expect(sectionDiffArgs("committed", "BASE", "src/a.ts")).toEqual(["diff", "--unified=3", "BASE", "HEAD", "--", "src/a.ts"])
    expect(sectionDiffArgs("staged", "BASE", "src/a.ts")).toEqual(["diff", "--unified=3", "--cached", "--", "src/a.ts"])
    expect(sectionDiffArgs("unstaged", "BASE", "src/a.ts")).toEqual(["diff", "--unified=3", "--", "src/a.ts"])
  })
})

describe("isSafeRelPath（pathspec 守卫，与 attachments 守卫同源精神）", () => {
  it("放行仓内相对路径（含 /）", () => {
    expect(isSafeRelPath("a.txt")).toBe(true)
    expect(isSafeRelPath("src/a/b.ts")).toBe(true)
  })
  it("拒空/绝对/穿越/反斜杠/前导-（option 注入）", () => {
    expect(isSafeRelPath("")).toBe(false)
    expect(isSafeRelPath("/etc/passwd")).toBe(false)
    expect(isSafeRelPath("../../etc/passwd")).toBe(false)
    expect(isSafeRelPath("src/../../../x")).toBe(false)
    expect(isSafeRelPath("a\\b")).toBe(false)
    expect(isSafeRelPath("--output=x")).toBe(false)
  })
})

describe("fileDiff against real repo", () => {
  // 复用文件顶部已建的 repo/base fixture（见既有 "against real repo" describe）；此处新建一份独立 fixture：
  it("改一行 → unified 含 @@ 与 +/- 行，binary=false", async () => {
    const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path")
    const { execFileSync } = await import("node:child_process")
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-fd-"))
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo })
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n"); g("add", "."); g("commit", "-qm", "init")
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim()
    fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\n")
    const fd = await fileDiff(repo, base, "unstaged", "a.txt")
    expect(fd.binary).toBe(false)
    expect(fd.unified).toContain("@@")
    expect(fd.unified).toContain("+TWO")
    fs.rmSync(repo, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/git-inspect.test.ts`
Expected: FAIL —「sectionDiffArgs is not exported / fileDiff is not a function」。

- [ ] **Step 3: Implement fileDiff in inspect.ts**

在 `packages/server/src/git/inspect.ts` 追加（`listFiles` 之后、`GitReadOps` 之前）：

```typescript
export type DiffSection = "againstBase" | "committed" | "staged" | "unstaged"
export interface FileDiff { path: string; section: DiffSection; unified: string; binary: boolean }

/** section → `git diff` 参数（单文件 pathspec 放在 `--` 之后，防路径被当作 revision）。 */
export const sectionDiffArgs = (section: DiffSection, baseRef: string, path: string): string[] => {
  const U = "--unified=3"
  switch (section) {
    case "againstBase": return ["diff", U, baseRef, "--", path]
    case "committed":   return ["diff", U, baseRef, "HEAD", "--", path]
    case "staged":      return ["diff", U, "--cached", "--", path]
    case "unstaged":    return ["diff", U, "--", path]
  }
}

const DIFF_SECTIONS: ReadonlySet<string> = new Set(["againstBase", "committed", "staged", "unstaged"])
export const isDiffSection = (s: string): s is DiffSection => DIFF_SECTIONS.has(s)

/** 相对路径 pathspec 守卫（与 attachments basename 守卫同源精神：拒穿越/绝对/选项注入）。
 * 允许 `src/a.ts` 这类含 `/` 的仓内相对路径；拒空、绝对、任何 `..` 段、反斜杠、前导 `-`（option 注入）。
 * 注：`sectionDiffArgs` 已把 path 放在 `--` 之后，本守卫是纵深防御的第二层。 */
export const isSafeRelPath = (p: string): boolean => {
  if (p === "" || p.startsWith("/") || p.startsWith("-") || p.includes("\\") || p.includes("\0")) return false
  return !p.split("/").some((seg) => seg === "..")
}

export const fileDiff = async (worktree: string, baseRef: string, section: DiffSection, path: string): Promise<FileDiff> => {
  const unified = await run(worktree, sectionDiffArgs(section, baseRef, path))
  // 二进制：git 输出 "Binary files ... differ"（无 @@ hunk）。untracked 文件不在四 section 内（仍未 add），不走本端点。
  const binary = /^Binary files .* differ$/m.test(unified) || (unified.includes("GIT binary patch"))
  return { path, section, unified, binary }
}
```

`GitReadOps` 接口加：

```typescript
export interface GitReadOps {
  diffstat(worktree: string, baseRef: string): Promise<DiffStat>
  changes(worktree: string, baseRef: string): Promise<ChangesReport>
  files(worktree: string): Promise<string[]>
  diff(worktree: string, baseRef: string, section: DiffSection, path: string): Promise<FileDiff>
}
export const realGitRead: GitReadOps = { diffstat: diffShortstat, changes: collectChanges, files: listFiles, diff: fileDiff }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/git-inspect.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing route test**

在 `packages/server/test/http-gitread.test.ts` 追加一个 `git/diff` 用例（沿用文件既有的 app + 假 gitRead 装配手法——复制该文件顶部建 app 的 helper，注入一个带 `diff` 的假 gitRead）：

```typescript
it("GET /workspaces/:id/git/diff?section=unstaged&path=a.txt → 200 FileDiff", async () => {
  const fakeGitRead = {
    diffstat: async () => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
    changes: async () => ({ againstBase: [], committed: [], staged: [], unstaged: [], untracked: [] }),
    files: async () => [],
    diff: async (_w: string, _b: string, section: string, path: string) =>
      ({ path, section, unified: "@@ -1 +1 @@\n-one\n+ONE\n", binary: false }),
  }
  // ...用本文件既有 makeTestApp(...) 传入 gitRead: fakeGitRead、一个 active workspace（同既有用例）...
  const r = await request("GET", `/workspaces/${wsId}/git/diff?section=unstaged&path=a.txt`)
  expect(r.status).toBe(200)
  expect(r.body.unified).toContain("+ONE")
  expect(r.body.section).toBe("unstaged")
})

it("git/diff 缺 path → 400", async () => {
  const r = await request("GET", `/workspaces/${wsId}/git/diff?section=unstaged`)
  expect(r.status).toBe(400)
})

it("git/diff 坏 section → 400", async () => {
  const r = await request("GET", `/workspaces/${wsId}/git/diff?section=bogus&path=a.txt`)
  expect(r.status).toBe(400)
})

it("git/diff 路径穿越 → 400（pathspec 守卫）", async () => {
  const r = await request("GET", `/workspaces/${wsId}/git/diff?section=unstaged&path=${encodeURIComponent("../../etc/passwd")}`)
  expect(r.status).toBe(400)
})

it("param-400 早于 ws 检查：坏 section + 不存在的 ws → 400（不是 404/409）", async () => {
  // 证明 query 校验发生在 WorkspacesRepo.get/active 检查之前——param 非法即刻 400，压根不查 ws。
  const r = await request("GET", `/workspaces/nonexistent-ws-id/git/diff?section=bogus&path=a.txt`)
  expect(r.status).toBe(400)
})
```

> 实现者：复制本测试文件顶部现有的 app 装配（`createApp({ ..., gitRead })` + 建 active workspace + bearer token）到这两个用例可见的作用域；`request`/`wsId`/token 的取法照抄同文件既有 `git/changes` 用例。

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/server/test/http-gitread.test.ts`
Expected: FAIL — 404（路由未加）。

- [ ] **Step 7: Add git/diff route in app.ts**

把 `packages/server/src/http/app.ts:488` 的正则从

```typescript
        const gitRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/(git\/diffstat|git\/changes|files|commands)$/)
```

改为（加 `git/diff`）：

```typescript
        const gitRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/(git\/diffstat|git\/changes|git\/diff|files|commands)$/)
```

**关键：query 校验（400）必须早于 `runRoute` 里的 ws 存在/active 检查（404/409）。** 把整个 `if (req.method === "GET" && gitRoute)` 块（app.ts:489-513）替换为下面版本——git/diff 的 section/path 校验提到 `runRoute` 之前，success 回调只在 ws 已确认 active 后取 diff：

```typescript
        if (req.method === "GET" && gitRoute) {
          const wsId = gitRoute[1]!
          const kind = gitRoute[2]!
          if (kind !== "commands" && !gitRead) return err(res, 501, "Internal", "gitRead unavailable")
          // git/diff 的 query 校验先于下面的 ws 存在/active 检查（param-400 早于 404/409）
          let diffSection: DiffSection = "againstBase"
          let diffPath = ""
          if (kind === "git/diff") {
            const s = url.searchParams.get("section") ?? ""
            diffPath = url.searchParams.get("path") ?? ""
            if (!isDiffSection(s)) return err(res, 400, "Validation", "section 必须是 againstBase|committed|staged|unstaged")
            if (diffPath === "") return err(res, 400, "Validation", "path required")
            if (!isSafeRelPath(diffPath)) return err(res, 400, "Validation", "path 非法（禁绝对路径 / .. 穿越 / 前导 -）")
            diffSection = s
          }
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(wsId)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              return ws
            }),
            async (ws) => {
              try {
                if (kind === "git/diffstat") return send(res, 200, await gitRead!.diffstat(ws.path, ws.baseRef))
                if (kind === "git/changes") return send(res, 200, await gitRead!.changes(ws.path, ws.baseRef))
                if (kind === "git/diff") return send(res, 200, await gitRead!.diff(ws.path, ws.baseRef, diffSection, diffPath))
                if (kind === "files") return send(res, 200, { files: await gitRead!.files(ws.path) })
                return send(res, 200, { commands: claudeHome !== undefined ? scanSlashCommands(ws.path, claudeHome) : scanSlashCommands(ws.path, "") })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "GitError", e?.message ?? String(e))
              }
            },
            onError,
          )
        }
```

在 app.ts 顶部 import 增补 `isDiffSection`、`isSafeRelPath` 与类型 `DiffSection`（从 `../git/inspect.js`）。`err`/`send`/`scanSlashCommands`/`WorkspacesRepo`/`ConflictError` 已在作用域内。

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run packages/server/test/http-gitread.test.ts packages/server/test/git-inspect.test.ts`
Expected: PASS
Run: `npm run typecheck`
Expected: 清洁。

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/git/inspect.ts packages/server/src/http/app.ts packages/server/test/git-inspect.test.ts packages/server/test/http-gitread.test.ts
git commit -m "feat(server): unified-diff 端点 git/diff（section + 单文件 pathspec）"
```

---

### Task 3: client 409 EngineBusy toast（M2p1 residual）

**Files:**
- Modify: `packages/client/src/stores/data.ts`（`sendInput` 识别 409 EngineBusy）
- Modify: `packages/client/src/composer/Composer.tsx:96-106`（`deliver` catch 分流，不 alert EngineBusy）
- Test: `packages/client/test/engine-busy-toast.test.ts`

**Interfaces:**
- Consumes: server `POST /input` 忙时回 `409 { error: "EngineBusy", message }`（app.ts:594）；`pushWarning(code, message)`（data.ts:133）。
- Produces: `sendInput` 遇 409 EngineBusy → `pushWarning` + throw 一个带 `code: "EngineBusy"` 的错误对象（供 Composer 识别不再 alert）。

- [ ] **Step 1: Write the failing test**

Create `packages/client/test/engine-busy-toast.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest"
import { useData } from "../src/stores/data.js"

describe("sendInput 409 EngineBusy → toast 而非裸错误", () => {
  beforeEach(() => {
    useData.setState({ warnings: [], pendingSends: [] })
    useData.getState().setApi({ info: { port: 1, token: "t" } } as any)
  })
  it("409 EngineBusy → pushWarning 一条 + 抛出带 code=EngineBusy 的错误", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 409, json: async () => ({ error: "EngineBusy", message: "engine 正忙" }),
    })) as any
    let caught: any = null
    await useData.getState().sendInput("w1", { text: "hi", mode: "send", skipStable: false }).catch((e) => { caught = e })
    expect(caught?.code).toBe("EngineBusy")
    expect(useData.getState().warnings.some((w) => w.code === "EngineBusy")).toBe(true)
  })
  it("非 EngineBusy 的 409/500 → 不 pushWarning，抛普通错误", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ error: "TmuxError", message: "boom" }),
    })) as any
    let caught: any = null
    await useData.getState().sendInput("w1", { text: "hi", mode: "send", skipStable: false }).catch((e) => { caught = e })
    expect(caught?.code).toBeUndefined()
    expect(useData.getState().warnings.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/engine-busy-toast.test.ts`
Expected: FAIL —（当前 sendInput 对 409 只 throw 普通 Error，无 `code`，也不 pushWarning）。

- [ ] **Step 3: Implement 409 分流 in sendInput**

改 `packages/client/src/stores/data.ts` 的 `sendInput`，把 `if (!r.ok)` 块换成：

```typescript
      if (!r.ok) {
        const j: any = await r.json().catch(() => ({}))
        if (r.status === 409 && j.error === "EngineBusy") {
          get().pushWarning("EngineBusy", j.message ?? "engine 正忙且无原生队列，稍后重试或改用 ⌘Enter 打断并发送")
          const e: any = new Error(j.message ?? "EngineBusy"); e.code = "EngineBusy"; throw e
        }
        throw new Error(j.message ?? `input failed ${r.status}`)
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/client/test/engine-busy-toast.test.ts`
Expected: PASS

- [ ] **Step 5: Composer deliver 不再 alert EngineBusy**

改 `packages/client/src/composer/Composer.tsx` 的 `deliver`（L96-106）catch 块：EngineBusy 已经 toast 过，只恢复草稿不 alert：

```typescript
  const deliver = async (mode: "send" | "interrupt-send" | "insert", skipStable: boolean): Promise<void> => {
    const body = text.trim()
    if (body === "") return
    update("") // 先清（乐观）
    try {
      await useData.getState().sendInput(wsId, { text: body, mode, skipStable })
    } catch (e: any) {
      update(body) // 恢复草稿
      if (e?.code !== "EngineBusy") alert(`投递失败：${e?.message ?? e}`) // EngineBusy 已由 toast 提示，不再弹窗
    }
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run packages/client/test/engine-busy-toast.test.ts`
Expected: PASS
Run: `npm run typecheck`
Expected: 清洁。

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/stores/data.ts packages/client/src/composer/Composer.tsx packages/client/test/engine-busy-toast.test.ts
git commit -m "feat(client): 409 EngineBusy → toast（不再裸 alert）"
```

---

### Task 4: unified-diff 解析器（纯函数）

**Files:**
- Create: `packages/client/src/rightpanel/diff.ts`
- Test: `packages/client/test/diff-parse.test.ts`

**Interfaces:**
- Consumes: server `FileDiff.unified`（Task 2 产出）。
- Produces:
  - `type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta"`
  - `interface DiffLine { kind: DiffLineKind; text: string; oldNo: number | null; newNo: number | null }`
  - `parseUnifiedDiff(unified: string): DiffLine[]`

- [ ] **Step 1: Write the failing test**

Create `packages/client/test/diff-parse.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { parseUnifiedDiff } from "../src/rightpanel/diff.js"

describe("parseUnifiedDiff", () => {
  const sample =
    "diff --git a/a.txt b/a.txt\n" +
    "index 111..222 100644\n" +
    "--- a/a.txt\n" +
    "+++ b/a.txt\n" +
    "@@ -1,3 +1,3 @@\n" +
    " one\n" +
    "-two\n" +
    "+TWO\n" +
    " three\n"

  it("分类每行并计算新旧行号", () => {
    const lines = parseUnifiedDiff(sample)
    const kinds = lines.map((l) => l.kind)
    expect(kinds).toEqual(["meta", "meta", "meta", "meta", "hunk", "ctx", "del", "add", "ctx"])
    const ctx1 = lines[5]!; expect(ctx1).toMatchObject({ text: "one", oldNo: 1, newNo: 1 })
    const del = lines[6]!;  expect(del).toMatchObject({ kind: "del", text: "two", oldNo: 2, newNo: null })
    const add = lines[7]!;  expect(add).toMatchObject({ kind: "add", text: "TWO", oldNo: null, newNo: 2 })
    const ctx2 = lines[8]!; expect(ctx2).toMatchObject({ text: "three", oldNo: 3, newNo: 3 })
  })

  it("空 diff → 空数组", () => {
    expect(parseUnifiedDiff("")).toEqual([])
  })

  it("多 hunk：第二 hunk 头重置行号", () => {
    const two = "@@ -1,1 +1,1 @@\n-a\n+A\n@@ -10,1 +10,1 @@\n-b\n+B\n"
    const lines = parseUnifiedDiff(two)
    const secondDel = lines.find((l) => l.text === "b")!
    expect(secondDel.oldNo).toBe(10)
  })

  it("no-newline-at-eof 标记（\\ No newline…）归 meta，不占行号、不误当 ctx", () => {
    const nn = "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+A\n"
    const lines = parseUnifiedDiff(nn)
    const marker = lines.find((l) => l.text.startsWith("\\"))!
    expect(marker.kind).toBe("meta")
    // 标记不推进行号：其后的 +A 仍是 new 行 1
    const add = lines.find((l) => l.kind === "add")!
    expect(add.newNo).toBe(1)
  })

  it("binary file stanza：Binary files … differ 归 meta（无 hunk/无行号）", () => {
    const bin = "diff --git a/logo.png b/logo.png\nindex 111..222 100644\nBinary files a/logo.png b/logo.png differ\n"
    const lines = parseUnifiedDiff(bin)
    expect(lines.every((l) => l.kind === "meta")).toBe(true)
    expect(lines.some((l) => l.text.includes("Binary files"))).toBe(true)
  })

  it("rename header（similarity/rename from/rename to）全归 meta", () => {
    const ren = "diff --git a/old.ts b/new.ts\nsimilarity index 92%\nrename from old.ts\nrename to new.ts\n"
    const lines = parseUnifiedDiff(ren)
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "meta", "meta"])
  })

  it("new file / deleted file mode 头归 meta", () => {
    const nf = "diff --git a/x.ts b/x.ts\nnew file mode 100644\nindex 000..111\n--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1 @@\n+hello\n"
    const kinds = parseUnifiedDiff(nf).map((l) => l.kind)
    expect(kinds.slice(0, 5)).toEqual(["meta", "meta", "meta", "meta", "meta"])
    expect(kinds).toContain("hunk")
    expect(kinds).toContain("add")
    const del = "diff --git a/y.ts b/y.ts\ndeleted file mode 100644\nindex 111..000\n--- a/y.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"
    expect(parseUnifiedDiff(del).some((l) => l.text.startsWith("deleted file") && l.kind === "meta")).toBe(true)
  })

  it("copy from / copy to 头归 meta（不误当 ctx 推进行号）", () => {
    const cp = "diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\ncopy from src/a.ts\ncopy to src/b.ts\n"
    const lines = parseUnifiedDiff(cp)
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "meta", "meta"])
    // 关键回归：copy from/to 若落进 else 分支会被当 ctx 并推进 oldNo/newNo；这里断言零 ctx。
    expect(lines.some((l) => l.kind === "ctx")).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/diff-parse.test.ts`
Expected: FAIL —「parseUnifiedDiff is not a function」。

- [ ] **Step 3: Implement parseUnifiedDiff**

Create `packages/client/src/rightpanel/diff.ts`:

```typescript
/** unified diff（git diff --unified=3）→ 结构化行。纯函数，node 可测。渲染候选 @pierre/diffs 已评估延后（D1）。 */
export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta"
export interface DiffLine { kind: DiffLineKind; text: string; oldNo: number | null; newNo: number | null }

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export const parseUnifiedDiff = (unified: string): DiffLine[] => {
  if (unified === "") return []
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of unified.split("\n")) {
    if (raw === "" && out.length > 0) continue // 尾随空行忽略（split 产物）
    const m = HUNK_RE.exec(raw)
    if (m) {
      oldNo = Number(m[1]); newNo = Number(m[2])
      out.push({ kind: "hunk", text: raw, oldNo: null, newNo: null })
      continue
    }
    // diff/index/---/+++ 等文件头（含 rename/copy/mode/binary 各 extended header 行）
    if (raw.startsWith("diff ") || raw.startsWith("index ") ||
        raw.startsWith("--- ") || raw.startsWith("+++ ") ||
        raw.startsWith("new file") || raw.startsWith("deleted file") ||
        raw.startsWith("old mode") || raw.startsWith("new mode") ||
        raw.startsWith("similarity ") || raw.startsWith("dissimilarity ") ||
        raw.startsWith("rename ") || raw.startsWith("copy ") ||
        raw.startsWith("Binary files")) {
      out.push({ kind: "meta", text: raw, oldNo: null, newNo: null })
      continue
    }
    const c = raw[0]
    if (c === "+") { out.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo }); newNo++ }
    else if (c === "-") { out.push({ kind: "del", text: raw.slice(1), oldNo, newNo: null }); oldNo++ }
    else if (c === "\\") { out.push({ kind: "meta", text: raw, oldNo: null, newNo: null }) } // "\ No newline at end of file"
    else { out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo, newNo }); oldNo++; newNo++ }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/client/test/diff-parse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/rightpanel/diff.ts packages/client/test/diff-parse.test.ts
git commit -m "feat(client): unified-diff 纯函数解析器（parseUnifiedDiff）"
```

---

### Task 5: DiffView 组件 + RightPanel 文件行点开行级 diff

**Files:**
- Create: `packages/client/src/rightpanel/DiffView.tsx`
- Modify: `packages/client/src/rightpanel/RightPanel.tsx`（`ChangeSection` 文件行可点开 + 挂 DiffView）
- Modify: `packages/client/src/stores/types.ts`（加 `FileDiff`）
- Modify: `packages/client/src/styles.css`（追加 `/* T5 diff */` 样式块）
- Test: 复用 `diff-parse.test.ts`（DiffView 本身是 DOM，node 单测覆盖其纯选行逻辑于 Task 6）

**Interfaces:**
- Consumes: `parseUnifiedDiff`（T4）；`GET /workspaces/:id/git/diff?section=&path=`（T2）。
- Produces:
  - `interface FileDiff { path: string; section: DiffSection; unified: string; binary: boolean }`（types.ts，与 server 同形）
  - `<DiffView wsId section path onComment={(sel) => void} />` —— 选行后回调 `LineSelection`（在 T6 定义并接线；本 task 先渲染 + 选行高亮，`onComment` 传占位）。

- [ ] **Step 1: types.ts 加 FileDiff + DiffSection**

在 `packages/client/src/stores/types.ts` 追加：

```typescript
export type DiffSection = "againstBase" | "committed" | "staged" | "unstaged"
export interface FileDiff { path: string; section: DiffSection; unified: string; binary: boolean }
```

- [ ] **Step 2: Implement DiffView.tsx**

Create `packages/client/src/rightpanel/DiffView.tsx`:

```typescript
import { useEffect, useState } from "react"
import { useData } from "../stores/data"
import { parseUnifiedDiff, type DiffLine } from "./diff"
import type { DiffSection } from "../stores/types"

export interface LineSelection { path: string; section: DiffSection; startIdx: number; endIdx: number; lines: DiffLine[] }

export const DiffView = ({ wsId, section, path, onComment }: {
  wsId: string; section: DiffSection; path: string; onComment: (sel: LineSelection) => void
}) => {
  const [lines, setLines] = useState<DiffLine[] | null>(null)
  const [binary, setBinary] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<number | null>(null) // 选区起点
  const [head, setHead] = useState<number | null>(null)      // 选区终点

  useEffect(() => {
    setLines(null); setErr(null); setAnchor(null); setHead(null)
    const api = useData.getState().getApi()
    if (!api) return
    void api.req("GET", `/workspaces/${wsId}/git/diff?section=${section}&path=${encodeURIComponent(path)}`)
      .then((r: any) => { setBinary(r.binary); setLines(parseUnifiedDiff(r.unified)) })
      .catch((e: any) => setErr(e?.message ?? String(e)))
  }, [wsId, section, path])

  if (err) return <div className="diff-err">diff 加载失败：{err}</div>
  if (binary) return <div className="dim">二进制文件，无行级 diff</div>
  if (!lines) return <div className="dim">加载 diff…</div>

  const selectable = (i: number) => lines[i]!.kind === "add" || lines[i]!.kind === "del" || lines[i]!.kind === "ctx"
  const inSel = (i: number) => anchor !== null && head !== null && i >= Math.min(anchor, head) && i <= Math.max(anchor, head)
  const onClickLine = (i: number, shift: boolean) => {
    if (!selectable(i)) return
    if (shift && anchor !== null) setHead(i)
    else { setAnchor(i); setHead(i) }
  }
  const commit = () => {
    if (anchor === null || head === null) return
    const s = Math.min(anchor, head), e = Math.max(anchor, head)
    onComment({ path, section, startIdx: s, endIdx: e, lines: lines.slice(s, e + 1) })
    setAnchor(null); setHead(null)
  }

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span className="diff-file">{path}</span>
        <button className="btn-sm" disabled={anchor === null} onClick={commit} title="对选中行写评论（追加到 composer）">评论选中行</button>
      </div>
      <div className="diff-body">
        {lines.map((l, i) => (
          <div key={i}
            className={`dl dl-${l.kind}${inSel(i) ? " dl-sel" : ""}${selectable(i) ? " dl-pick" : ""}`}
            onClick={(ev) => onClickLine(i, ev.shiftKey)}>
            <span className="dl-old">{l.oldNo ?? ""}</span>
            <span className="dl-new">{l.newNo ?? ""}</span>
            <span className="dl-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : l.kind === "hunk" ? "" : " "}</span>
            <span className="dl-text">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: RightPanel 文件行可点开 DiffView**

改 `packages/client/src/rightpanel/RightPanel.tsx`：给 `ChangeSection` 加 `section` prop 与「点开 diff」。在 `RightPanel` 组件里加选中文件态 `openDiff: { section, path } | null`，点文件行 set，DiffView 展开覆盖列表（带返回按钮）。关键改动：

`ChangeSection` 签名与文件行：

```typescript
const ChangeSection = ({ title, section, list, onOpen }: {
  title: string; section: DiffSection; list: FileChange[]; onOpen: (section: DiffSection, path: string) => void
}) => {
  const [open, setOpen] = useState(true)
  return (
    <section className="chg-section">
      <h4 onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {title}（{list.length}）</h4>
      {open && list.map((f) => (
        <div className="chg-row chg-row-pick" key={f.path} title={`点开行级 diff：${f.path}`}
          onClick={() => onOpen(section, f.path)}>
          <span className="chg-path">{f.path}</span>
          <span className="diffcount"><em className="plus">+{f.insertions}</em><em className="minus">−{f.deletions}</em></span>
        </div>
      ))}
    </section>
  )
}
```

在 `RightPanel` 组件内（`import { DiffView } from "./DiffView"`、`import type { DiffSection } from "../stores/types"`、`import { injectComment } from "./comment"`——`injectComment` 在 T6 建，本 task 先用占位 `const injectComment = (_wsId: string, _sel: unknown) => {}` 内联，T6 替换为真实导入）：

```typescript
  const [openDiff, setOpenDiff] = useState<{ section: DiffSection; path: string } | null>(null)
  // ...在 panel === "changes" 分支：openDiff 存在时渲染 DiffView，否则渲染四分区
```

changes 分支渲染改为：

```typescript
        {panel === "changes" && (
          openDiff ? (
            <div className="diff-pane">
              <button className="diff-back" onClick={() => setOpenDiff(null)}>‹ 返回变更列表</button>
              <DiffView wsId={wsId} section={openDiff.section} path={openDiff.path}
                onComment={(sel) => injectComment(wsId, sel)} />
            </div>
          ) : changes ? (
            <>
              <div className="chg-total">vs base：{stat ? `+${stat.insertions} −${stat.deletions}（${stat.filesChanged} 文件）` : "…"}</div>
              <ChangeSection title="Against base" section="againstBase" list={changes.againstBase} onOpen={(s, p) => setOpenDiff({ section: s, path: p })} />
              <ChangeSection title="Committed" section="committed" list={changes.committed} onOpen={(s, p) => setOpenDiff({ section: s, path: p })} />
              <ChangeSection title="Staged" section="staged" list={changes.staged} onOpen={(s, p) => setOpenDiff({ section: s, path: p })} />
              <ChangeSection title="Unstaged" section="unstaged" list={changes.unstaged} onOpen={(s, p) => setOpenDiff({ section: s, path: p })} />
              {/* untracked 段不可点开 diff（未 add，四 section 不含），保持只读列表 */}
              {changes.untracked.length > 0 && (
                <section className="chg-section">
                  <h4>Untracked（{changes.untracked.length}）</h4>
                  {changes.untracked.map((p) => <div className="chg-row" key={p}><span className="chg-path">{p}</span></div>)}
                </section>
              )}
            </>
          ) : <div className="dim">加载中…</div>
        )}
```

- [ ] **Step 4: styles.css 追加 diff 样式**

在 `packages/client/src/styles.css` 末尾追加：

```css
/* T5 diff */
.diff-pane { display: flex; flex-direction: column; min-height: 0; }
.diff-back { align-self: flex-start; color: var(--fg-dim); font-size: 12px; padding: 4px 0; }
.diff-view { display: flex; flex-direction: column; min-height: 0; }
.diff-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 0; }
.diff-file { font-size: 12px; color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-sm { font-size: 11px; border: 1px solid var(--border); border-radius: 5px; padding: 2px 8px; }
.btn-sm:disabled { opacity: 0.4; cursor: default; }
.diff-body { font-family: ui-monospace, monospace; font-size: 12px; overflow: auto; min-height: 0; }
.dl { display: flex; white-space: pre; }
.dl-old, .dl-new { width: 34px; flex: none; text-align: right; padding-right: 6px; color: var(--fg-dim); user-select: none; }
.dl-sign { width: 12px; flex: none; user-select: none; }
.dl-text { flex: 1; }
.dl-add { background: rgba(158,206,106,0.12); } .dl-add .dl-sign { color: var(--ok); }
.dl-del { background: rgba(247,118,142,0.12); } .dl-del .dl-sign { color: var(--danger); }
.dl-hunk { color: var(--accent); } .dl-meta { color: var(--fg-dim); }
.dl-pick { cursor: pointer; }
.dl-sel { outline: 1px solid var(--accent); outline-offset: -1px; }
```

- [ ] **Step 5: Run typecheck + regression（diff parse 仍绿）**

Run: `npm run typecheck`
Expected: 清洁（若 `injectComment` 用占位，确保占位签名与 T6 一致：`(wsId: string, sel: LineSelection) => void`）。
Run: `npx vitest run packages/client/test/diff-parse.test.ts`
Expected: PASS

- [ ] **Step 6: Chrome 截图自验（行级 diff）**

Chrome `?server=` 打开一个有改动的 codex/claude workspace → 右栏 Changes → 点一个 Unstaged 文件 → 看到行级 diff（+绿/−红/行号）；Shift 点选多行高亮；点「评论选中行」不报错。截图存 scratchpad。

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/rightpanel/DiffView.tsx packages/client/src/rightpanel/RightPanel.tsx packages/client/src/stores/types.ts packages/client/src/styles.css
git commit -m "feat(client): 右栏文件行点开行级 diff 视图 + 选行"
```

---

### Task 6: 评论写回组装（formatLineComment）+ 追加 composer 草稿

**Files:**
- Create: `packages/client/src/rightpanel/comment.ts`
- Modify: `packages/client/src/rightpanel/RightPanel.tsx`（把 T5 的占位 `injectComment` 换成真实 import）
- Test: `packages/client/test/comment-format.test.ts`

**Interfaces:**
- Consumes: `LineSelection`（T5 DiffView 产出）；`makeDrafts(localStorage)`（drafts.ts）；`useUi.focusComposer()`（ui.ts:53）；`sanitizePromptForPty` 语义由 server 投递侧承担（写回不在 client 消毒）。
- Produces:
  - `formatLineComment(sel: LineSelection, comment: string): string`（纯）
  - `injectComment(wsId: string, sel: LineSelection): void`（弹出 prompt 收评论 → 组装 → 追加草稿 → focusComposer）

- [ ] **Step 1: Write the failing test**

Create `packages/client/test/comment-format.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { formatLineComment } from "../src/rightpanel/comment.js"
import type { LineSelection } from "../src/rightpanel/DiffView.js"

const sel: LineSelection = {
  path: "src/a.ts", section: "unstaged", startIdx: 0, endIdx: 1,
  lines: [
    { kind: "del", text: "const x = 1", oldNo: 41, newNo: null },
    { kind: "add", text: "const x = 2", oldNo: null, newNo: 41 },
  ],
}

describe("formatLineComment（D2 格式）", () => {
  it("组装 path + 行号范围 + diff 代码块 + 评论", () => {
    const out = formatLineComment(sel, "这里为什么改成 2？")
    expect(out).toContain("关于 `src/a.ts`")
    expect(out).toContain("41") // 行号出现
    expect(out).toContain("```diff")
    expect(out).toContain("-const x = 1")
    expect(out).toContain("+const x = 2")
    expect(out).toContain("这里为什么改成 2？")
  })
  it("单行选区 → 单行号（非范围）", () => {
    const one: LineSelection = { ...sel, endIdx: 0, lines: [sel.lines[0]!] }
    const out = formatLineComment(one, "c")
    expect(out).toContain("第 41 行")
    expect(out).not.toContain("41–")
  })
  it("空评论 → 仍产出引用块（评论行留空）", () => {
    const out = formatLineComment(sel, "")
    expect(out).toContain("```diff")
  })
  it("选中内容含 ``` → 围栏自动加长到 4 根反引号（内容不被提前截断）", () => {
    const fenced: LineSelection = {
      path: "README.md", section: "unstaged", startIdx: 0, endIdx: 0,
      lines: [{ kind: "add", text: "```ts", oldNo: null, newNo: 7 }],
    }
    const out = formatLineComment(fenced, "看这里")
    // 开围栏用 4 根反引号（比内容里最长的 3 根多 1），后接 diff 语言标记
    expect(out).toContain("````diff\n")
    // 闭围栏也是 4 根反引号独占一行（前后各一个换行）
    expect(out).toContain("\n````\n")
    // 内容里的 ```ts 原样保留（verbatim，不被消掉）
    expect(out).toContain("+```ts")
    // 显式核算围栏长度：内容最长反引号串为 3，故围栏恰为 4（不多不少）——用行级切分精确断言，避免子串重叠误判
    const openFence = out.split("\n").find((ln) => ln.endsWith("diff"))!
    expect(openFence).toBe("````diff")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/comment-format.test.ts`
Expected: FAIL —「formatLineComment is not a function」。

- [ ] **Step 3: Implement comment.ts**

Create `packages/client/src/rightpanel/comment.ts`:

```typescript
import { makeDrafts } from "../composer/drafts"
import { useUi } from "../stores/ui"
import type { LineSelection } from "./DiffView"

const drafts = makeDrafts(
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }
)

const sign = (kind: string): string => (kind === "add" ? "+" : kind === "del" ? "-" : " ")

/** 嵌套围栏守卫（longest-backtick+1）：选中的 diff 内容可能含 ``` 反引号串（改到 markdown / 模板串代码时）。
 * 用「内容里最长反引号串 + 1」根反引号做围栏（下限 3），避免代码块被内容里的 ``` 提前截断。 */
const fenceFor = (content: string): string => {
  const longest = (content.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0)
  return "`".repeat(Math.max(3, longest + 1))
}

/** D2：把选中的 diff 行 + 用户评论组装成 markdown 片段（写回经 composer→sanitize→PTY，不在此消毒）。 */
export const formatLineComment = (sel: LineSelection, comment: string): string => {
  const first = sel.lines[0]
  const last = sel.lines[sel.lines.length - 1]
  // 行号取该段实际涉及的行（优先新号，删除行取旧号）
  const lineNo = (l: typeof first): number | null => (l ? (l.newNo ?? l.oldNo) : null)
  const a = lineNo(first)
  const b = lineNo(last)
  const range = a === null ? "" : a === b || b === null ? `第 ${a} 行` : `第 ${a}–${b} 行`
  const block = sel.lines.map((l) => `${sign(l.kind)}${l.text}`).join("\n")
  const fence = fenceFor(block) // 内容不含 ``` 时恒为 3 根反引号（``` ），含则自动加长
  return `关于 \`${sel.path}\`${range === "" ? "" : ` ${range}`}：\n${fence}diff\n${block}\n${fence}\n${comment}`
}

/** 收评论 → 组装 → 追加到该 ws 的 composer 草稿尾部（复用 @<path> 注入手法）→ 聚焦 composer。 */
export const injectComment = (wsId: string, sel: LineSelection): void => {
  const comment = typeof prompt === "function" ? (prompt("对选中行的评论（追加到 composer，可再编辑后发送）：") ?? "") : ""
  const snippet = formatLineComment(sel, comment)
  const cur = drafts.load(wsId)
  drafts.save(wsId, cur === "" ? snippet : `${cur}\n\n${snippet}`)
  useUi.getState().focusComposer()
}
```

> 注：`window.prompt` 在 Tauri webview 可用；node 测试不覆盖 `injectComment` 的 DOM 交互（`formatLineComment` 已单测）。若未来要富输入框替换 `prompt`，改这一处即可，格式函数不动。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/client/test/comment-format.test.ts`
Expected: PASS

- [ ] **Step 5: RightPanel 换真实 injectComment**

在 `packages/client/src/rightpanel/RightPanel.tsx` 顶部把 T5 的占位改为真实导入：

```typescript
import { DiffView } from "./DiffView"
import { injectComment } from "./comment"
```

删掉 T5 内联的占位 `const injectComment = ...`。`onComment={(sel) => injectComment(wsId, sel)}` 保持不变。

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run packages/client/test/comment-format.test.ts packages/client/test/diff-parse.test.ts`
Expected: PASS
Run: `npm run typecheck`
Expected: 清洁。

- [ ] **Step 7: Chrome 截图自验（写回闭环）**

Chrome `?server=`：打开行级 diff → 选行 → 点「评论选中行」→ 弹框输入评论 → 确认 → composer 里出现组装好的 markdown（`关于 \`path\` 第 N 行：` + diff 块 + 评论）→ Enter 投递 → 终端 TUI 收到该 prompt（claude 会开始回应）。截图存 scratchpad。

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/rightpanel/comment.ts packages/client/src/rightpanel/RightPanel.tsx packages/client/test/comment-format.test.ts
git commit -m "feat(client): diff 行评论 → 组装 prompt → 写回 composer（Superset 闭环，C6）"
```

---

### Task 7: 用户键位 JSON 覆盖（有效 registry）

**Files:**
- Create: `packages/client/src/settings/settings.ts`（settings store：theme/lang/keybinding 覆盖）
- Create: `packages/client/src/settings/keybindings.ts`（纯：`mergeKeybindings`）
- Modify: `packages/client/src/hotkeys/registry.ts`（`byChord`/`resolveHotkey` 读有效 registry；加 `app.commandPalette`、`app.settings` id）
- Modify: `packages/client/src/chrome/Cheatsheet.tsx`（读有效 registry）
- Test: `packages/client/test/keybindings.test.ts`

**Interfaces:**
- Consumes: `HOTKEYS_REGISTRY`（registry.ts:20）；localStorage `coolie.keybindings`（JSON `{ [HotkeyId]: chord }`）。
- Produces:
  - `mergeKeybindings(base: readonly HotkeyDef[], overrides: Record<string,string>): HotkeyDef[]`（纯）
  - `setKeybindingOverrides(o)` / `getEffectiveRegistry(): HotkeyDef[]`（settings store）
  - `resolveHotkey` 命中有效 registry（覆盖后的 chord）。

- [ ] **Step 1: Write the failing test**

Create `packages/client/test/keybindings.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { mergeKeybindings } from "../src/settings/keybindings.js"
import { HOTKEYS_REGISTRY } from "../src/hotkeys/registry.js"

describe("mergeKeybindings", () => {
  it("覆盖已知 id 的 chord，其余不变", () => {
    const merged = mergeKeybindings(HOTKEYS_REGISTRY, { "composer.focus": "meta+shift+l" })
    expect(merged.find((h) => h.id === "composer.focus")!.chord).toBe("meta+shift+l")
    expect(merged.find((h) => h.id === "workspace.new")!.chord).toBe("meta+n")
  })
  it("未知 id 的覆盖被忽略（不新增条目）", () => {
    const merged = mergeKeybindings(HOTKEYS_REGISTRY, { "bogus.id": "meta+z" })
    expect(merged.length).toBe(HOTKEYS_REGISTRY.length)
    expect(merged.some((h) => h.id === ("bogus.id" as any))).toBe(false)
  })
  it("空覆盖 → 原样返回等价（逐条相等）", () => {
    const merged = mergeKeybindings(HOTKEYS_REGISTRY, {})
    expect(merged).toEqual([...HOTKEYS_REGISTRY])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/keybindings.test.ts`
Expected: FAIL —「mergeKeybindings is not a function」。

- [ ] **Step 3: Implement keybindings.ts (pure)**

Create `packages/client/src/settings/keybindings.ts`:

```typescript
import type { HotkeyDef } from "../hotkeys/registry"

/** 用户 JSON 覆盖（{ [hotkeyId]: chord }）合并进 base registry。未知 id 忽略；不新增条目（单一真源不被外部扩张）。 */
export const mergeKeybindings = (base: readonly HotkeyDef[], overrides: Record<string, string>): HotkeyDef[] =>
  base.map((h) => (overrides[h.id] && typeof overrides[h.id] === "string" ? { ...h, chord: overrides[h.id]! } : h))

const LS_KEY = "coolie.keybindings"
export const loadKeybindingOverrides = (): Record<string, string> => {
  try {
    if (typeof localStorage === "undefined") return {}
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {}
    const j = JSON.parse(raw)
    return j && typeof j === "object" ? j : {}
  } catch { return {} }
}
```

- [ ] **Step 4: settings store + registry 读有效 registry**

Create `packages/client/src/settings/settings.ts`:

```typescript
import { create } from "zustand"
import { HOTKEYS_REGISTRY, type HotkeyDef } from "../hotkeys/registry"
import { mergeKeybindings, loadKeybindingOverrides } from "./keybindings"

export type ThemePref = "system" | "light" | "dark"
export type Lang = "zh" | "en"

interface SettingsState {
  theme: ThemePref
  lang: Lang
  keybindings: Record<string, string>
  effectiveHotkeys: HotkeyDef[]
  setTheme(t: ThemePref): void
  setLang(l: Lang): void
  setKeybindings(o: Record<string, string>): void
}

const LS = (k: string, d: string): string => {
  try { return typeof localStorage !== "undefined" ? (localStorage.getItem(k) ?? d) : d } catch { return d }
}
const save = (k: string, v: string): void => { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v) } catch { /* noop */ } }

const initialKb = loadKeybindingOverrides()

export const useSettings = create<SettingsState>((set) => ({
  theme: LS("coolie.theme", "system") as ThemePref,
  lang: LS("coolie.lang", "zh") as Lang,
  keybindings: initialKb,
  effectiveHotkeys: mergeKeybindings(HOTKEYS_REGISTRY, initialKb),
  setTheme: (theme) => { save("coolie.theme", theme); set({ theme }) },
  setLang: (lang) => { save("coolie.lang", lang); set({ lang }) },
  setKeybindings: (keybindings) => {
    save("coolie.keybindings", JSON.stringify(keybindings))
    set({ keybindings, effectiveHotkeys: mergeKeybindings(HOTKEYS_REGISTRY, keybindings) })
  },
}))
```

改 `packages/client/src/hotkeys/registry.ts`：把 `HotkeyId` 扩两个新 id、`byChord`/`resolveHotkey` 改成从有效 registry 现算（不能在模块加载期固化，否则覆盖不生效）：

```typescript
export type HotkeyId =
  | "workspace.new" | "tab.newShell" | "tab.close"
  | "workspace.jump.1" | ... | "workspace.jump.9"
  | "workspace.prev" | "workspace.next"
  | "composer.focus" | "engine.interrupt" | "app.cheatsheet"
  | "app.commandPalette" | "app.settings"   // ← 新增（T8/T11 用）
```

在 `HOTKEYS_REGISTRY` 数组末尾追加：

```typescript
  { id: "app.commandPalette", chord: "meta+k", label: "命令面板", category: "App" },
  { id: "app.settings", chord: "meta+,", label: "设置", category: "App" },
```

（`normalizeChord` 的 `CODE_MAP` 加 `Comma: ","`。）把文件底部改为动态 byChord：

```typescript
import { useSettings } from "../settings/settings"

export const resolveHotkey = (e: KeyEventLike): HotkeyDef | null => {
  const chord = normalizeChord(e)
  if (!chord) return null
  // 有效 registry（含用户覆盖）现算——覆盖变更即时生效，无需重载。
  const reg = useSettings.getState().effectiveHotkeys
  return reg.find((h) => h.chord === chord) ?? null
}
```

> 循环依赖注意：`settings.ts` import registry 的 `HOTKEYS_REGISTRY`+`HotkeyDef`（值+类型），registry 只在函数体内 `useSettings.getState()`（运行期），无模块加载期环。若 bundler 报环，把 registry 里的 `import { useSettings }` 改为函数内动态 `require`——但 ESM 下运行期引用不成环，优先直接 import。

`Cheatsheet.tsx` 改读有效 registry：

```typescript
import { useSettings } from "../settings/settings"
// ...
export const Cheatsheet = () => {
  const open = useUi((s) => s.cheatsheetOpen)
  const registry = useSettings((s) => s.effectiveHotkeys)
  if (!open) return null
  const cats = [...new Set(registry.map((h) => h.category))]
  // ...把两处 HOTKEYS_REGISTRY 换成 registry
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run packages/client/test/keybindings.test.ts packages/client/test/hotkeys.test.ts packages/client/test/global-hotkeys.test.ts`
Expected: PASS（既有 hotkeys 测试仍绿——覆盖为空时有效 registry == 原 registry）。
Run: `npm run typecheck`
Expected: 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/settings/ packages/client/src/hotkeys/registry.ts packages/client/src/chrome/Cheatsheet.tsx packages/client/test/keybindings.test.ts
git commit -m "feat(client): 用户键位 JSON 覆盖 → 有效 registry（三处同源不破）"
```

---

### Task 8: ⌘K 命令面板

**Files:**
- Create: `packages/client/src/chrome/CommandPalette.tsx`
- Modify: `packages/client/src/stores/ui.ts`（`paletteOpen` 态）
- Modify: `packages/client/src/hotkeys/useGlobalHotkeys.ts`（绑定 `app.commandPalette`）
- Modify: `packages/client/src/App.tsx`（挂载 `<CommandPalette />`——**共享文件串行段**）
- Modify: `packages/client/src/styles.css`（`/* T8 palette */`）
- Test: `packages/client/test/command-palette.test.ts`

**Interfaces:**
- Consumes: `fuzzyFilter`（composer/fuzzy.ts）；有效 registry（T7）；`orderedActiveWs`（useGlobalHotkeys.ts:7）；`dispatchHotkey` 层机制。
- Produces:
  - `buildCommands(deps): Command[]`（纯）——把 hotkey 动作 + workspace 跳转合成命令列表。
  - `interface Command { id: string; title: string; run(): void }`

- [ ] **Step 1: Write the failing test**

Create `packages/client/test/command-palette.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { buildCommands, filterCommands } from "../src/chrome/CommandPalette.js"

describe("命令面板命令表", () => {
  const deps = {
    hotkeys: [
      { id: "workspace.new", chord: "meta+n", label: "新建 workspace", category: "Workspace" },
      { id: "app.cheatsheet", chord: "meta+/", label: "快捷键一览", category: "App" },
    ],
    workspaces: [{ id: "w1", name: "usa-yellowstone" }, { id: "w2", name: "china-guilin" }],
    runHotkey: () => {},
    selectWs: () => {},
  }
  it("hotkey + workspace 都成命令", () => {
    const cmds = buildCommands(deps as any)
    expect(cmds.some((c) => c.title.includes("新建 workspace"))).toBe(true)
    expect(cmds.some((c) => c.title.includes("usa-yellowstone"))).toBe(true)
  })
  it("fuzzy 过滤命中 title", () => {
    const cmds = buildCommands(deps as any)
    const hits = filterCommands(cmds, "guilin")
    expect(hits.length).toBe(1)
    expect(hits[0]!.title).toContain("china-guilin")
  })
  it("空 query → 全部", () => {
    const cmds = buildCommands(deps as any)
    expect(filterCommands(cmds, "").length).toBe(cmds.length)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/command-palette.test.ts`
Expected: FAIL —「buildCommands is not a function」。

- [ ] **Step 3: Implement CommandPalette.tsx**

Create `packages/client/src/chrome/CommandPalette.tsx`:

```typescript
import { useState, useEffect, useRef } from "react"
import { useUi } from "../stores/ui"
import { useData } from "../stores/data"
import { useSettings } from "../settings/settings"
import { fuzzyFilter } from "../composer/fuzzy"
import { dispatchHotkey } from "../hotkeys/dispatch"
import { orderedActiveWs } from "../hotkeys/useGlobalHotkeys"
import type { HotkeyDef, HotkeyId } from "../hotkeys/registry"

export interface Command { id: string; title: string; run(): void }
export interface BuildDeps {
  hotkeys: readonly HotkeyDef[]
  workspaces: readonly { id: string; name: string }[]
  runHotkey(id: HotkeyId): void
  selectWs(id: string): void
}

export const buildCommands = (d: BuildDeps): Command[] => [
  ...d.hotkeys
    .filter((h) => h.id !== "app.commandPalette")
    .map((h) => ({ id: `hk:${h.id}`, title: `${h.category} · ${h.label}`, run: () => d.runHotkey(h.id) })),
  ...d.workspaces.map((w) => ({ id: `ws:${w.id}`, title: `切到 workspace · ${w.name}`, run: () => d.selectWs(w.id) })),
]

export const filterCommands = (cmds: Command[], query: string): Command[] => {
  if (query.trim() === "") return cmds
  const titles = cmds.map((c) => c.title)
  const hits = new Set(fuzzyFilter(titles, query))
  return cmds.filter((c) => hits.has(c.title))
}

export const CommandPalette = () => {
  const open = useUi((s) => s.paletteOpen)
  const [q, setQ] = useState("")
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { setQ(""); setSel(0); requestAnimationFrame(() => inputRef.current?.focus()) } }, [open])
  if (!open) return null

  const hotkeys = useSettings.getState().effectiveHotkeys
  const cmds = buildCommands({
    hotkeys,
    workspaces: orderedActiveWs(),
    runHotkey: (id) => { close(); dispatchHotkey({ metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, code: "", key: "", } as any) === undefined; runById(id) },
    selectWs: (id) => { close(); useUi.getState().selectWs(id) },
  })
  const list = filterCommands(cmds, q)
  const close = () => useUi.getState().setPalette(false)
  function runById(id: HotkeyId) {
    // 直接调用同 useGlobalHotkeys 的动作：复用注册层——用 dispatch 层按 id 触发
    const layerRun = (window as any).__coolieRunHotkey as ((i: HotkeyId) => void) | undefined
    layerRun?.(id)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal palette" onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="palette-input" placeholder="输入命令…" value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0) }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); close() }
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, list.length - 1)) }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
            else if (e.key === "Enter") { e.preventDefault(); const c = list[sel]; if (c) { close(); c.run() } }
          }} />
        <div className="palette-list">
          {list.map((c, i) => (
            <div key={c.id} className={`palette-item${i === sel ? " sel" : ""}`}
              onMouseEnter={() => setSel(i)} onClick={() => { close(); c.run() }}>{c.title}</div>
          ))}
          {list.length === 0 && <div className="dim palette-empty">无匹配命令</div>}
        </div>
      </div>
    </div>
  )
}
```

> **动作路由简化**：为避免 `runHotkey` 通过合成键盘事件绕路（易错），改成 `useGlobalHotkeys` 在挂载时把它的动作表挂到 `window.__coolieRunHotkey`。见 Step 4。把上面 `buildCommands` 的 `runHotkey` 直接用 `runById`，删掉 `dispatchHotkey(...) === undefined` 那行冗余。最终 `runHotkey: (id) => { close(); runById(id) }`。

- [ ] **Step 4: ui store paletteOpen + useGlobalHotkeys 暴露动作表 + 绑定 ⌘K**

`packages/client/src/stores/ui.ts`：加 `paletteOpen: boolean` + `setPalette(open: boolean): void`：

```typescript
  paletteOpen: false,
  setPalette: (paletteOpen) => set({ paletteOpen }),
```

（接口段同步加 `paletteOpen: boolean; setPalette(open: boolean): void`。）

`packages/client/src/hotkeys/useGlobalHotkeys.ts`：在 `pushHotkeyLayer({...})` 的 handlers 里加 `app.commandPalette`，并把 handlers 表挂到 window 供 palette 复用：

```typescript
    const handlers = {
      "workspace.new": () => useUi.getState().setDispatchMode(true, useData.getState().projects[0]?.id ?? null),
      "workspace.prev": () => jumpAdjacent(-1),
      "workspace.next": () => jumpAdjacent(+1),
      ...(Object.fromEntries([1,2,3,4,5,6,7,8,9].map((n) => [`workspace.jump.${n}`, () => jumpTo(n - 1)]))),
      "composer.focus": () => useUi.getState().focusComposer(),
      "engine.interrupt": () => {
        const wsId = useUi.getState().selectedWs
        if (wsId) void useData.getState().sendInput(wsId, { text: "", mode: "interrupt", skipStable: true }).catch(() => {})
      },
      "app.cheatsheet": () => useUi.getState().setCheatsheet(!useUi.getState().cheatsheetOpen),
      "app.commandPalette": () => useUi.getState().setPalette(!useUi.getState().paletteOpen),
    } as Record<string, () => void>
    ;(window as any).__coolieRunHotkey = (id: string) => handlers[id]?.()
    const pop = pushHotkeyLayer(handlers as any)
```

（cleanup 里 `delete (window as any).__coolieRunHotkey`。）

- [ ] **Step 5: App.tsx 挂载（共享文件串行段）**

`import { CommandPalette } from "./chrome/CommandPalette"`，在 `<Cheatsheet />` 旁加 `<CommandPalette />`。

- [ ] **Step 6: styles.css 追加**

```css
/* T8 palette */
.palette { width: 520px; padding: 0; overflow: hidden; }
.palette-input { width: 100%; box-sizing: border-box; padding: 14px 18px; font-size: 15px; background: transparent; color: var(--fg); border-bottom: 1px solid var(--border); }
.palette-list { max-height: 320px; overflow-y: auto; }
.palette-item { padding: 8px 18px; cursor: pointer; font-size: 13px; }
.palette-item.sel { background: var(--panel); }
.palette-empty { padding: 14px 18px; }
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run packages/client/test/command-palette.test.ts`
Expected: PASS
Run: `npm run typecheck`
Expected: 清洁。

- [ ] **Step 8: Chrome 截图自验（⌘K）**

Chrome `?server=`：按 `⌘K` 弹面板，输入 "yellow" 命中 workspace，Enter 切过去；输入 "新建" 命中 workspace.new。Esc 关。截图存 scratchpad。

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/chrome/CommandPalette.tsx packages/client/src/stores/ui.ts packages/client/src/hotkeys/useGlobalHotkeys.ts packages/client/src/App.tsx packages/client/src/styles.css packages/client/test/command-palette.test.ts
git commit -m "feat(client): ⌘K 命令面板（hotkey + workspace 跳转，fuzzy）"
```

---

### Task 9: footer cheatsheet 条

**Files:**
- Create: `packages/client/src/chrome/Footer.tsx`
- Modify: `packages/client/src/App.tsx`（挂载 `<Footer />`——**共享文件串行段**）
- Modify: `packages/client/src/styles.css`（`/* T9 footer */`）
- Test: `packages/client/test/footer.test.ts`

**Interfaces:**
- Consumes: 有效 registry（T7 `useSettings.effectiveHotkeys`）。
- Produces: `footerHints(registry): { chord: string; label: string }[]`（纯，选一组常用键）。

- [ ] **Step 1: Write the failing test**

Create `packages/client/test/footer.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { footerHints } from "../src/chrome/Footer.js"
import { HOTKEYS_REGISTRY } from "../src/hotkeys/registry.js"

describe("footerHints", () => {
  it("挑常用键，且 chord 已美化为 ⌘ 符号", () => {
    const hints = footerHints(HOTKEYS_REGISTRY)
    expect(hints.length).toBeGreaterThan(0)
    expect(hints.some((h) => h.chord.includes("⌘"))).toBe(true)
    // 常用集必含 命令面板 与 新建
    expect(hints.some((h) => h.label.includes("命令面板") || h.chord.includes("K"))).toBe(true)
  })
  it("覆盖后的 chord 反映在 footer（同一真源）", () => {
    const overridden = HOTKEYS_REGISTRY.map((h) => h.id === "composer.focus" ? { ...h, chord: "meta+shift+l" } : h)
    const hints = footerHints(overridden)
    const focus = hints.find((h) => h.label.includes("composer") || h.label.includes("聚焦"))
    if (focus) expect(focus.chord).toContain("⇧")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/footer.test.ts`
Expected: FAIL —「footerHints is not a function」。

- [ ] **Step 3: Implement Footer.tsx**

Create `packages/client/src/chrome/Footer.tsx`:

```typescript
import { useUi } from "../stores/ui"
import { useSettings } from "../settings/settings"
import type { HotkeyDef } from "../hotkeys/registry"

const prettyChord = (chord: string): string =>
  chord.replace("meta+", "⌘").replace("alt+", "⌥").replace("shift+", "⇧").toUpperCase()

// footer 常驻只显示一小组高频键（同一真源：从有效 registry 取，覆盖后自动跟随）。
const FOOTER_IDS = ["workspace.new", "composer.focus", "engine.interrupt", "app.commandPalette", "app.cheatsheet"]

export const footerHints = (registry: readonly HotkeyDef[]): { chord: string; label: string }[] =>
  FOOTER_IDS
    .map((id) => registry.find((h) => h.id === id))
    .filter((h): h is HotkeyDef => h !== undefined)
    .map((h) => ({ chord: prettyChord(h.chord), label: h.label }))

export const Footer = () => {
  const registry = useSettings((s) => s.effectiveHotkeys)
  const hints = footerHints(registry)
  return (
    <footer className="app-footer">
      {hints.map((h) => (
        <span className="footer-hint" key={h.label}><kbd>{h.chord}</kbd> {h.label}</span>
      ))}
      <span className="footer-spacer" />
      <button className="footer-more" onClick={() => useUi.getState().setCheatsheet(true)}>⌘/ 全部快捷键</button>
    </footer>
  )
}
```

- [ ] **Step 4: App.tsx 挂载 + styles.css**

`import { Footer } from "./chrome/Footer"`，在 `.app-frame` 内、`</div>` 关闭前（`<TmuxGuide />` 一带）加 `<Footer />`（放最外层底部）。styles.css 追加：

```css
/* T9 footer */
.app-footer { height: 24px; flex: none; display: flex; align-items: center; gap: 16px; padding: 0 12px; border-top: 1px solid var(--border); font-size: 11px; color: var(--fg-dim); }
.footer-hint kbd { background: #1a1a1e; border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; margin-right: 4px; font-size: 10px; }
.footer-spacer { flex: 1; }
.footer-more { color: var(--fg-dim); font-size: 11px; }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run packages/client/test/footer.test.ts`
Expected: PASS
Run: `npm run typecheck`
Expected: 清洁。

- [ ] **Step 6: Chrome 截图自验（footer）**

Chrome `?server=`：底部条显示 ⌘N/⌘L/⌘./⌘K/⌘/ 提示，点「全部快捷键」弹 cheatsheet。截图存 scratchpad。

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/chrome/Footer.tsx packages/client/src/App.tsx packages/client/src/styles.css packages/client/test/footer.test.ts
git commit -m "feat(client): footer cheatsheet 条（HOTKEYS_REGISTRY 第三处同源）"
```

---

### Task 10: 主题（system/light/dark）

**Files:**
- Create: `packages/client/src/settings/theme.ts`（`resolveTheme` 纯 + `applyTheme` 副作用）
- Modify: `packages/client/src/settings/settings.ts`（`setTheme` 已在 T7；此处接 `applyTheme`）
- Modify: `packages/client/src/App.tsx`（boot 时 applyTheme + 订阅）
- Modify: `packages/client/src/chrome/Titlebar.tsx`（主题切换按钮）
- Modify: `packages/client/src/styles.css`（`:root[data-theme="light"]` 变量覆盖 + `/* T10 theme */`）
- Test: `packages/client/test/theme.test.ts`

**Interfaces:**
- Consumes: `useSettings.theme`（T7）；`window.matchMedia`（system 判定）。
- Produces:
  - `resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark"`（纯）
  - `applyTheme(pref: ThemePref): void`（设 `document.documentElement.dataset.theme`）

- [ ] **Step 1: Write the failing test**

Create `packages/client/test/theme.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { resolveTheme } from "../src/settings/theme.js"

describe("resolveTheme", () => {
  it("显式 light/dark 直接返回", () => {
    expect(resolveTheme("light", true)).toBe("light")
    expect(resolveTheme("dark", false)).toBe("dark")
  })
  it("system 跟随 systemDark", () => {
    expect(resolveTheme("system", true)).toBe("dark")
    expect(resolveTheme("system", false)).toBe("light")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/theme.test.ts`
Expected: FAIL —「resolveTheme is not a function」。

- [ ] **Step 3: Implement theme.ts**

Create `packages/client/src/settings/theme.ts`:

```typescript
import type { ThemePref } from "./settings"

export const resolveTheme = (pref: ThemePref, systemDark: boolean): "light" | "dark" =>
  pref === "system" ? (systemDark ? "dark" : "light") : pref

export const applyTheme = (pref: ThemePref): void => {
  if (typeof document === "undefined") return
  const systemDark = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true
  document.documentElement.dataset.theme = resolveTheme(pref, systemDark)
}
```

- [ ] **Step 4: settings 接 applyTheme + App boot 应用 + Titlebar 切换**

`packages/client/src/settings/settings.ts` 的 `setTheme` 改为：

```typescript
  setTheme: (theme) => { save("coolie.theme", theme); set({ theme }); applyTheme(theme) },
```

（顶部 `import { applyTheme } from "./theme"`。）

`packages/client/src/App.tsx`：在 boot effect 起始处调用一次 `applyTheme(useSettings.getState().theme)`（`import { useSettings } from "./settings/settings"`、`import { applyTheme } from "./settings/theme"`）。

`packages/client/src/chrome/Titlebar.tsx`：加主题循环按钮（system→light→dark→system）。在 titlebar 右侧现有内容旁加：

```typescript
import { useSettings } from "../settings/settings"
// 组件内：
const theme = useSettings((s) => s.theme)
const nextTheme = (t: string) => (t === "system" ? "light" : t === "light" ? "dark" : "system")
// JSX（放连接状态旁）：
<button className="tl-theme" title={`主题：${theme}`} onClick={() => useSettings.getState().setTheme(nextTheme(theme) as any)}>
  {theme === "dark" ? "🌙" : theme === "light" ? "☀️" : "🖥"}
</button>
```

- [ ] **Step 5: styles.css light 主题变量**

在 `styles.css` 的 `:root {...}` 之后追加（`/* T10 theme */`）——light 覆盖 CSS 变量，暗色维持 `:root` 默认；`data-theme="dark"` 显式回落默认，`system` 已由 applyTheme 落成 light/dark：

```css
/* T10 theme */
:root[data-theme="light"] {
  --bg: rgba(248, 248, 250, 0.86);
  --panel: rgba(0, 0, 0, 0.035);
  --border: rgba(0, 0, 0, 0.12);
  --fg: #1c1c1f;
  --fg-dim: #6a6a72;
  --accent: #3b6fd4;
  --danger: #c94f60;
  --ok: #4f9a3a;
  --warn: #b8860b;
}
:root[data-theme="light"] .modal { background: #ffffff; }
:root[data-theme="light"] .modal pre,
:root[data-theme="light"] .hk-row kbd,
:root[data-theme="light"] .footer-hint kbd { background: #f0f0f3; }
.tl-theme { margin-left: 8px; font-size: 13px; }
```

> 说明：既有 styles.css 已全量用 CSS 变量（`--bg/--fg/...`），故 light 主题主要是变量覆盖；仅少数硬编码深色（`.modal` `#26262b`、`kbd` `#1a1a1e`）在 light 下单独覆盖。实现者用 Chrome 在 light 下扫一眼有无遗漏的硬编码深色块，补进上面选择器。

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run packages/client/test/theme.test.ts`
Expected: PASS
Run: `npm run typecheck`
Expected: 清洁。

- [ ] **Step 7: Chrome 截图自验（主题）**

Chrome `?server=`：点 titlebar 主题按钮循环 system→light→dark，确认整窗配色切换、reload 后保持（localStorage）。截图 light+dark 各一张存 scratchpad。

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/settings/theme.ts packages/client/src/settings/settings.ts packages/client/src/App.tsx packages/client/src/chrome/Titlebar.tsx packages/client/src/styles.css packages/client/test/theme.test.ts
git commit -m "feat(client): 主题 system/light/dark（CSS 变量覆盖 + 持久化）"
```

---

### Task 11: i18n 基础设施 + Plan 4 面文案外置

**Files:**
- Create: `packages/client/src/i18n/dict.ts`（zh/en 字典）
- Create: `packages/client/src/i18n/index.ts`（`t()` + 语言 hook）
- Modify: `packages/client/src/settings/settings.ts`（`setLang`——T7 已建）
- Modify: `packages/client/src/chrome/Titlebar.tsx`（语言切换）
- Modify: 若干 Plan-4 新组件与关键 chrome 走 `t()`（见 Step 4）
- Test: `packages/client/test/i18n.test.ts`

**Interfaces:**
- Consumes: `useSettings.lang`（T7）。
- Produces:
  - `t(key: MsgKey, lang?: Lang): string`（纯，缺省读 store lang）
  - `useT(): (key: MsgKey) => string`（组件内响应 lang 变化）

- [ ] **Step 1: Write the failing test**

Create `packages/client/test/i18n.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { t } from "../src/i18n/index.js"
import { DICT } from "../src/i18n/dict.js"

describe("i18n t()", () => {
  it("按 lang 取词", () => {
    expect(t("dispatch.title", "zh")).toBe("新 Workspace")
    expect(t("dispatch.title", "en")).toBe("New Workspace")
  })
  it("缺 key → 回退 key 本身（不崩）", () => {
    expect(t("nonexistent.key" as any, "en")).toBe("nonexistent.key")
  })
  it("zh/en 字典 key 集一致（无漏译）", () => {
    const zk = Object.keys(DICT.zh).sort()
    const ek = Object.keys(DICT.en).sort()
    expect(ek).toEqual(zk)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/i18n.test.ts`
Expected: FAIL —「t is not a function」。

- [ ] **Step 3: Implement dict.ts + index.ts**

Create `packages/client/src/i18n/dict.ts`（含 Plan 4 面 + 代表性 chrome 文案；zh/en key 集必须一致）：

```typescript
export const DICT = {
  zh: {
    "dispatch.title": "新 Workspace",
    "dispatch.project": "项目",
    "dispatch.engine": "引擎",
    "dispatch.model": "模型",
    "dispatch.effort": "effort",
    "dispatch.cancel": "Esc 取消",
    "dispatch.placeholder": "描述任务… Enter 创建 workspace 并作为首条 prompt 投递",
    "right.changes": "Changes",
    "right.files": "Files",
    "diff.commentSelected": "评论选中行",
    "diff.back": "‹ 返回变更列表",
    "diff.binary": "二进制文件，无行级 diff",
    "diff.loading": "加载 diff…",
    "palette.placeholder": "输入命令…",
    "palette.empty": "无匹配命令",
    "footer.all": "⌘/ 全部快捷键",
    "offline.banner": "server 重连中…（终端画面由 tmux 保管，不会丢）",
    "composer.placeholder": "给 engine 的话… Enter 发送 · ⌘Enter 打断并发送 · ⌥Enter 仅插入 · ⇧Enter 换行",
  },
  en: {
    "dispatch.title": "New Workspace",
    "dispatch.project": "Project",
    "dispatch.engine": "Engine",
    "dispatch.model": "Model",
    "dispatch.effort": "effort",
    "dispatch.cancel": "Esc to cancel",
    "dispatch.placeholder": "Describe the task… Enter creates the workspace and delivers it as the first prompt",
    "right.changes": "Changes",
    "right.files": "Files",
    "diff.commentSelected": "Comment on selection",
    "diff.back": "‹ Back to changes",
    "diff.binary": "Binary file — no line diff",
    "diff.loading": "Loading diff…",
    "palette.placeholder": "Type a command…",
    "palette.empty": "No matching command",
    "footer.all": "⌘/ All shortcuts",
    "offline.banner": "Reconnecting to server… (terminal is preserved by tmux)",
    "composer.placeholder": "Message to engine… Enter send · ⌘Enter interrupt+send · ⌥Enter insert · ⇧Enter newline",
  },
} as const

export type MsgKey = keyof (typeof DICT)["zh"]
```

Create `packages/client/src/i18n/index.ts`:

```typescript
import { useSettings, type Lang } from "../settings/settings"
import { DICT, type MsgKey } from "./dict"

export const t = (key: MsgKey, lang?: Lang): string => {
  const l = lang ?? useSettings.getState().lang
  return DICT[l]?.[key] ?? DICT.zh[key] ?? key
}

/** 组件内用：随 lang 变化重渲染。 */
export const useT = (): ((key: MsgKey) => string) => {
  const lang = useSettings((s) => s.lang)
  return (key: MsgKey) => t(key, lang)
}
```

- [ ] **Step 4: 把 Plan 4 面 + 关键 chrome 文案换成 t()**

在以下组件内 `const tr = useT()`，把硬编码中文换成 `tr("...")`（**只换 Step 3 字典里有 key 的那些**）：
- `Dispatch.tsx`：`<h2>{tr("dispatch.title")}</h2>`、项目/引擎/模型/effort label、cancel、placeholder。
- `DiffView.tsx`：「评论选中行」`diff.commentSelected`、binary、loading。
- `RightPanel.tsx`：「返回变更列表」`diff.back`、Changes/Files 标签用 `right.changes`/`right.files`。
- `CommandPalette.tsx`：`palette.placeholder`、`palette.empty`。
- `Footer.tsx`：「全部快捷键」`footer.all`。
- `App.tsx`：offline banner `offline.banner`。
- `Composer.tsx`：默认 placeholder `composer.placeholder`。

`Titlebar.tsx` 加语言切换（zh⇄en）：

```typescript
const lang = useSettings((s) => s.lang)
<button className="tl-lang" title="Language" onClick={() => useSettings.getState().setLang(lang === "zh" ? "en" : "zh")}>
  {lang === "zh" ? "中" : "EN"}
</button>
```

> 其余 M1 组件（Sidebar/TabsBar/EmptyState 等）的文案迁移沿用同一 `useT()` 模式增量补，不在本 task 强制全量——字典按需扩 key（zh/en 成对，`i18n.test.ts` 的 key-集一致断言会守住漏译）。

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run packages/client/test/i18n.test.ts`
Expected: PASS（含 zh/en key 集一致断言）。
Run: `npm run typecheck`
Expected: 清洁。

- [ ] **Step 6: Chrome 截图自验（i18n）**

Chrome `?server=`：点 titlebar 语言按钮 zh⇄en，确认 dispatch/diff/palette/footer/composer placeholder 文案切换。截图 en 一张存 scratchpad。

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/i18n/ packages/client/src/settings/settings.ts packages/client/src/chrome/Titlebar.tsx packages/client/src/composer/Dispatch.tsx packages/client/src/rightpanel/DiffView.tsx packages/client/src/rightpanel/RightPanel.tsx packages/client/src/chrome/CommandPalette.tsx packages/client/src/chrome/Footer.tsx packages/client/src/App.tsx packages/client/src/composer/Composer.tsx packages/client/test/i18n.test.ts
git commit -m "feat(client): i18n 基础设施（t/useT + zh/en）+ Plan 4 面文案外置"
```

---

### Task 12: 附件/图片（composer 图片 → 临时目录 → 插路径）

**Files:**
- Create: `packages/client/src/composer/attachments.ts`（纯组装 + wiring）
- Modify: `packages/client/src/composer/Composer.tsx`（textarea paste/drop 图片）
- Modify: `packages/server/src/http/app.ts`（`POST /workspaces/:id/attachments`）
- Test: `packages/client/test/attachments.test.ts`、`packages/server/test/http-attachments.test.ts`

**Interfaces:**
- Consumes: `getApi()`（data.ts）；server `ws.path`。
- Produces:
  - `parseDataUrl(dataUrl): { mime: string; base64: string } | null`（纯）
  - `attachmentFilename(mime, seq): string`（纯）
  - server `POST /workspaces/:id/attachments { filename, dataBase64 }` → `201 { path }`（写 `<coolieHome>/attachments/<wsId>/<uuid>-<filename>`，返回**绝对路径**供 `@` 注入）。

- [ ] **Step 1: Write the failing test（client 纯）**

Create `packages/client/test/attachments.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { parseDataUrl, attachmentFilename } from "../src/composer/attachments.js"

describe("attachments 纯逻辑", () => {
  it("parseDataUrl 拆 mime + base64", () => {
    expect(parseDataUrl("data:image/png;base64,AAAB")).toEqual({ mime: "image/png", base64: "AAAB" })
  })
  it("非 data URL → null", () => {
    expect(parseDataUrl("http://x/y.png")).toBeNull()
    expect(parseDataUrl("")).toBeNull()
  })
  it("attachmentFilename 由 mime 推扩展名 + seq", () => {
    expect(attachmentFilename("image/png", 1)).toBe("pasted-1.png")
    expect(attachmentFilename("image/jpeg", 2)).toBe("pasted-2.jpg")
    expect(attachmentFilename("image/gif", 3)).toBe("pasted-3.gif")
    expect(attachmentFilename("application/octet-stream", 4)).toBe("pasted-4.bin")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/attachments.test.ts`
Expected: FAIL —「parseDataUrl is not a function」。

- [ ] **Step 3: Implement attachments.ts**

Create `packages/client/src/composer/attachments.ts`:

```typescript
import { useData } from "../stores/data"

export const parseDataUrl = (dataUrl: string): { mime: string; base64: string } | null => {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  return m ? { mime: m[1]!, base64: m[2]! } : null
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }
export const attachmentFilename = (mime: string, seq: number): string => `pasted-${seq}.${EXT[mime] ?? "bin"}`

let seq = 0
/** 上传图片 → 得绝对路径 → 交回调（Composer 插入草稿）。失败静默（返回 null）。 */
export const uploadAttachment = async (wsId: string, dataUrl: string): Promise<string | null> => {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) return null
  const api = useData.getState().getApi()
  if (!api) return null
  const filename = attachmentFilename(parsed.mime, ++seq)
  try {
    const r = await api.req("POST", `/workspaces/${wsId}/attachments`, { filename, dataBase64: parsed.base64 })
    return r.path ?? null
  } catch { return null }
}
```

- [ ] **Step 4: Composer paste/drop 图片**

在 `packages/client/src/composer/Composer.tsx` 的 `<textarea>` 加 `onPaste`/`onDrop`：读剪贴板/拖拽的图片 File → `FileReader.readAsDataURL` → `uploadAttachment` → 把返回路径以 `@<abspath>` 追加进 composer（复用 `update`）。加 helper（组件内）：

```typescript
  const handleImage = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result ?? "")
      void import("./attachments").then(({ uploadAttachment }) =>
        uploadAttachment(wsId, url).then((path) => {
          if (path) update(text === "" ? `@${path}` : `${text} @${path}`)
        }))
    }
    reader.readAsDataURL(file)
  }
```

textarea 加：

```typescript
          onPaste={(e) => {
            const img = Array.from(e.clipboardData.items).find((it) => it.type.startsWith("image/"))
            const f = img?.getAsFile()
            if (f) { e.preventDefault(); handleImage(f) }
          }}
          onDrop={(e) => {
            const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("image/"))
            if (f) { e.preventDefault(); handleImage(f) }
          }}
```

- [ ] **Step 5: Write the failing test（server 端点）**

Create `packages/server/test/http-attachments.test.ts`（沿用 http 测试装配手法，注入一个临时 `home`）：

```typescript
// 复制本目录既有 http 测试的 app 装配 helper；核心断言：
it("POST /workspaces/:id/attachments 写文件并回绝对路径", async () => {
  const tiny = Buffer.from("hello").toString("base64")
  const r = await request("POST", `/workspaces/${wsId}/attachments`, { filename: "pasted-1.png", dataBase64: tiny })
  expect(r.status).toBe(201)
  expect(r.body.path).toMatch(/attachments/)
  expect(fs.existsSync(r.body.path)).toBe(true)
  expect(fs.readFileSync(r.body.path).toString()).toBe("hello")
})
it("路径穿越 filename 被拒（400）", async () => {
  const r = await request("POST", `/workspaces/${wsId}/attachments`, { filename: "../../evil", dataBase64: "AA==" })
  expect(r.status).toBe(400)
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/server/test/http-attachments.test.ts`
Expected: FAIL — 404（路由未加）。

- [ ] **Step 7: Add attachments route in app.ts**

在 `packages/server/src/http/app.ts` 的 tabsCreate 路由块附近加（需要 `config.home` 或注入的 home——用既有 `cfg`/home 变量；参考 `claudeHome`/`codexHome` 的注入方式，若 app 有 `config.home` 用之，否则在 `AppDeps` 增 `attachmentsDir?: string` 由 wiring 传 `<home>/attachments`）：

```typescript
        const attachRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/attachments$/)
        if (req.method === "POST" && attachRoute) {
          const body = await readJson(req)
          const filename = String(body.filename ?? "")
          // 防路径穿越：只许 basename，无分隔符、非 . / ..
          if (filename === "" || filename !== path.basename(filename) || filename === "." || filename === "..")
            return err(res, 400, "Validation", "filename 非法")
          if (typeof body.dataBase64 !== "string") return err(res, 400, "Validation", "dataBase64 required")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(attachRoute[1]!)
              if (ws.status !== "active") return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              return ws
            }),
            async (ws) => {
              try {
                const dir = path.join(config!.home, "attachments", ws.id)
                fs.mkdirSync(dir, { recursive: true })
                const dest = path.join(dir, `${randomUUID()}-${filename}`)
                fs.writeFileSync(dest, Buffer.from(body.dataBase64, "base64"))
                send(res, 201, { path: dest })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "Internal", e?.message ?? String(e))
              }
            },
            onError,
          )
        }
```

顶部 import 增补 `import { randomUUID } from "node:crypto"`、确保 `fs`/`path` 已 import（app.ts 顶部已有 `import * as fs` / path，若无则加）。`config!.home` 若不存在于 `config`，改用 `AppDeps.attachmentsDir` 注入（在 wiring 处传 `path.join(home, "attachments")`，此处 `path.join(attachmentsDir, ws.id)`）。实现者按 app.ts 现有 config 形状二选一，保持与 `claudeHome`/`codexHome` 注入一致。

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run packages/client/test/attachments.test.ts packages/server/test/http-attachments.test.ts`
Expected: PASS
Run: `npm run typecheck`
Expected: 清洁。

- [ ] **Step 9: Chrome 截图自验（附件）**

Chrome `?server=`：composer 里 `Cmd+V` 粘一张截图 → composer 追加 `@<abspath>`；Enter 投递后 claude 能读到该图片路径。截图存 scratchpad。

- [ ] **Step 10: Commit**

```bash
git add packages/client/src/composer/attachments.ts packages/client/src/composer/Composer.tsx packages/server/src/http/app.ts packages/client/test/attachments.test.ts packages/server/test/http-attachments.test.ts
git commit -m "feat(client): composer 图片附件（粘贴/拖拽 → 临时目录 → @路径注入）"
```

---

### Task 13: web client 壳（复用三通道，守卫 Tauri 专有面）

> **可降级**（D5）：若执行时超载，本 task 可整体延 M2.5，不阻塞 T1–T12 与 T14。若延后，T14 冒烟清单删去 web 项。

> **MED-2 决策（web 入口，诚实的最小选项）：不新造 `web.tsx`。** 既有 `index.html` 已 `<script src="/src/main.tsx">`，`main.tsx` 挂 `<App/>`；而计划里的 `web.tsx` 与 `main.tsx` 逐字节相同——那是欺骗性重复。**真相是：`index.html` + `src/main.tsx` + M1 的 `?server=<port>:<token>` dev seam 本身就是 M2 的 web client。** web 与桌面的唯一实质差异是构建期 `__COOLIE_SERVER_CMD__` define：桌面注入 daemon 拉起命令，web 置空（web 永不 spawn，`discovery.ts` 非-Tauri 分支只 probe）。故 web 目标 = 复用 `index.html` 入口的一份 `vite.web.config.ts`（换 `outDir` + 空 define）+ 运行期 `isDesktop()` 守卫原生面。**不新增入口文件。**

**Files:**
- Create: `packages/client/vite.web.config.ts`（web 构建配置，`input: "index.html"`——复用既有入口）
- Create: `packages/client/src/platform.ts`（`isDesktop()`）
- Modify: `packages/client/src/chrome/Titlebar.tsx`（Tauri 拖拽/窗口按钮守卫）
- Modify: `packages/client/src/terminal/TabsBar.tsx`（Open in iTerm2 按钮 `isDesktop()` 守卫——若该按钮在别处，grep `iTerm` 定位）
- Modify: `packages/client/package.json`（`build:web`/`dev:web` 脚本）
- Test: `packages/client/test/web-guard.test.ts`

**Interfaces:**
- Consumes: `ensureServer()`（discovery.ts 已在非 Tauri 下走 `?server=` probe）。
- Produces: `isDesktop(): boolean`（= `hasTauri()` 的公开封装，供组件守卫原生面）。

- [ ] **Step 1: Write the failing test**

Create `packages/client/test/web-guard.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest"
import { isDesktop } from "../src/platform.js"

describe("isDesktop（Tauri 探测）", () => {
  afterEach(() => { delete (globalThis as any).window })
  it("无 window.__TAURI_INTERNALS__ → false（web）", () => {
    ;(globalThis as any).window = {}
    expect(isDesktop()).toBe(false)
  })
  it("有 __TAURI_INTERNALS__ → true（desktop）", () => {
    ;(globalThis as any).window = { __TAURI_INTERNALS__: {} }
    expect(isDesktop()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/web-guard.test.ts`
Expected: FAIL —「Cannot find module ../src/platform.js」。

- [ ] **Step 3: Implement platform.ts**

Create `packages/client/src/platform.ts`:

```typescript
/** 桌面（Tauri）vs web 单一判定。discovery.ts 的 hasTauri 私有，这里给公开封装供 UI 守卫原生面。 */
export const isDesktop = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
```

- [ ] **Step 4: 守卫原生面**

- `Titlebar.tsx`：红绿灯窗口按钮 + 拖拽区仅 desktop 显示：`const desktop = isDesktop()`，`{desktop && <div className="traffic-lights">...</div>}`；`data-tauri-drag-region` 属性只在 desktop 加（web 下自绘 titlebar 不可拖但仍显示标题/连接状态/主题/语言）。
- Open in iTerm2 按钮（grep `iTerm2`/`iTerm` 定位，多半在 `terminal/TabsBar.tsx`）：`{isDesktop() && <button ...>Open in iTerm2</button>}`（web 无本地终端，隐藏）。

- [ ] **Step 5: web 构建配置 + 脚本（复用 index.html 入口，不新造入口文件）**

**不创建 `web.tsx`。** web 目标复用既有 `index.html`（已指向 `/src/main.tsx` → `<App/>`）。只新建一份构建配置换 `outDir` + 空 `__COOLIE_SERVER_CMD__` define。

Create `packages/client/vite.web.config.ts`（对照既有 `vite.config.ts`：同 `@vitejs/plugin-react`，唯一差异是 define 置空 + `outDir: dist-web`，入口仍是仓根 `index.html`）：

```typescript
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// web 构建：入口沿用 index.html（→ src/main.tsx → <App/>）。桌面专有 Tauri invoke 在运行期由 isDesktop() 守卫，
// 不进 web 代码路径。与 vite.config.ts 的唯一实质差异：__COOLIE_SERVER_CMD__ 置空——web 永不 spawn daemon
// （discovery.ts 非-Tauri 分支只按 ?server=<port>:<token> probe 一个已在跑的隔离 server）。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist-web", target: "es2022", rollupOptions: { input: "index.html" } },
  define: { __COOLIE_SERVER_CMD__: JSON.stringify("") },
})
```

`packages/client/package.json` scripts 加：

```json
    "build:web": "vite build --config vite.web.config.ts",
    "dev:web": "vite --config vite.web.config.ts"
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run packages/client/test/web-guard.test.ts`
Expected: PASS
Run: `npm run typecheck && npm --prefix packages/client run build:web`
Expected: typecheck 清洁；web 构建产出 `dist-web/`。

- [ ] **Step 7: Chrome 冒烟自验（web client）**

`npm --prefix packages/client run dev:web`，Chrome 打开 `http://localhost:5173/?server=<port>:<token>`，确认：无红绿灯窗口按钮、无 Open in iTerm2、三通道（列表 REST / 事件 SSE / 终端 WS）都活、composer 投递到位。截图存 scratchpad。

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/platform.ts packages/client/vite.web.config.ts packages/client/src/chrome/Titlebar.tsx packages/client/src/terminal/TabsBar.tsx packages/client/package.json packages/client/test/web-guard.test.ts
git commit -m "feat(client): web client 壳（复用 index.html 入口 + isDesktop 守卫原生面 + web 构建目标）"
```

---

### Task 14: README + 全量回归 + GUI 冒烟清单

**Files:**
- Modify: `README.md`
- Test: 全量 vitest + 双 typecheck

- [ ] **Step 1: 更新 README**

在 `README.md` 补 M2 Plan 4 段：
- **行级 diff 评论写回**：右栏 Changes 点文件 → 行级 diff → 选行 → 「评论选中行」→ 组装进 composer → Enter 经消毒写回 engine PTY。
- **GUI 引擎选择器**：Cmd+N 创建流可选 claude/codex + 模型 + effort（codex）。
- **打磨清单**：⌘K 命令面板、footer cheatsheet、⌘/ 全部快捷键、用户键位覆盖（`~` 侧 localStorage `coolie.keybindings` JSON `{ [hotkeyId]: chord }`）、主题（system/light/dark）、i18n（zh/en，titlebar 切换）、附件（粘贴/拖拽图片）。
- **web client**：`npm --prefix packages/client run dev:web` + `?server=<port>:<token>`；`build:web` 产 `dist-web/`。

- [ ] **Step 2: 全量回归**

Run: `npx vitest run`
Expected: 全绿（含本 plan 新增 diff-parse / comment-format / keybindings / theme / i18n / attachments / engine-select / command-palette / footer / web-guard / engine-busy-toast / server git-diff + attachments + create-effort 用例）。
Run: `npm run typecheck`（client + server 双 typecheck）
Expected: 清洁。
Run: `npm --prefix packages/client run build:web`
Expected: web 构建成功。

- [ ] **Step 3: GUI 冒烟清单（Chrome dev seam，人工 5 分钟）**

起隔离 server（临时 `COOLIE_*_HOME`）+ `dev:vite`，Chrome `?server=<port>:<token>` 逐项走查并截图：
1. **引擎选择器**：Cmd+N → 引擎下拉含 claude+codex；选 codex 出 effort 下拉；创建 codex workspace 成功（create→active）。
2. **行级 diff + 写回**：改动文件 → 右栏点文件 → 行级 diff 渲染（+/−/行号）→ Shift 选多行 → 评论 → composer 出组装 prompt → Enter → 终端 TUI 收到。
3. **409 EngineBusy toast**：codex 忙时 composer 发送 → 右上 toast「engine 正忙」，无裸 alert。
4. **⌘K**：面板 fuzzy 命中 workspace/hotkey，Enter 执行。
5. **footer / ⌘/**：footer 显高频键；点「全部快捷键」弹 cheatsheet。
6. **键位覆盖**：localStorage 设 `coolie.keybindings={"composer.focus":"meta+shift+l"}` → reload → cheatsheet/footer/实际绑定三处都变 ⌘⇧L。
7. **主题**：titlebar 切 light/dark/system，reload 保持。
8. **i18n**：titlebar 切 EN，diff/dispatch/palette/footer/composer 文案变英文。
9. **附件**：composer 粘贴图片 → `@<abspath>` 注入。
10. **web client**：`dev:web` + `?server=` 下无红绿灯/无 iTerm2 按钮，三通道活。
11. **seam-3 stale-status 走查（M2p1/P5 residual）**：归档一个 active workspace → 晚到的 engine wrapper-exit 报告不得把已归档 tab 置 error（左栏徽标应稳定为 archived，不闪 `!`）；unarchive 后 heal 重算状态正确。观察 8s 无 stale `!`。

把 11 项结果（PASS/观察）与截图路径记入 commit message 或 scratchpad 冒烟报告。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: M2 Plan 4 README（行级 diff 写回 + 打磨 + web client）+ 全量回归/GUI 冒烟"
```

---

## Self-Review

**1. Spec / roadmap 覆盖：**

| spec/roadmap 项 | 落点 |
|---|---|
| 行级 diff + 评论写回 PTY（C6, spec §7.1） | T2（server unified-diff 端点）+ T4（解析器）+ T5（DiffView）+ T6（评论组装→composer→消毒管道） |
| `@pierre/diffs` 许可复核 | D1：评估后延后，自撸解析器，留可替换接缝 |
| GUI 引擎选择器（carry-over 第一优先） | T1（Dispatch 去 engines[0] 硬编码 + effort 全链贯通 create，**真 HTTP+lifecycle 集成测试 + retry 保 effort**；T1 是 Dispatch.tsx canonical owner，Plan3 fan-out 后叠） |
| client 409 EngineBusy toast（residual） | T3 |
| seam-3 stale-status walkthrough（residual） | T14 Step 3 项 11（GUI 走查项，非新代码——本就是「观测到再收」的走查项） |
| 用户键位 JSON 覆盖（spec §7.3，M2 削减获批） | T7（mergeKeybindings + 有效 registry，三处同源不破） |
| ⌘K 命令面板 | T8 |
| footer cheatsheet | T9（第三处同源） |
| 主题 | T10（system/light/dark，CSS 变量覆盖已就绪） |
| i18n 文案外置 | T11（t/useT + zh/en + 切换；Plan 4 面全覆盖，M1 面增量，D4） |
| 附件/图片（spec §7.2） | T12（粘贴/拖拽 → 临时目录端点 → @路径） |
| web client 壳 | T13（**复用 index.html+main.tsx 入口**——不造 web.tsx，MED-2；isDesktop 守卫 + web 构建目标，可降级 D5） |
| 回归 + GUI 冒烟 | T14 |

**2. Placeholder 扫描：** 无 TBD/TODO/「类似 Task N」。每个 code step 给了完整代码或精确 before/after 编辑锚点（含行号）。T1 的 `http-create-effort.test.ts` 从「纯贯通点单测」升级为**完整可跑的 HTTP+lifecycle 集成测试**（harness 镜像 `bootstrap-prompt-gate.test.ts`，无占位）。少数「实现者核对」注记（attachments 的 home 注入形状二选一、iTerm2 按钮 grep 定位）——都是与既有代码对齐的机械动作，非设计空白。

**3. Type 一致性核对：**
- `DiffSection`：server（inspect.ts `DiffSection`）与 client（types.ts）同名同形复制（Global Constraints「client 不 import server 包」约定）。
- `FileDiff`：server/client 同形（path/section/unified/binary）。
- `LineSelection`（T5 DiffView 导出）→ T6 `injectComment(wsId, sel)` 与 `formatLineComment(sel, comment)` 消费；T5 占位 `injectComment` 签名 `(wsId: string, sel: LineSelection) => void` 与 T6 真实导出一致。
- `EngineInfo.efforts?: readonly string[]`（T1 types.ts）与 server `GET /config` 下发的 `efforts`（app.ts:480，源自 engine `efforts?: readonly string[]` types.ts:30）一致。
- `StartEngineSessionInput.effort?`（T1）→ `launchCommand({effort})`（engine types.ts:33-34 `launchCommand(opts:{sessionId;model?;effort?})` 已收 effort，核对属实）一致；`PostCreateContext.effort?`→bootstrap `ctx.effort`→session 一致。
- **effort 的 createCtx round-trip（retry 保 effort）**：`PostCreateContext.effort?`（lifecycle.ts:21）↔ `repo.setCreateCtx/getCreateCtx` 形状 `{initialPrompt?;engineId?;effort?}`（workspaces.ts:36-37，T1 一并加 effort——核对既有实现只存/取 initialPrompt+engineId，不改会丢 effort）。集成测试 retry 用例正是钉这一环。
- `buildCreateBody`（T1 导出，`(i:CreateBodyInput)=>Record<string,string>`）签名标记为**跨-plan 稳定契约**（Plan3 fan-out 消费）——engine-select.test.ts 与 DispatchPanel.submit 两处调用点同形。
- `isSafeRelPath`（inspect.ts，T2 导出）在 git-inspect.test.ts 单测 + app.ts git/diff 路由消费，pathspec 守卫与 attachments basename 守卫同源精神。
- `fenceFor`（comment.ts 私有，T6/MINOR-2）：longest-backtick+1 围栏；comment-format.test.ts 的既有「toContain('\`\`\`diff')」用例在无反引号内容下仍恒 3 根，不破。
- `HotkeyId` 扩 `app.commandPalette`/`app.settings`（T7）→ T8 `meta+k` chord、footer FOOTER_IDS 引用一致；`mergeKeybindings`/`effectiveHotkeys` 在 registry.resolveHotkey、Cheatsheet、Footer、CommandPalette 四处消费同一 `useSettings.effectiveHotkeys` 真源。
- `ThemePref`/`Lang` 在 settings.ts 定义，theme.ts/i18n 消费一致。

**4. 波次/共享文件风险：** App.tsx（T8/T9/T10/T13）、styles.css（T5/T8/T9/T10/T11）、registry.ts（T7/T8）、app.ts（T1/T2/T12）已在「波次纪律」列明串行/只追加规则。**新增跨-plan 共享文件 `Dispatch.tsx`（本 plan T1 ⨯ Plan3 fan-out T11）**：BINDING controller 裁定 T1 为 canonical owner（整体重写 + 导出 `buildCreateBody`），Plan3 fan-out 在 T1 合并**之后**、在重写后形状上叠加，`buildCreateBody` 导出签名保持稳定供 Plan3 消费——已在「波次纪律」与 T1 头部双处载明。三个 sibling plan（P2/P3/P4）文件面：本 plan 仅 P4 独占 client/rightpanel、client/settings、client/i18n、client/chrome 新文件；共享的 protocol/App.tsx 按 roadmap §四「Plan 4 后合并吸收」纪律，server app.ts 的 P4 新增路由（git/diff、attachments）与 P2（queue）/P3（fan-out/deep-link）路由是不相邻代码块，追加不改行。

**5. 已解决的歧义：**
- 「写回 PTY」是否直投 → 定为经 composer 草稿（D2），复用消毒/队列/skipStable，不新造投递路径（符合 Global Constraints）。
- effort 能否创建后设 → codex effort 是启动参数（`-c model_reasoning_effort=`），只能 create 时定；且发现 session.ts:29 当前**丢弃** effort/model，T1 一并修复贯通；并核出 `repo.setCreateCtx/getCreateCtx` 只存 initialPrompt+engineId，retry 会丢 effort → T1 补 createCtx 的 effort 存取（集成测试 retry 用例钉死）。
- i18n 全量 vs 范围 → D4 定为「基础设施 + Plan 4 面全覆盖 + M1 面增量」，`i18n.test.ts` 的 zh/en key 集一致断言守漏译。
- web client 入口是否新造 web.tsx → **不造（MED-2）**：`web.tsx` 与 `main.tsx` 逐字节相同是欺骗性重复；`index.html`+`main.tsx`+`?server=` dev seam 本身即 web client，web 目标只差一份换 outDir/空 define 的 `vite.web.config.ts`。
- 评论 diff 块含 ``` 会截断围栏 → MINOR-2：`fenceFor` 用 longest-backtick+1 围栏，含 ``` 内容自动加长到 4+ 根。
- git/diff 参数校验时序 → MINOR-3：param-400 提到 `runRoute` 之前，早于 ws 存在/active（404/409）；path 走 `isSafeRelPath` pathspec 守卫。
- web client 风险 → D5 定为可降级末段 task，不阻塞回归。

**6. SUCCESS loop（自验 ≥8，含 re-grep 名字漂移 + 就地核对真实代码）：**
1. **bootstrap harness 真存在**：读 `packages/server/test/bootstrap-prompt-gate.test.ts`，确认 `buildLayer`/`recordingTmux.newSession` 录制/真 tmux socket/`ProjectsRepo.add` 种项目 手法——T1 集成测试逐一镜像。
2. **launchCommand 收 effort 属实**：engine `types.ts:33-34` 的 `launchCommand(opts:{sessionId;model?;effort?})` 确含 effort；`session.ts:29` 当前**未**传 effort（待 T1 修）——claim 对齐。
3. **createCtx 会丢 effort**：读 `repo/workspaces.ts:96-115`，`setCreateCtx/getCreateCtx` 只 pick initialPrompt+engineId → 不加 effort 则 retry 丢——T1 Step4 补，retry 用例守。
4. **create/retry 走同一 provision**：`lifecycle.ts:153-196` 确认 retry 从 `getCreateCtx` 回填 ctx 再 provision；首启失败注入（newSession→TmuxError→HookError→rollbackToError→status=error）路径核对属实，retry 前置条件 `status==="error"` 满足。
5. **git/diff 路由现状**：`app.ts:488-513` 确认 active 检查在 runRoute 内、send 在成功回调——故 MINOR-3 需把 param 校验**提到 runRoute 之前**才能 400 早于 409；改写后 handler 完整替换给出。
6. **web 入口真相**：读 `index.html`（`<script src="/src/main.tsx">`）+ `main.tsx`（挂 `<App/>`）+ `vite.config.ts`（`__COOLIE_SERVER_CMD__` define）——证实 `web.tsx` 是重复，MED-2 改为复用 index.html。
7. **parser copy 分支**：核对 T4 parser meta `startsWith` 清单原缺 `copy `——补 `copy `/`old mode`/`new mode`/`dissimilarity`；copy 用例断言「零 ctx」防回归误判。
8. **re-grep 名字漂移**：`grep buildCreateBody/CreateBodyInput/isSafeRelPath/launchEfforts/failNextNewSession/fenceFor/web.tsx` 全仓一致——`web.tsx` 仅剩「不新造」的说明性提及，无残留 Create/git-add；T1 commit git-add 补 `repo/workspaces.ts`；typo「spaw」→「spawn」已修。
9. **既有测试不破**：comment-format 既有 `toContain('\`\`\`diff')` 在无反引号内容下围栏恒 3 根仍过；diff-parse 既有 kinds 断言不受新 meta 分支影响（新增行仅命中 meta，不改既有样例）。
