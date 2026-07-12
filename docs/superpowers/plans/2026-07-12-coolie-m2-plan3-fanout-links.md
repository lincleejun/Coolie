# Coolie M2 · Plan 3：fan-out 多 workspace 派发 + `coolie://` deep links + 外部终端模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一条 prompt 能一次派发到多个 workspace/多引擎（CLI `coolie create --agents claude:2,codex:1`，每个 workspace 独立生命周期）；引入 `coolie://` 标准 URL scheme 深链到 workspace/tab（GUI 从系统链接聚焦，CLI 生成/打开链接）；把「Open in iTerm2」升级为可配置的**外部终端**，并新增 per-workspace「外部终端模式」（GUI 不挂内嵌终端、只引导 `tmux attach` 的工作流）。顺带清 M1 carry-over **C12**（shell-tab create 的 tmux-op-then-DB 非原子）。

**Architecture:** Plan 3 是 M2 Wave 1 三并行 plan 之一，建立在 **Plan 1 已合入**的接缝上（`GET /config` 下发 `engines[]`、`POST /workspaces` 已接受 `engineId`、`PostCreateContext`/`setCreateCtx` 已贯通、codex 已注册进 registry）。**fan-out 不加 server 批量端点**——遵 roadmap「各 workspace 独立生命周期」，由 CLI/GUI 端对现有 `POST /workspaces` 发 N 次；server 侧只新增一个 `fanoutGroup?` 分组元数据（复用 Plan 1 的 `setCreateCtx`/`PostCreateContext` 落进 `workspaces.data`），fan-out 结果呈现为一张表 + 每个 workspace 的 `coolie://workspace/<id>` 深链。**deep links 用官方 `tauri-plugin-deep-link` v2**（`plugins-workspace`）：`tauri.conf.json` 注册 `coolie` scheme、Rust `.plugin(tauri_plugin_deep_link::init())`、JS `onOpenUrl`+`getCurrent` 回调路由到 UI store（`selectWs`/`selectTab`）；URL 语法本身抽成 `packages/protocol/src/links.ts` 的纯函数（`parseCoolieUrl`/`buildCoolieUrl`），CLI 与 client 共用、可纯测。**外部终端**把 `openInIterm` 泛化为终端注册表（iTerm2 / Terminal.app AppleScript + 用户自定义命令模板，复用现有 Rust `spawn_detached` command，不引 tauri shell/opener 插件），并把 attach 命令的 tmux session 名从 TabsBar 内联字符串归一到 `tmuxSessionName`；「外部终端模式」是 per-workspace 客户端持久化开关（仿 drafts 的 localStorage 模式，node 测试环境降级为内存）。C12 用 Plan 1 C3 同法：tmux 建窗成功但 DB insert 失败时补偿 kill window。依据：spec §五（tmux/Open in iTerm2）、§七（Client UI/CenterArea）、§八（CLI fan-out / deep links）、§十三（M2 scope）；M2 roadmap `2026-07-12-coolie-m2-roadmap.md`（Plan 3 scope + C12）；Tauri v2 deep-link 官方文档。

**Tech Stack:** 与 main 落地代码一致：TypeScript ^5.x（strict + exactOptionalPropertyTypes）、Node ≥22 运行时（bun 仅装包/跑脚本）、Effect ^3.21.4（server 侧）、commander（CLI）、React 18 + zustand（client）、vitest（三包）、Tauri **2.x**（`macos-private-api`）、`tmux -L coolie`。新增依赖：Rust `tauri-plugin-deep-link@2`（`packages/client/src-tauri/Cargo.toml`）、npm `@tauri-apps/plugin-deep-link@^2`（`packages/client/package.json`）——**仅这两个**，均为官方 plugins-workspace。外部终端不引任何新依赖（复用现有 `spawn_detached` + `osascript`）。真终端/真 GUI 只出现在最终 Task 12 手工冒烟；自动化测试全走纯函数 + `vi.mock("@tauri-apps/api/core")` 注入 `invoke` 假体。

## Global Constraints

（承 M1/Plan 1 全套，逐条仍生效——每个 task 的要求隐含本节）

- server 与 CLI 的一切进程**必须以 Node 运行**（`node`/`tsx`），bun 只做 `bun install`/`bun run`。
- Effect 锁 `^3.21.4`；server 侧代码按 main 已合入代码的实际 API 风格书写（`runRoute`+`Exit.match`、`errorFromCause` 按 `_tag` 映射状态码、repo「写库+事件 append」同一 `db.transaction`）。若个别 API 有出入以官方 docs 等价改写，**任务的行为契约（每步测试断言）不变**。
- **依赖 Plan 1 已合入 main**：本计划假定 `GET /config` 已下发 `engines[]`、`POST /workspaces` 已校验/接受 `engineId`、`WorkspaceLifecycle.create` opts 已含 `engineId?`、`PostCreateContext = { initialPrompt?; engineId? }` 与 `repo.setCreateCtx` 已存在、codex 已注册进 `EngineRegistryLive`。fan-out 跨引擎起 session 直接复用这些接缝，本计划**不重复实现**它们，只在其上追加 `fanoutGroup`。
- **engine 进程只属于 tmux**：fan-out 创建的每个 workspace 与单建规格一致（`coolie-<wsId>` session、window 0 = engine、keep-alive）；server/CLI 死掉不杀 engine。fan-out 是 N 次独立 create，**无跨 workspace 的原子事务**（roadmap 明定：各 workspace 独立生命周期；部分失败按行报告，不整体回滚已成功者）。
- **AppleScript / shell 注入纪律**（承 M1 `openInIterm` 的 `SHELL_SAFE`）：任何把 `tmuxSocket`/`wsId` 拼进 AppleScript 或 `spawn_detached` argv 的路径，必须先过 `SHELL_SAFE = /^[A-Za-z0-9._-]+$/` 白名单校验，非法即抛，绝不拼接。自定义终端模板只做 `{cmd}` 占位替换，`{cmd}` 的值来自已校验的 socket/wsId 组装，不接受用户任意字符串直插 argv 之外的语义。
- **deep-link scheme 固定 `coolie`**；URL 语法只认 `coolie://workspace/<id>`、`coolie://workspace/<id>/tab/<tabId>`、`coolie://project/<id>`，其余一律 `parseCoolieUrl → null`（安全默认拒绝）；id 段必须匹配 `/^[A-Za-z0-9._-]+$/`。macOS 上 deep-link 只能由**已安装到 `/Applications` 的 bundle** 触发（`tauri-plugin-deep-link` 文档），dev 下 `onOpenUrl` 运行期回调仍可用但 scheme 注册需 bundle——故 Rust/conf 改动的真验证在 Task 12 冒烟；纯 `parseCoolieUrl`/`routeCoolieUrl` 逻辑在 Task 2/8 用 vitest 钉死。macOS **不需要** single-instance 插件（原生 emit 事件）；Windows/Linux 需要，**本计划显式只做 macOS**（与 iTerm2/spec 一致），Win/Linux single-instance 记为后置。
- **token/安全默认值不变**：server 绑 `127.0.0.1` + unix socket；除 `GET /health` 外一切端点强制 token；日志/链接绝不打印含 token 的完整 URL。`coolie://` 链接**绝不含 token**（只含 workspace/tab id，纯本机路由）。
- SQLite 写库纪律不变：本计划**无 schema 变更**（`fanoutGroup` 写进 `workspaces.data` 的 `createCtx` JSON，复用 Plan 1 已建的 `setCreateCtx`，不加列）；migration 幂等、禁无 WHERE sweep。
- **测试隔离/零泄漏**：server/CLI 测试经 `COOLIE_HOME`/`COOLIE_WORKSPACES_ROOT`/`COOLIE_TMUX_SOCKET`/`COOLIE_CLAUDE_HOME`/`COOLIE_CLAUDE_CONFIG` 指 mkdtemp/专属测试 socket，绝不碰真实 `~/.coolie`/`~/coolie`/`~/.claude`/`~/.codex`、绝不碰生产 `-L coolie` socket；用了 tmux 的测试文件 `afterAll` `tmux kill-server`。client 测试为 **node env 无 DOM**：任何 `localStorage`/`@tauri-apps/api/core` 访问必须 `typeof` 守卫或 `vi.mock` 注入，纯逻辑（parse/route/build/store transition）不依赖真实浏览器/Tauri。
- 每个 Task 结束必须 `git commit`，conventional commits（feat/fix/test/docs/chore）。
- 本计划**不做**（显式延后至其他 M2 plan）：codex adapter 与引擎无关运行时接缝（Plan 1，已合入）；server 端 prompt 队列 + 通知/注意力（Plan 2）；diff 行评论写回 + 用户键位 JSON/⌘K/footer + 主题/i18n + 附件 + web client（Plan 4）。fan-out 的 GUI 多选（Task 11）是 Dispatch 的**最小**扩展；引擎/模型选择器的美化归 Plan 4。

## File Structure（本计划新建/修改）

```
packages/protocol/src/
  links.ts                            # 新建：coolie:// URL 语法（parseCoolieUrl/buildCoolieUrl/CoolieLinkTarget/COOLIE_SCHEME）
  domain.ts                           # 修改：+MAX_FANOUT（fan-out 实例上限——CLI 与 client 共用的单一常量，client 无 cli 依赖故落 protocol）
  index.ts                            # 修改：re-export ./links.js
  routes.ts                           # 修改：POST /workspaces 描述 +fanoutGroup?
packages/cli/src/
  fanout.ts                           # 新建：parseAgentsSpec / expandAgents（MAX_FANOUT 从 @coolie/protocol re-export）
  main.ts                             # 修改：create +--agents（fan-out 循环 + 结果表）；+link 子命令（生成/--open 打开 coolie://）
packages/server/src/
  http/app.ts                         # 修改：C12（tabsCreate 建窗成功但 DB insert 失败 → 补偿 kill window）；POST /workspaces 读 body.fanoutGroup
  workspace/lifecycle.ts              # 修改：PostCreateContext +fanoutGroup?；create opts +fanoutGroup?；透传 provision + 存 createCtx
  repo/workspaces.ts                  # 修改：setCreateCtx/getCreateCtx round-trip +fanoutGroup（唯一 reader：retry 回填读回；见 Task 5 MED-2 决策）
packages/client/
  package.json                        # 修改：+@tauri-apps/plugin-deep-link
  src/deeplink.ts                     # 新建：routeCoolieUrl（parse → DeepLinkRouter 派发）+ DeepLinkRouter 接口
  src/App.tsx                         # 修改：bootstrap effect 内 getCurrent + onOpenUrl 接线到 useUi
  src/terminal/terminals.ts           # 新建：终端注册表（buildAttachCommand / buildTerminalLaunch / TerminalId）
  src/stores/terminal.ts              # 新建：useTerminal（terminalApp/customTemplate/externalByWs，localStorage 守卫持久化）
  src/terminal/TabsBar.tsx            # 修改：openInIterm → openInTerminal（消费 terminals.ts + useTerminal）；终端选择器；CenterArea 外部模式占位（C12/外部终端）
  src/composer/Dispatch.tsx           # 修改：fan-out 多选（引擎×实例）+ 循环创建 + 结果提示 ⚠ 建立在 Plan 4 Task 1 重写后的 Dispatch 形态上（消费其 buildCreateBody）——Task 11 须排在 Plan-4-T1 合并之后
  src-tauri/Cargo.toml                # 修改：+tauri-plugin-deep-link = "2"
  src-tauri/tauri.conf.json           # 修改：plugins.deep-link.desktop.schemes=["coolie"]；bundle.active + macOS
  src-tauri/src/main.rs               # 修改：.plugin(tauri_plugin_deep_link::init())
  src-tauri/capabilities/default.json # 修改：+deep-link:default
README.md                             # 修改：fan-out / coolie:// / 外部终端 用法 + 冒烟清单（Task 12）
```

## Task Order / 波次并行

12 个 task 按共享文件切成五波，波内标 ∥ 的可并行，标 → 的须串行：

```
Wave A  ∥  { T1, T2, T3, T4 }     # 独立文件：cli/fanout.ts(+protocol/domain.ts MAX_FANOUT)、protocol/links.ts+index.ts、client/terminals.ts、server/app.ts(C12)
Wave B  →  T5                     # server lifecycle+app.ts+repo/workspaces.ts fanoutGroup（app.ts 与 T4 冲突面 → T4 先收口）
Wave C  →  T6 → T7                # cli/main.ts：fan-out create → link（同文件串行）
Wave D  ∥  { T8, T9→T10 }         # T8 App.tsx+deeplink；T9→T10 TabsBar/CenterArea 串行
Wave D'  →  T11                   # ⚠ Dispatch fan-out：GATED on Plan 4 Task 1 已合并（见下方跨 Plan 横幅）——不能与 Plan-4-T1 并发
Wave E  →  T12                    # README + 全量回归 + 冒烟
```

> **⚠⚠ 跨 Plan 硬依赖横幅（binding controller decision）**：`packages/client/src/composer/Dispatch.tsx` 的**唯一 canonical owner 是 Plan 4 Task 1**（整体重写：引擎/模型/effort 选择器 + 导出 `buildCreateBody`）。**本计划 Task 11 必须在 Plan 4 Task 1 已合入 main 之后执行**——它在重写后的 Dispatch 形态之上叠加 fan-out 多选（消费 `buildCreateBody` 构造每个 workspace 的 body，`buildFanoutRequests` 仍为纯可测核心）。执行调度二选一：**(a) 先跑完 Plan 4（至少 T1）再跑本计划 Wave D'**，或 **(b) 把 T11 从 Wave D 拆出、单独排在 Plan-4-T1 merge 之后（即上表 Wave D'）**。绝不可让 T11 与 Plan-4-T1 并发改同一文件（必然冲突且形态不兼容）。

