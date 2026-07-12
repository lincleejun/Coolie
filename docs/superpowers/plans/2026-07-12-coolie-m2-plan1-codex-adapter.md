# Coolie M2 · Plan 1：codex 引擎 adapter + 引擎无关运行时接缝 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M1 为 codex 预留的 Engine 抽象接缝真正接通——让 Coolie 能创建 **codex** workspace 并跑通 create→active→archive 全链路：codex 原生 TUI 在 tmux window 0 渲染、hooks 旁路 + rollout mtime 兜底驱动状态徽标、服务端造的会话 id「先启动后回填」、trust 预置跳过首启对话框、effort 档位与 `--resume` 复活。同时把 `GET /config`/`/hooks`/`bootstrap`/transcript-home 从「claude 硬编码」改造为**引擎无关**，并清 5 项 M1 引擎运行时 carry-over。

**Architecture:** 承 M1 三条不可 violated 原则——**codex 与 claude 同构**：engine 进程只属于 tmux（server/CLI 死掉不影响）、绝不自渲染对话流（codex 用它自己的 TUI 在 tmux 里渲染，本计划**不用** app-server / 不用 `exec --json`，那是 M3+ 无头兜底）、绝不 scrape 终端画面（状态只从 codex hooks 回调 + rollout JSONL mtime + git 拿）。新增 `packages/server/src/engine/codex/`（adapter/transcript/trust/hooks 四文件），注册进 `EngineRegistryLive`。M1 已把 `heal.ts` 写成引擎无关（`getEngine(registry, tab.engineId ?? "claude")`），本计划补齐剩余三处硬编码：`GET /config` 下发全部注册引擎、`POST /hooks/:engine` 泛化路由、`bootstrap` 走 `ctx.engineId`；并引入 per-engine 数据目录（claude `~/.claude` / codex `~/.codex`）。会话 id 生命周期差异（claude 客户端造 id / codex 服务端造 id）经新增 `Engine.serverGeneratedId` 标志分流：codex 起始 `engineSessionId=null`，首个 SessionStart hook 回填真 id（复用 M1 `/hooks` 回填接缝，修 C4 使其在 stored=null 时也回填）。依据：spec §六、§一原则、codex.md §1/§3/§5/§6/§9；M2 roadmap `2026-07-12-coolie-m2-roadmap.md`。

**Tech Stack:** 与 main 落地代码一致：TypeScript ^5.x（strict + exactOptionalPropertyTypes）、Node ≥22 运行时（bun 仅装包/跑脚本）、Effect ^3.21.4（Context.Tag / Layer / Effect.gen / Data.TaggedError / runPromiseExit+Exit 解包）、better-sqlite3、vitest、commander；tmux 3.6a（`-L coolie` 专属 socket）；本机 **codex-cli 0.139.0**（`/opt/homebrew/bin/codex`）——真启动只出现在最终 Task 12 手工冒烟，自动化测试一律用 fake Engine 注入或 `COOLIE_CODEX_CMD=cat` 覆盖 seam。无新增 npm 依赖（codex 是外部二进制，走 PATH 发现，同 claude opcode 路线）。

## Global Constraints

（承 M1 Plan 3/4 全套，逐条仍生效——每个 task 的要求隐含本节）