> **⚠ 共享文件冲突面（M1 P5「共享文件串行段」纪律）**：
> - `packages/server/src/http/app.ts`：**T4（C12）与 T5（fanoutGroup body）都改** → 绝不并发，T4 先。
> - `packages/cli/src/main.ts`：**T6 与 T7 都改** → 串行，T6 先。
> - `packages/client/src/terminal/TabsBar.tsx`：**T9（终端选择器）与 T10（外部模式占位）都改** → 串行，T9 先。
> - **跨 Plan 冲突（roadmap §四）**：`App.tsx`（本计划 T8 改 bootstrap effect）Plan 2（通知横幅）/Plan 4（主题壳）也会碰——按 roadmap「Plan 4 后合并吸收」或串行段纪律协调，本计划只在 bootstrap effect 内**追加** getCurrent/onOpenUrl 两行接线，不动既有结构。
> - **`Dispatch.tsx` 跨 Plan（binding controller decision）**：**Plan 4 Task 1 是 Dispatch.tsx 的 canonical owner**（整体重写引擎/模型/effort 选择器 + 导出 `buildCreateBody`）。本计划 **Task 11 不与之并发、而是在其合并之后叠加** fan-out 多选——消费 `buildCreateBody` 生成 per-workspace body，`buildFanoutRequests` 为纯可测核心。见上方跨 Plan 硬依赖横幅：T11 排入 Wave D'（Plan-4-T1 merge 之后）。
> - 契约定档：`CoolieLinkTarget`/`parseCoolieUrl`（T2）、`TerminalId`/`buildTerminalLaunch`（T3）、`AgentSpec`/`parseAgentsSpec`（T1）在各自 Wave A task 定义，后续 task 只消费不重定义。

---

### Task 1: fan-out `--agents` 规格解析器（`parseAgentsSpec`）

**Files:**
- Create: `packages/cli/src/fanout.ts`
- Modify: `packages/protocol/src/domain.ts`（+`MAX_FANOUT`——单一常量源，CLI 与 client 共用；client 无 cli 依赖，故落 protocol）
- Test: `packages/cli/test/fanout.test.ts`

**Interfaces:**
- Consumes: `MAX_FANOUT` from `@coolie/protocol`（fanout.ts re-export，供 CLI 就近使用）。
- Produces:
  - `interface AgentSpec { engineId: string; count: number }`
  - `parseAgentsSpec(raw: string): AgentSpec[]`——解析 `"claude:2,codex:1"`；空/格式错/count<1 抛 `Error`（消息可读）。
  - `expandAgents(specs: AgentSpec[]): string[]`——展平成逐实例 engineId 列表（`[{claude,2},{codex,1}] → ["claude","claude","codex"]`）。
  - `MAX_FANOUT = 16`——**canonical 定义在 `@coolie/protocol/domain.ts`**（单次 fan-out 实例上限，防跑飞）；`fanout.ts` re-export，client（Task 11 GUI 总量 cap）直接从 `@coolie/protocol` import——两端同一常量、不重复定义。

> **MED-1 决策**：`MAX_FANOUT` 不留在 cli/fanout.ts 私有——CLI（Task 6 循环上限）与 GUI（Task 11 总量 cap）必须用**同一**常量，而 `packages/client` 无 `@coolie/cli` 依赖（见 package.json：client → `@coolie/protocol` only），故 canonical 落 `@coolie/protocol/domain.ts`（与既有 `tmuxSessionName` 同处），两端各自从 protocol 取。

- [ ] **Step 1: 写失败测试**

`packages/cli/test/fanout.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { parseAgentsSpec, expandAgents, MAX_FANOUT } from "../src/fanout.js"

describe("parseAgentsSpec", () => {
  it("解析多段 engine:count", () => {
    expect(parseAgentsSpec("claude:2,codex:1")).toEqual([
      { engineId: "claude", count: 2 }, { engineId: "codex", count: 1 },
    ])
  })
  it("容忍空白并小写 engineId", () => {
    expect(parseAgentsSpec(" Claude:1 , codex:3 ")).toEqual([
      { engineId: "claude", count: 1 }, { engineId: "codex", count: 3 },
    ])
  })
  it("空串抛", () => { expect(() => parseAgentsSpec("")).toThrow() })
  it("格式错抛（缺 count）", () => { expect(() => parseAgentsSpec("claude")).toThrow(/engine:count/) })
  it("count<1 抛", () => { expect(() => parseAgentsSpec("claude:0")).toThrow(/count/) })
})

describe("expandAgents", () => {
  it("展平为逐实例列表", () => {
    expect(expandAgents([{ engineId: "claude", count: 2 }, { engineId: "codex", count: 1 }]))
      .toEqual(["claude", "claude", "codex"])
  })
})

it("MAX_FANOUT 为正整数上限", () => { expect(MAX_FANOUT).toBeGreaterThanOrEqual(2) })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/cli && bun run vitest run test/fanout.test.ts`
Expected: FAIL——`../src/fanout.js` 不存在。

- [ ] **Step 3: 实现——先在 protocol 加 MAX_FANOUT，再写 fanout.ts re-export**

`packages/protocol/src/domain.ts` 追加（放在 `tmuxSessionName` 附近；`index.ts` 已 `export * from "./domain.js"`，无需改 index）：

```ts
/** 单次 fan-out 实例数上限：防手滑 `claude:999` 拖垮机器（每实例 = 一个 worktree + tmux session）。
 *  CLI（coolie create --agents）与 GUI（Dispatch fan-out 多选）共用同一常量——client 无 @coolie/cli 依赖，故落 protocol。 */
export const MAX_FANOUT = 16
```

`packages/cli/src/fanout.ts`：

```ts
// MAX_FANOUT 的 canonical 定义在 @coolie/protocol（单一常量源，client 亦从 protocol 取）；此处 re-export 供 CLI 就近使用。
export { MAX_FANOUT } from "@coolie/protocol"

export interface AgentSpec {
  readonly engineId: string
  readonly count: number
}

/** 解析 `--agents` 规格：`"claude:2,codex:1"` → [{claude,2},{codex,1}]。空/格式错/count<1 抛可读 Error。 */
export const parseAgentsSpec = (raw: string): AgentSpec[] => {
  const segs = raw.split(",").map((s) => s.trim()).filter((s) => s !== "")
  if (segs.length === 0) throw new Error("--agents 不能为空（示例：claude:2,codex:1）")
  const out: AgentSpec[] = []
  for (const s of segs) {
    const m = s.match(/^([A-Za-z0-9][A-Za-z0-9-]*):([0-9]+)$/)
    if (!m) throw new Error(`--agents 段格式错误：'${s}'（应为 engine:count，如 claude:2）`)
    const count = Number.parseInt(m[2]!, 10)
    if (count < 1) throw new Error(`--agents 段 '${s}' 的 count 必须 ≥1`)
    out.push({ engineId: m[1]!.toLowerCase(), count })
  }
  return out
}

/** 展平成逐实例 engineId 列表（保持声明顺序）。 */
export const expandAgents = (specs: readonly AgentSpec[]): string[] =>
  specs.flatMap((s) => Array.from({ length: s.count }, () => s.engineId))
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd packages/protocol && bun run typecheck && cd ../cli && bun run vitest run test/fanout.test.ts && bun run typecheck`
Expected: PASS（`MAX_FANOUT` 经 fanout.ts re-export，测试 `import { MAX_FANOUT } from "../src/fanout.js"` 仍成立）；双 typecheck 清洁。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/domain.ts packages/cli/src/fanout.ts packages/cli/test/fanout.test.ts
git commit -m "feat(cli): fan-out --agents 规格解析器 + MAX_FANOUT 落 protocol（CLI/GUI 共用常量）"
```

---

### Task 2: `coolie://` URL 语法（protocol/links.ts 纯函数）

**Files:**
- Create: `packages/protocol/src/links.ts`
- Modify: `packages/protocol/src/index.ts`（re-export）
- Test: `packages/protocol/test/links.test.ts`（若无 test 目录则新建；沿用其它 protocol 测试装配）

**Interfaces:**
- Consumes: 无（纯字符串）。
- Produces:
  - `const COOLIE_SCHEME = "coolie"`
  - `type CoolieLinkTarget = { kind: "workspace"; workspaceId: string; tabId?: string } | { kind: "project"; projectId: string }`
  - `buildCoolieUrl(t: CoolieLinkTarget): string`
  - `parseCoolieUrl(raw: string): CoolieLinkTarget | null`——非 `coolie://`、未知形状、非法 id → `null`（安全默认拒绝）。

- [ ] **Step 1: 写失败测试**

`packages/protocol/test/links.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { buildCoolieUrl, parseCoolieUrl, COOLIE_SCHEME } from "../src/links.js"

describe("buildCoolieUrl", () => {
  it("workspace", () => { expect(buildCoolieUrl({ kind: "workspace", workspaceId: "w1" })).toBe("coolie://workspace/w1") })
  it("workspace+tab", () => { expect(buildCoolieUrl({ kind: "workspace", workspaceId: "w1", tabId: "t2" })).toBe("coolie://workspace/w1/tab/t2") })
  it("project", () => { expect(buildCoolieUrl({ kind: "project", projectId: "p3" })).toBe("coolie://project/p3") })
})

describe("parseCoolieUrl（build/parse 往返 + 拒绝畸形）", () => {
  it("往返 workspace/tab", () => {
    const t = { kind: "workspace", workspaceId: "w1", tabId: "t2" } as const
    expect(parseCoolieUrl(buildCoolieUrl(t))).toEqual(t)
  })
  it("往返 project", () => {
    const t = { kind: "project", projectId: "p3" } as const
    expect(parseCoolieUrl(buildCoolieUrl(t))).toEqual(t)
  })
  it("容忍尾斜杠 / query / fragment", () => {
    expect(parseCoolieUrl("coolie://workspace/w1/?x=1#frag")).toEqual({ kind: "workspace", workspaceId: "w1" })
  })
  it("scheme 大小写不敏感（COOLIE://），但 id 段保留原样大小写", () => {
    expect(parseCoolieUrl("COOLIE://workspace/W1")).toEqual({ kind: "workspace", workspaceId: "W1" })
    expect(parseCoolieUrl("Coolie://project/P3")).toEqual({ kind: "project", projectId: "P3" })
  })
  it("非 coolie scheme → null", () => { expect(parseCoolieUrl("https://workspace/w1")).toBeNull() })
  it("未知 host → null", () => { expect(parseCoolieUrl("coolie://bogus/x")).toBeNull() })
  it("非法 id（含空格/斜杠注入）→ null", () => {
    expect(parseCoolieUrl("coolie://workspace/a b")).toBeNull()
    expect(parseCoolieUrl("coolie://workspace/w1/tab/")).toBeNull()
    expect(parseCoolieUrl("coolie://workspace/w1/bogus/t2")).toBeNull()
  })
  it("COOLIE_SCHEME 常量", () => { expect(COOLIE_SCHEME).toBe("coolie") })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/protocol && bun run vitest run test/links.test.ts`
Expected: FAIL——`../src/links.js` 不存在。

- [ ] **Step 3: 实现 links.ts**

```ts
export const COOLIE_SCHEME = "coolie"
const PREFIX = `${COOLIE_SCHEME}://`
const SAFE = /^[A-Za-z0-9._-]+$/

export type CoolieLinkTarget =
  | { readonly kind: "workspace"; readonly workspaceId: string; readonly tabId?: string }
  | { readonly kind: "project"; readonly projectId: string }

/** 构造标准 coolie:// 深链（CLI `coolie link` 与结果表复用）。 */
export const buildCoolieUrl = (t: CoolieLinkTarget): string => {
  switch (t.kind) {
    case "workspace":
      return t.tabId !== undefined
        ? `${PREFIX}workspace/${t.workspaceId}/tab/${t.tabId}`
        : `${PREFIX}workspace/${t.workspaceId}`
    case "project":
      return `${PREFIX}project/${t.projectId}`
  }
}

/** 解析 coolie:// 深链——安全默认拒绝：非本 scheme / 未知形状 / 非法 id 段一律 null。
 *  scheme 大小写不敏感（RFC 3986：scheme 比较 case-insensitive；`COOLIE://` 亦接受），但 host/id 段保留原样大小写。 */