- server 与 CLI 的一切进程**必须以 Node 运行**（`node`/`tsx`），bun 只做 `bun install`/`bun run`（spec §2.2：node-pty 不兼容 Bun）。
- Effect 锁 `^3.21.4`；代码按 main 已合入代码的实际 API 风格书写（`Runtime` 返回 `Exit`、`errorFromCause` 按 `_tag` 映射状态码、repo 的「写库+事件 append」同一 `db.transaction`、bus 广播在 commit 后）。若个别 API 有出入以官方 docs 等价改写，**任务的行为契约（每步测试断言）不变**。
- **engine 进程只属于 tmux**：server 死亡不得杀 engine；codex 的 tmux session 与 claude 同规格（`coolie-<wsId>`、window 0 = engine、keep-alive 包装）。codex adapter 绝不自起进程、绝不 attach——它只产出 `launchCommand` 字符串数组交给 `startEngineSession`。
- **绝不 scrape 终端画面**：codex 状态只来自 ① `POST /hooks/codex`（hooks 旁路）② rollout JSONL mtime 兜底轮询 ③ git。`capturePane` 只允许「测试断言」与 `waitStable` 画面稳定检测两个用途，绝不解析内容取语义。
- **绝不用 app-server / `exec --json` 驱动 codex**（spec §一原则 2 + §十三刻意不做）：M2 codex = 交互式 TUI + 三路旁路语义（codex.md §1 路径三）。app-server / headless 自渲染是 M3+ 兜底，本计划一行都不碰。
- **prompt 消毒强制**：任何经 composer/bootstrap 投向 codex pane 的文本必须先过 `sanitizePromptForPty`（M1 `deliverPrompt` 已内建）。WS 终端通道输入字节是用户真实键击，**原样透传不消毒**（C1 修的正是这条被 M1 违反的地方）。
- **Terminal Identity Boundary**（kobe）：所有进入 tmux/PTY 的环境统一 `TERM=xterm-256color` + `COLORTERM=truecolor`、剥 `TERM_PROGRAM`/`TERM_PROGRAM_VERSION`/`TERM_SESSION_ID`（M1 `sanitizedTmuxEnv` 已做，codex 复用，不重复实现）。
- **hooks 纪律**（kobe hook-cmd 三铁律）：hook 转发脚本绝不拉起 server、任何失败静默、**永远 exit 0**；注入幂等、可 opt-out（`COOLIE_DISABLE_HOOKS=1`）；注入的 codex hooks 配置（`.codex/hooks.json`）必须进 `.git/info/exclude` 防脏树（同 claude `.claude/settings.local.json`）。
- **trust 预置纪律**（承 M1 claude `seedFolderTrust`）：写第三方配置（codex `~/.codex/config.toml` / `.codex/hooks.json`）一律**原子写（tmp+rename）、merge-only（绝不覆盖用户既有键）、幂等、可经 `COOLIE_CODEX_HOME` 覆写到临时目录**。产品决策已记录（同 claude）：用户加入项目派生的 Coolie worktree **隐式受信**。
- **id 生命周期进抽象**：claude=客户端造 id（`--session-id <uuid>`）；codex=服务端造 id（不支持预指定，从 `thread.started`/rollout 文件名/首个 hook 的 `session_id` 回读，codex.md §4/§9）。本计划经 `Engine.serverGeneratedId` 分流，绝不给 codex 传 `--session-id`。
- 安全默认值不变：server 绑 `127.0.0.1` + unix socket；除 `GET /health` 外一切端点（含 `/hooks/:engine`）强制 token；日志绝不打印含 token 的完整 URL。
- SQLite 写库纪律不变：本计划**无 schema 变更**（复用现有 `tabs`/`events`/`workspaces` 表；C2 的 initialPrompt 持久化写进 `workspaces.data` JSON 列，不加列——opencode 折衷）；migration 幂等、禁无 WHERE sweep。
- 所有测试经 `COOLIE_HOME`/`COOLIE_WORKSPACES_ROOT`/`COOLIE_TMUX_SOCKET`/`COOLIE_CLAUDE_HOME`/**`COOLIE_CODEX_HOME`（本计划新增）**指向 mkdtemp 临时目录/专属测试 socket，绝不读写真实 `~/.coolie`、`~/coolie`、`~/.claude`、`~/.codex`，绝不碰生产 `-L coolie` socket；**零泄漏**：每个用了 tmux 的测试文件 afterAll `kill-server`；套件跑完真实 `~/.codex/config.toml` 字节级 diff 必须为空（Task 6 建立此不变量断言）。
- 真 codex 只出现在 Task 12 的手工冒烟清单；自动化测试中 engine 命令一律用 `COOLIE_CODEX_CMD=cat`（launchCommand 用户覆盖 seam，同 `COOLIE_CLAUDE_CMD`）或 fake Engine 注入。
- 每个 Task 结束必须 `git commit`，conventional commits（feat/fix/test/docs/chore）。
- 本计划**不做**（显式延后至其他 M2 plan）：server 端 prompt 队列 + 通知/注意力（Plan 2）；fan-out / deep links / 外部终端（Plan 3）；diff 行评论写回 + 主题/i18n + web client + codex UI 选择器美化（Plan 4——本计划只让 `GET /config` 下发 codex，Dispatch 已能渲染第 0 个引擎，多引擎选择器 UI 归 Plan 4）；codex `notify=[…]` OS 通知兜底（Plan 2 通知域——本计划 turn 检测靠 hooks + rollout mtime 两路已足）；codex app-server（M3+）。

## File Structure（本计划新建/修改）

```
packages/protocol/src/
  routes.ts                          # 修改：POST /workspaces body 描述 +engineId?；+POST /hooks/:engine 路由描述（替 /hooks/claude）
packages/server/
  src/config.ts                      # 修改：+codexHome（COOLIE_CODEX_HOME，默认 ~/.codex）
  src/engine/types.ts                # 修改（F4）：Engine +可选 serverGeneratedId?/models?/efforts?（默认 false/[]/undefined）；prepareWorkspace 多收 codexConfigPath?
  src/engine/registry.ts             # 修改：注册 codexEngine；+engineHome(engineId, cfg) 辅助
  src/engine/codex/adapter.ts        # 新建：codexEngine（capabilities/launchCommand/statusFromHookEvent/…）+ codexModels/codexEfforts
  src/engine/codex/transcript.ts     # 新建：rollout 路径按 UUID 扫描 + deriveTitle（滤合成 user 行）
  src/engine/codex/trust.ts          # 新建：seedCodexTrust（config.toml project trust，原子/merge-only）+ defaultCodexConfigPath
  src/engine/codex/hooks.ts          # 新建：codex .codex/hooks.json 幂等注入（复用泛化转发脚本）
  src/engine/claude/hooks.ts         # 修改：ensureHookScript(home, engineId) 泛化——脚本 POST /hooks/<engine>；claude 调用点传 "claude"
  src/engine/bootstrap.ts            # 修改：registry.get(ctx.engineId ?? "claude")；serverGeneratedId → engineSessionId 起始 null；prepareWorkspace 传 codexConfigPath
  src/engine/session.ts              # 修改（F7）：StartEngineSessionInput.sessionId: string → string|null；launchCommand 调用点 sessionId: i.sessionId ?? ""
  src/workspace/lifecycle.ts         # 修改：PostCreateContext +engineId?；create 存 initialPrompt+engineId 进 workspaces.data；retry 回填 ctx（C2）
  src/workspace/heal.ts              # 修改（F1）：transcriptExists 的 home 用 engineHome(engine.id, cfg) 而非硬编码 cfg.claudeHome（Task 3）
  src/engine/monitor.ts             # 修改（F1）：TranscriptPollerDeps 去 engine/home 单值 → resolveEngine(engineId)+homeFor(engineId) per-tab 注册表查；pollOnce 按 tab.engineId 解析引擎+home（Task 3）
  src/http/app.ts                    # 修改：GET /config 下发全部注册引擎；/hooks/claude → /hooks/:engine（registry.get(engine)）；C4 回填在 stored=null 时也触发；deriveTitle 用 engineHome；engine-exit 单事务（C3）；F6 /input send-while-busy 409 守卫
  src/main.ts                        # 修改（F1）：startTranscriptPoller 装配从单 engine/home → resolveEngine/homeFor 闭包（查 registry + engineHome）
  src/http/ws.ts                     # 修改：C1 输入二进制原样透传（去 toString("utf8")）
  README.md（或 packages/server/README）# 修改：codex 引擎接入说明 + 冒烟清单（Task 12）
```

## Task Order / 波次并行（adversarial review 采纳的分区）

12 个 task 不是严格线性——按共享文件切成四波，波内标 ∥ 的可并行，标 → 的须串行：

```
Wave A  ∥  { T5, T6, T7, T10 }        # 纯新建/独立文件（codex transcript/trust/hooks；ws.ts 输入 + F6 http.input 测试），互不碰
Wave B  →  T3 → T8 → T1               # T3 落 types 可选字段 + engineHome + monitor/heal；T8 codex adapter+注册；T1 /config 下发（依赖 registry 有 codex）
Wave C  →  T2 → T4 → T9               # T2 create 贯通 engineId；T4 /hooks:engine + F6 守卫；T9 bootstrap 服务端造 id 回填
Wave D  →  T11 → T12                  # T11 retry/engine-exit 事务；T12 README + 全量回归 + 冒烟
```

> **⚠ app.ts / bootstrap.ts 共享冲突面（M1 P5「共享文件串行段」纪律）**：**T1 / T2 / T4 / T11 都改 `http/app.ts`，且 T2 / T4 / T9 都改 `engine/bootstrap.ts`——这些 task 绝不并发执行**（同一文件的行级冲突不可 merge）。Wave B/C/D 的 `→` 串行即为此设。Wave A 与 B/C/D 之间：A 全为独立文件，可与 B 的 T3 起点并行铺开，但 T8 需要 T5/T6/T7 的产物（transcript/trust/hooks）就绪，故 A 必须先于 T8 收口。跨 task 的 `Engine` 可选字段（F4）与 `engineHome`/`TranscriptPollerDeps`（F1）契约在 T3 定档，后续 task 只消费不重定义。

---

### Task 1: `GET /config` 下发全部注册引擎（去 claude 硬编码）

**Files:**
- Modify: `packages/server/src/http/app.ts`（`GET /config` 段，约 421–438 行）
- Test: `packages/server/test/http.config.test.ts`（若无则新建；沿用现有 http 测试装配）

**Interfaces:**
- Consumes: `EngineRegistry`（`ReadonlyMap<string, Engine>`）、`Engine.{id,displayName,capabilities}`、adapter 侧 `claudeModels`。
- Produces: `GET /config` 返回 `{ tmuxSocket, engines: Array<{id, displayName, capabilities, models, efforts?}> }`——`engines` 覆盖 registry 全部条目（M1 只有 claude；本计划 Task 8 注册 codex 后自动多一条）。client `stores/data.ts` 已按 `engines[]` 数组消费，无需改 client。

- [ ] **Step 1: 写失败测试**——config 下发数组含每个注册引擎

在 `packages/server/test/http.config.test.ts` 追加（若文件不存在，参照 `packages/server/test/` 现有 http 测试的 server 装配 helper 建立最小骨架，注入一个含两个 fake engine 的 registry）：

```ts
import { describe, it, expect } from "vitest"
import { Layer } from "effect"
import { EngineRegistry } from "../src/engine/registry.js"
import type { Engine } from "../src/engine/types.js"
// 复用现有 http 测试的 buildApp / request helper（同目录其它 http.*.test.ts 的模式）
import { withTestServer, get } from "./helpers/http.js"

const fakeEngine = (id: string, models: string[]): Engine => ({
  id, displayName: `Fake ${id}`,
  capabilities: { nativeQueue: id === "claude", midSessionModelSwitch: true, resume: true, hooks: true, effort: id === "codex" },
  terminalTitle: "none", serverGeneratedId: id === "codex",
  newSessionId: () => "x", launchCommand: () => [id], statusFromHookEvent: () => null,
  transcriptPath: () => "/dev/null", deriveTitle: () => null, resumeArgs: () => [], models, efforts: id === "codex" ? ["low", "high"] : undefined,
})

describe("GET /config engines", () => {
  it("下发全部注册引擎，非仅 claude", async () => {
    const reg = new Map<string, Engine>([["claude", fakeEngine("claude", ["default", "opus"])], ["codex", fakeEngine("codex", ["gpt-5"])]])
    await withTestServer({ registry: Layer.succeed(EngineRegistry, reg) }, async (base, token) => {
      const body = await get(base, "/config", token)
      const ids = body.engines.map((e: any) => e.id).sort()
      expect(ids).toEqual(["claude", "codex"])
      const codex = body.engines.find((e: any) => e.id === "codex")
      expect(codex.capabilities.nativeQueue).toBe(false)
      expect(codex.models).toEqual(["gpt-5"])
      expect(codex.efforts).toEqual(["low", "high"])
    })
  })
})
```

> 注（F4，前置微改本 task 就做，别拖到 Task 8）：在 `packages/server/src/engine/types.ts` 的 `Engine` interface 加三个**可选**字段——`serverGeneratedId?: boolean`（默认 false）、`models?: readonly string[]`（默认 `[]`）、`efforts?: readonly string[]`。**选可选而非必填是刻意的**：M1 已有 4 个 `Engine` 测试 fake（`test/http-heal.test.ts`、`test/heal.test.ts`、`test/lifecycle-tmux.test.ts`、`test/bootstrap-prompt-gate.test.ts`，皆 `nativeQueue:true` 的 claude 替身）不设这三字段——若设必填，这 4 个 fake + 真 `claudeEngine` 全部 typecheck 报错，须逐个补字段；设可选则**零改动**通过（它们 serverGeneratedId 默认 false、models 默认 `[]`，对各自测试语义无影响，因这些测试不打 `GET /config`）。本 task 的 `fakeEngine` helper 显式设了三字段（它要断言 /config 下发），是刻意示范。Task 8 只需给真 claude/codex adapter 显式补 `serverGeneratedId`/`models`（否则 /config 下发空 models、GUI 无选项）。字段完整定义见 Task 8 Step 4。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/http.config.test.ts`
Expected: FAIL——现状 `engines` 只含 claude（硬编码 `claude ? [{…}] : []`），断言 `["claude","codex"]` 不满足；或 `withTestServer` helper 若缺则先补 helper。

- [ ] **Step 3: 改 `GET /config` 遍历 registry**

`packages/server/src/http/app.ts` 内 `GET /config` 段替换硬编码 claude 分支。先在文件顶部把 `import { claudeModels } from "../engine/claude/adapter.js"` 改为不再单点依赖 claude（保留 import 供 registry 内引擎自带 models）。将 Effect 体改为：

```ts
        if (route === "GET /config") {
          if (!config) return err(res, 500, "Internal", "config unavailable")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const registry = yield* EngineRegistry
              const engines = [...registry.values()].map((e) => ({
                id: e.id,
                displayName: e.displayName,
                capabilities: e.capabilities,
                models: e.models ?? [], // F4：models 可选，缺省下发空数组（fake 引擎无 models）
                ...(e.efforts !== undefined ? { efforts: e.efforts } : {}),
              }))
              return { tmuxSocket: config.tmuxSocket, engines }
            }),
            (body) => send(res, 200, body),
            onError,
          )
        }
```

> `Engine` 需暴露 `models`/`efforts`（见 Step 1 注）。claude adapter 的 `claudeModels` 迁移进 `claudeEngine.models`（Task 8 一并处理 codex；此处 claude 若尚未挂 `models` 字段，先把 `claudeEngine.models = claudeModels`）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/server && bun run vitest run test/http.config.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/app.ts packages/server/src/engine/types.ts packages/server/test/http.config.test.ts
git commit -m "feat(server): GET /config 下发全部注册引擎（去 claude 硬编码）"
```

---

### Task 2: create 流水线贯通 `engineId`（bootstrap 用 ctx.engineId）

**Files:**
- Modify: `packages/protocol/src/routes.ts`（POST /workspaces 描述）
- Modify: `packages/server/src/workspace/lifecycle.ts`（`PostCreateContext` +engineId；create 透传）
- Modify: `packages/server/src/http/app.ts`（POST /workspaces 读 body.engineId）
- Modify: `packages/server/src/engine/bootstrap.ts`（`registry.get(ctx.engineId ?? "claude")`）
- Test: `packages/server/test/engine.bootstrap.test.ts`（现有 bootstrap 测试文件追加）

**Interfaces:**
- Consumes: `PostCreateContext`（M1：`{ initialPrompt? }`）、`EngineRegistry`。
- Produces: `PostCreateContext = { readonly initialPrompt?: string; readonly engineId?: string }`；`WorkspaceLifecycle.create(opts)` opts +`engineId?: string`；bootstrap 依 `ctx.engineId ?? "claude"` 选引擎、tab.engineId = 该引擎 id。

- [ ] **Step 1: 写失败测试**——create 带 engineId 时 bootstrap 选对应引擎

在 `packages/server/test/engine.bootstrap.test.ts` 追加（沿用该文件既有的 fake tmux + in-memory repo 装配；注入含 claude+一个 fake "codex" 的 registry，fake codex 的 `launchCommand` 返回 `["codex-fake"]`）：

```ts
it("create 带 engineId=codex → tab.engineId=codex、launch 用 codex 命令", async () => {
  const { runCreate, tabsRepo, tmux } = await setupBootstrap({ engines: ["claude", "codex-fake"] })
  const ws = await runCreate({ engineId: "codex", initialPrompt: "" })
  const tab = await tabsRepo.findEngineTab(ws.id)
  expect(tab?.engineId).toBe("codex")
  expect(tmux.lastNewSession?.command.join(" ")).toContain("codex-fake")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.bootstrap.test.ts -t "engineId=codex"`
Expected: FAIL——现状 `registry.get("claude")` 恒选 claude。

- [ ] **Step 3: 加 engineId 到 PostCreateContext 与 create opts**

`packages/server/src/workspace/lifecycle.ts`：

```ts
export interface PostCreateContext { readonly initialPrompt?: string; readonly engineId?: string }
```

`create` 的 opts 类型（约 31 行）加 `engineId?: string`，并在调用 `provision` 时透传（约 170 行）：

```ts
        return yield* provision(ws, project.repoRoot, {
          ...(opts.initialPrompt !== undefined ? { initialPrompt: opts.initialPrompt } : {}),
          ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
        }).pipe(
```

- [ ] **Step 4: http 读 body.engineId + 校验**

`packages/server/src/http/app.ts` 的 `POST /workspaces` 段，在既有校验后加：

```ts
          if (body.engineId !== undefined && typeof body.engineId !== "string")
            return err(res, 400, "Validation", "engineId must be a string")
```

并在 `create({…})` 调用里加：

```ts
                ...(body.engineId ? { engineId: body.engineId } : {}),
```

- [ ] **Step 5: bootstrap 用 ctx.engineId**

`packages/server/src/engine/bootstrap.ts` 内，把 `const engine = registry.get("claude")` 改为：

```ts
        const engineId = ctx.engineId ?? "claude"
        const engine = registry.get(engineId)
        if (!engine) return yield* new HookError({ message: `engine 未注册：${engineId}` })
```

（下方 `engine.newSessionId()`、`engine.capabilities.hooks`、`engine.prepareWorkspace`、tab.engineId=engine.id 全部自然随 `engine` 变量走，无需再改。）

- [ ] **Step 6: 更新 protocol 路由描述**

`packages/protocol/src/routes.ts` 第 9 行描述改为：

```ts
  { method: "POST",   path: "/workspaces",               description: "创建 workspace {projectId, engineId?, branchSlug?, name?, initialPrompt?}（engineId 缺省 claude；同步跑完流水线才返回）" },
```

- [ ] **Step 7: 跑测试确认通过 + 回归**

Run: `cd packages/server && bun run vitest run test/engine.bootstrap.test.ts && bun run typecheck && cd ../protocol && bun run typecheck`
Expected: PASS；双 typecheck 清洁。

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/routes.ts packages/server/src/workspace/lifecycle.ts packages/server/src/http/app.ts packages/server/src/engine/bootstrap.ts packages/server/test/engine.bootstrap.test.ts
git commit -m "feat(server): create 流水线贯通 engineId（bootstrap 走 ctx.engineId）"
```

---

### Task 3: per-engine 数据目录（`codexHome` + `engineHome` 辅助）+ monitor/heal per-engine home 转换（F1/F2）

**Files:**
- Modify: `packages/server/src/config.ts`（+codexHome）
- Modify: `packages/server/src/engine/registry.ts`（+engineHome 辅助）
- Modify: `packages/server/src/engine/monitor.ts`（F1：`TranscriptPollerDeps` 去单 `engine`/`home` → per-tab `resolveEngine`/`homeFor`；`pollOnce` 按 `tab.engineId` 解析）
- Modify: `packages/server/src/workspace/heal.ts`（F1：`transcriptExists` 的 home 从硬编码 `cfg.claudeHome` → `engineHome(engine.id, cfg)`）
- Modify: `packages/server/src/main.ts`（F1：poller 装配改喂 `resolveEngine`/`homeFor` 闭包）
- Test: `packages/server/test/config.test.ts`、`packages/server/test/engine.registry.test.ts`、`packages/server/test/engine.monitor.test.ts`（新增 per-engine 轮询 RED 测试）

**Interfaces:**
- Consumes: `CoolieConfig`（M1：含 `home`、`claudeHome`、`tmuxSocket` 等）、`EngineRegistry`（`ReadonlyMap<string, Engine>`）、`Engine.transcriptPath`。
- Produces:
  - `CoolieConfig.codexHome: string`（`COOLIE_CODEX_HOME` 覆写，默认 `~/.codex`）；`engineHome(engineId: string | null, cfg: { claudeHome: string; codexHome: string }): string`——claude→claudeHome、codex→codexHome、null/未知→claudeHome 兜底。供 Task 4/5/6/9/11 与 monitor/heal/hooks 端点解析 per-engine 转录目录。
  - **F1**：`TranscriptPollerDeps` 丢弃单值 `engine`/`home`，改为 `resolveEngine(engineId: string | null) => Engine | undefined`（注册表查）+ `homeFor(engineId: string | null) => string`（per-engine home）。`pollOnce` 对每个 tab 用其 `tab.engineId` 解析引擎与 home——两个不同引擎的 tab 各读**自己的** home（claude→claudeHome、codex→codexHome），不再全表钉死 claude。
  - **F2**：`pollOnce` 保留 `if (tab.engineSessionId === null) continue`——codex 服务端造 id 在首个 SessionStart hook 回填前 `engineSessionId=null`。此期**刻意不做 mtime 兜底**：codex rollout 文件在 SessionStart（=会话真正起）之前根本不存在，`statMtimeMs` 必得 null，兜底无从谈起；而 F3 已保证 codex 首启即触发 hook（`--dangerously-bypass-hook-trust` + trust 预置），SessionStart hook 一到即回填 id，之后轮询正常接管。故 null-id 期状态由 hooks 独家负责（有据可依，非漏洞）。测试钉死：null-id 的 codex tab 被安全跳过（不抛、不 stat）。

- [ ] **Step 1: 写失败测试**

`packages/server/test/config.test.ts` 追加：

```ts
it("codexHome 默认 ~/.codex，可经 COOLIE_CODEX_HOME 覆写", () => {
  const a = loadConfig({ ...baseEnv }); expect(a.codexHome).toBe(path.join(os.homedir(), ".codex"))
  const b = loadConfig({ ...baseEnv, COOLIE_CODEX_HOME: "/tmp/cx" }); expect(b.codexHome).toBe("/tmp/cx")
})
```

`packages/server/test/engine.registry.test.ts` 追加：

```ts
import { engineHome } from "../src/engine/registry.js"
it("engineHome 按引擎 id 选目录，未知兜底 claudeHome", () => {
  const cfg = { claudeHome: "/c", codexHome: "/x" }
  expect(engineHome("claude", cfg)).toBe("/c")
  expect(engineHome("codex", cfg)).toBe("/x")
  expect(engineHome("mystery", cfg)).toBe("/c")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/config.test.ts test/engine.registry.test.ts`
Expected: FAIL——`codexHome`/`engineHome` 未定义。

- [ ] **Step 3: config 加 codexHome**

`packages/server/src/config.ts`：`CoolieConfig` 的形状里 `claudeHome` 旁加 `codexHome: string`，`loadConfig` 里参照 `claudeHome` 的实现加：

```ts
    codexHome: env.COOLIE_CODEX_HOME ?? path.join(os.homedir(), ".codex"),
```

（若 `claudeHome` 是 `env.COOLIE_CLAUDE_HOME ?? path.join(os.homedir(), ".claude")` 形态，则严格对齐同款。）

- [ ] **Step 4: registry 加 engineHome 辅助**

`packages/server/src/engine/registry.ts` 追加：

```ts
/** per-engine 转录/数据目录解析：claude→claudeHome、codex→codexHome、null/未知→claudeHome 兜底。
 * transcriptPath/deriveTitle/mtime 轮询的调用点用它，替代 M1 硬编码的 cfg.claudeHome。 */
export const engineHome = (engineId: string | null, cfg: { readonly claudeHome: string; readonly codexHome: string }): string =>
  engineId === "codex" ? cfg.codexHome : cfg.claudeHome
```

（`engine.registry.test.ts` 的用例补一行 null 兜底：`expect(engineHome(null, cfg)).toBe("/c")`。）

- [ ] **Step 5: 写 monitor per-engine 轮询失败测试（F1/F2）**

`packages/server/test/engine.monitor.test.ts`（若无则新建）追加——两个不同引擎的 tab 各被轮询到**自己的** home，且 null-id codex tab 被安全跳过：

```ts
import { describe, it, expect } from "vitest"
import { pollOnce, type TranscriptPollerDeps } from "../src/engine/monitor.js"
import type { Engine } from "../src/engine/types.js"
import type { Tab } from "@coolie/protocol"

// 两个 fake 引擎：各自 transcriptPath 把 home 编进返回值，便于断言「读了哪个 home」。
const fakeEngine = (id: string): Engine => ({
  id, displayName: id,
  capabilities: { nativeQueue: id === "claude", midSessionModelSwitch: true, resume: true, hooks: true, effort: id === "codex" },
  terminalTitle: "none",
  newSessionId: () => "x",
  launchCommand: () => [id],
  statusFromHookEvent: () => null,
  transcriptPath: ({ home, sessionId }) => `${home}::${id}::${sessionId}`,
  deriveTitle: () => null,
  resumeArgs: (s) => [s],
})
const mkTab = (id: string, engineId: string, sid: string | null): Tab =>
  ({ id, engineId, engineSessionId: sid, status: "idle", lastHookAt: null, tmuxWindow: 0, title: null } as unknown as Tab)