export const parseCoolieUrl = (raw: string): CoolieLinkTarget | null => {
  if (!raw.toLowerCase().startsWith(PREFIX)) return null // scheme 先小写再比对；id 段仍取原始 raw（不丢大小写）
  const rest = raw.slice(PREFIX.length).replace(/[?#].*$/, "").replace(/\/+$/, "")
  const seg = rest.split("/").filter((s) => s !== "")
  const ok = (s: string | undefined): s is string => s !== undefined && SAFE.test(s)
  if (seg[0] === "workspace" && ok(seg[1])) {
    if (seg.length === 2) return { kind: "workspace", workspaceId: seg[1] }
    if (seg.length === 4 && seg[2] === "tab" && ok(seg[3])) return { kind: "workspace", workspaceId: seg[1], tabId: seg[3] }
    return null
  }
  if (seg[0] === "project" && seg.length === 2 && ok(seg[1])) return { kind: "project", projectId: seg[1] }
  return null
}
```

- [ ] **Step 4: re-export**

`packages/protocol/src/index.ts` 追加（与既有 `export * from "./routes.js"` 同款）：

```ts
export * from "./links.js"
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd packages/protocol && bun run vitest run test/links.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/links.ts packages/protocol/src/index.ts packages/protocol/test/links.test.ts
git commit -m "feat(protocol): coolie:// URL 语法（parseCoolieUrl/buildCoolieUrl）"
```

---

### Task 3: 外部终端注册表（terminals.ts 纯函数）

**Files:**
- Create: `packages/client/src/terminal/terminals.ts`
- Test: `packages/client/test/terminals.test.ts`

**Interfaces:**
- Consumes: `tmuxSessionName` from `@coolie/protocol`（归一 TabsBar 内联的 `coolie-${wsId}`）。
- Produces:
  - `type TerminalId = "iterm2" | "terminal" | "custom"`
  - `interface TerminalLaunch { program: string; args: string[] }`
  - `buildAttachCommand(tmuxSocket: string, wsId: string): string`——校验后返回 `tmux -L <socket> attach -t coolie-<wsId>`；非法 socket/wsId 抛。
  - `buildTerminalLaunch(id: TerminalId, tmuxSocket: string, wsId: string, customTemplate?: string): TerminalLaunch`——把 attach 命令包成 `spawn_detached` 的 `{program,args}`；iterm2/terminal 走 osascript，custom 走 `{cmd}` 模板（按空白分词，`{cmd}` **token-anywhere**：可整参亦可嵌参内 `replaceAll` 替换；缺 `{cmd}` 或含引号即抛可读错——朴素分词不支持引号参数，明确拒绝而非静默错拆）。未知 `id`（运行期来自持久化的脏值）落 `default` 分支抛错。

- [ ] **Step 1: 写失败测试**

`packages/client/test/terminals.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { buildAttachCommand, buildTerminalLaunch } from "../src/terminal/terminals.js"

describe("buildAttachCommand", () => {
  it("拼 tmux attach（session 名归一 coolie-<wsId>）", () => {
    expect(buildAttachCommand("coolie", "w1")).toBe("tmux -L coolie attach -t coolie-w1")
  })
  it("非法 socket 抛（注入防护）", () => {
    expect(() => buildAttachCommand("coolie; rm -rf /", "w1")).toThrow()
    expect(() => buildAttachCommand("coolie", 'w1"; evil')).toThrow()
  })
})

describe("buildTerminalLaunch", () => {
  it("iterm2 → osascript，脚本含 attach 命令", () => {
    const l = buildTerminalLaunch("iterm2", "coolie", "w1")
    expect(l.program).toBe("/usr/bin/osascript")
    expect(l.args[0]).toBe("-e")
    expect(l.args[1]).toContain("iTerm2")
    expect(l.args[1]).toContain("tmux -L coolie attach -t coolie-w1")
  })
  it("terminal → Terminal.app 的 do script", () => {
    const l = buildTerminalLaunch("terminal", "coolie", "w1")
    expect(l.program).toBe("/usr/bin/osascript")
    expect(l.args[1]).toContain("Terminal")
    expect(l.args[1]).toContain("do script")
  })
  it("custom 模板 {cmd} 整参替换 + argv 拆分（cmd 含空格 → 单个 argv 元素）", () => {
    const l = buildTerminalLaunch("custom", "coolie", "w1", "/usr/bin/open -na WezTerm --args start -- sh -lc {cmd}")
    expect(l.program).toBe("/usr/bin/open")
    expect(l.args).toEqual(["-na", "WezTerm", "--args", "start", "--", "sh", "-lc", "tmux -L coolie attach -t coolie-w1"])
  })
  it("custom 模板 token-anywhere（{cmd} 嵌在参数内也替换）", () => {
    const l = buildTerminalLaunch("custom", "coolie", "w1", "/usr/bin/env sh -lc exec={cmd}")
    expect(l.args).toEqual(["sh", "-lc", "exec=tmux -L coolie attach -t coolie-w1"])
  })
  it("custom 缺 {cmd} 占位抛", () => {
    expect(() => buildTerminalLaunch("custom", "coolie", "w1", "open -na WezTerm")).toThrow(/\{cmd\}/)
  })
  it("custom 含引号抛（朴素分词不支持带空格的引号参数）", () => {
    expect(() => buildTerminalLaunch("custom", "coolie", "w1", 'open -na Foo --args -e "echo {cmd}"')).toThrow(/引号/)
    expect(() => buildTerminalLaunch("custom", "coolie", "w1", "open -na Foo -e 'x {cmd}'")).toThrow(/引号/)
  })
  it("多空白分词稳健（连续空格不产生空参）", () => {
    const l = buildTerminalLaunch("custom", "coolie", "w1", "/bin/foo   sh   -lc   {cmd}")
    expect(l.args).toEqual(["sh", "-lc", "tmux -L coolie attach -t coolie-w1"])
  })
  it("非法 wsId 抛（所有分支都先校验）", () => {
    expect(() => buildTerminalLaunch("iterm2", "coolie", "w 1")).toThrow()
  })
  it("未知 id 落 default 分支抛（持久化脏值防御）", () => {
    expect(() => buildTerminalLaunch("bogus" as any, "coolie", "w1")).toThrow(/未知终端类型/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client && bun run vitest run test/terminals.test.ts`
Expected: FAIL——`terminals.ts` 不存在。

- [ ] **Step 3: 实现 terminals.ts**

```ts
import { tmuxSessionName } from "@coolie/protocol"

export type TerminalId = "iterm2" | "terminal" | "custom"

export interface TerminalLaunch {
  readonly program: string
  readonly args: string[]
}

const SHELL_SAFE = /^[A-Za-z0-9._-]+$/ // socket/wsId 拼进 shell/AppleScript 前的白名单——挡引号/分号/换行注入

/** 组装 attach 命令；session 名走 protocol 的 tmuxSessionName（归一 TabsBar 旧内联字符串）。 */
export const buildAttachCommand = (tmuxSocket: string, wsId: string): string => {
  if (!SHELL_SAFE.test(tmuxSocket) || !SHELL_SAFE.test(wsId))
    throw new Error(`拒绝打开：非法 socket/wsId（仅允许字母数字 . _ -）：${tmuxSocket} / ${wsId}`)
  return `tmux -L ${tmuxSocket} attach -t ${tmuxSessionName(wsId)}`
}

const itermScript = (cmd: string): string =>
  [
    'tell application "iTerm2"',
    "  activate",
    "  set w to (create window with default profile)",
    `  tell current session of w to write text "${cmd}"`,
    "end tell",
  ].join("\n")

const terminalAppScript = (cmd: string): string =>
  ['tell application "Terminal"', "  activate", `  do script "${cmd}"`, "end tell"].join("\n")

/** 把 attach 命令包成 spawn_detached 的 {program,args}。
 *  iterm2/terminal 走 osascript（AppleScript-scriptable）；custom 走用户 `{cmd}` 模板（WezTerm/kitty/Ghostty 等经此接入）。 */
export const buildTerminalLaunch = (
  id: TerminalId,
  tmuxSocket: string,
  wsId: string,
  customTemplate?: string,
): TerminalLaunch => {
  const cmd = buildAttachCommand(tmuxSocket, wsId) // 内部已校验 socket/wsId
  switch (id) {
    case "iterm2":
      return { program: "/usr/bin/osascript", args: ["-e", itermScript(cmd)] }
    case "terminal":
      return { program: "/usr/bin/osascript", args: ["-e", terminalAppScript(cmd)] }
    case "custom": {
      if (customTemplate === undefined || !customTemplate.includes("{cmd}"))
        throw new Error("自定义终端模板必须含 {cmd} 占位（如：/usr/bin/open -na WezTerm --args start -- sh -lc {cmd}）")
      // LOW-1 引号纪律：按空白朴素分词，无法忠实处理带空格的引号参数——含引号即拒绝（要复杂参数请包一层脚本）。
      if (/["']/.test(customTemplate))
        throw new Error("自定义终端模板暂不支持引号（按空白朴素分词无法正确保留带空格的引号参数）；请用无引号参数或包一层 shell 脚本")
      const parts = customTemplate.split(/\s+/).filter((p) => p !== "")
      const [program, ...rest] = parts
      // token-anywhere：{cmd} 可作为整参（sh -lc {cmd}）或嵌在参数内（--run={cmd}）；replaceAll 就地替换。
      // 注意 cmd 本身含空格：替换后该参数是**单个** argv 元素（值内含空格），正符合 `sh -lc "<cmd>"` 语义。
      const args = rest.map((p) => (p.includes("{cmd}") ? p.replaceAll("{cmd}", cmd) : p))
      return { program: program!, args }
    }
    default: // 防御：TerminalId 为闭合联合，但运行期值可能来自持久化——落未知即抛而非静默返回 undefined。
      throw new Error(`未知终端类型：${String(id)}`)
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd packages/client && bun run vitest run test/terminals.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/terminal/terminals.ts packages/client/test/terminals.test.ts
git commit -m "feat(client): 外部终端注册表（buildTerminalLaunch：iterm2/terminal/custom）"
```

---

### Task 4: 修 C12——shell-tab create 的 tmux-op-then-DB 原子补偿

**Files:**
- Modify: `packages/server/src/http/app.ts`（`POST /workspaces/:id/tabs` 段，约 514–543 行）
- Test: `packages/server/test/http.tabs.test.ts`（若无则新建；沿用现有 http 测试装配）

**Interfaces:**
- Consumes: `composerOps.newShellWindow(session, cwd) => Promise<number>`、`composerOps.killWindow(session, index) => Promise<void>`、`TabsRepo.insert`。
- Produces: shell-tab create 变为「tmux 建窗 → DB insert 失败 → 补偿 kill window」——DB 写失败不再留孤儿 tmux window（C12）。行为契约：insert 成功路径不变（201 + tab）；insert 失败路径先 `killWindow(session, idx)` 再回错误码。

- [ ] **Step 1: 写失败测试**

`packages/server/test/http.tabs.test.ts`（注入一个 `composerOps` 假体：`newShellWindow` 返回固定 idx 并记录、`killWindow` 记录调用；注入一个 `TabsRepo`，其 `insert` 对 shell 抛错以模拟 DB 失败；seed 一个 active workspace）：

```ts
it("C12：DB insert 失败 → 补偿 kill 掉刚建的 tmux window（不留孤儿）", async () => {
  const killed: Array<{ session: string; index: number }> = []
  const composerOps = {
    newShellWindow: async (_s: string, _c: string) => 3,
    killWindow: async (session: string, index: number) => { killed.push({ session, index }) },
    input: async () => {},
  }
  const { base, token, wsId } = await withTabsServer({ composerOps, failInsert: true })
  const r = await postRaw(base, `/workspaces/${wsId}/tabs`, { kind: "shell" }, token)
  expect(r.status).toBeGreaterThanOrEqual(400)      // insert 失败 → 错误码
  expect(killed).toEqual([{ session: `coolie-${wsId}`, index: 3 }]) // 补偿 kill 了 window 3
})

it("C12：insert 成功路径不补偿、正常 201", async () => {
  const killed: string[] = []
  const composerOps = {
    newShellWindow: async () => 3,
    killWindow: async (s: string) => { killed.push(s) },
    input: async () => {},
  }
  const { base, token, wsId } = await withTabsServer({ composerOps, failInsert: false })
  const r = await postRaw(base, `/workspaces/${wsId}/tabs`, { kind: "shell" }, token)
  expect(r.status).toBe(201)
  expect(killed).toEqual([]) // 成功不 kill
})
```

> `withTabsServer` helper：若同目录已有 http 测试装配（`withTestServer`/`buildApp`）复用之，注入 `composerOps` 与一个 `failInsert` 时 `insert` 抛 `SqliteError`（或既有 tagged error）的 `TabsRepo`。参照 `packages/server/test/` 现有 http 测试建立最小骨架。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/http.tabs.test.ts -t C12`
Expected: FAIL——现状 insert 失败只 `errorFromCause` 回错误码，`killWindow` 从不被调，window 3 成孤儿。

- [ ] **Step 3: 改 tabsCreate 成功回调补偿**

`packages/server/src/http/app.ts` 的 `POST /workspaces/:id/tabs` 段，把 `async (ws) => {…}` 里 `Exit.match` 的 `onFailure` 分支加补偿 kill：

```ts
            async (ws) => {
              try {
                const session = tmuxSessionName(ws.id)
                const idx = await composerOps.newShellWindow(session, ws.path)
                const exit = await runtime(Effect.gen(function* () {
                  return yield* (yield* TabsRepo).insert({ workspaceId: ws.id, kind: "shell", tmuxWindow: idx })
                }))
                await Exit.match(exit, {
                  onSuccess: async (tab) => { send(res, 201, tab) },
                  onFailure: async (cause) => {
                    // C12：DB 写失败但 tmux window 已建 → 补偿 kill，绝不留孤儿 window。
                    // 补偿本身 best-effort：即便 kill 失败也要回原始 DB 错误（不吞、不二次抛）。
                    try { await composerOps.killWindow(session, idx) } catch { /* best-effort：window 可能已不在 */ }
                    const { status, body } = errorFromCause(cause, onError)
                    send(res, status, body)
                  },
                })
              } catch (e: any) {
                // newShellWindow 抛：tmux 建窗本身失败，无 DB 写、无窗可 kill——直接回错。
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
```

> `Exit.match` 的 handler 现返回 `Promise`；`await Exit.match(...)` 顺序执行补偿。`tmuxSessionName` 顶部已 import（M1 现状 `app.ts:16`）。`send`/`err`/`errorFromCause` 均既有。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd packages/server && bun run vitest run test/http.tabs.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/app.ts packages/server/test/http.tabs.test.ts
git commit -m "fix(server): shell-tab create DB 写失败补偿 kill tmux window（C12）"
```

---

### Task 5: fan-out 分组元数据（`fanoutGroup` 贯通 create）

**Files:**
- Modify: `packages/server/src/workspace/lifecycle.ts`（`PostCreateContext` +fanoutGroup；create opts 透传 + 存 createCtx）
- Modify: `packages/server/src/http/app.ts`（`POST /workspaces` 读校验 body.fanoutGroup）
- Modify: `packages/server/src/repo/workspaces.ts`（`setCreateCtx`/`getCreateCtx` round-trip +`fanoutGroup`——**MED-2 的唯一 reader**：使写入非死值）
- Modify: `packages/protocol/src/routes.ts`（描述）
- Test: `packages/server/test/workspace.lifecycle.test.ts`（追加）、`packages/server/test/repo.workspaces.test.ts`（round-trip 读回，若无则新建/复用现有 repo 测试装配）

> **MED-2 决策（fanoutGroup 目前是 write-only seed，须给一个便宜的真 reader）**：`fanoutGroup` 写进 `workspaces.data.createCtx`，是**为未来分组 UI 预留的种子**（Plan 4 / M3 的 fan-out 分组视图会读它渲染「同组 workspace」）。为避免死值，本计划补上**唯一便宜的读回路径**：把 `repo.getCreateCtx` 扩为一并返回 `fanoutGroup`——这既是 reader（round-trip 测试断言写入可读回），**也顺带修一个潜伏 bug**：Task 5 原声称「retry 天然带上 fanoutGroup」，但现状 `getCreateCtx`（workspaces.ts:106–115）只挑 `initialPrompt`/`engineId` 返回、**会丢弃 fanoutGroup**，retry 回填其实拿不到——扩 `getCreateCtx` 后该声明才真正成立。
> **不走 GET /workspaces passthrough**（已核对代码）：`rowToWorkspace`（workspaces.ts:15–24）只把 `data.portBase` 投到 `Workspace` domain 对象，`Workspace` schema（protocol/domain.ts）**无 fanoutGroup 字段**；要让 GET /workspaces 列表带 fanoutGroup 须改 `Workspace` domain schema + 所有消费者——**非 trivial**，且违反本计划「无 schema/domain 变更」纪律，故**不做**，标 `TODO(Plan 4/M3)`：分组 UI 落地时再决定是否上 domain 字段还是走专门的 `GET /workspaces/:id/createCtx`。

**Interfaces:**
- Consumes: `PostCreateContext = { initialPrompt?; engineId? }`（Plan 1）、`repo.setCreateCtx`/`repo.getCreateCtx`（Plan 1）、`create` opts（Plan 1：`{ projectId; branchSlug?; name?; initialPrompt?; engineId? }`）。
- Produces:
  - `PostCreateContext = { readonly initialPrompt?; readonly engineId?; readonly fanoutGroup?: string }`。
  - `create` opts +`fanoutGroup?: string`；透传给 `provision` 的 ctx，并随 Plan 1 的 `setCreateCtx` 一并落 `workspaces.data.createCtx`（retry 对称）。
  - `repo.setCreateCtx`/`getCreateCtx` 的 ctx 类型 +`fanoutGroup?: string`，**round-trip**：写入即可经 `getCreateCtx` 读回（reader，令写入非死值；retry 回填由此真正带上 fanoutGroup）。
  - `POST /workspaces` 接受 `fanoutGroup?: string`（校验为 string），透传 `create`。

- [ ] **Step 1: 写失败测试**

`packages/server/test/workspace.lifecycle.test.ts` 追加（沿用 Plan 1 建立的 `setupLifecycle({ hook })` 捕获 ctx 的既有装配——同 Plan 1 C2 测试模式）：

```ts
it("create 带 fanoutGroup → ctx.fanoutGroup 透传给 provision（fan-out 分组元数据）", async () => {
  const seen: Array<{ initialPrompt?: string; engineId?: string; fanoutGroup?: string }> = []
  const { create } = await setupLifecycle({ hook: (_ws, ctx) => { seen.push({ ...ctx }); return okProvision() } })
  await create({ projectId: "p", engineId: "codex", fanoutGroup: "fo-abc" })
  expect(seen[0]?.fanoutGroup).toBe("fo-abc")
  expect(seen[0]?.engineId).toBe("codex")
})
```

**MED-2 reader 测试**——`packages/server/test/repo.workspaces.test.ts`（复用现有 repo 测试装配：mkdtemp `COOLIE_HOME` + `WorkspacesRepoLive`；seed 一个 creating workspace 取其 id）：

```ts
it("setCreateCtx/getCreateCtx round-trip fanoutGroup（写入非死值——分组 UI 种子的唯一 reader）", async () => {
  const { repo, wsId } = await withWorkspacesRepo() // seed 一个 workspace，返回其 id
  await run(repo.setCreateCtx(wsId, { initialPrompt: "hi", engineId: "codex", fanoutGroup: "fo-abc" }))
  const ctx = await run(repo.getCreateCtx(wsId))
  expect(ctx).toEqual({ initialPrompt: "hi", engineId: "codex", fanoutGroup: "fo-abc" })
})

it("getCreateCtx 无 fanoutGroup 时不返回该键（可选字段）", async () => {
  const { repo, wsId } = await withWorkspacesRepo()
  await run(repo.setCreateCtx(wsId, { engineId: "claude" }))
  const ctx = await run(repo.getCreateCtx(wsId))
  expect(ctx.fanoutGroup).toBeUndefined()
})
```

> `run` = 现有 repo 测试跑 Effect 的 helper（`Effect.runPromise` + repo layer 提供）；`withWorkspacesRepo` 参照同目录既有 repo 测试装配建最小骨架（若已有则复用）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun run vitest run test/workspace.lifecycle.test.ts -t fanoutGroup`
Expected: FAIL——`create` opts 无 `fanoutGroup`，`PostCreateContext` 无该字段，ctx 里读不到。

- [ ] **Step 3: 扩 PostCreateContext + create opts + 透传**

`packages/server/src/workspace/lifecycle.ts`：

```ts
export interface PostCreateContext {
  readonly initialPrompt?: string
  readonly engineId?: string
  readonly fanoutGroup?: string
}
```

`create` 的 opts 类型（Plan 1 已含 `engineId?`）加 `fanoutGroup?: string`；`setCreateCtx`（Plan 1 约 170–173 行存 `{ initialPrompt, engineId }`）与 `provision` 调用点一并带上：

```ts
        // Plan 1 已存 initialPrompt+engineId；本计划追加 fanoutGroup（retry 对称回填）
        yield* repo.setCreateCtx(ws.id, {
          ...(opts.initialPrompt !== undefined ? { initialPrompt: opts.initialPrompt } : {}),
          ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
          ...(opts.fanoutGroup !== undefined ? { fanoutGroup: opts.fanoutGroup } : {}),
        })
        return yield* provision(ws, project.repoRoot, {
          ...(opts.initialPrompt !== undefined ? { initialPrompt: opts.initialPrompt } : {}),
          ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
          ...(opts.fanoutGroup !== undefined ? { fanoutGroup: opts.fanoutGroup } : {}),
        }).pipe(/* 既有 error 映射 */)
```

> 以 Plan 1 落地的 `setCreateCtx`/`provision` 实际签名为准（若 `setCreateCtx` 存的是整个 `PostCreateContext`，直接把三字段传入即可）。retry 路径（Plan 1 从 createCtx 回填 ctx）**只有在下面 Step 3b 扩了 `getCreateCtx` 之后**才真正带上 fanoutGroup（现状 getCreateCtx 会丢弃它——见 MED-2 决策）。

- [ ] **Step 3b: 扩 repo `setCreateCtx`/`getCreateCtx` round-trip fanoutGroup（MED-2 reader + 修 retry 丢字段）**

`packages/server/src/repo/workspaces.ts`：`WorkspacesRepoShape` 的两处 ctx 类型加 `fanoutGroup?: string`；`setCreateCtx` 落库、`getCreateCtx` 读回都补 fanoutGroup（沿用现有可选字段 spread 风格）：

```ts
  // WorkspacesRepoShape 内（第 36–37 行两签名）：
  readonly setCreateCtx: (id: string, ctx: { initialPrompt?: string; engineId?: string; fanoutGroup?: string }) => Effect.Effect<void, NotFoundError>
  readonly getCreateCtx: (id: string) => Effect.Effect<{ initialPrompt?: string; engineId?: string; fanoutGroup?: string }, NotFoundError>
```

`setCreateCtx` 实现（第 100–103 行）追加 fanoutGroup 落库：

```ts
        data.createCtx = {
          ...(ctx.initialPrompt !== undefined ? { initialPrompt: ctx.initialPrompt } : {}),
          ...(ctx.engineId !== undefined ? { engineId: ctx.engineId } : {}),
          ...(ctx.fanoutGroup !== undefined ? { fanoutGroup: ctx.fanoutGroup } : {}),
        }
```

`getCreateCtx` 实现（第 110–114 行）读回 fanoutGroup（**这一处令 fanoutGroup 非死值——分组 UI 种子的唯一 reader，也令 retry 回填真正带上它**）：

```ts
        const c = (data.createCtx ?? {}) as { initialPrompt?: unknown; engineId?: unknown; fanoutGroup?: unknown }
        return {
          ...(typeof c.initialPrompt === "string" ? { initialPrompt: c.initialPrompt } : {}),
          ...(typeof c.engineId === "string" ? { engineId: c.engineId } : {}),
          ...(typeof c.fanoutGroup === "string" ? { fanoutGroup: c.fanoutGroup } : {}),
        }
```

> **确认 lifecycle 的 setCreateCtx 调用点**（Step 3）已把 `opts.fanoutGroup` 一并传入——否则写入端断链、reader 永远读到空。若 Plan 1 的 lifecycle 是把整个 ctx 对象传给 `setCreateCtx`，则 Step 3 的 spread 已覆盖，无需重复。

- [ ] **Step 4: http 读校验 body.fanoutGroup**

`packages/server/src/http/app.ts` 的 `POST /workspaces` 段（Plan 1 已加 engineId 校验），在 engineId 校验后加：

```ts
          if (body.fanoutGroup !== undefined && typeof body.fanoutGroup !== "string")
            return err(res, 400, "Validation", "fanoutGroup must be a string")
```

并在 `create({…})` 调用里加（紧随 Plan 1 的 `...(body.engineId ? {…} : {})`）：

```ts
                ...(body.fanoutGroup ? { fanoutGroup: body.fanoutGroup } : {}),
```

- [ ] **Step 5: 更新 protocol 路由描述**

`packages/protocol/src/routes.ts` 的 `POST /workspaces` 描述（Plan 1 已列 engineId）改为：

```ts
  { method: "POST", path: "/workspaces", description: "创建 workspace {projectId, engineId?, branchSlug?, name?, initialPrompt?, fanoutGroup?}（engineId 缺省 claude；fanoutGroup 为 fan-out 分组元数据；同步跑完流水线才返回）" },
```

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `cd packages/server && bun run vitest run test/workspace.lifecycle.test.ts test/repo.workspaces.test.ts && bun run typecheck && cd ../protocol && bun run typecheck`
Expected: PASS（含 fanoutGroup round-trip reader 测试）；双 typecheck 清洁。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/workspace/lifecycle.ts packages/server/src/http/app.ts packages/server/src/repo/workspaces.ts packages/protocol/src/routes.ts packages/server/test/workspace.lifecycle.test.ts packages/server/test/repo.workspaces.test.ts
git commit -m "feat(server): fan-out 分组元数据 fanoutGroup 贯通 create + createCtx round-trip reader（MED-2）"
```

---

### Task 6: `coolie create --agents` fan-out 执行 + 结果表

**Files:**
- Modify: `packages/cli/src/main.ts`（`create` 命令 +`--agents`；抽 `resolveProjectId` helper；fan-out 循环 + 结果表）
- Test: `packages/cli/test/fanout-e2e.test.ts`（沿用现有 CLI e2e 装配）

**Interfaces:**
- Consumes: `parseAgentsSpec`/`expandAgents`/`MAX_FANOUT`（Task 1）、`buildCoolieUrl`（Task 2）、`api`（`client.ts`）、`decodeWorkspace`、`fail`、server `GET /config`（校验 engineId）、`POST /workspaces {projectId, engineId, fanoutGroup, ...}`（Task 5）。
- Produces: `coolie create <projectIdOrPath> --agents <spec> [--slug] [--name] [--prompt]`——一次创建 N 个 workspace（跨引擎），每个独立生命周期；打印结果表（`#/engine/workspace id/status/coolie:// 链接`）+ 组 id；任一失败退出码非 0。无 `--agents` 时行为与 M1 单建完全不变。

- [ ] **Step 1: 写失败测试**

`packages/cli/test/fanout-e2e.test.ts`（沿用 `cli-e2e.test.ts` 的 `coolie(...args)` execFileSync 装配 + mkdtemp home/repo + `COOLIE_CLAUDE_CMD=cat`/`COOLIE_DISABLE_HOOKS=1`；`afterAll` `coolie("server","stop")` + tmux kill）：

```ts
it("create --agents claude:2 一次建 2 个 workspace（同引擎），输出含 2 条 coolie:// 链接", () => {
  const out = coolie("create", repoPath, "--agents", "claude:2", "--prompt", "hi")
  const links = out.split("\n").filter((l) => l.includes("coolie://workspace/"))
  expect(links.length).toBe(2)
  // list 确认真建了 2 个
  const list = coolie("list")
  expect((list.match(/\bactive\b/g) ?? []).length).toBeGreaterThanOrEqual(2)
})

it("create --agents 含未知引擎 → 非零退出且报可用引擎", () => {
  let code = 0; let msg = ""
  try { coolie("create", repoPath, "--agents", "bogus:1") } catch (e: any) { code = e.status ?? 1; msg = String(e.stderr ?? e.stdout ?? "") }
  expect(code).not.toBe(0)
  expect(msg).toMatch(/未知引擎|claude/)
})

it("无 --agents 时单建行为不变（回归）", () => {
  const out = coolie("create", repoPath, "--prompt", "solo")
  expect(out).toMatch(/[0-9a-f-]{8,}/) // 打印了 workspace id
})
```

> codex 冒烟不在自动化里跑真 codex（本机依赖）；`--agents claude:2` 用 `COOLIE_CLAUDE_CMD=cat` 假引擎即可覆盖 fan-out 循环。跨引擎（codex）留 Task 12 手工冒烟。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/cli && bun run vitest run test/fanout-e2e.test.ts`
Expected: FAIL——`create` 无 `--agents` option，commander 报未知选项或忽略。

- [ ] **Step 3: 抽 resolveProjectId + 改 create action**

`packages/cli/src/main.ts`：把现有 `create` action 里「路径/id → projectId」解析抽成 helper（供单建与 fan-out 共用），并加 `--agents`：

```ts
// create 顶部 import 追加
import { parseAgentsSpec, expandAgents, MAX_FANOUT } from "./fanout.js"
import { buildCoolieUrl } from "@coolie/protocol"

/** 把 <projectIdOrPath> 解析成 projectId（存在的路径 → 查/建 project；否则原样当 id）。 */
const resolveProjectId = async (projectIdOrPath: string): Promise<string> => {
  const abs = path.resolve(projectIdOrPath)
  if (fs.existsSync(abs)) {
    const projects = await api("GET", "/projects")
    const found = (projects as any[]).find((p) => p.repoRoot === abs)
    if (found) return found.id
    return (await api("POST", "/projects", { repoRoot: abs })).id
  }
  return projectIdOrPath
}
```

（`path`/`fs` 若 main.ts 未 import 则补 `import * as path from "node:path"` / `import * as fs from "node:fs"`——以现状为准。）

`create` 命令定义改为：

```ts
program
  .command("create")
  .argument("<projectIdOrPath>")
  .option("--slug <slug>")
  .option("--name <name>")
  .option("--prompt <prompt>")
  .option("--agents <spec>", "扇出到多引擎/多实例，如 claude:2,codex:1（一条 prompt 派发到多个 workspace）")
  .action(async (projectIdOrPath: string, opts: { slug?: string; name?: string; prompt?: string; agents?: string }) => {
    const projectId = await resolveProjectId(projectIdOrPath)
    if (!opts.agents) {
      // 单建（M1 行为不变）
      const ws = decodeWorkspace(await api("POST", "/workspaces", {
        projectId,
        ...(opts.slug ? { branchSlug: opts.slug } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.prompt ? { initialPrompt: opts.prompt } : {}),
      }))
      console.log(ws.id)
      return
    }
    // fan-out
    const specs = parseAgentsSpec(opts.agents)
    const flat = expandAgents(specs)
    if (flat.length > MAX_FANOUT) fail(`fan-out 实例数 ${flat.length} 超上限 ${MAX_FANOUT}`)
    const cfg = await api("GET", "/config")
    const known = new Set((cfg.engines as Array<{ id: string }>).map((e) => e.id))
    for (const s of specs)
      if (!known.has(s.engineId)) fail(`未知引擎 '${s.engineId}'，可用：${[...known].join(", ")}`)
    const groupId = `fo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const rows: Array<{ n: number; engine: string; id: string; status: string; link: string }> = []
    let failed = 0
    for (let i = 0; i < flat.length; i++) {
      const engineId = flat[i]!
      // slug 唯一化：给了 --slug 且多实例时逐个加后缀，避免 branch 撞名
      const branchSlug = opts.slug ? (flat.length > 1 ? `${opts.slug}-${i + 1}` : opts.slug) : undefined
      try {
        const ws = decodeWorkspace(await api("POST", "/workspaces", {
          projectId, engineId, fanoutGroup: groupId,
          ...(branchSlug ? { branchSlug } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.prompt ? { initialPrompt: opts.prompt } : {}),
        }))
        rows.push({ n: i + 1, engine: engineId, id: ws.id, status: "created", link: buildCoolieUrl({ kind: "workspace", workspaceId: ws.id }) })
      } catch (e: any) {
        failed++
        rows.push({ n: i + 1, engine: engineId, id: "-", status: `failed: ${e?.message ?? e}`, link: "-" })
      }
    }
    // 结果表
    console.log(`fan-out group ${groupId}（${flat.length - failed}/${flat.length} 成功）`)
    for (const r of rows)
      console.log(`  ${String(r.n).padEnd(3)}${r.engine.padEnd(8)}${r.id.padEnd(38)}${r.status.padEnd(10)}${r.link}`)
    if (failed > 0) process.exit(1)
  })
```

> **部分失败纪律**：fan-out 是 N 次独立 create，某个失败不回滚已成功者（roadmap：各 workspace 独立生命周期）；失败行照列（含错误信息），末尾任一失败 → `process.exit(1)`，成功的 workspace 已在库里（左栏 error 项可 Retry / `coolie delete` 清理）。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd packages/cli && bun run vitest run test/fanout-e2e.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁（`@coolie/protocol` 已导出 `buildCoolieUrl`——Task 2）。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/test/fanout-e2e.test.ts
git commit -m "feat(cli): coolie create --agents fan-out（多 workspace 派发 + 结果表 + coolie:// 链接）"
```

---

### Task 7: `coolie link` 生成/打开 deep link

**Files:**
- Modify: `packages/cli/src/main.ts`（+`link` 子命令）
- Test: `packages/cli/test/link.test.ts`

**Interfaces:**
- Consumes: `buildCoolieUrl`（Task 2）、`spawnSync`（macOS `open`）。
- Produces: `coolie link <wsId> [--tab <tabId>] [--open]`——打印 `coolie://workspace/<wsId>[/tab/<tabId>]`；`--open` 用 macOS `open` 交给系统处理器（拉起/聚焦 GUI）。不触网、不需 server（纯 URL 生成）。

- [ ] **Step 1: 写失败测试**

`packages/cli/test/link.test.ts`（`link` 不依赖 server，可直接 `coolie("link", ...)`；但 `coolie(...)` helper 仍带测试 env，无害）：

```ts
it("link 打印 workspace 深链", () => {
  const out = coolie("link", "w1").trim()
  expect(out).toBe("coolie://workspace/w1")
})
it("link --tab 打印 workspace/tab 深链", () => {
  const out = coolie("link", "w1", "--tab", "t2").trim()
  expect(out).toBe("coolie://workspace/w1/tab/t2")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/cli && bun run vitest run test/link.test.ts`
Expected: FAIL——`link` 子命令不存在，commander `showHelpAfterError` 报未知命令、非零退出。

- [ ] **Step 3: 加 link 子命令**

`packages/cli/src/main.ts`（`spawnSync` 已在 `enter`/`open` 用过，已 import）：

```ts
program
  .command("link")
  .description("生成 workspace/tab 的 coolie:// deep link（--open 交系统处理器打开）")
  .argument("<wsId>")
  .option("--tab <tabId>")
  .option("--open", "用系统默认处理器打开链接（macOS：open）")
  .action((wsId: string, opts: { tab?: string; open?: boolean }) => {
    const url = buildCoolieUrl({ kind: "workspace", workspaceId: wsId, ...(opts.tab ? { tabId: opts.tab } : {}) })
    console.log(url)
    if (opts.open) {
      const r = spawnSync("open", [url], { stdio: "inherit" })
      if (r.status !== 0) fail("open 失败（macOS 专用；确认 Coolie.app 已安装并注册 coolie:// scheme）")
    }
  })
```

（`buildCoolieUrl` 已在 Task 6 Step 3 import；若按 task 顺序 T7 单独执行，确认 `import { buildCoolieUrl } from "@coolie/protocol"` 在场。）

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd packages/cli && bun run vitest run test/link.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/test/link.test.ts
git commit -m "feat(cli): coolie link 生成/打开 coolie:// deep link"
```

---

### Task 8: deep-link 端到端——Tauri 插件接线 + client `onOpenUrl` 路由

**Files:**
- Create: `packages/client/src/deeplink.ts`
- Modify: `packages/client/src/App.tsx`（bootstrap effect 内 getCurrent + onOpenUrl 接线）
- Modify: `packages/client/package.json`（+`@tauri-apps/plugin-deep-link`）
- Modify: `packages/client/src-tauri/Cargo.toml`（+`tauri-plugin-deep-link`）
- Modify: `packages/client/src-tauri/tauri.conf.json`（schemes + bundle）
- Modify: `packages/client/src-tauri/src/main.rs`（`.plugin(...)`）
- Modify: `packages/client/src-tauri/capabilities/default.json`（+`deep-link:default`）
- Test: `packages/client/test/deeplink.test.ts`

**Interfaces:**
- Consumes: `parseCoolieUrl`/`CoolieLinkTarget`（Task 2）、`useUi.selectWs`/`useUi.selectTab`/`useUi.setDispatchMode`（现状 store）、`@tauri-apps/plugin-deep-link` 的 `getCurrent`/`onOpenUrl`。
- Produces:
  - `interface DeepLinkRouter { selectWs; selectTab; openProjectDispatch }`
  - `routeCoolieUrl(raw: string, r: DeepLinkRouter): boolean`——parse 成功则派发到对应 UI 动作，返回是否命中。
  - App 启动时 `getCurrent()`（冷启动带 URL）+ 运行期 `onOpenUrl`（热触发）都路由；macOS scheme `coolie` 注册。

- [ ] **Step 1: 写失败测试**（纯路由逻辑，node-safe）

`packages/client/test/deeplink.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest"
import { routeCoolieUrl } from "../src/deeplink.js"

const mkRouter = () => ({
  selectWs: vi.fn(), selectTab: vi.fn(), openProjectDispatch: vi.fn(),
})

describe("routeCoolieUrl", () => {
  it("workspace → selectWs", () => {
    const r = mkRouter()
    expect(routeCoolieUrl("coolie://workspace/w1", r)).toBe(true)
    expect(r.selectWs).toHaveBeenCalledWith("w1")
    expect(r.selectTab).not.toHaveBeenCalled()
  })
  it("workspace/tab → selectWs + selectTab", () => {
    const r = mkRouter()
    expect(routeCoolieUrl("coolie://workspace/w1/tab/t2", r)).toBe(true)
    expect(r.selectWs).toHaveBeenCalledWith("w1")
    expect(r.selectTab).toHaveBeenCalledWith("w1", "t2")
  })
  it("project → openProjectDispatch", () => {
    const r = mkRouter()
    expect(routeCoolieUrl("coolie://project/p3", r)).toBe(true)
    expect(r.openProjectDispatch).toHaveBeenCalledWith("p3")
  })
  it("畸形 → false，不派发", () => {
    const r = mkRouter()
    expect(routeCoolieUrl("https://evil/x", r)).toBe(false)
    expect(r.selectWs).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client && bun run vitest run test/deeplink.test.ts`
Expected: FAIL——`deeplink.ts` 不存在。

- [ ] **Step 3: 实现 deeplink.ts**

```ts
import { parseCoolieUrl } from "@coolie/protocol"

export interface DeepLinkRouter {
  readonly selectWs: (wsId: string) => void
  readonly selectTab: (wsId: string, tabId: string) => void
  readonly openProjectDispatch: (projectId: string) => void
}

/** 把 coolie:// 深链路由到 UI 动作。命中返回 true，畸形/未知返回 false（不派发任何动作）。 */
export const routeCoolieUrl = (raw: string, r: DeepLinkRouter): boolean => {
  const t = parseCoolieUrl(raw)
  if (t === null) return false
  switch (t.kind) {
    case "workspace":
      r.selectWs(t.workspaceId)
      if (t.tabId !== undefined) r.selectTab(t.workspaceId, t.tabId)
      return true
    case "project":
      r.openProjectDispatch(t.projectId)
      return true
  }
}
```

- [ ] **Step 4: 跑纯逻辑测试确认通过**

Run: `cd packages/client && bun run vitest run test/deeplink.test.ts`
Expected: PASS。

- [ ] **Step 5: 装 npm 插件**

`packages/client/package.json` 的 `dependencies` 加 `"@tauri-apps/plugin-deep-link": "^2"`（对齐 `@tauri-apps/api` 大版本），然后：

Run: `cd /Users/outman/workspace/ai/personal_ai/Coolie && bun install`

- [ ] **Step 6: App.tsx 接线 getCurrent + onOpenUrl**

`packages/client/src/App.tsx` 顶部 import 追加：

```ts
import { getCurrent as getCurrentDeepLink, onOpenUrl } from "@tauri-apps/plugin-deep-link"
import { routeCoolieUrl, type DeepLinkRouter } from "./deeplink"
```

在 bootstrap `useEffect` 内（`started.current = true` 之后、`void (async () => {…})()` 之前或之内均可；下面接在 async IIFE 成功链末尾，且把 unlisten 纳入 cleanup）。新增一个 `let stopDeepLink` 与既有 `stopSse`/`stopLease` 并列，并在 async 体尾部加：

```ts
    let stopDeepLink: (() => void) | null = null
    // …既有 stopSse/stopLease 声明…
    void (async () => {
      try {
        // …既有 ensureServer/bootstrap/lease/sse…
        const router: DeepLinkRouter = {
          selectWs: (id) => useUi.getState().selectWs(id),
          selectTab: (ws, tab) => useUi.getState().selectTab(ws, tab),
          openProjectDispatch: (pid) => useUi.getState().setDispatchMode(true, pid),
        }
        const handle = (urls: string[] | null) => { for (const u of urls ?? []) routeCoolieUrl(u, router) }
        // 冷启动：app 由 coolie:// 拉起
        void getCurrentDeepLink().then(handle).catch(() => {})
        // 运行期：app 已开着再来一条链接
        stopDeepLink = await onOpenUrl(handle)
      } catch (e: any) {
        setBootErr(e?.message ?? String(e))
      }
    })()
    return () => { stopSse?.(); stopLease?.(); stopDeepLink?.() }
```

> `onOpenUrl` 返回 `Promise<UnlistenFn>`；存入 `stopDeepLink` 并在 effect cleanup 调用。deep-link 失败绝不阻断 boot（`.catch(()=>{})`）——非 Tauri 环境（纯 vite dev/浏览器）`getCurrent`/`onOpenUrl` 可能 reject，吞掉即可。
>
> **⚠ LOW-4 测试边界（明示，非遗漏）**：本 Step 的 App.tsx 胶水（`getCurrent`→`handle`、`onOpenUrl`→`stopDeepLink`、`router` 三方法接 `useUi.getState()`、cleanup 调 unlisten）**不进自动化测试**——它是纯 Tauri 运行期接线（真插件事件 + 真 store 单例），vitest（node env、无 Tauri、无真 DOM）无法忠实驱动。可测面已尽数下沉到纯函数 `routeCoolieUrl`（Step 1 钉死 parse→派发的全部分支）；App.tsx 只是把 `routeCoolieUrl` 挂到插件事件与 store 上的**薄胶水**，其正确性由 `cargo check`（Step 9，编译期证插件/类型解析）+ **Task 12 手工冒烟第 3/4 项**（冷启动 getCurrent 路由、运行期 onOpenUrl 聚焦、畸形 URL 不崩）兜底。刻意不为此薄胶水引入 jsdom + Tauri mock 的重装配——收益不抵维护成本。

- [ ] **Step 7: Tauri 插件注册（Rust）**

`packages/client/src-tauri/Cargo.toml` 的 `[dependencies]` 加：

```toml
tauri-plugin-deep-link = "2"
```

`packages/client/src-tauri/src/main.rs` 的 `tauri::Builder::default()` 链上加 `.plugin(...)`（放在 `.invoke_handler(...)` 之前或之后皆可，惯例在 setup 前）：

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![read_server_info, spawn_detached, binary_on_path])
        .setup(|app| { /* 既有 vibrancy + 菜单 */ Ok(()) })
        .run(tauri::generate_context!())
        .expect("error while running coolie client");
```

- [ ] **Step 8: scheme 注册（conf）+ capability**

`packages/client/src-tauri/tauri.conf.json`：加顶层 `plugins.deep-link.desktop.schemes`，并把 `bundle` 打开（scheme 的 macOS 注册在 bundle 的 Info.plist CFBundleURLTypes 里生成，需 `active:true` + macOS bundle 目标）：

```json
  "plugins": {
    "deep-link": {
      "desktop": { "schemes": ["coolie"] }
    }
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "macOS": { "minimumSystemVersion": "12.0" }
  }
```

（替换现状 `"bundle": { "active": false }`；`identifier` 保持 `app.coolie.client`。）

`packages/client/src-tauri/capabilities/default.json` 的 `permissions` 数组追加 `"deep-link:default"`（与既有 `core:default` 等并列）。

- [ ] **Step 9: Rust 编译 + client typecheck**

Run: `cd packages/client/src-tauri && cargo check`
Expected: 成功（deep-link 插件 crate 解析、`init()` 存在）。

Run: `cd packages/client && bun run typecheck`
Expected: 清洁（`@tauri-apps/plugin-deep-link` 类型解析、App.tsx 接线过 tsc）。

> Rust deep-link **运行时**行为无法在 vitest 覆盖；纯路由（`routeCoolieUrl`）由 Step 1 钉死，插件接线由 `cargo check` + Task 12 手工冒烟（安装到 `/Applications` 后 `coolie link <id> --open`）验证。

- [ ] **Step 10: Commit**

```bash
git add packages/client/src/deeplink.ts packages/client/src/App.tsx packages/client/package.json packages/client/src-tauri/Cargo.toml packages/client/src-tauri/tauri.conf.json packages/client/src-tauri/src/main.rs packages/client/src-tauri/capabilities/default.json packages/client/test/deeplink.test.ts
git commit -m "feat(client): coolie:// deep link 端到端（tauri-plugin-deep-link + onOpenUrl 路由）"
```

---

### Task 9: 外部终端可配置——`openInTerminal` + 终端选择器 + terminal store

**Files:**
- Create: `packages/client/src/stores/terminal.ts`
- Modify: `packages/client/src/terminal/TabsBar.tsx`（`openInIterm` → `openInTerminal` 消费 terminals.ts + store；工具栏加终端选择器）
- Test: `packages/client/test/terminal-store.test.ts`

**Interfaces:**
- Consumes: `buildTerminalLaunch`/`TerminalId`（Task 3）、`invoke("spawn_detached", {program, args})`（现有 Rust command）、`useData(s=>s.config)`（tmuxSocket）。
- Produces:
  - `useTerminal` store：`terminalApp: TerminalId`、`customTemplate: string`、`setTerminalApp`、`setCustomTemplate`（localStorage 持久化，node 环境降级内存）。
  - `openInTerminal(tmuxSocket, wsId, id, customTemplate?): Promise<void>`——`buildTerminalLaunch` → `invoke("spawn_detached", …)`。
  - TabsBar 的「Open in iTerm2」按钮换成「Open in <terminal>」+ 一个 `<select>` 选终端 app。

- [ ] **Step 1: 写失败测试**（store 纯状态迁移，node-safe：`localStorage` 未定义时降级内存）

`packages/client/test/terminal-store.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { useTerminal, coerceTerminalId } from "../src/stores/terminal.js"

describe("useTerminal", () => {
  it("默认 iterm2，setTerminalApp 切换", () => {
    expect(useTerminal.getState().terminalApp).toBe("iterm2")
    useTerminal.getState().setTerminalApp("terminal")
    expect(useTerminal.getState().terminalApp).toBe("terminal")
  })
  it("customTemplate 可设", () => {
    useTerminal.getState().setCustomTemplate("open -na WezTerm --args start -- sh -lc {cmd}")
    expect(useTerminal.getState().customTemplate).toContain("{cmd}")
  })
})

// LOW-3：持久化脏值校验（纯函数直测，node-safe，不依赖 localStorage）
describe("coerceTerminalId", () => {
  it("已知值原样返回", () => {
    expect(coerceTerminalId("iterm2")).toBe("iterm2")
    expect(coerceTerminalId("terminal")).toBe("terminal")
    expect(coerceTerminalId("custom")).toBe("custom")
  })
  it("未知/脏值（旧版本枚举、null、非串）回落默认 iterm2", () => {
    expect(coerceTerminalId("wezterm")).toBe("iterm2")   // 未来可能新增但当前未知
    expect(coerceTerminalId(null)).toBe("iterm2")         // localStorage.getItem 缺键
    expect(coerceTerminalId(42)).toBe("iterm2")           // 非串脏值
    expect(coerceTerminalId(undefined)).toBe("iterm2")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client && bun run vitest run test/terminal-store.test.ts`
Expected: FAIL——`stores/terminal.js` 不存在。

- [ ] **Step 3: 实现 terminal store**

```ts
import { create } from "zustand"
import type { TerminalId } from "../terminal/terminals.js"

// node 测试环境无 localStorage：降级为 null（内存态），生产/浏览器持久化。
const ls = typeof localStorage !== "undefined" ? localStorage : null
const K_APP = "coolie.terminalApp"
const K_TMPL = "coolie.terminalCustom"

const TERMINAL_IDS: readonly TerminalId[] = ["iterm2", "terminal", "custom"]
/** LOW-3：localStorage 里的 terminalApp 可能是旧版本/被手改的脏值——未知值一律回落默认 iterm2，绝不把脏值塞进 store。 */
export const coerceTerminalId = (v: unknown): TerminalId =>
  typeof v === "string" && (TERMINAL_IDS as readonly string[]).includes(v) ? (v as TerminalId) : "iterm2"

interface TerminalState {
  readonly terminalApp: TerminalId
  readonly customTemplate: string
  readonly setTerminalApp: (id: TerminalId) => void
  readonly setCustomTemplate: (t: string) => void
}

export const useTerminal = create<TerminalState>((set) => ({
  terminalApp: coerceTerminalId(ls?.getItem(K_APP)), // 校验持久化值，未知回落 iterm2
  customTemplate: ls?.getItem(K_TMPL) ?? "",
  setTerminalApp: (id) => { const safe = coerceTerminalId(id); ls?.setItem(K_APP, safe); set({ terminalApp: safe }) },
  setCustomTemplate: (t) => { ls?.setItem(K_TMPL, t); set({ customTemplate: t }) },
}))
```

- [ ] **Step 4: TabsBar 换 openInTerminal + 选择器**

`packages/client/src/terminal/TabsBar.tsx`：删掉文件内 `SHELL_SAFE`+`openInIterm`（逻辑已归 Task 3 `terminals.ts`），改为消费 `terminals.ts` + store。顶部 import 调整：

```ts
import { buildTerminalLaunch, type TerminalId } from "./terminals"
import { useTerminal } from "../stores/terminal"
// invoke 仍需（spawn_detached）
```

新增 `openInTerminal`（薄封装 invoke，导出以便手测；纯组装在 terminals.ts 已测）：

```ts
export const openInTerminal = async (
  tmuxSocket: string, wsId: string, id: TerminalId, customTemplate?: string,
): Promise<void> => {
  const { program, args } = buildTerminalLaunch(id, tmuxSocket, wsId, customTemplate)
  await invoke("spawn_detached", { program, args })
}
```

`CenterArea` 内读 store 与 config，替换工具栏按钮块（现状 `↗ Open in iTerm2` 单按钮，约 87–91 行）：

```tsx
        {(() => {
          const terminalApp = useTerminal((s) => s.terminalApp)
          const customTemplate = useTerminal((s) => s.customTemplate)
          const label = terminalApp === "iterm2" ? "iTerm2" : terminalApp === "terminal" ? "Terminal" : "自定义终端"
          return (
            <div className="term-open-group">
              <select
                className="term-picker"
                value={terminalApp}
                onChange={(e) => useTerminal.getState().setTerminalApp(e.target.value as TerminalId)}
                title="选择外部终端 app"
              >
                <option value="iterm2">iTerm2</option>
                <option value="terminal">Terminal.app</option>
                <option value="custom">自定义…</option>
              </select>
              <button
                className="iterm-btn"
                title={`在 ${label} 中打开（同一 tmux 会话）`}
                onClick={() =>
                  config && void openInTerminal(config.tmuxSocket, wsId, terminalApp, customTemplate).catch((e) => alert(e.message))
                }
              >↗ Open in {label}</button>
            </div>
          )
        })()}
```

> 自定义模板的编辑入口（一个 text input，写 `useTerminal.setCustomTemplate`）可放设置面板；本 task 最小化：选 `custom` 但模板为空时点击会因 `buildTerminalLaunch` 抛「须含 {cmd}」被 `alert` 提示（已测该抛错路径）。模板编辑 UI 细化留 Plan 4 设置面板。

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd packages/client && bun run vitest run test/terminal-store.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁（TabsBar 现引 terminals.ts/store）。

> 若既有 `packages/client/test/` 有测 `openInIterm` 的用例，它已随 helper 迁移——同步改为 import `buildTerminalLaunch`/`openInTerminal`（Task 3 测已覆盖组装，TabsBar 侧的 openInTerminal 是薄 invoke 封装）。grep `openInIterm` 全量确认无悬空引用（App/别处未引它）。

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/stores/terminal.ts packages/client/src/terminal/TabsBar.tsx packages/client/test/terminal-store.test.ts
git commit -m "feat(client): 可配置外部终端（iTerm2/Terminal.app/自定义）+ openInTerminal"
```

---

### Task 10: 外部终端模式（per-workspace）——GUI 不挂内嵌终端、引导 attach

**Files:**
- Modify: `packages/client/src/stores/terminal.ts`（+`externalByWs` + `toggleExternal`/`isExternal`）
- Modify: `packages/client/src/terminal/TabsBar.tsx`（`CenterArea` 外部模式占位 + 切换按钮）
- Test: `packages/client/test/terminal-store.test.ts`（追加外部模式用例）

**Interfaces:**
- Consumes: `useTerminal`（Task 9）、`buildAttachCommand`（Task 3，显示 attach 命令文本）、`openInTerminal`（Task 9）。
- Produces:
  - store：`externalByWs: Record<string, boolean>`、`toggleExternal(wsId)`、`isExternal(wsId): boolean`（localStorage 持久化 per workspace）。
  - `CenterArea`：当 `isExternal(wsId)` 为真，`term-stack` 渲染引导占位（attach 命令文本 + 「在外部终端打开」按钮 + 「回内嵌」切换），**不挂 `TerminalView`**（不起 node-pty WS）——即 spec §十三「外部终端模式（不开 GUI 终端、引导 iTerm2 attach 的工作流）」。

- [ ] **Step 1: 写失败测试**

`packages/client/test/terminal-store.test.ts` 追加：

```ts
it("外部模式 per-workspace 开关", () => {
  const s = useTerminal.getState()
  expect(s.isExternal("wX")).toBe(false)
  s.toggleExternal("wX")
  expect(useTerminal.getState().isExternal("wX")).toBe(true)
  useTerminal.getState().toggleExternal("wX")
  expect(useTerminal.getState().isExternal("wX")).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client && bun run vitest run test/terminal-store.test.ts -t 外部模式`
Expected: FAIL——`isExternal`/`toggleExternal` 未定义。

- [ ] **Step 3: store 加 externalByWs**

`packages/client/src/stores/terminal.ts`：加 key + 字段 + 两方法：

```ts
const K_EXT = "coolie.externalTermByWs"
const readExt = (): Record<string, boolean> => {
  try { return JSON.parse(ls?.getItem(K_EXT) ?? "{}") } catch { return {} }
}
```

`TerminalState` 追加：

```ts
  readonly externalByWs: Record<string, boolean>
  readonly toggleExternal: (wsId: string) => void
  readonly isExternal: (wsId: string) => boolean
```

`create` 体追加：

```ts
  externalByWs: readExt(),
  toggleExternal: (wsId) => set((s) => {
    const next = { ...s.externalByWs, [wsId]: !s.externalByWs[wsId] }
    ls?.setItem(K_EXT, JSON.stringify(next))
    return { externalByWs: next }
  }),
  isExternal: (wsId) => get().externalByWs[wsId] === true,
```

（`create<TerminalState>((set, get) => ({…}))`——加 `get` 形参。）

- [ ] **Step 4: CenterArea 外部模式占位**

`packages/client/src/terminal/TabsBar.tsx` 的 `CenterArea`：在 `term-stack` 渲染前判断外部模式。顶部 import 加 `buildAttachCommand`。在 `return (...)` 的 `<div className="term-stack">` 处改为条件：

```tsx
      {useTerminal((s) => s.isExternal(wsId)) ? (
        <div className="term-external">
          <p className="dim">外部终端模式：GUI 不挂内嵌终端，请用外部终端 attach 同一 tmux 会话。</p>
          {config && <code className="attach-cmd">{buildAttachCommand(config.tmuxSocket, wsId)}</code>}
          <div className="term-external-actions">
            <button className="btn" onClick={() =>
              config && void openInTerminal(config.tmuxSocket, wsId,
                useTerminal.getState().terminalApp, useTerminal.getState().customTemplate).catch((e) => alert(e.message))
            }>在外部终端打开</button>
            <button onClick={() => useTerminal.getState().toggleExternal(wsId)}>回内嵌终端</button>
          </div>
        </div>
      ) : (
        <div className="term-stack">
          {/* …既有惰性挂载 TerminalView 列表不变… */}
        </div>
      )}
```

并在工具栏（Task 9 的 `term-open-group` 旁）加一个模式切换按钮：

```tsx
              <button
                className="term-mode-toggle"
                title="切换外部终端模式（不挂内嵌终端）"
                onClick={() => useTerminal.getState().toggleExternal(wsId)}
              >{useTerminal((s) => s.isExternal(wsId)) ? "内嵌" : "外部"}</button>
```

> 外部模式为真时不渲染 `TerminalView` → 不建 node-pty attach WS（server 侧 refcount 不增），正是「不开 GUI 终端」。惰性挂载的 `viewed` 集合不受影响；切回内嵌时按原逻辑重新挂载。

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd packages/client && bun run vitest run test/terminal-store.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁。

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/stores/terminal.ts packages/client/src/terminal/TabsBar.tsx packages/client/test/terminal-store.test.ts
git commit -m "feat(client): 外部终端模式 per-workspace（不挂内嵌终端 + attach 引导）"
```

---

### Task 11: GUI Dispatch fan-out 多选（引擎×实例）

> **⚠⚠ 硬依赖横幅（binding controller decision）：本 Task 在 Plan 4 Task 1 合入 main 之后执行。**
> `Dispatch.tsx` 的 canonical owner 是 **Plan 4 Task 1**（整体重写：引擎/模型/effort 三选择器 + 导出纯函数 `buildCreateBody({projectId, engineId, prompt, effort, model}): Record<string,string>`）。本 Task **不重写 Dispatch、不与 Plan-4-T1 并发**——它在重写后的形态之上**叠加** fan-out 多选：复用 `buildCreateBody` 生成每个 workspace 的 body（继承所选 effort/model），把 fan-out 展开与总量 cap 收进纯可测核心。调度：把本 Task 排入 Wave D'（Plan-4-T1 merge 之后），或先跑完 Plan 4 再回来。**执行前先确认 `Dispatch.tsx` 已含 `export const buildCreateBody` 与 `engineId/model/effort` 选择态**；若尚未，STOP——依赖未满足。

**Files:**
- Modify: `packages/client/src/composer/Dispatch.tsx`（在 Plan-4-T1 重写后的 `DispatchPanel` 上叠加 fan-out 多选状态 + 循环创建 + 总量 cap）
- Test: `packages/client/test/dispatch-fanout.test.ts`

**Interfaces:**
- Consumes: **`buildCreateBody`（Plan 4 Task 1 导出，同文件）**、`MAX_FANOUT`（`@coolie/protocol`，与 CLI 同一常量——MED-1）、`useData(s=>s.config?.engines)`、`api.req("POST", "/workspaces", body)`（body 含 Task 5 的 `fanoutGroup`）、`useUi.selectWs`。
- Produces:
  - `fanoutTotal(counts: Record<string, number>): number`——纯函数，counts 求和（cap 判定与计数提示共用）。
  - `buildFanoutRequests(base: FanoutBase, counts: Record<string, number>, groupId: string): Array<Record<string, string>>`——**3 参**纯函数（与实现同参数——LOW-2）：对每个 `count>0` 的引擎逐实例调用 `buildCreateBody` 得 body，再叠加 `fanoutGroup: groupId`；返回 N 个请求 body。`FanoutBase = { projectId; prompt; effort: string; model: string }`（effort/model 取当前选择器值，全实例统一）。
  - `submit` 分流：`fanoutTotal===0` → 走 Plan-4-T1 原单建（`buildCreateBody` 单发）；否则循环 `api.req` 提交 N 个（各独立生命周期，选中首个成功者，部分失败按行报告）。
  - **MED-1 总量 cap**：`fanoutTotal(counts) > MAX_FANOUT` 时 submit 直接拒绝并置错，且**提交按钮 disabled + 计数提示**（`将创建 X 个（上限 MAX_FANOUT）`；超限显式红字）。UI 加 per-engine 计数 stepper。单实例（默认全 0）行为与 Plan-4-T1 单建完全不变。

- [ ] **Step 1: 写失败测试**（抽纯函数测 fan-out 请求构造 + cap，避免依赖真 api/DOM）

`packages/client/test/dispatch-fanout.test.ts`（`buildFanoutRequests` 消费 `buildCreateBody`——Plan-4-T1 已导出于同文件，测试直接 import 二者所在模块）：

```ts
import { describe, it, expect } from "vitest"
import { buildFanoutRequests, fanoutTotal } from "../src/composer/Dispatch.js"
import { MAX_FANOUT } from "@coolie/protocol"

const base = { projectId: "p1", prompt: "hi", effort: "default", model: "default" }

describe("buildFanoutRequests（消费 Plan-4-T1 的 buildCreateBody + 叠加 fanoutGroup）", () => {
  it("按 counts 展开成逐实例请求，带 engineId+fanoutGroup+initialPrompt", () => {
    const reqs = buildFanoutRequests(base, { claude: 2, codex: 1 }, "fo-x")
    expect(reqs).toHaveLength(3)
    expect(reqs.filter((r) => r.engineId === "claude")).toHaveLength(2)
    expect(reqs.every((r) => r.projectId === "p1" && r.fanoutGroup === "fo-x" && r.initialPrompt === "hi")).toBe(true)
  })
  it("effort 经 buildCreateBody 贯通（codex high 进 body）", () => {
    const reqs = buildFanoutRequests({ ...base, effort: "high" }, { codex: 1 }, "fo-x")
    expect(reqs[0]?.effort).toBe("high")
  })
  it("count 为 0 的引擎被跳过", () => {
    expect(buildFanoutRequests(base, { claude: 1, codex: 0 }, "fo-x")).toHaveLength(1)
  })
  it("全 0 → 空（调用方回退单建）", () => {
    expect(buildFanoutRequests(base, { claude: 0 }, "fo-x")).toHaveLength(0)
  })
})

describe("fanoutTotal + MED-1 总量 cap", () => {
  it("counts 求和", () => {
    expect(fanoutTotal({ claude: 2, codex: 1 })).toBe(3)
    expect(fanoutTotal({})).toBe(0)
  })
  it("超 MAX_FANOUT 可判定（submit 据此拒绝并 disable 按钮）", () => {
    const over = { claude: MAX_FANOUT, codex: 1 }
    expect(fanoutTotal(over)).toBeGreaterThan(MAX_FANOUT)
    const atCap: Record<string, number> = { claude: MAX_FANOUT }
    expect(fanoutTotal(atCap)).toBe(MAX_FANOUT) // 恰等上限不算超
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client && bun run vitest run test/dispatch-fanout.test.ts`
Expected: FAIL——`buildFanoutRequests`/`fanoutTotal` 未导出。

- [ ] **Step 3: 抽纯函数 + 叠加进 Plan-4-T1 的 submit**

`packages/client/src/composer/Dispatch.tsx` 顶部（`buildCreateBody` 已由 Plan-4-T1 定义于此）追加导出纯函数；`import { MAX_FANOUT } from "@coolie/protocol"`：

```ts
export interface FanoutBase {
  readonly projectId: string
  readonly prompt: string
  readonly effort: string
  readonly model: string
}

/** counts 求和（cap 判定 + 计数提示共用）。 */
export const fanoutTotal = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((a, b) => a + (b > 0 ? b : 0), 0)

/** 把「引擎→实例数」映射展开成逐实例创建请求：每实例复用 Plan-4-T1 的 buildCreateBody（继承 effort/model），
 *  再叠加 fanoutGroup。count>0 才纳入，保持插入顺序。3 参与调用点一致。 */
export const buildFanoutRequests = (
  base: FanoutBase,
  counts: Record<string, number>,
  groupId: string,
): Array<Record<string, string>> => {
  const out: Array<Record<string, string>> = []
  for (const [engineId, n] of Object.entries(counts))
    for (let i = 0; i < n; i++)
      out.push({
        ...buildCreateBody({ projectId: base.projectId, engineId, prompt: base.prompt, effort: base.effort, model: base.model }),
        fanoutGroup: groupId,
      })
  return out
}
```

`DispatchPanel`（Plan-4-T1 形态：已有 `engineId`/`engine`/`model`/`effort`/`creating`/`err` 状态与 `submit`）内加 fan-out 计数状态与 cap，并把既有 `submit` 分流为「单建 vs fan-out」：

```ts
  const [counts, setCounts] = useState<Record<string, number>>({})
  const totalFanout = fanoutTotal(counts)
  const overCap = totalFanout > MAX_FANOUT   // MED-1：超上限即禁提交

  const submit = (prompt: string): void => {
    const api = useData.getState().getApi()
    if (!api || !projectId || !engine || creating) return
    if (overCap) { setErr(`fan-out 实例数 ${totalFanout} 超上限 ${MAX_FANOUT}，请减少计数`); return } // MED-1 硬闸
    setCreating(true); setErr(null)
    void (async () => {
      try {
        if (totalFanout === 0) {
          // 单建：完全走 Plan-4-T1 原路径（buildCreateBody + 可选 midSession 模型切换）
          const body = buildCreateBody({ projectId, engineId: engine.id, prompt, effort, model })
          const ws = await api.req("POST", "/workspaces", body)
          useUi.getState().selectWs(ws.id)
          if (model !== "default" && engine.capabilities.midSessionModelSwitch)
            void deliverModelSwitch(ws.id, model, true).catch(() => {})
          return
        }
        // fan-out：逐实例创建（各独立生命周期），选中首个成功者，部分失败按行报告
        const groupId = `fo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const reqs = buildFanoutRequests({ projectId, prompt, effort, model }, counts, groupId)
        let firstId: string | null = null
        const errs: string[] = []
        for (const body of reqs) {
          try { const ws = await api.req("POST", "/workspaces", body); firstId = firstId ?? ws.id }
          catch (e: any) { errs.push(`${body.engineId}: ${e?.message ?? e}`) }
        }
        if (firstId) useUi.getState().selectWs(firstId)
        if (errs.length > 0) setErr(`部分失败（${errs.length}/${reqs.length}）：${errs.join("；")}`)
      } catch (e: any) {
        setErr(e?.message ?? String(e))
      } finally {
        setCreating(false)
      }
    })()
  }
```

UI 加 fan-out 计数区 + cap 反馈（放在 Plan-4-T1 的引擎/模型/effort 选择器之后、提交按钮之前）：

```tsx
      <div className="dispatch-fanout">
        <label>Fan-out（每引擎实例数，>0 即多派发；上限 {MAX_FANOUT}）</label>
        {engines.map((e) => (
          <span key={e.id} className="fanout-eng">
            {e.displayName}
            <input type="number" min={0} max={MAX_FANOUT} value={counts[e.id] ?? 0}
              onChange={(ev) => setCounts((c) => ({ ...c, [e.id]: Math.max(0, Number(ev.target.value) || 0) }))} />
          </span>
        ))}
        {totalFanout > 0 && !overCap &&
          <span className="dim">将创建 {totalFanout} 个 workspace（各独立生命周期，上限 {MAX_FANOUT}）</span>}
        {overCap &&
          <span className="err">fan-out 实例数 {totalFanout} 超上限 {MAX_FANOUT}，请减少计数</span>}
      </div>
```

Plan-4-T1 的提交按钮补 disabled（MED-1：超限或创建中禁用）——`disabled={creating || overCap}`（沿用其既有 `disabled` 表达式，与 `|| overCap` 合取）。

> 与 Plan 4 的分工（已并入横幅）：Plan-4-T1 拥有 Dispatch 重写与选择器样式；本 Task 只叠加 fan-out 计数/循环/cap，`fanoutTotal`+`buildFanoutRequests` 是核心可测面。effort/model 在 fan-out 下对所有实例统一（取当前选择器值）——per-engine 差异化留后续。样式类名 `dispatch-fanout`/`fanout-eng` 待 Plan 4 主题统一。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd packages/client && bun run vitest run test/dispatch-fanout.test.ts && bun run typecheck`
Expected: PASS；typecheck 清洁（`buildCreateBody` 由 Plan-4-T1 在场，`MAX_FANOUT` 从 `@coolie/protocol` 解析）。

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/composer/Dispatch.tsx packages/client/test/dispatch-fanout.test.ts
git commit -m "feat(client): Dispatch fan-out 多选（叠加 Plan-4 buildCreateBody + 总量 cap MAX_FANOUT）"
```

---

### Task 12: README + 全量回归 + 手工冒烟清单

**Files:**
- Modify: `README.md`（fan-out / coolie:// / 外部终端 章节）
- Test: 全量 vitest（三包）+ 三处 typecheck + `cargo check` + 手工冒烟

**Interfaces:**
- Consumes: 前 11 task 全部产物。
- Produces: 文档化三特性用法 + 一份可复现冒烟清单（含跨引擎 fan-out、deep-link 打开、外部终端模式）。

- [ ] **Step 1: 写 README 章节**

在 README 合适处新增小节，写清：
- **fan-out**：`coolie create <repo> --agents claude:2,codex:1 --prompt "…"` 一次建 3 个 workspace（跨引擎，各独立生命周期）；结果表列 `#/engine/id/status/coolie:// 链接` + 组 id；部分失败按行报告、退出码非 0；`MAX_FANOUT=16` 上限（CLI 与 GUI 共用 `@coolie/protocol` 同一常量）；GUI 在 Dispatch 面板用 fan-out 计数区等价操作，超上限时提交按钮禁用并提示。
- **coolie:// deep links**：URL 语法 `coolie://workspace/<id>`、`coolie://workspace/<id>/tab/<tabId>`、`coolie://project/<id>`；`coolie link <wsId> [--tab <id>] [--open]` 生成/打开；GUI 经 `tauri-plugin-deep-link` 的 `onOpenUrl`/`getCurrent` 聚焦对应 workspace/tab；**macOS 限制**：scheme 注册需 app 已 bundle 并安装到 `/Applications`（dev 下运行期回调可用但冷启动路由需安装）；不需 single-instance（macOS 原生 emit）。
- **外部终端**：工具栏选终端 app（iTerm2 / Terminal.app / 自定义 `{cmd}` 模板，WezTerm/kitty/Ghostty 经自定义模板接入）；「外部终端模式」per-workspace 开关——开启后 GUI 不挂内嵌终端、只显示 `tmux -L coolie attach -t coolie-<wsId>` 引导 + 一键在外部终端打开。
- **安全**：所有 socket/wsId 拼 shell/AppleScript 前过 `SHELL_SAFE` 白名单；`coolie://` 链接不含 token。

- [ ] **Step 2: 全量回归 + 三 typecheck + cargo check**

Run:
```
cd packages/protocol && bun run vitest run && bun run typecheck
cd ../server && bun run vitest run && bun run typecheck
cd ../cli && bun run vitest run && bun run typecheck
cd ../client && bun run vitest run && bun run typecheck
cd src-tauri && cargo check
```
Expected: 三包 vitest 全绿；四处 typecheck 清洁；`cargo check` 成功（deep-link 插件解析）。

- [ ] **Step 3: 手工冒烟（发版前 5 分钟清单，记录 PASS/FAIL）**

前置：本机 `codex` 在 PATH 且 `codex login`（跨引擎 fan-out 需要）；`bun run build` + 安装 `Coolie.app` 到 `/Applications`（deep-link 冷启动需 bundle）；全程用临时 `COOLIE_HOME`/`COOLIE_*_HOME`/`COOLIE_TMUX_SOCKET`，绝不碰真实目录。

1. **fan-out 同引擎**：`coolie create <repo> --agents claude:2 --prompt "回答 PONG"`——观察结果表 2 行、`coolie list` 见 2 个 active、各自 `coolie-<wsId>` session 独立。
2. **fan-out 跨引擎**：`coolie create <repo> --agents claude:1,codex:1 --prompt "回答 PONG"`——claude 与 codex 各建 1 个 workspace，各自 TUI 在 window 0 渲染、各答 PONG；部分失败（如 codex 未登录）按行报告且退出码非 0，成功的 claude workspace 保留。
3. **deep-link CLI→GUI（LOW-4：App.tsx 胶水的唯一验证入口——运行期 `onOpenUrl`）**：GUI 已开着，`coolie link <wsId> --open`——GUI 聚焦到该 workspace；`coolie link <wsId> --tab <tabId> --open`——聚焦并切到该 tab。**冷启动（App.tsx `getCurrent` 路径）**：GUI 关闭时 `open coolie://workspace/<wsId>`——GUI 拉起并落在该 workspace（此步专门验证 bootstrap effect 里 `getCurrentDeepLink().then(handle)` 的冷启动路由与 `onOpenUrl` 的 unlisten cleanup 不泄漏）。
4. **deep-link 畸形（App.tsx 胶水健壮性）**：`open coolie://bogus/x`——GUI 不崩、无动作（`routeCoolieUrl` 返回 false，胶水 `handle` 遍历不抛）。
5. **外部终端可配置**：工具栏选 Terminal.app → Open——Terminal.app 起新窗 attach 同一 tmux 会话，里外同画面；选「自定义」填 `open -na Ghostty --args -e sh -lc {cmd}` → Open——Ghostty attach（若装了）。
6. **外部终端模式**：某 workspace 切「外部」——中央区变引导占位（显示 attach 命令），内嵌 TerminalView 不挂（server 该 ws 的 GUI PTY refcount 不增）；点「在外部终端打开」→ 外部终端 attach；切「内嵌」→ TerminalView 重新挂载、画面完好（tmux 保管）。
7. **C12 回归**：正常 `⌘T` 新 shell tab 成功建窗 + 入库；（如可注入 DB 故障）确认建窗后 DB 失败时无孤儿 window（`tmux -L coolie list-windows` 不残留）。
8. **零泄漏**：退出后确认真实 `~/.coolie`/`~/.claude`/`~/.codex` 无本次测试产物（全程临时 home）。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: fan-out / coolie:// deep links / 外部终端模式 用法 + 冒烟清单（M2 Plan 3 完成）"
```

---

## Self-Review

按 writing-plans skill 的三项自检，对照 spec §五/§七/§八/§十三 与 roadmap Plan 3 scope 复核本计划。

**1. Spec coverage（Plan 3 责任范围内的 spec 点）：**
- spec §八「fan-out（`--agents claude:2,codex:1`）」→ Task 1（解析器）+ Task 6（CLI 执行 + 结果表）+ Task 5（fanoutGroup 元数据）+ Task 11（GUI 多选）✓。跨引擎依赖 Plan 1 的 engineId/registry（已合入），本计划复用不重实现 ✓。
- spec §八「`coolie://` deep links（标准 URL 结构）」→ Task 2（URL 语法）+ Task 7（CLI link）+ Task 8（GUI onOpenUrl 端到端）✓。
- spec §十三「外部终端模式（per task）」→ Task 9（可配置终端）+ Task 10（per-workspace 外部模式，不挂内嵌终端）✓；spec §五「Open in iTerm2」升级为多终端并归一 `tmuxSessionName` ✓。
- roadmap Plan 3 carry-over「C12 shell-tab tmux-op-then-DB 非原子」→ Task 4（补偿 kill window）✓。
- 明确不做（其他 plan）：codex adapter（Plan 1）、server 队列/通知（Plan 2）、diff 评论/键位/主题/i18n/web client（Plan 4）——Global Constraints 已声明 ✓。

**2. Placeholder scan：** 全部步骤含完整可执行代码与真实断言；无 TBD/「类似 Task N」。Task 8 的 Rust/conf 改动无法 vitest 覆盖，已明确以 `cargo check` + Task 12 手工冒烟兜底，并非占位；App.tsx 深链胶水的测试边界（LOW-4）已在 Task 8 显式标注、并纳入 Task 12 冒烟第 3/4 项。Task 9 Step 4 / Task 10 Step 4 对 `CenterArea` 的编辑基于已读取的 TabsBar.tsx 真实结构（惰性挂载 `viewed`/`term-stack` 均在场），给出可落地的条件渲染骨架而非「自行发挥」。自定义终端模板编辑 UI 显式记为 Plan 4 细化（非本计划 gap）。仅有的一处 `TODO(Plan 4/M3)`（Task 5 MED-2：fanoutGroup 是否上 `Workspace` domain 字段 / 专门端点）是**经代码核对后的显式延后决策**（GET /workspaces passthrough 非 trivial、违反无 schema 变更纪律），且该字段已有便宜的真 reader（`getCreateCtx` round-trip）令其非死值，非悬空占位。

**3. Type consistency（逐条核对）：**
- `CoolieLinkTarget`/`parseCoolieUrl`/`buildCoolieUrl`（Task 2）→ CLI（Task 6/7 用 `buildCoolieUrl`）、client（Task 8 `routeCoolieUrl` 用 `parseCoolieUrl`）签名一致；`project` 分支 build/parse 对称，`routeCoolieUrl` 的 `switch` 覆盖 `workspace`/`project` 两 kind（穷尽，无 fanout 死链——已刻意剔除 fanout URL kind，仅保留可路由目标）✓。
- `TerminalId = "iterm2"|"terminal"|"custom"`（Task 3）→ store（Task 9 `terminalApp: TerminalId`，读持久化值经 `coerceTerminalId` 校验、未知回落 iterm2——LOW-3）、TabsBar（`<select>` 的 `as TerminalId`）、`buildTerminalLaunch` 形参一致；`buildTerminalLaunch` 的 `switch` 带 `default` 分支（LOW-3：运行期脏值防御）✓。
- `AgentSpec`/`expandAgents`（Task 1）→ Task 6 `expandAgents(specs)` 一致；`MAX_FANOUT` **canonical 落 `@coolie/protocol/domain.ts`**（MED-1），Task 1 fanout.ts re-export、Task 6 经 fanout.ts、Task 11 直接从 protocol import——三处同一常量、无重复定义（client 无 cli 依赖，故必走 protocol）✓。
- `PostCreateContext`（Task 5 加 `fanoutGroup?`）建立在 Plan 1 的 `{ initialPrompt?; engineId? }` 上——本计划**假定 Plan 1 已合入**（Global Constraints 首条声明），`setCreateCtx`/`provision`/retry 均 Plan 1 既有点位，Task 5 追加一个可选字段并**同步扩 repo `setCreateCtx`/`getCreateCtx` round-trip**（MED-2：否则 retry 回填丢 fanoutGroup、写入成死值）；`create` opts 三字段 spread 与 http body spread 对齐 ✓。
- `buildFanoutRequests`（Task 11）签名 **`(base: FanoutBase, counts, groupId)`——3 参，与实现/调用点完全一致（LOW-2 修正原 Interfaces 5 参 prose）**；返回 `Array<Record<string,string>>`，每项 = **Plan-4-T1 的 `buildCreateBody(...)` 输出 + `fanoutGroup`**（叠加而非另造 body），字段与 server `POST /workspaces` 接受集（Plan 1 engineId/effort + Task 5 fanoutGroup）一致；`fanoutTotal`+`MAX_FANOUT`（protocol）给 MED-1 总量 cap ✓。
- `DeepLinkRouter.{selectWs,selectTab,openProjectDispatch}`（Task 8）→ App.tsx 用 `useUi.getState().selectWs/selectTab/setDispatchMode`（现状 store 确有这三方法，见 Dispatch.tsx/TabsBar.tsx 调用）✓。
- terminal store（Task 9/10）：`useTerminal` 从 Task 9 的 `{terminalApp,customTemplate,set…}` 到 Task 10 追加 `{externalByWs,toggleExternal,isExternal}`——`create<TerminalState>((set,get)=>…)` 在 Task 10 引入 `get` 形参，`TerminalState` 单一定义处随之扩展，无跨 task 形状漂移 ✓。
- C12（Task 4）：`Exit.match` 的 `onFailure` 改 async 补偿 `composerOps.killWindow(session, idx)`——`killWindow(session:string,index:number)` 签名与 `ComposerOps`（ops.ts:17）一致；`tmuxSessionName(ws.id)` 归一 session 名 ✓。

**波次/冲突自检：** app.ts（T4/T5）、main.ts（T6/T7）、TabsBar.tsx（T9/T10）三处同文件 task 均标 `→` 串行；Wave A 四 task 文件互不相交可并行（T1 加碰 protocol/domain.ts 加 MAX_FANOUT，与 T2 的 index.ts/links.ts、T3/T4 无写冲突；T4 虽碰 app.ts 但与 T5 之间已排序）。**跨 plan 硬依赖（binding controller decision）**：`Dispatch.tsx` canonical owner 是 **Plan 4 Task 1**——本计划 T11 从 Wave D 拆出、单独排 **Wave D'（Plan-4-T1 merge 之后）**，在 Task 头 + Task Order + File Structure + 冲突面注四处均有 loud 横幅，绝不与 Plan-4-T1 并发。App.tsx（T8）Plan 2/4 也碰，按串行段纪律「只在 bootstrap effect 内追加两行接线」协调。

**4. 对抗性评审落实（逐条闭环，SUCCESS ≥8）：**
1. **MED-1**（GUI 总量 cap）→ Task 11 `submit` 硬闸 `fanoutTotal(counts) > MAX_FANOUT` 拒绝 + 按钮 `disabled` + 计数/超限提示；`MAX_FANOUT` 与 CLI 同源（protocol）；纯函数 `fanoutTotal` + cap 测试 ✓。
2. **MED-2**（fanoutGroup write-only）→ 显式标为 Plan 4/M3 分组 UI 种子 + `TODO`；补唯一便宜 reader（`getCreateCtx` round-trip，兼修 retry 丢字段潜伏 bug）+ round-trip 测试；核对 GET /workspaces passthrough 非 trivial 故不做、已陈述决策 ✓。
3. **LOW-1**（custom `{cmd}`）→ token-anywhere `replaceAll` 就地替换 + 含引号明确拒绝（documented naive-split 限制）+ `\s+` 稳健分词；token-embedded/引号拒绝/多空白测试 ✓。
4. **LOW-2**（arity）→ `buildFanoutRequests` Interfaces prose 改 3 参、与实现/调用点一致 ✓。
5. **LOW-3**（持久化 terminalApp）→ `coerceTerminalId` 未知回落默认 + `buildTerminalLaunch` switch `default` 分支；纯函数直测脏值/null/非串 ✓。
6. **LOW-4**（App.tsx 胶水未测）→ Task 8 显式测试边界说明（可接受）+ 纳入 Task 12 冒烟第 3/4 项（冷启动 getCurrent、运行期 onOpenUrl、畸形不崩）✓。
7. **NIT**（scheme 大小写）→ `parseCoolieUrl` 先 `toLowerCase()` 再 `startsWith`（id 段取原始 raw 保留大小写）+ `COOLIE://` 测试 ✓。
8. **CROSS-PLAN 归口（binding）**→ Plan 4 Task 1 为 Dispatch.tsx canonical owner；本计划 T11 重写为「在 buildCreateBody 之上叠加 fan-out」、`buildFanoutRequests` 仍为纯核心；四处 loud 横幅 + Wave D' 排期，调度须 T11 落在 Plan-4-T1 merge 之后（或先跑 Plan 4）✓。

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-12-coolie-m2-plan3-fanout-links.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每 task 一个 fresh subagent，task 间两阶段评审，快速迭代。
**2. Inline Execution** — 本会话内 executing-plans，批量执行带 checkpoint。

**Which approach?**