describe("pollOnce per-engine home（F1/F2）", () => {
  it("两引擎 tab 各读自己的 home；null-id codex tab 安全跳过", async () => {
    const claude = fakeEngine("claude"); const codex = fakeEngine("codex")
    const statted: string[] = []
    const deps: TranscriptPollerDeps = {
      listEngineTabs: async () => [
        { tab: mkTab("t-c", "claude", "sid-c"), workspacePath: "/w/c" },
        { tab: mkTab("t-x", "codex", "sid-x"), workspacePath: "/w/x" },
        { tab: mkTab("t-null", "codex", null), workspacePath: "/w/n" }, // F2：null id
      ],
      statMtimeMs: (p) => { statted.push(p); return null }, // 返回 null → 不改状态，只验路径
      setStatus: async () => {},
      resolveEngine: (eid) => (eid === "codex" ? codex : claude),
      homeFor: (eid) => (eid === "codex" ? "/home/codex" : "/home/claude"),
    }
    await pollOnce(deps)
    expect(statted).toContain("/home/claude::claude::sid-c") // claude tab 读 claudeHome
    expect(statted).toContain("/home/codex::codex::sid-x")   // codex tab 读 codexHome（不是 claudeHome！）
    expect(statted.some((p) => p.includes("t-null") || p.includes("/w/n"))).toBe(false) // null-id 未 stat
    expect(statted).toHaveLength(2)
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.monitor.test.ts`
Expected: FAIL——`TranscriptPollerDeps` 现无 `resolveEngine`/`homeFor`（是单 `engine`/`home`），typecheck 即报错。

- [ ] **Step 7: 改 monitor.ts 为 per-engine（F1/F2）**

`packages/server/src/engine/monitor.ts`——`TranscriptPollerDeps` 与 `pollOnce` 改为按 `tab.engineId` 查引擎/home：

```ts
export interface TranscriptPollerDeps {
  readonly listEngineTabs: () => Promise<Array<{ tab: Tab; workspacePath: string }>>
  readonly statMtimeMs: (p: string) => number | null
  readonly setStatus: (tabId: string, status: TabStatus) => Promise<void>
  /** F1：按 tab.engineId 查引擎（注册表）——不同引擎的 tab 各用自己的 transcriptPath。 */
  readonly resolveEngine: (engineId: string | null) => Engine | undefined
  /** F1：按 tab.engineId 解析 per-engine 转录目录（engineHome）。 */
  readonly homeFor: (engineId: string | null) => string
  readonly now?: () => number
}

export const pollOnce = async (deps: TranscriptPollerDeps): Promise<void> => {
  const now = (deps.now ?? Date.now)()
  for (const { tab, workspacePath } of await deps.listEngineTabs()) {
    // F2：codex 服务端造 id 在首个 SessionStart hook 回填前为 null；此期 rollout 文件尚不存在，
    // mtime 兜底无从做起，状态由 hooks 独家负责（F3 的 --dangerously-bypass-hook-trust 保证 hook 首启即达）。
    if (tab.engineSessionId === null) continue
    const engine = deps.resolveEngine(tab.engineId)
    if (engine === undefined) continue // 未注册引擎：跳过（防御）
    const home = deps.homeFor(tab.engineId)
    const p = engine.transcriptPath({ home, cwd: workspacePath, sessionId: tab.engineSessionId })
    const next = decideStatusFromMtime({
      nowMs: now, mtimeMs: deps.statMtimeMs(p), lastHookAtMs: tab.lastHookAt, current: tab.status,
    })
    if (next !== null) await deps.setStatus(tab.id, next)
  }
}
```

（`startTranscriptPoller` 签名不变——仍收 `TranscriptPollerDeps`，只是其形状变了。）

- [ ] **Step 8: 改 heal.ts + main.ts 装配（F1）**

`packages/server/src/workspace/heal.ts`（约 54–56 行）的 `transcriptExists` 把硬编码 `cfg.claudeHome` 换成 per-engine——它已有 `engine` 参数，改用 `engineHome(engine.id, cfg)`：

```ts
    const transcriptExists = (engine: { id: string; transcriptPath: (o: { home: string; cwd: string; sessionId: string }) => string },
      cwd: string, sessionId: string | null): boolean =>
      sessionId !== null && fs.existsSync(engine.transcriptPath({ home: engineHome(engine.id, cfg), cwd, sessionId }))
```

（`transcriptExists` 的 `engine` 形参类型补上 `id: string`；顶部 `import { engineHome } from "../engine/registry.js"`。）

`packages/server/src/main.ts`（约 94–106 行）poller 装配从单 `engine: claude` / `home: cfg.claudeHome` 改为闭包查注册表：

```ts
  // turn detector 兜底：转录 mtime 轮询（hooks 沉默时接管）——F1：per-engine 解析，非只 claude。
  const registry = Context.get(runtimeCtx, EngineRegistry)
  const stopPoller = startTranscriptPoller({
    listEngineTabs: async () => {
      const exit = await runtime(Effect.gen(function* () { return yield* (yield* TabsRepo).listEngineTabs() }))
      return Exit.isSuccess(exit) ? exit.value : []
    },
    statMtimeMs: (p) => { try { return fs.statSync(p).mtimeMs } catch { return null } },
    setStatus: async (tabId, status) => {
      await runtime(Effect.gen(function* () { yield* (yield* TabsRepo).setStatus(tabId, status, "poller") }))
    },
    resolveEngine: (engineId) => registry.get(engineId ?? "claude"),
    homeFor: (engineId) => engineHome(engineId, cfg),
  })
```

（删除 `const claude = registry.get("claude")` 与 `claude ? … : () => {}` 三元——poller 现对全部注册引擎生效，不再单点依赖 claude 存在；`main.ts` 顶部加 `import { engineHome } from "./engine/registry.js"`。）

- [ ] **Step 9: 跑测试确认通过 + 回归**

Run: `cd packages/server && bun run vitest run test/config.test.ts test/engine.registry.test.ts test/engine.monitor.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁（含 M1 既有 heal/monitor 测试——若它们直接构造旧 `TranscriptPollerDeps`（单 engine/home），须同步改为 `resolveEngine`/`homeFor`——grep `TranscriptPollerDeps`/`startTranscriptPoller(` 全量定位）。

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/engine/registry.ts packages/server/src/engine/monitor.ts packages/server/src/workspace/heal.ts packages/server/src/main.ts packages/server/test/config.test.ts packages/server/test/engine.registry.test.ts packages/server/test/engine.monitor.test.ts
git commit -m "feat(server): per-engine 数据目录 + monitor/heal per-engine home 转换（F1/F2）"
```

---

### Task 4: 泛化 hook 转发脚本 + `POST /hooks/:engine` 路由

**Files:**
- Modify: `packages/server/src/engine/claude/hooks.ts`（`ensureHookScript(home, engineId)` 泛化）
- Modify: `packages/server/src/http/app.ts`（`/hooks/claude` → `/hooks/:engine`；deriveTitle 用 engineHome；**F6：`/input` send-while-busy 409 守卫**）
- Modify: `packages/server/src/engine/bootstrap.ts`（`ensureHookScript(cfg.home, engine.id)` 传引擎）
- Modify: `packages/protocol/src/routes.ts`（路由描述）
- Test: `packages/server/test/engine.hooks.test.ts`、`packages/server/test/http.hooks.test.ts`、`packages/server/test/http.input.test.ts`（F6）

**Interfaces:**
- Consumes: `ensureHookScript`（M1：`(home) => string` 写 `hooks/claude-hook.sh` 且 POST `/hooks/claude`）；`/hooks/claude` 端点。
- Produces: `ensureHookScript(home: string, engineId: string): string`——写 `hooks/<engineId>-hook.sh`、脚本 POST `/hooks/<engineId>`；`hookScriptPath(home, engineId)` 同步泛化。`POST /hooks/:engine` 用 `registry.get(engine)`，claude/codex 均走同一处理逻辑（`statusFromHookEvent` 已 per-engine）。

- [ ] **Step 1: 写失败测试**

`packages/server/test/engine.hooks.test.ts` 追加：

```ts
it("ensureHookScript 按引擎产脚本、POST 到 /hooks/<engine>", () => {
  const home = mkTmp()
  const cp = ensureHookScript(home, "codex")
  expect(cp).toContain("codex-hook.sh")
  const body = fs.readFileSync(cp, "utf8")
  expect(body).toContain("/hooks/codex?workspace=")
  expect(body.trim().endsWith("exit 0")).toBe(true) // 三铁律：永远 exit 0
})
```

`packages/server/test/http.hooks.test.ts` 追加（沿用现有 hooks 端点测试装配，注入 registry 含 fake "codex"，其 `statusFromHookEvent` 对 `{hook_event_name:"Stop"}` 返回 `"awaiting-input"`）：

```ts
it("POST /hooks/codex 命中 codex 引擎并置状态", async () => {
  // 先 create 一个 engineId=codex 的 workspace（或直接 seed 一个 engineId=codex 的 tab）
  await post(base, `/hooks/codex?workspace=${wsId}`, { hook_event_name: "Stop", session_id: "sid-1" }, token)
  const tab = await tabsRepo.findEngineTab(wsId)
  expect(tab?.status).toBe("awaiting-input")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.hooks.test.ts test/http.hooks.test.ts -t hooks`
Expected: FAIL——`ensureHookScript` 只收 1 参、`/hooks/codex` 路由不存在（现状 `route === "POST /hooks/claude"` 硬匹配）。

- [ ] **Step 3: 泛化 ensureHookScript**

`packages/server/src/engine/claude/hooks.ts`：

```ts
export const hookScriptPath = (home: string, engineId: string): string =>
  path.join(home, "hooks", `${engineId}-hook.sh`)

/** hook 转发脚本（kobe 三铁律：绝不拉起 server、失败静默、永远 exit 0）。
 * 按引擎生成：POST /hooks/<engineId>。token/port 运行时从 server.json 读，脚本不含密钥。 */
export const ensureHookScript = (home: string, engineId: string): string => {
  const p = hookScriptPath(home, engineId)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const script = `#!/bin/sh
# Coolie ${engineId} hook forwarder（自动生成，勿手改）。
INFO="${home}/server.json"
[ -f "$INFO" ] || exit 0
PORT=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$INFO")
TOKEN=$(sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' "$INFO")
[ -n "$PORT" ] && [ -n "$TOKEN" ] || exit 0
curl -s -m 2 -X POST "http://127.0.0.1:$PORT/hooks/${engineId}?workspace=$COOLIE_WORKSPACE" \\
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  --data-binary @- >/dev/null 2>&1
exit 0
`
  fs.writeFileSync(p, script, { mode: 0o755 })
  return p
}
```

`injectClaudeHooks` 内 `sh "${opts.scriptPath}"` 不变（scriptPath 现由调用方按引擎传入）。

- [ ] **Step 4: bootstrap 传 engine.id 给脚本**

`packages/server/src/engine/bootstrap.ts` 内 `ensureHookScript(cfg.home)` → `ensureHookScript(cfg.home, engine.id)`（claude 段仍 `engine.id === "claude"`；codex 的 hooks 注入在 Task 7 接入 `injectCodexHooks`，此处脚本生成对两引擎通用）。

- [ ] **Step 5: 泛化 http 路由为 /hooks/:engine**

`packages/server/src/http/app.ts`：把 `if (route === "POST /hooks/claude")` 改为正则匹配（**放在 `POST /hooks/engine-exit` 检查之后**，避免 `engine-exit` 被吞）：

```ts
        // 注意：/hooks/engine-exit 的检查必须在本段之前（engine-exit 也匹配 [^/]+）
        const hookRoute = url.pathname.match(/^\/hooks\/([^/]+)$/)
        if (req.method === "POST" && hookRoute && hookRoute[1] !== "engine-exit") {
          const engineId = hookRoute[1]!
          const wsId = url.searchParams.get("workspace")
          if (!wsId) return err(res, 400, "Validation", "workspace query param required")
          const body = await readJson(req)
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const tabs = yield* TabsRepo
              const registry = yield* EngineRegistry
              const engine = registry.get(engineId)
              const tab = engine ? yield* tabs.findEngineTab(wsId) : null
              if (!engine || !tab) return { ok: true } // 未知引擎/无 tab：hook 永远成功，静默吞
              yield* tabs.touchHookAt(tab.id, Date.now())
              const hookSid = typeof (body as any)?.session_id === "string" && (body as any).session_id !== ""
                ? (body as any).session_id as string : null
              const sid = hookSid ?? tab.engineSessionId
              // C4：stored 为 null 也回填（codex 服务端造 id：起始 null，首个 hook 带来真 id）
              if (hookSid !== null && hookSid !== tab.engineSessionId)
                yield* tabs.setEngineSessionId(tab.id, hookSid)
              const status = engine.statusFromHookEvent(body)
              if (status !== null) yield* tabs.setStatus(tab.id, status, "hook")
              const evtName = (body as any)?.hook_event_name
              const evType =
                evtName === "UserPromptSubmit" ? "engine.turn.started"
                : evtName === "Stop" ? "engine.turn.finished"
                : evtName === "Notification" ? "engine.notification"
                : evtName === "SessionEnd" ? "engine.session.ended"
                : evtName === "SessionStart" ? "engine.session.started" : null
              if (evType !== null)
                yield* (yield* EventsRepo).append({ workspaceId: wsId, type: evType, payload: { tabId: tab.id, sessionId: sid } })
              if (evtName === "Stop" && tab.title === null && sid !== null) {
                const home = engineHome(engine.id, config!)
                const ws = yield* (yield* WorkspacesRepo).get(wsId).pipe(Effect.option)
                if (Option.isSome(ws)) {
                  const tp = engine.transcriptPath({ home, cwd: ws.value.path, sessionId: sid })
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
```

顶部 import 加 `import { engineHome } from "../engine/registry.js"`。删掉旧的 `route === "POST /hooks/claude"` 分支与其 `claudeHome` 局部依赖（deriveTitle 现走 `engineHome`）。

> C4 断言收紧点：条件由 M1 的 `hookSid !== null && tab.engineSessionId !== null && hookSid !== tab.engineSessionId` 改为 `hookSid !== null && hookSid !== tab.engineSessionId`——去掉 `tab.engineSessionId !== null`，使 codex 起始 null 时首个 hook 能回填。

- [ ] **Step 6: 更新 protocol 路由描述**

`packages/protocol/src/routes.ts` 把 `/hooks/claude` 描述替换为：

```ts
  { method: "POST", path: "/hooks/:engine", description: "engine hook 回调转发（claude/codex；?workspace= 必带）" },
```

- [ ] **Step 7: 写 F6 失败测试**——非 nativeQueue 引擎忙时 send 被 409 拒

`packages/server/test/http.input.test.ts`（沿用现有 http 测试装配；seed 两个 active workspace：一个 engineId=codex（`nativeQueue=false`）、一个 claude（`nativeQueue=true`），各自 engine tab `status="working"`）：

```ts
it("F6：codex（nativeQueue=false）忙时 mode:send → 409 EngineBusy", async () => {
  const r = await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "send", text: "hi" }, token)
  expect(r.status).toBe(409)
  expect(r.body.error).toBe("EngineBusy") // 机器可读错误码
})
it("F6：claude（nativeQueue=true）忙时 send → 不 409（原生 mid-turn 队列放行）", async () => {
  const r = await postRaw(base, `/workspaces/${claudeWsId}/input`, { mode: "send", text: "hi" }, token)
  expect(r.status).not.toBe(409)
})
it("F6：codex 忙时 interrupt/insert 仍放行（守卫只挡 send）", async () => {
  const r = await postRaw(base, `/workspaces/${codexWsId}/input`, { mode: "interrupt", text: "" }, token)
  expect(r.status).not.toBe(409)
})
```

- [ ] **Step 8: 跑 F6 测试确认失败**

Run: `cd packages/server && bun run vitest run test/http.input.test.ts -t F6`
Expected: FAIL——现状 `/input` 对忙碌 codex 的 send 直接投 tmux（degraded），无 409 守卫。

- [ ] **Step 9: 实现 F6 守卫（`/input` 段）**

`packages/server/src/http/app.ts` 的 `POST /workspaces/:id/input` 段，把 Effect.gen 里 `return { ws, tab }` 扩为一并解析 engine，并在 success 回调最前置守卫：

```ts
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(inputRoute[1]!)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              const tab = yield* (yield* TabsRepo).findEngineTab(ws.id)
              if (!tab) return yield* new NotFoundError({ message: "无 engine tab" })
              const engine = (yield* EngineRegistry).get(tab.engineId ?? "claude")
              return { ws, tab, engine }
            }),
            async ({ ws, tab, engine }) => {
              // F6【Plan-1-only 降级守卫；Plan 2 队列落地时删除本 if 块——REMOVAL MARKER: replace with enqueue】：
              // 非 nativeQueue 引擎（codex）忙时不接 send（Plan 1 无 server 端队列，Plan 2 才有）。
              if (mode === "send" && tab.status === "working" && engine?.capabilities.nativeQueue === false)
                return err(res, 409, "EngineBusy", "engine 正忙且无原生队列，send 暂不支持（排队见 M2 Plan 2）")
              try {
                const target = `${tmuxSessionName(ws.id)}:${tab.tmuxWindow ?? 0}`
                await composerOps.input(target, { text: body.text, mode, skipStable: body.skipStable === true })
                // …既有 composer.delivered 事件 append 与 send(res,200) 不变…
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
```

顶部 import 确保有 `EngineRegistry`（Task 1 已引）。`err(res, 409, "EngineBusy", …)` 走既有 err helper，响应体 `{ error: "EngineBusy", message }`。

> 说明：守卫只挡 `mode:"send"`；`interrupt`/`interrupt-send`/`insert` 不挡（interrupt 本就是打断当前 turn，insert 是插字不提交）。claude `nativeQueue=true` 恒放行（TUI 自排队）。**Plan 2 用 server 端队列取代本守卫时，按 REMOVAL MARKER 删除此 if 块**。

- [ ] **Step 10: 跑测试确认通过 + 回归**

Run: `cd packages/server && bun run vitest run test/engine.hooks.test.ts test/http.hooks.test.ts test/http.input.test.ts && bun run typecheck`
Expected: PASS（含 M1 既有 claude hook 测试——若它们仍打 `/hooks/claude`，现路由正则同样命中，行为不变）；typecheck 清洁。

- [ ] **Step 11: Commit**

```bash
git add packages/server/src/engine/claude/hooks.ts packages/server/src/engine/bootstrap.ts packages/server/src/http/app.ts packages/protocol/src/routes.ts packages/server/test/engine.hooks.test.ts packages/server/test/http.hooks.test.ts packages/server/test/http.input.test.ts
git commit -m "feat(server): 泛化 hook 转发脚本 + POST /hooks/:engine（C4 回填）+ /input send-busy 守卫（F6）"
```

---

### Task 5: codex rollout 转录 reader（路径扫描 + deriveTitle）

**Files:**
- Create: `packages/server/src/engine/codex/transcript.ts`
- Test: `packages/server/test/engine.codex.transcript.test.ts`

**Interfaces:**
- Consumes: 无（纯文件系统 + 字符串解析）。
- Produces:
  - `codexTranscriptPath(home: string, sessionId: string): string`——在 `<home>/sessions/**/rollout-*-<sessionId>.jsonl` 日期树里 newest-first 扫描反查（codex.md §3：文件名内嵌 UUID）；找不到返回一个确定但不存在的路径（`<home>/sessions/<sessionId>.missing`），使 mtime 轮询 `statMtimeMs` 返回 null 而安全跳过。
  - `codexDeriveTitle(jsonl: string): string | null`——从 rollout 首个**非合成** user 消息派生标题（codex.md §3：repo instructions / environment envelope 以 `role:"user"` 持久化但需滤除；`session_meta.first_user_message` 优先）。

- [ ] **Step 1: 写失败测试**

`packages/server/test/engine.codex.transcript.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { codexTranscriptPath, codexDeriveTitle } from "../src/engine/codex/transcript.js"

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cx-"))

describe("codexTranscriptPath", () => {
  it("按 UUID 在日期树里反查 rollout 文件", () => {
    const home = mkTmp()
    const sid = "019f4fe0-2fea-73f0-9453-171807d42083"
    const dir = path.join(home, "sessions", "2026", "07", "12")
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `rollout-2026-07-12T00-00-00-${sid}.jsonl`)
    fs.writeFileSync(f, "{}\n")
    expect(codexTranscriptPath(home, sid)).toBe(f)
  })
  it("找不到 → 返回确定的 .missing 路径（不抛）", () => {
    const home = mkTmp()
    expect(codexTranscriptPath(home, "nope")).toBe(path.join(home, "sessions", "nope.missing"))
  })
})

describe("codexDeriveTitle", () => {
  it("取首个非合成 user 消息；滤除 environment/AGENTS envelope", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "x", first_user_message: "修好登录 bug" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd=/x</environment_context>" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "真正的第一句" }] } }),
    ].join("\n")
    expect(codexDeriveTitle(lines)).toBe("修好登录 bug") // session_meta.first_user_message 优先
  })
  it("无 first_user_message 时退回首个非合成 user 文本", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "第二句才是人说的" }] } }),
    ].join("\n")
    expect(codexDeriveTitle(lines)).toBe("第二句才是人说的")
  })
  it("坏行宽容跳过、空转录返回 null", () => {
    expect(codexDeriveTitle("not json\n{bad")).toBeNull()
    expect(codexDeriveTitle("")).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.codex.transcript.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 transcript.ts**

```ts
import * as fs from "node:fs"
import * as path from "node:path"

/** 在 <home>/sessions/<YYYY>/<MM>/<DD>/rollout-*-<sessionId>.jsonl 日期树里 newest-first 反查
 * （codex.md §3：文件名内嵌 UUIDv7 即 session id，无法直接拼路径）。找不到 → 返回确定的
 * .missing 路径，让 mtime 轮询的 statMtimeMs 拿到 null 而安全跳过（绝不抛）。 */
export const codexTranscriptPath = (home: string, sessionId: string): string => {
  const root = path.join(home, "sessions")
  const missing = path.join(root, `${sessionId}.missing`)
  const listDesc = (dir: string): string[] => {
    try { return fs.readdirSync(dir).sort((a, b) => b.localeCompare(a)) } catch { return [] }
  }
  for (const y of listDesc(root)) {
    const yd = path.join(root, y)
    for (const m of listDesc(yd)) {
      const md = path.join(yd, m)
      for (const d of listDesc(md)) {
        const dd = path.join(md, d)
        for (const f of listDesc(dd)) {
          if (f.startsWith("rollout-") && f.includes(sessionId) && f.endsWith(".jsonl"))
            return path.join(dd, f)
        }
      }
    }
  }
  return missing
}

/** 合成 user 行（codex.md §3 kobe isSyntheticCodexUserRow）：repo instructions / environment
 * envelope 以 role:"user" 持久化但 live 流不重放，标题派生必须滤除。 */
const SYNTHETIC_MARKERS = ["<environment_context>", "<user_instructions>", "AGENTS.md", "<project_doc>"]
const isSynthetic = (text: string): boolean => SYNTHETIC_MARKERS.some((m) => text.includes(m))

const firstText = (content: unknown): string | null => {
  if (!Array.isArray(content)) return null
  for (const c of content) {
    const t = (c as any)?.text
    if (typeof t === "string" && t.trim() !== "") return t.trim()
  }
  return null
}

/** 从 rollout JSONL 派生标题：session_meta.first_user_message 优先，否则首个非合成 user 文本。
 * 逐行 best-effort（codex.md §3：schema 无版本号，坏行跳过）。 */
export const codexDeriveTitle = (jsonl: string): string | null => {
  let fallback: string | null = null
  for (const line of jsonl.split("\n")) {
    const s = line.trim()
    if (s === "") continue
    let row: any
    try { row = JSON.parse(s) } catch { continue }
    const p = row?.payload
    if (row?.type === "session_meta" && typeof p?.first_user_message === "string" && p.first_user_message.trim() !== "")
      return p.first_user_message.trim()
    if (fallback === null && row?.type === "response_item" && p?.type === "message" && p?.role === "user") {
      const text = firstText(p.content)
      if (text !== null && !isSynthetic(text)) fallback = text
    }
  }
  return fallback
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/server && bun run vitest run test/engine.codex.transcript.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engine/codex/transcript.ts packages/server/test/engine.codex.transcript.test.ts
git commit -m "feat(server): codex rollout 转录 reader（UUID 反查 + 滤合成行派生标题）"
```

---

### Task 6: codex trust 预置（config.toml project trust，原子/merge-only）

**Files:**
- Create: `packages/server/src/engine/codex/trust.ts`
- Test: `packages/server/test/engine.codex.trust.test.ts`

**Interfaces:**
- Consumes: 无（文件系统）。
- Produces:
  - `defaultCodexConfigPath(codexHome: string): string` = `<codexHome>/config.toml`。
  - `seedCodexTrust(configPath: string, cwd: string): void`——幂等、原子（tmp+rename）、**merge-only** 地在 `config.toml` 追加/更新 `[projects."<realpath(cwd)>"] trust_level = "trusted"`（codex.md §7：Conductor 同法跳过 TUI「trust this folder」对话框——该对话框在回答前不发 SessionStart，会死锁就绪门控，同 claude folder-trust）。已存在同 path 的 trusted 条目则 no-op；用户其它键原样保留。realpath 关键（`/tmp`→`/private/tmp`，同 M1 claude trust.ts 教训）。

- [ ] **Step 1: 写失败测试**

`packages/server/test/engine.codex.trust.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { seedCodexTrust, defaultCodexConfigPath } from "../src/engine/codex/trust.js"

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cxt-"))

describe("seedCodexTrust", () => {
  it("空配置 → 写入 trusted 条目（realpath 归一）", () => {
    const home = mkTmp(); const cfg = defaultCodexConfigPath(home); const cwd = mkTmp()
    seedCodexTrust(cfg, cwd)
    const real = fs.realpathSync(cwd)
    const txt = fs.readFileSync(cfg, "utf8")
    expect(txt).toContain(`[projects."${real}"]`)
    expect(txt).toContain('trust_level = "trusted"')
  })
  it("merge-only：保留用户既有键，幂等重跑不重复", () => {
    const home = mkTmp(); const cfg = defaultCodexConfigPath(home); const cwd = mkTmp()
    fs.mkdirSync(path.dirname(cfg), { recursive: true })
    fs.writeFileSync(cfg, 'model = "gpt-5"\n\n[projects."/other"]\ntrust_level = "trusted"\n')
    seedCodexTrust(cfg, cwd); seedCodexTrust(cfg, cwd) // 幂等
    const txt = fs.readFileSync(cfg, "utf8")
    expect(txt).toContain('model = "gpt-5"')          // 用户键保留
    expect(txt).toContain('[projects."/other"]')       // 既有条目保留
    const real = fs.realpathSync(cwd)
    const occurrences = txt.split(`[projects."${real}"]`).length - 1
    expect(occurrences).toBe(1)                          // 不重复
  })
  it("UPSERT（F5）：header 已存在但无 trust_level → 补 trusted，段内其它键保留", () => {
    const home = mkTmp(); const cfg = defaultCodexConfigPath(home); const cwd = mkTmp()
    const real = fs.realpathSync(cwd)
    fs.mkdirSync(path.dirname(cfg), { recursive: true })
    // 半写状态：本 cwd 的段在，但只有别的键、没有 trust_level（旧实现会误判已受信而跳过）。
    fs.writeFileSync(cfg, `[projects."${real}"]\nsome_key = "v"\n`)
    seedCodexTrust(cfg, cwd)
    const txt = fs.readFileSync(cfg, "utf8")
    expect(txt).toContain('trust_level = "trusted"') // 补上了
    expect(txt).toContain('some_key = "v"')           // 段内其它键保留
    // 幂等：重跑不再重复插入。
    seedCodexTrust(cfg, cwd)
    const txt2 = fs.readFileSync(cfg, "utf8")
    expect(txt2.split('trust_level =').length - 1).toBe(1)
  })
  it("UPSERT（F5）：header 存在且 trust_level 非 trusted → 改写为 trusted", () => {
    const home = mkTmp(); const cfg = defaultCodexConfigPath(home); const cwd = mkTmp()
    const real = fs.realpathSync(cwd)
    fs.mkdirSync(path.dirname(cfg), { recursive: true })
    fs.writeFileSync(cfg, `[projects."${real}"]\ntrust_level = "untrusted"\n`)
    seedCodexTrust(cfg, cwd)
    const txt = fs.readFileSync(cfg, "utf8")
    expect(txt).toContain('trust_level = "trusted"')
    expect(txt).not.toContain('untrusted')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.codex.trust.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 trust.ts**

> 为避免引第三方 TOML 库（YAGNI），采用**行级 UPSERT**策略：只在必要处追加/改写与本 cwd 相关的 `trust_level` 行，绝不重排用户既有其它内容。
>
> **F5 修正**：旧实现「header 已存在则整段 no-op」是错的——若用户（或半写）留下 `[projects."<cwd>"]` 段但**缺 `trust_level`**（或值非 `"trusted"`），Coolie 会**误判已受信**，起 session 时仍被 folder-trust 对话框卡死。正解是真正的 **UPSERT**：段不存在→追加整段；段存在但无 `trust_level`→在段内插入；段存在且 `trust_level` 非 trusted→改写为 trusted；段存在且已 trusted→幂等 no-op。

```ts
import * as fs from "node:fs"
import * as path from "node:path"

export const defaultCodexConfigPath = (codexHome: string): string => path.join(codexHome, "config.toml")

const realpathBestEffort = (p: string): string => {
  try { return fs.realpathSync(p) } catch { return p }
}

const atomicWrite = (configPath: string, next: string): void => {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.coolie-tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, configPath) // 原子替换
}

/** 幂等、原子（tmp+rename）、merge-only 的 codex project trust UPSERT（codex.md §7；F5）。
 * - 段不存在 → 末尾追加 `[projects."<real>"]\ntrust_level = "trusted"`。
 * - 段存在但无 trust_level → 段内首行后插入 trust_level="trusted"。
 * - 段存在且 trust_level 非 "trusted" → 改写该行为 "trusted"。
 * - 段存在且已 "trusted" → no-op（幂等）。
 * 用户其它键/其它 project 段一字不动。 */
export const seedCodexTrust = (configPath: string, cwd: string): void => {
  const real = realpathBestEffort(cwd)
  const header = `[projects."${real}"]`
  let existing = ""
  try { existing = fs.readFileSync(configPath, "utf8") } catch { /* 无文件 → 新建 */ }

  const lines = existing === "" ? [] : existing.split("\n")
  const headerIdx = lines.findIndex((l) => l.trim() === header)

  if (headerIdx === -1) {
    // 段不存在 → 追加整段（保尾换行规整）。
    const prefix = existing === "" || existing.endsWith("\n") ? existing : existing + "\n"
    atomicWrite(configPath, `${prefix}${existing === "" ? "" : "\n"}${header}\ntrust_level = "trusted"\n`)
    return
  }

  // 段存在 → 定位其范围（到下一个 table header 或文件尾），在段内查 trust_level。
  let end = lines.length
  for (let j = headerIdx + 1; j < lines.length; j++) {
    if (/^\s*\[/.test(lines[j]!)) { end = j; break }
  }
  let trustAbs = -1
  for (let j = headerIdx + 1; j < end; j++) {
    if (/^\s*trust_level\s*=/.test(lines[j]!)) { trustAbs = j; break }
  }

  if (trustAbs === -1) {
    // 段有、trust_level 无 → 在 header 后插入。
    lines.splice(headerIdx + 1, 0, 'trust_level = "trusted"')
    atomicWrite(configPath, lines.join("\n"))
    return
  }
  if (/^\s*trust_level\s*=\s*"trusted"\s*$/.test(lines[trustAbs]!)) return // 已 trusted → 幂等 no-op
  // trust_level 存在但非 trusted → UPSERT 改写为 trusted（保留原缩进）。
  const indent = (lines[trustAbs]!.match(/^\s*/) ?? [""])[0]
  lines[trustAbs] = `${indent}trust_level = "trusted"`
  atomicWrite(configPath, lines.join("\n"))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/server && bun run vitest run test/engine.codex.trust.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engine/codex/trust.ts packages/server/test/engine.codex.trust.test.ts
git commit -m "feat(server): codex trust 预置（config.toml project trust，原子 merge-only 幂等）"
```

---

### Task 7: codex hooks 注入（`.codex/hooks.json` 幂等，进 info/exclude）

**Files:**
- Create: `packages/server/src/engine/codex/hooks.ts`
- Test: `packages/server/test/engine.codex.hooks.test.ts`

**Interfaces:**
- Consumes: `injectInfoExclude`（M1 `workspace/include.ts`）。
- Produces: `injectCodexHooks(opts: { worktreePath, workspaceId, scriptPath }): void`——幂等写 `<worktree>/.codex/hooks.json`（codex.md §6：项目级 hooks 配置位置），事件表 `SessionStart/UserPromptSubmit/Stop`（与 claude 旁路同集；**不挂 PermissionRequest**——它是决策 hook，观察者误挂会干扰审批流，codex.md §6 kobe 教训）；shape 与 claude settings.json hooks 同构（kobe 复用同一 JsonHookAdapter）。先移除引用本脚本的旧条目再追加（幂等），用户 hooks 保留。`CODEX_HOOK_EVENTS` 导出供测试与 bootstrap。

- [ ] **Step 1: 写失败测试**

`packages/server/test/engine.codex.hooks.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { injectCodexHooks, CODEX_HOOK_EVENTS } from "../src/engine/codex/hooks.js"

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cxh-"))

describe("injectCodexHooks", () => {
  it("写 .codex/hooks.json，覆盖旁路事件、绝不挂 PermissionRequest", () => {
    const wt = mkTmp()
    injectCodexHooks({ worktreePath: wt, workspaceId: "ws1", scriptPath: "/s/codex-hook.sh" })
    const j = JSON.parse(fs.readFileSync(path.join(wt, ".codex", "hooks.json"), "utf8"))
    for (const e of CODEX_HOOK_EVENTS) expect(Array.isArray(j.hooks[e])).toBe(true)
    expect(j.hooks.PermissionRequest).toBeUndefined()
    expect(JSON.stringify(j)).toContain("/s/codex-hook.sh")
    expect(JSON.stringify(j)).toContain("COOLIE_WORKSPACE=ws1")
  })
  it("幂等：重跑不重复本脚本条目，保留用户 hooks", () => {
    const wt = mkTmp()
    const dir = path.join(wt, ".codex"); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user-own.sh" }] }] } }))
    injectCodexHooks({ worktreePath: wt, workspaceId: "ws1", scriptPath: "/s/codex-hook.sh" })
    injectCodexHooks({ worktreePath: wt, workspaceId: "ws1", scriptPath: "/s/codex-hook.sh" })
    const j = JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8"))
    const stopCmds = JSON.stringify(j.hooks.Stop)
    expect(stopCmds).toContain("user-own.sh")                 // 用户条目保留
    expect(stopCmds.split("/s/codex-hook.sh").length - 1).toBe(1) // 本脚本不重复
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.codex.hooks.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 codex/hooks.ts**

```ts
import * as fs from "node:fs"
import * as path from "node:path"

/** codex 旁路观察事件（codex.md §6）：与 claude 旁路同集，映射 SessionStart→就绪、
 * UserPromptSubmit→turn-start、Stop→turn-complete。绝不含 PermissionRequest（决策 hook）。 */
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const

/** 幂等注入项目级 codex hooks（codex.md §6：<repo>/.codex/hooks.json，shape 同 claude settings.json）。
 * 先移除引用本脚本的旧条目再追加；用户自有 hooks 原样保留。 */
export const injectCodexHooks = (opts: {
  readonly worktreePath: string
  readonly workspaceId: string
  readonly scriptPath: string
}): void => {
  const dir = path.join(opts.worktreePath, ".codex")
  const file = path.join(dir, "hooks.json")
  fs.mkdirSync(dir, { recursive: true })
  let settings: any = {}
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")) } catch { /* 无文件/坏 JSON → 重建 */ }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) settings = {}
  if (typeof settings.hooks !== "object" || settings.hooks === null) settings.hooks = {}
  const command = `COOLIE_WORKSPACE=${opts.workspaceId} sh "${opts.scriptPath}"`
  for (const evt of CODEX_HOOK_EVENTS) {
    const entries: any[] = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : []
    const kept = entries.filter((e) => !JSON.stringify(e).includes(opts.scriptPath))
    kept.push({ hooks: [{ type: "command", command }] })
    settings.hooks[evt] = kept
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/server && bun run vitest run test/engine.codex.hooks.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engine/codex/hooks.ts packages/server/test/engine.codex.hooks.test.ts
git commit -m "feat(server): codex hooks 注入（.codex/hooks.json 幂等，去 PermissionRequest）"
```

---

### Task 8: codex adapter + 注册（Engine 装配 + serverGeneratedId 分流）

**Files:**
- Modify: `packages/server/src/engine/types.ts`（Engine +`serverGeneratedId` +`models` +`efforts?`）
- Modify: `packages/server/src/engine/claude/adapter.ts`（claudeEngine 补 `serverGeneratedId:false` + `models: claudeModels`）
- Create: `packages/server/src/engine/codex/adapter.ts`
- Modify: `packages/server/src/engine/registry.ts`（注册 codexEngine）
- Test: `packages/server/test/engine.codex.adapter.test.ts`

**Interfaces:**
- Consumes: `codexTranscriptPath`/`codexDeriveTitle`（Task 5）、`seedCodexTrust`/`defaultCodexConfigPath`（Task 6）、`discoverCodexBinary`（本 task 内联最小实现，同 claude opcode 多路径）。
- Produces: `codexEngine: Engine`，注册进 `EngineRegistryLive`。字段契约：
  - `id="codex"`、`displayName="Codex"`、`terminalTitle="engine-owned"`（codex OSC0 标题可配，codex.md §8）、`serverGeneratedId=true`。
  - `capabilities = { nativeQueue:false, midSessionModelSwitch:true, resume:true, hooks:true, effort:true }`（codex.md §9）。
  - `models = codexModels`（`["gpt-5-codex","gpt-5"]` 占位，可 env 覆写）、`efforts = codexEfforts`（`["low","medium","high","xhigh"]`，codex.md §2）。
  - `launchCommand({sessionId,model,effort,resume})`：**绝不传 `--session-id`**（服务端造 id）；`resume` → `codex resume <sessionId>`；否则 `codex`（交互 TUI）；`-c tui.terminal_title=["activity","thread-title"]`（codex.md §8 kobe，整段作单个 argv）；`--model <model>`（有则）；`-c model_reasoning_effort=<effort>`（有则）；`COOLIE_CODEX_CMD` 覆写 seam。
  - `newSessionId()`：返回占位 UUID（**永不传给 codex**，仅满足接口；bootstrap 因 `serverGeneratedId` 起始存 null）。
  - `statusFromHookEvent`：同 claude 映射（codex 事件名同集）。
  - `transcriptPath({home,sessionId})`→`codexTranscriptPath`；`deriveTitle`→`codexDeriveTitle`；`resumeArgs(sid)`→`["resume", sid]`。
  - `prepareWorkspace({cwd, codexConfigPath})`→`seedCodexTrust(codexConfigPath ?? defaultCodexConfigPath(...), cwd)`。

> **✅ bypass-hook-trust 歧义已在本机（2026-07-12，codex-cli 0.139.0 @ `/opt/homebrew/bin/codex`）经验证解决（F3）**：`codex --help` 与 `codex exec --help` **均**列出 `--dangerously-bypass-hook-trust`（"Run enabled hooks without requiring persisted hook trust for this invocation"）——即**交互式 `codex` 与 `codex exec` 都支持该 flag**。原始探测输出：
>
> ```
> $ codex --help 2>&1 | grep -i -A2 bypass
>       --dangerously-bypass-hook-trust
>           Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
>           Intended only for automation that already vets hook sources
> ```
>
> **裁定（单分支，无二分支残留）**：`launchCommand` **无条件追加 `--dangerously-bypass-hook-trust`**（产品决策：Coolie 自建 worktree 由 Coolie 亲自注入 `.codex/hooks.json`，来源已 vet，隐式受信——同 claude folder-trust）。这保证 codex hooks（SessionStart/UserPromptSubmit/Stop）在**首启即触发**、无需用户 `/hooks` 手动信任、不死锁就绪门控。就绪门控（gateOnHooks）对 codex 的**精确武装条件**：`engine.capabilities.hooks === true`（Task 8 codex 能力位）**且** trust 已预置（Task 6 `seedCodexTrust` 跳过 folder-trust 对话框）**且** launch 带 `--dangerously-bypass-hook-trust`（本 task）——三者齐备 → 首个 SessionStart hook 必达 → 门控开 → id 回填（Task 9）。这条链亦是 F2「null-id 期不做 mtime 兜底」成立的前提（见 Task 3 monitor 转换）。

- [ ] **Step 1: bypass flag 结论已固化（无需再探测；下方 launchCommand 已含 flag）**

本机探测已完成（见上 ✅ 块）：`--dangerously-bypass-hook-trust` 在交互式 `codex` 上**存在**。故 Step 5 `launchCommand` **无条件**含该 flag；不保留「缺失分支」。（若未来目标机 codex 版本低于 0.139.0 缺此 flag，才需回退到「hooks 手动 trust + rollout mtime 兜底」——但那是移植期的事，非本计划范围。）

- [ ] **Step 2: 写失败测试**

`packages/server/test/engine.codex.adapter.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { codexEngine } from "../src/engine/codex/adapter.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { Effect, Layer } from "effect"
import { EngineRegistry } from "../src/engine/registry.js"

describe("codexEngine", () => {
  it("能力位与 claude 分流：nativeQueue=false、effort=true、serverGeneratedId=true", () => {
    expect(codexEngine.capabilities.nativeQueue).toBe(false)
    expect(codexEngine.capabilities.effort).toBe(true)
    expect(codexEngine.serverGeneratedId).toBe(true)
  })
  it("launchCommand 绝不含 --session-id；resume 走 codex resume <id>", () => {
    const fresh = codexEngine.launchCommand({ sessionId: "SID", model: "gpt-5", effort: "high" })
    expect(fresh).not.toContain("--session-id")
    expect(fresh.join(" ")).toContain("model_reasoning_effort=high")
    expect(fresh).toContain("--model"); expect(fresh).toContain("gpt-5")
    expect(fresh).toContain("--dangerously-bypass-hook-trust") // F3：hooks 首启即触发
  })
  it("bypass-hook-trust flag 在 resume 与 fresh 两路都在", () => {
    expect(codexEngine.launchCommand({ sessionId: "SID" })).toContain("--dangerously-bypass-hook-trust")
    expect(codexEngine.launchCommand({ sessionId: "SID", resume: true })).toContain("--dangerously-bypass-hook-trust")
    const res = codexEngine.launchCommand({ sessionId: "SID", resume: true })
    expect(res.join(" ")).toContain("resume SID")
    expect(res).not.toContain("--session-id")
  })
  it("COOLIE_CODEX_CMD 覆写 seam 原样使用", () => {
    const prev = process.env.COOLIE_CODEX_CMD
    process.env.COOLIE_CODEX_CMD = "cat"
    try { expect(codexEngine.launchCommand({ sessionId: "x" })).toEqual(["cat"]) }
    finally { process.env.COOLIE_CODEX_CMD = prev }
  })
  it("注册进 EngineRegistryLive", () =>
    Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const reg = yield* EngineRegistry
      expect(reg.get("codex")?.id).toBe("codex")
      expect(reg.get("claude")?.id).toBe("claude")
    }), EngineRegistryLive)))
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.codex.adapter.test.ts`
Expected: FAIL——`codex/adapter.js` 不存在、registry 未注册 codex。

- [ ] **Step 4: 扩展 Engine interface**

`packages/server/src/engine/types.ts`：`Engine` 加三字段（`serverGeneratedId` 说明 id 由服务端造、起始存 null；`models`/`efforts` 供 `GET /config` 下发）：

```ts
export interface Engine {
  readonly id: string
  readonly displayName: string
  readonly capabilities: EngineCapabilities
  readonly terminalTitle: "engine-owned" | "none"
  /** true = 服务端造 id（codex），bootstrap 起始存 engineSessionId=null，首个 hook 回填；
   * 缺省/false = 客户端造 id（claude/fake），launchCommand 传 --session-id。
   * **F4：可选，默认 false**——M1 既有 4 个测试 fake（http-heal/heal/lifecycle-tmux/bootstrap-prompt-gate）
   * 与真 claudeEngine 无须逐个补字段即通过 typecheck；bootstrap 用 `engine.serverGeneratedId === true` 判定。 */
  readonly serverGeneratedId?: boolean
  /** GUI 模型选择器选项（/config 下发，UI 禁止硬编码 vendor 字符串）。
   * **F4：可选，默认 `[]`**（`GET /config` 侧 `e.models ?? []`）——同上，既有 fake 不必补。
   * claude/codex 两真 adapter 仍显式设 `models`（否则 /config 下发空数组，GUI 无选项）。 */
  readonly models?: readonly string[]
  /** reasoning effort 档位（codex ✓ none/low/medium/high/xhigh；claude 无 → undefined）。 */
  readonly efforts?: readonly string[]
  readonly newSessionId: () => string
  readonly launchCommand: (opts: {
    readonly sessionId: string; readonly model?: string; readonly effort?: string; readonly resume?: boolean
  }) => string[]
  readonly statusFromHookEvent: (evt: unknown) => TabStatus | null
  readonly transcriptPath: (opts: { readonly home: string; readonly cwd: string; readonly sessionId: string }) => string
  readonly deriveTitle: (jsonl: string) => string | null
  readonly resumeArgs: (sessionId: string) => string[]
  readonly prepareWorkspace?: (ctx: { readonly cwd: string; readonly claudeConfigPath?: string | undefined; readonly codexConfigPath?: string | undefined }) => void
}
```

`packages/server/src/engine/claude/adapter.ts`：`claudeEngine` 加 `serverGeneratedId: false,` 与 `models: claudeModels,`（把现有 `export const claudeModels` 移到 adapter 顶部再引用，或原地引用）。`prepareWorkspace` 签名多收（忽略）`codexConfigPath` 无碍。

- [ ] **Step 5: 实现 codex/adapter.ts**

```ts
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import type { TabStatus } from "@coolie/protocol"
import type { Engine } from "../types.js"
import { codexTranscriptPath, codexDeriveTitle } from "./transcript.js"
import { seedCodexTrust, defaultCodexConfigPath } from "./trust.js"

/** codex 二进制多路径发现（opcode 路线，同 claude binary.ts）。 */
const discoverCodexBinary = (): string | null => {
  const candidates = [
    process.env.COOLIE_CODEX_BIN,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((p): p is string => typeof p === "string" && p !== "")
  for (const c of candidates) { try { if (fs.existsSync(c)) return c } catch { /* skip */ } }
  return null
}

/** hook 事件 → tab 状态（codex 事件名与 claude 旁路同集，codex.md §6）。 */
const HOOK_STATUS: Record<string, TabStatus> = {
  UserPromptSubmit: "working",
  Stop: "awaiting-input",
  SessionStart: "awaiting-input", // 会话就绪、TUI attach stdin，等价「等你输入」
  SessionEnd: "idle",
}

/** GUI 模型选择器选项（占位，可经 COOLIE_CODEX_MODELS 逗号分隔覆写）。 */
export const codexModels = (process.env.COOLIE_CODEX_MODELS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])
  .length > 0
  ? process.env.COOLIE_CODEX_MODELS!.split(",").map((s) => s.trim()).filter(Boolean)
  : ["gpt-5-codex", "gpt-5"]

/** reasoning effort 档位（codex.md §2）。 */
export const codexEfforts = ["low", "medium", "high", "xhigh"]

export const codexEngine: Engine = {
  id: "codex",
  displayName: "Codex",
  capabilities: { nativeQueue: false, midSessionModelSwitch: true, resume: true, hooks: true, effort: true },
  terminalTitle: "engine-owned", // codex OSC0 标题可配（codex.md §8）
  serverGeneratedId: true,       // 服务端造 id：bootstrap 起始存 null，首个 SessionStart hook 回填
  models: codexModels,
  efforts: codexEfforts,
  // 占位 id：codex 不支持预指定 session id，此值永不传给 codex（serverGeneratedId 分流后 bootstrap 都不会用它）。
  newSessionId: () => randomUUID(),
  launchCommand: ({ model, effort, resume }) => {
    const override = (process.env.COOLIE_CODEX_CMD ?? "").trim()
    if (override !== "") return override.split(/\s+/)
    const bin = discoverCodexBinary() ?? "codex"
    // 轻量状态通道：activity spinner 出现在标题 = 正在跑（codex.md §8 kobe；整段含引号作单个 argv）
    const titleArg = 'tui.terminal_title=["activity","thread-title"]'
    const args = resume === true
      ? [bin, ...codexResumeArgs(/* sessionId 由下方 resumeArgs 提供 */ "")]
      : [bin]
    // resume 分支的 sessionId 在真实调用里由 opts.sessionId 提供——见下方修正
    return args
  },
  statusFromHookEvent: (evt) => {
    const name = (evt as any)?.hook_event_name
    return typeof name === "string" ? HOOK_STATUS[name] ?? null : null
  },
  transcriptPath: ({ home, sessionId }) => codexTranscriptPath(home, sessionId),
  deriveTitle: codexDeriveTitle,
  resumeArgs: (sessionId) => ["resume", sessionId],
  // Coolie 自建 worktree 隐式受信：起 session 前预置 config.toml project trust，跳过 TUI 首启信任对话框。
  prepareWorkspace: ({ cwd, codexConfigPath }) => seedCodexTrust(codexConfigPath ?? defaultCodexConfigPath(defaultCodexHome()), cwd),
}

const defaultCodexHome = (): string => process.env.COOLIE_CODEX_HOME ?? `${process.env.HOME}/.codex`
const codexResumeArgs = (sessionId: string): string[] => ["resume", sessionId]
```

> **实现修正（Step 5 必须落实，勿留上面的占位注释）**：`launchCommand` 要正确拼 sessionId 与 title/model/effort。正解形态：

```ts
  launchCommand: ({ sessionId, model, effort, resume }) => {
    const override = (process.env.COOLIE_CODEX_CMD ?? "").trim()
    if (override !== "") return override.split(/\s+/)
    const bin = discoverCodexBinary() ?? "codex"
    const args = resume === true ? [bin, "resume", sessionId] : [bin]
    args.push("-c", 'tui.terminal_title=["activity","thread-title"]')
    if (model) args.push("--model", model)
    if (effort) args.push("-c", `model_reasoning_effort=${effort}`)
    // F3 已核实（codex-cli 0.139.0 交互式 codex 支持此 flag）：无条件旁路 hook trust，
    // 因 Coolie 亲自注入 .codex/hooks.json（来源已 vet），保证 SessionStart hook 首启即触发。
    args.push("--dangerously-bypass-hook-trust")
    return args
  },
```

（把 Step 5 第一版 `launchCommand` 整体替换为此正解，删除占位 `codexResumeArgs`/含糊注释；测试断言即以此为准。）

- [ ] **Step 6: registry 注册 codex**

`packages/server/src/engine/registry.ts`：

```ts
import { claudeEngine } from "./claude/adapter.js"
import { codexEngine } from "./codex/adapter.js"

export const EngineRegistryLive = Layer.sync(EngineRegistry, () =>
  new Map<string, Engine>([[claudeEngine.id, claudeEngine], [codexEngine.id, codexEngine]]))
```

- [ ] **Step 7: 跑测试确认通过 + 全量回归**

Run: `cd packages/server && bun run vitest run test/engine.codex.adapter.test.ts && bun run vitest run && bun run typecheck`
Expected: 全绿；typecheck 清洁。`GET /config` 测试（Task 1）现应真下发 claude+codex 两条。

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/engine/types.ts packages/server/src/engine/claude/adapter.ts packages/server/src/engine/codex/adapter.ts packages/server/src/engine/registry.ts packages/server/test/engine.codex.adapter.test.ts
git commit -m "feat(server): codex adapter + 注册（serverGeneratedId 分流、effort/resume/trust）"
```

---

### Task 9: 服务端造 id「先启动后回填」（bootstrap + codex hooks 接入）

**Files:**
- Modify: `packages/server/src/engine/bootstrap.ts`（serverGeneratedId → engineSessionId 起始 null；codex 走 `injectCodexHooks`；prepareWorkspace 传 codexConfigPath）
- Test: `packages/server/test/engine.bootstrap.test.ts`

**Interfaces:**
- Consumes: `Engine.serverGeneratedId`（Task 8）、`injectCodexHooks`（Task 7）、`/hooks/:engine` 回填（Task 4，C4）。
- Produces: bootstrap 对 `serverGeneratedId=true` 的引擎：`sessionId=null`、tab.engineSessionId=null、launchCommand 不带 id；首个 `engine.session.started`（codex SessionStart hook 经 `/hooks/codex` → C4 回填）把真 id 写回 tab。就绪门控（gateOnHooks）与首条 prompt 投递逻辑对 codex 与 claude 一致复用。

- [ ] **Step 1: 写失败测试**

`packages/server/test/engine.bootstrap.test.ts` 追加：

```ts
it("serverGeneratedId 引擎 create → tab.engineSessionId 起始 null，launch 不带 session id", async () => {
  const { runCreate, tabsRepo, tmux } = await setupBootstrap({ engines: ["claude", "codex-fake"] })
  // fake codex：serverGeneratedId=true、launchCommand 返回 ["codex-fake"]（无 id）
  const ws = await runCreate({ engineId: "codex", initialPrompt: "" })
  const tab = await tabsRepo.findEngineTab(ws.id)
  expect(tab?.engineSessionId).toBeNull()
  expect(tmux.lastNewSession?.command.join(" ")).not.toContain("SID")
})
it("codex 首个 SessionStart hook 回填真 id（复用 /hooks 回填）", async () => {
  const { runCreate, tabsRepo, postHook } = await setupBootstrap({ engines: ["claude", "codex-fake"] })
  const ws = await runCreate({ engineId: "codex", initialPrompt: "" })
  await postHook("codex", ws.id, { hook_event_name: "SessionStart", session_id: "real-cx-id" })
  const tab = await tabsRepo.findEngineTab(ws.id)
  expect(tab?.engineSessionId).toBe("real-cx-id")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/engine.bootstrap.test.ts -t serverGeneratedId`
Expected: FAIL——现状 `sessionId = engine.newSessionId()` 恒非 null 并写进 tab。

- [ ] **Step 3: bootstrap 按 serverGeneratedId 分流 id + codex hooks**

`packages/server/src/engine/bootstrap.ts`：

`const sessionId = engine.newSessionId()` 改为：

```ts
        // 服务端造 id（codex）：起始 null，首个 SessionStart hook 经 /hooks/:engine 回填真 id（C4）。
        // F4：serverGeneratedId 可选 → 用 === true 判定（缺省/false 走客户端造 id，同 claude）。
        const sessionId: string | null = engine.serverGeneratedId === true ? null : engine.newSessionId()
```

hooks 注入段（现只 injectClaudeHooks）按引擎分流：

```ts
        if (engine.capabilities.hooks && !hooksDisabled()) {
          yield* Effect.try({
            try: () => {
              const scriptPath = ensureHookScript(cfg.home, engine.id)
              if (engine.id === "codex") {
                injectCodexHooks({ worktreePath: ws.path, workspaceId: ws.id, scriptPath })
                injectInfoExclude(project.repoRoot, ".codex/hooks.json")
              } else {
                injectClaudeHooks({ worktreePath: ws.path, workspaceId: ws.id, scriptPath })
                injectInfoExclude(project.repoRoot, ".claude/settings.local.json")
              }
            },
            catch: (e) => new HookError({ message: `hooks 注入失败：${String(e)}` }),
          })
        }
```

顶部 import 加 `import { injectCodexHooks } from "./codex/hooks.js"`。

prepareWorkspace 调用传 codexConfigPath：

```ts
        if (engine.prepareWorkspace) {
          yield* Effect.try({
            try: () => engine.prepareWorkspace!({ cwd: ws.path, claudeConfigPath: cfg.claudeConfigPath, codexConfigPath: cfg.codexConfigPath }),
            catch: (e) => new HookError({ message: `workspace 预备失败：${String(e)}` }),
          })
        }
```

> `cfg.codexConfigPath`：若 M1 config 无此字段，加一个可选 `codexConfigPath?: string`（`COOLIE_CODEX_CONFIG` 覆写，用于测试指向临时 config.toml——同 claude 的 `COOLIE_CLAUDE_CONFIG`）。默认 undefined → adapter 用 `defaultCodexConfigPath(codexHome)`。测试务必设 `COOLIE_CODEX_CONFIG` 指向临时目录，防污染真实 `~/.codex/config.toml`（Task 6 零泄漏不变量）。

**F7（sessionId 类型统一，跨 task 单一故事，禁 `string`/`string|null` 混用）**：把 `StartEngineSessionInput.sessionId` 放宽为 `string | null`（`packages/server/src/engine/session.ts` line 12）——codex（serverGeneratedId）分支传 `null`、claude 传 uuid。`Engine.launchCommand` 的 `opts.sessionId` **仍保持 `string`**（interface 不放宽：它只在真需 id 的 resume/`--session-id` 场景被用，null 无意义），因此**合并点唯一且落在 session.ts 内部**：

```ts
// packages/server/src/engine/session.ts
export interface StartEngineSessionInput {
  readonly ws: Workspace
  readonly repoRoot: string
  readonly engine: Engine
  readonly sessionId: string | null   // F7：codex=null（服务端造 id）；claude=uuid
  readonly resume: boolean
  readonly home: string
}
// …startEngineSession 内：
const engineCommand = i.engine.launchCommand({ sessionId: i.sessionId ?? "", resume: i.resume })
// codex launchCommand 本就忽略 sessionId（除 resume），空串安全；claude resume 时 i.sessionId 必非 null。
```

bootstrap 调用 `startEngineSession(tmux, { …, sessionId, … })` **直接传 `sessionId`（已是 `string | null`，无须 `?? ""`）**；tab.insert 的 `engineSessionId: sessionId`（null 合法，`tabs.engineSessionId` 列可空）；events `engine.started` payload `sessionId`（null 合法）。至此 `string | null` 从 bootstrap → session input → tabs/events 三处贯通，仅在 session.ts 喂 launchCommand 的**单一合并点** `?? ""`。heal.ts 的 `startEngineSession(... sessionId: plan.sessionId ...)`（`plan.sessionId` 现即 `string | null`）自然兼容，无须改。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd packages/server && bun run vitest run test/engine.bootstrap.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engine/bootstrap.ts packages/server/src/engine/session.ts packages/server/src/config.ts packages/server/test/engine.bootstrap.test.ts
git commit -m "feat(server): 服务端造 id 先启动后回填（codex bootstrap + hooks 接入）"
```

---

### Task 10: 修 C1 终端输入二进制透传 + C8 delivery 测试

**Files:**
- Modify: `packages/server/src/http/ws.ts`（约 86–93 行，输入侧）
- Modify: `packages/server/test/tmux.delivery.test.ts`（C8：二进制断言改 fromCharCode）
- Test: `packages/server/test/http.ws.test.ts`（新增非 UTF8 输入往返断言）

**Interfaces:**
- Consumes: WS 终端通道 message handler（M1）。
- Produces: 终端输入字节 **原样 Buffer 透传** `p.write(data)`——非 UTF8 键序（方向键/Alt 组合/中文 IME 分段字节）不再被 `toString("utf8")` 损坏（C1，spec Global Constraint「WS 终端输入原样透传不消毒」）。控制帧（JSON）仍按 `isBinary=false` 分支解析。

- [ ] **Step 1: 写失败测试**——非 UTF8 字节往返不被损坏

`packages/server/test/http.ws.test.ts` 追加（沿用现有 ws 测试装配：连真 pty 跑 `cat`，或注入 fake pty 捕获 `write` 入参）：

```ts
it("二进制输入原样透传（非 UTF8 字节不被 utf8 往返损坏）", async () => {
  const written: Buffer[] = []
  const fakePty = { write: (d: Buffer) => written.push(Buffer.from(d)), onData: () => {}, /* … */ } as any
  const { sendBinary } = await openWsWithPty(fakePty)
  const raw = Buffer.from([0x1b, 0x5b, 0x41, 0xff, 0xfe]) // ESC [ A + 非法 utf8 尾字节
  await sendBinary(raw)
  expect(written[0]!.equals(raw)).toBe(true) // 字节级一致，绝不 replacement-char 化
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/http.ws.test.ts -t 二进制输入`
Expected: FAIL——现状 `p.write(data.toString("utf8"))` 把 `0xff 0xfe` 转成 U+FFFD 再回编码，字节不等。

- [ ] **Step 3: ws.ts 输入侧原样透传**

`packages/server/src/http/ws.ts` message handler（约 86–93 行）：

```ts
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        p.write(data) // 原样二进制透传：终端输入就是真实键击字节，绝不 utf8 往返（C1）
        return
      }
      try {
        const msg = JSON.parse(data.toString("utf8")) // 控制帧仍是 UTF8 JSON
        // …既有 resize/控制逻辑不变…
      } catch { /* 既有 */ }
    })
```

> node-pty 的 `IPty.write` 接受 `string`；传 Buffer 需确认签名。若 `write(data: string)` 只收字符串，用 `p.write(data.toString("latin1"))`——latin1 是字节保真编码（0x00–0xFF 一一对应），等价于原样字节透传，与 M1 输出侧 `Buffer.from(d, "latin1")` 对称。二选一以 node-pty 实际 `write` 签名为准，测试断言（字节级 equals）不变。

- [ ] **Step 4: C8——delivery 测试二进制断言改 fromCharCode**

`packages/server/test/tmux.delivery.test.ts` 里对 pasteText/控制字节的断言（M1 遗留「二进制不可 diff」），把 raw-bytes 断言改为 `String.fromCharCode(...bytes)` 形式（cosmetic，使失败 diff 可读）。定位现有断言并等价改写，断言语义不变。

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `cd packages/server && bun run vitest run test/http.ws.test.ts test/tmux.delivery.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/http/ws.ts packages/server/test/http.ws.test.ts packages/server/test/tmux.delivery.test.ts
git commit -m "fix(server): 终端输入二进制原样透传（C1）+ delivery 测试可读断言（C8）"
```

---

### Task 11: 修 C2 retry 补投 prompt+engineId + C3 engine-exit 单事务

**Files:**
- Modify: `packages/server/src/workspace/lifecycle.ts`（create 存 initialPrompt+engineId 进 workspaces.data；retry 回填 ctx）
- Modify: `packages/server/src/repo/workspaces.ts`（如需读写 data 列的 helper——按 M1 既有 `data` JSON 列模式）
- Modify: `packages/server/src/repo/tabs.ts` 或 `http/app.ts`（C3：engine-exit 的 setStatus+append 折进单事务）
- Test: `packages/server/test/workspace.lifecycle.test.ts`、`packages/server/test/http.hooks.test.ts`

**Interfaces:**
- Consumes: `workspaces.data` JSON 列（M1 opencode 折衷，已存在）；`retry`（M1）；`/hooks/engine-exit`（M1）。
- Produces:
  - create 把 `{ initialPrompt?, engineId? }` 存进 `workspaces.data.createCtx`；`retry(id)` 读回并构造 `PostCreateContext` 传给 `provision`——修 C2（重试补投首条 prompt 且用原引擎）。
  - engine-exit 的 `setStatus` + `events.append` 在同一 `db.transaction` 内（C3），与其它 repo 写库纪律一致。

- [ ] **Step 1: 写失败测试**

`packages/server/test/workspace.lifecycle.test.ts` 追加：

```ts
it("retry 补投原 initialPrompt + engineId（C2）", async () => {
  const seen: Array<{ initialPrompt?: string; engineId?: string }> = []
  const { create, retry } = await setupLifecycle({ hook: (_ws, ctx) => { seen.push({ ...ctx }); return failFirstThenOk() } })
  const ws = await create({ projectId: "p", engineId: "codex", initialPrompt: "第一句" }) // 首次 hook 失败 → status=error
  seen.length = 0
  await retry(ws.id)
  expect(seen[0]).toEqual({ initialPrompt: "第一句", engineId: "codex" }) // 重试补回，而非 {}
})
```

`packages/server/test/http.hooks.test.ts` 追加（C3 事务原子性——注入一个在 events.append 抛错的 fake，断言 setStatus 不落库；或验证二者同 txn 提交）：

```ts
it("engine-exit 的 setStatus+append 单事务（C3）：append 失败则 status 不变", async () => {
  const { postEngineExit, tabsRepo, breakEventsAppend } = await setupHooks()
  breakEventsAppend() // 让 events.append 抛
  const before = (await tabsRepo.findEngineTab(wsId))!.status
  await postEngineExit(wsId, { exitCode: 1 }).catch(() => {})
  expect((await tabsRepo.findEngineTab(wsId))!.status).toBe(before) // 回滚，未半写
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/workspace.lifecycle.test.ts -t "retry 补投" test/http.hooks.test.ts -t "engine-exit 的 setStatus"`
Expected: FAIL——现状 retry 传 `{}`（账本 C2）、engine-exit 两次写非事务（C3）。

- [ ] **Step 3: create 存 createCtx、retry 回填**

`packages/server/src/workspace/lifecycle.ts`：`create` 在插入/更新 workspace 行时把 `{ initialPrompt, engineId }` 写进 `data.createCtx`（复用 M1 写 `data` JSON 列的既有 helper——若 repo 暴露 `patchData(id, partial)` 或整行写，沿用）。`retry` 段（约 175 行）读回：

```ts
    const retry: WorkspaceLifecycleShape["retry"] = (id) =>
      Effect.gen(function* () {
        const ws = yield* wsRepo.get(id)
        // …既有 status 校验 / emit workspace.creating…
        const ctx = (ws.data?.createCtx ?? {}) as { initialPrompt?: string; engineId?: string }
        return yield* provision(ws, project.repoRoot, {
          ...(ctx.initialPrompt !== undefined ? { initialPrompt: ctx.initialPrompt } : {}),
          ...(ctx.engineId !== undefined ? { engineId: ctx.engineId } : {}),
        }).pipe(/* 既有 error 映射 */)
      })
```

> 以 M1 `workspaces` repo 的实际 `data` 读写 API 为准（若 `ws.data` 已是解析后的对象则直接读；若是字符串则 `JSON.parse`）。create 写入点同源。

- [ ] **Step 4: engine-exit 单事务（C3）**

`packages/server/src/http/app.ts` 的 `POST /hooks/engine-exit` 段，把 `tabs.setStatus` + `events.append` 包进一个 `db.transaction`——沿用 M1 tabs repo「写库+事件同事务」的既有模式（如 `tabs.setStatusWithEvent(...)` 若已有则复用；否则在 TabsRepo 加一个原子方法或用 repo 暴露的 `withTransaction`）。目标：两写同提交/同回滚。

```ts
              // C3：状态与事件同事务（与 tabs 其它写库点一致）
              yield* tabs.recordEngineExit(tab.id, wsId, body.exitCode) // 内部 db.transaction：setStatus + events.append
```

（在 `packages/server/src/repo/tabs.ts` 加 `recordEngineExit`，body 为原两写的合并事务版；事件 payload 不变：`type:"engine.exited", payload:{tabId, sessionId, exitCode}`；status `exitCode===0?"idle":"error"`，source `"wrapper"`。）

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `cd packages/server && bun run vitest run && bun run typecheck`
Expected: 全绿；typecheck 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/workspace/lifecycle.ts packages/server/src/repo/workspaces.ts packages/server/src/repo/tabs.ts packages/server/src/http/app.ts packages/server/test/workspace.lifecycle.test.ts packages/server/test/http.hooks.test.ts
git commit -m "fix(server): retry 补投 prompt+engineId（C2）+ engine-exit 单事务（C3）"
```

---

### Task 12: README + 全量回归 + 真 codex 手工冒烟清单

**Files:**
- Modify: `README.md`（或 `packages/server/README.md`）——codex 引擎接入章节
- Test: 全量 vitest + 双 typecheck + 手工冒烟

**Interfaces:**
- Consumes: 前 11 task 全部产物。
- Produces: 文档化 codex 接入（如何选引擎、trust/hooks 行为、id 回填、effort、已知 bypass-flag 歧义结论）；一份可复现的真 codex 冒烟清单。

- [ ] **Step 1: 写 README codex 章节**

在 README「Engine 抽象」附近新增小节，写清：
- 创建 codex workspace：GUI 引擎选择器（Plan 4 前，Dispatch 默认取 `engines[0]`；CLI 见下）/ `curl POST /workspaces {projectId, engineId:"codex", initialPrompt}` / `COOLIE_CODEX_CMD` 覆写 seam（测试用 `cat`）。
- codex 与 claude 的行为差异表：服务端造 id（先启动后回填）、hooks 有 trust 门（结论：bypass flag 存在与否见 Task 8 Step 1 记录）、rollout 转录在 `~/.codex/sessions/`、effort 档位、`--resume`。
- 环境变量：`COOLIE_CODEX_HOME`、`COOLIE_CODEX_CONFIG`、`COOLIE_CODEX_CMD`、`COOLIE_CODEX_BIN`、`COOLIE_CODEX_MODELS`。
- 零泄漏纪律：测试必设 `COOLIE_CODEX_HOME`+`COOLIE_CODEX_CONFIG` 指临时目录。

- [ ] **Step 2: 全量回归 + 双 typecheck**

Run: `cd packages/server && bun run vitest run && bun run typecheck && cd ../protocol && bun run typecheck && cd ../client && bun run typecheck`
Expected: 全量 vitest 绿；三处 typecheck 清洁（client 未改，`GET /config` 多下发 codex 对 client 结构兼容——`engines[]` 数组已支持）。

- [ ] **Step 3: 真 codex 手工冒烟（发版前 5 分钟清单，记录 PASS/FAIL）**

前置：本机 `codex` 在 PATH（`/opt/homebrew/bin/codex`，0.139.0）；已 `codex login`；用**临时** `COOLIE_HOME`/`COOLIE_CODEX_HOME`/`COOLIE_CODEX_CONFIG` 指 mkdtemp，绝不碰真实 `~/.codex`。

1. 起 server（临时 home），`POST /projects {repoRoot: <某 git repo>}`。
2. `POST /workspaces {projectId, engineId:"codex", initialPrompt:"回答 PONG 两个字"}`——观察：worktree 建成、`.codex/hooks.json` 写入且进 `.git/info/exclude`、`config.toml` 出现该 worktree 的 trusted 段、tmux session `coolie-<wsId>` window0 跑 codex TUI。
3. 事件流 `GET /events?workspace=<id>`：应见 `engine.started`（sessionId=null）→ `engine.session.started`（首个 SessionStart hook）→ tab.engineSessionId 被回填为真 UUIDv7 → `prompt.delivered` 在 `engine.session.started` **之后**（无 `prompt.delivery.degraded`，无吞字）。
4. `tmux -L coolie attach -t coolie-<wsId>`（Open in iTerm2 等价）：codex 真答出 PONG，里外同画面。
5. 徽标流转：忙时 `●working`、停时 `✓awaiting-input`（hooks 驱动；若本机 codex hooks 需手动 trust 则改由 rollout mtime 兜底，仍应流转——记录实际路径）。
6. `--resume`：杀 window（keep-alive 落 shell）→ `POST /workspaces/<id>/tabs/<tabId>/resume` → codex 复活同会话（rollout 追加，不新建文件）。
7. archive → worktree 删、branch 留、`config.toml` trusted 段留存无害；unarchive 从 branch 重建、heal 用 codex transcriptPath 正确定位。
8. 退出后 `diff <(cat ~/.codex/config.toml)`（真实）为空——零泄漏确认（全程用了临时 `COOLIE_CODEX_CONFIG`）。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: codex 引擎接入说明 + 真机冒烟清单（M2 Plan 1 完成）"
```

---

## Self-Review

按 writing-plans skill 的三项自检，对照 spec §六/§十三与 codex.md 复核本计划。

**1. Spec coverage（M2 Plan 1 责任范围内的 spec 点）：**
- spec §十三「codex adapter」→ Tasks 5–9（transcript/trust/hooks/adapter/id 回填）✓；`GET /config` 下发（Task 1）+ create 贯通 engineId（Task 2）让 GUI/CLI 可选 codex ✓。
- spec §六「id 生命周期差异必须进抽象」→ `serverGeneratedId` 分流 + 先启动后回填（Tasks 8/9）✓。
- spec §六「codex hooks 有 trust 门、notify/OSC title 白送」→ trust 预置（Task 6）+ hooks 注入（Task 7）+ `terminal_title` 注入（Task 8 launchCommand）✓；notify OS 通知显式延 Plan 2（Global Constraints 已声明）✓。
- codex.md §9 能力矩阵每行 → capabilities（Task 8）逐位对齐：nativeQueue=false/effort=true/resume/hooks ✓；`--session-id` 不支持 → launchCommand 绝不传（Task 8 测试钉死）✓；会话列表源 sqlite/app-server → **本计划未用**（M1 徽标靠 hooks+mtime 已足，会话列表 UI 非 Plan 1 范围，codex.md §9「会话列表源」留待需要时）——记为有意 YAGNI，不算 gap。
- codex.md §3 rollout schema + 合成行过滤 → Task 5 transcript reader ✓。
- M1 carry-over C1/C2/C3/C4/C8 → Tasks 10/11/4 ✓；C5（引擎无关化）→ Tasks 1/2/3/4 ✓。C6/C7/C9/C10 明确不在本计划（roadmap 分诊表已分派/关闭）✓。

**2. Placeholder scan：** Task 8 Step 5 第一版 `launchCommand` 故意含占位注释，但**紧随其后的「实现修正」块给了完整正解并明令整体替换**——非遗留 placeholder，是「先展示错误形态再纠正」的教学结构，最终落地代码完整无 TBD。其余步骤均含完整可执行代码与真实断言。**原「唯一待实现者定夺」的 bypass-hook-trust flag（F3）现已在本机（codex-cli 0.139.0）实测消解**：交互式 `codex` 与 `codex exec` 均支持该 flag，Task 8 收敛为单分支无条件追加，`launchCommand` 正解含 flag 且 adapter 测试断言其存在——不再有二分支/占位/外部未知残留。全计划零 placeholder、零 TBD。

**3. Type consistency（adversarial round 后重核，逐条 grep 过）：**
- `Engine` 扩展字段现为**可选**（F4）：`serverGeneratedId?: boolean`（默认 false）、`models?: readonly string[]`（默认 `[]`）、`efforts?`、`prepareWorkspace` 多收 `codexConfigPath?`——定义在 Task 8 Step 4，Task 1 Step 1 注同款。**选可选修掉了原「typecheck clean」假声明**：若设必填，M1 既有 4 个 `Engine` 测试 fake（`http-heal`/`heal`/`lifecycle-tmux`/`bootstrap-prompt-gate`，皆不设这三字段）+ 真 `claudeEngine` 会全数 typecheck 报错，Task 1「typecheck 清洁」不成立；设可选后这 4 fake 零改动通过，claude/codex 两真 adapter 显式补 `serverGeneratedId`/`models`（Task 8 Step 4/5）以正确下发 /config。消费点 `e.models ?? []`（Task 1 Step 3）、`engine.serverGeneratedId === true`（Task 9 Step 3）均按可选写 ✓。
- `PostCreateContext = { initialPrompt?, engineId? }`（Task 2 Step 3）在 bootstrap（Task 2 Step 5 读 `ctx.engineId`）、lifecycle retry（Task 11 Step 3 构造）一致 ✓。
- `engineHome(engineId: string | null, cfg)`（Task 3 Step 4，签名放宽收 null）——**F1：heal.ts/monitor.ts/main.ts 的 `cfg.claudeHome` 替换现已单列为 Task 3 Step 7/8 的显式步骤 + RED 测试（`engine.monitor.test.ts`）**，不再是「实现者 ad-hoc、靠 Task 12 冒烟兜」的悬空项。调用点：http deriveTitle（Task 4 Step 5）、heal `transcriptExists`（Task 3 Step 8）、monitor `homeFor`（Task 3 Step 7）、main 装配（Task 3 Step 8）全部一致 ✓。
- `TranscriptPollerDeps`（F1）从单 `engine`/`home` 改为 `resolveEngine(engineId)`/`homeFor(engineId)`——M1 既有 monitor/heal 测试若直接构造旧 deps，Task 3 Step 9 明令 grep `TranscriptPollerDeps`/`startTranscriptPoller(` 全量同步（否则 typecheck 挡）。
- `ensureHookScript(home, engineId)`（Task 4 Step 3）两参签名在 bootstrap（Task 4 Step 4）调用点一致 ✓；`hookScriptPath` 同步改两参——**注意 main.ts:82 有 M1 遗留的单参 `ensureHookScript(cfg.home)` 调用点**，实现者 grep `hookScriptPath(` / `ensureHookScript(` 全量改（Task 4 内落实，含 main.ts）✓。
- **F7 sessionId 单一故事**：`StartEngineSessionInput.sessionId: string | null`（session.ts，Task 9），codex 传 null；`launchCommand` 的 `opts.sessionId: string` 不放宽，唯一合并点 `i.sessionId ?? ""` 落在 session.ts 内；bootstrap/tab.insert/events payload 全走 `string | null`（`engineSessionId` 列 M1 已可空）。heal.ts 的 `plan.sessionId` 亦 `string | null`，天然兼容 ✓。无 `string`/`string|null` 混用残留。
- codex `newSessionId` 返回 string（占位）满足接口，但 bootstrap 对 `serverGeneratedId===true` 走 `null` 分支不调它（Task 9 Step 3）——无类型冲突 ✓。
- **F6**：`/input` 守卫用 `engine?.capabilities.nativeQueue === false`（engine 可能 undefined→乐观放行，安全），返回 `err(res,409,"EngineBusy",…)`，与 M1 err helper 签名一致 ✓。

**adversarial round：F1–F7 + roadmap gaps applied.**
- F1（monitor per-engine，未 tasked）→ Task 3 Step 5–10（新 `engine.monitor.test.ts` RED：两引擎读各自 home + null-id 跳过；monitor/heal/main.ts 全改）。
- F2（null-id 期 mtime 兜底真空）→ Task 3 Interfaces + Step 7 注：刻意保留 skip（rollout 文件此期不存在，hooks 独家负责），由 F3 的 hook-fire 保证兜底。
- F3（bypass-hook-trust 歧义）→ **本机实测已解**：codex-cli 0.139.0 交互式 `codex` 与 `codex exec` 均有 `--dangerously-bypass-hook-trust` → Task 8 单分支无条件加 flag（+ adapter 测试钉死）；就绪门控武装条件写死（hooks cap ∧ trust 预置 ∧ bypass flag）。
- F4（Engine 新字段破坏 4 fake / 假 typecheck 声明）→ 字段改可选 + 显式列出 4 fake 免改；本节假声明已改正。
- F5（seedCodexTrust header-in-无-trust_level 漏 upsert）→ Task 6 重写为真 UPSERT + 两个新测试（补 trusted / 改写非 trusted）。
- F6（codex send-while-busy degraded）→ Task 4 Step 7–11：`/input` 409 EngineBusy 守卫 + 测试 + Plan 2 REMOVAL MARKER。
- F7（sessionId 类型统一）→ session.ts `string | null` 贯通，单一合并点。
- roadmap gaps → 见 roadmap §二分诊表新增行（C11–C13 + P5 minors CLOSED + 两 M1-pre-acceptance 候选）与 §四波次说明。

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-12-coolie-m2-plan1-codex-adapter.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每 task 一个 fresh subagent，task 间两阶段评审，快速迭代。
**2. Inline Execution** — 本会话内 executing-plans，批量执行带 checkpoint。

**Which approach?**
</content>
