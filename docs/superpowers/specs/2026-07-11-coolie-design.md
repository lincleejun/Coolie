# Coolie 设计文档

> 日期：2026-07-11。本文是 brainstorm 的产出，所有决策已与作者逐条确认。
> 研究依据：[refs/research/README.md](../../../refs/research/README.md)（13 份调研文档）；需求原文：[Context.MD](../../../Context.MD)。

## 一、定位与设计原则

**Coolie 是 coding agent 的二次环境脚手架**：不做 coding agent 本身，为多个 coding engine（Claude Code、Codex 等）提供干净的并行开发环境。一句话：coolie = repo + branch 的干净开发环境伴侣，类似 Conductor 但更轻、为个人服务。

三条不可violated的原则：

1. **engine 进程只属于 tmux**。server、GUI、CLI 任何一个死掉都不影响正在跑的 engine；重连即恢复。（kobe 验证的所有权分离）
2. **绝不自渲染 engine 对话流**。engine 用自己的 TUI 在 tmux 里渲染（"tux" = tmux，作者已确认）；Coolie 只做环境、投递与旁路语义。headless 自渲染仅作未来兜底（M3+），若做只做三档：markdown / 通用 tool 卡片 / diff。
3. **绝不 scrape 终端画面 pattern 获取状态**。结构化状态只从 hooks / 转录文件 / git 拿。（agent-deck 的维护地狱教训）

## 二、总体架构

### 2.1 进程拓扑（方案 A：按需 daemon）

```
┌───────────┐   ┌───────────┐   ┌────────────┐
│ Tauri GUI │   │ coolie CLI│   │  iTerm2    │
│ (React)   │   │           │   │ （逃生舱）  │
└─────┬─────┘   └─────┬─────┘   └─────┬──────┘
      │ HTTP+WS+SSE   │ HTTP(unix)    │ tmux attach（直连，不经 server）
      ▼               ▼               │
┌─────────────────────────────────┐   │
│ coolie-server（Node + Effect）   │   │
│ · REST 控制面（workspace CRUD）  │   │
│ · WS 二进制帧：终端字节           │   │
│ · SSE 事件流（live + durable）   │   │
│ · PTY 服务：node-pty ── tmux ────┼───┤
│ · SQLite：全部元数据             │   ▼
└─────────────────────────────────┘ ┌─────────────────────────┐
   按需拉起，refcount 惰性退出        │ tmux -L coolie          │
                                    │ 每 workspace 一个        │
                                    │ session：engine/setup/… │
                                    └─────────────────────────┘
```

- server 是独立 Node 进程：GUI 或 CLI 谁先用谁拉起（Unix socket + 本地 HTTP/WS）。
- 客户端按 kobe 的 role 化 refcount：GUI 持有 server 生命周期、终端 pane 不持有；最后一个持有者断开后惰性退出。
- server 暴露 TCP 端口时的安全默认值：非 loopback 且无 token → 拒绝启动（agent-deck）。
- 不需要独立 pty-daemon（Superset 有）：tmux 就是我们的会话持久层。

### 2.2 Monorepo（bun workspaces 管包，server 运行时 = Node）

| 包 | 职责 | 栈 |
|---|---|---|
| `packages/protocol` | API contract + 共享类型，client/CLI 的类型来源 | Effect Schema |
| `packages/server` | daemon：API、PTY、lifecycle、SQLite、engine 集成 | Node + Effect（Layer DI + @effect/platform HTTP） |
| `packages/engines` | Engine Registry：claude adapter（M1）、codex（M2） | Effect |
| `packages/client` | 桌面壳 + React UI + xterm.js | React + Tauri 2 |
| `packages/cli` | 瘦客户端，纯 protocol 消费者 | TS |

- **DI：全面 Effect**（作者确认，greenfield 第一天就用避免 opencode 式迁移）：Layer 做服务组装与 dispose、`Effect.gen` 写业务、Schema 做校验、@effect/platform 做 HTTP。
- **server 运行时必须是 Node**：node-pty 不兼容 Bun（kobe/Superset 均被迫用 Node sidecar）。
- CLI 对本地 server 可用 opencode 式"内嵌 transport"（内存直调），零端口依赖。

### 2.3 数据流三通道（不混用）

1. **REST**：控制面（workspace CRUD、lifecycle 动作、composer 投递）。
2. **WS 二进制帧**：终端字节（PTY ↔ xterm.js），绝不塞 JSON 信封。
3. **SSE 双通道**：live 通知（不承诺 replay）+ durable per-workspace 事件流（`events.seq` 游标续传）。（opencode 双通道语义）

## 三、数据模型与存储

SQLite 单库（`~/.coolie/coolie.db`），server 单写者。索引列提升 + JSON `data` 列折衷（opencode）。

| 表 | 关键列 | 说明 |
|---|---|---|
| `projects` | id, name, repo_root, default_base_branch | repo_root 指向用户已有 checkout，不搬家 |
| `workspaces` | id, project_id, name, path, branch, base_branch, base_ref, status, pinned | name = 目录名（**国家公园名池**）；branch = `coolie/<语义slug>`；base_ref 记录创建基点供 diff 用 |
| `tabs` | id, workspace_id, kind(engine/setup/shell), engine_id, engine_session_id, tmux_window | GUI tab ↔ tmux window 映射 |
| `events` | seq, workspace_id, type, payload(JSON), ts | durable 事件流，SSE replay 数据源 |

写库纪律（agent-deck 防误删三件套）：拒绝空条件 sweep、破坏性写前 `.bak`、幂等 migration。

**双命名体系**：目录名求稳定（生成后不动，rename 只改显示 label），branch 名求语义。命名池做成可插拔 name pool provider：内置 **national-parks（默认，`国家-公园` 如 `usa-yellowstone`、`china-zhangjiajie`）**、cities、animals，Settings 可切换与自定义。（优先级低）

## 四、Workspace Lifecycle（四项全 M1）

```
creating ──成功──▶ active ──archive──▶ archived ──unarchive──▶ active
    │失败              │delete（脏树二次确认）    │delete（删记录）
    ▼                  ▼
  error（可重试；半成品已自动回滚）
```

- **create**：`git fetch` → `git worktree prune` → `git worktree add --no-track -b coolie/<slug> ~/coolie/workspaces/<repo>/<园名> origin/<base>` → 写 `branch.<name>.base` → `.git/info/exclude` 注入工具目录 → 按 `.worktreeinclude` 复制 gitignored 文件（.env 等）→ 分配 10 端口段（`$COOLIE_PORT_0..9`）→ setup script 在 setup tab **可见执行** → 建 tmux session → 启 engine → 投递首条 prompt（若有）。任何一步失败：自动回滚删半成品 worktree，绝不留孤儿，status=error 可重试。
- **setup script 三层合并**：repo `.coolie/setup.sh`（可提交）→ 本机覆盖（`~/.coolie/projects/<id>/`）→ local overlay；注入 `$COOLIE_ROOT`、`$COOLIE_PORT_*`。
- **archive**：杀 tmux session → 删 worktree → **branch 一律保留** → 记录留档；unarchive 从 branch 重建。
- **delete**：脏树二次确认后删 worktree + 记录（branch 保留）。只走 `git worktree remove`（脏树自动拒绝），绝不裸 rm。
- **finish**：Create PR（`gh pr create`，prompt 模板可被 repo 内文件覆盖）+ merge back（回主 checkout merge，脏树保护）。
- **adopt**：收养已有外部 worktree（`git worktree list --porcelain` 枚举）。
- checkpoint 语义（如做）用 git 私有 ref（`refs/coolie-checkpoints/<id>`，Conductor 方案），不自建快照系统。

## 五、tmux 链路与终端

- 专属 socket `tmux -L coolie`；session = `coolie-<wsId>`；**window 0 = engine，setup/shell 各占 window，即 GUI 的 tabs**；tmux 内原生分屏用户随意用。
- server 为每个在看的 GUI 终端 tab 起一个 node-pty attach；attach 前 fit + heal 防首帧 reflow；resize 防抖。
- 发键走**持久 tmux control-mode client**（macOS 上每次 fork+exec 有 10–50ms 延迟，agent-deck 实测）。
- prompt 投递（kobe 踩坑结晶）：画面稳定检测（连续两帧稳定）→ 消毒（CRLF 归一、剥 CSI/OSC/控制字符、tab 展开，Superset `sanitizePromptForPty`）→ bracketed paste `send-keys -l --` → 停 150ms → Enter。
- 环境：`TERM=xterm-256color`、剥 `TERM_PROGRAM`（kobe Terminal Identity Boundary）。
- 渲染器：**xterm.js 6**（WebGL + canvas/DOM fallback）；ghostty-web 留观察名单（五项硬伤，见 tauri-terminal-poc.md）。tmux 居中已实测吸收 claude TUI 的暴力重画（绕开 xterm.js scroll-jump 问题族）。
- **Open in iTerm2**：一等公民按钮，`tmux -L coolie attach -t coolie-<wsId>`，里外同一画面。

## 六、Engine 抽象（M1 只实现 claude，接口一步到位）

Effect service `Engine`，六件套裁剪版：

| 能力 | claude 实现（M1） |
|---|---|
| `identity/capabilities` | id、名称、能力位（nativeQueue、midSessionModelSwitch…）+ Noop 降级；UI 禁止硬编码 vendor 字符串 |
| `launchCommand` 流水线 | base cmd → model/effort 参数 → `--session-id <uuid>`（claude 客户端造 id）→ terminal title 注入 |
| `hooksAdapter` | 往 workspace 注入 hooks（settings 层面）：幂等、可 opt-out、hook 脚本只 POST 回 server、永远 exit 0 |
| `turnDetector` | hook 事件为主 + `~/.claude/projects/**` transcript mtime 轮询兜底 → 徽标 ●工作中/✓等输入/!错误/○空闲 |
| `historyReader` | 读 transcript JSONL：派生标题（首条 user 消息）、`--resume <sessionId>` 复活死会话 |
| `promptDelivery` | 见第五节投递流水线；`/model` 等 slash 命令映射 |

codex（M2）已有完整调研（[codex.md](../../../refs/research/codex.md)）：服务端造 id 需"先启动后回填"、hooks 有 trust 门、`notify`/OSC title 白送状态。id 生命周期差异**必须进抽象**。

## 七、Client UI

### 7.1 布局（Cursor 左栏 + cmux 中央 + Conductor 右栏）

```
┌──────────┬──────────────────────────────┬─────────┐
│ + New    │ usa-yellowstone ⑂coolie/fix-x│ Changes │
│ 🔍 Search │ ┌─[claude][setup][run][sh+]─┐│  +42−7  │
│──────────│ │  claude 自己的 TUI         ││ Files   │
│ ▾ Coolie │ │  (xterm.js / WebGL)       ││（默认收 │
│  ● usa-… │ └─[↗ Open in iTerm2]────────┘│ 起为文字 │
│  ✓ china…│ ┌─ Composer ────────────────┐│ 入口）   │
│──────────│ │ prompt… [Claude·Opus·High]││         │
│ ⚙ 设置    │ └───────────────────────────┘│         │
└──────────┴──────────────────────────────┴─────────┘
```

- **左栏**（Cursor 三段式）：固定动作区（New/Search）→ Projects 分组两层列表（project → workspace；每行状态徽标 + `+N−M` diff 计数 + pin）→ 底部设置。diff 计数 = `git diff --shortstat` 轮询（引擎无关的最有信息量状态位，优先做）。
- **右栏**：默认收起为文字入口。Changes（四分区：against-base/committed/staged/unstaged，基于 base_ref；git 操作在 worker 线程）+ Files（文件树，`@<path>` 注入 composer）。M2：diff 行评论 → 消毒 → 写回 agent PTY（Superset 闭环）。diff 渲染候选 `@pierre/diffs`（许可需复核）。
- 窗口质感：`decorations:false + transparent + macOSPrivateApi + vibrancy` 自绘 titlebar；**Edit 菜单保留系统角色项**（否则 Cmd+C/V/A 全废）。

### 7.2 常驻 Composer（核心交互，作者以 Conductor 截图确认）

**定位**：绑定当前 workspace，是 engine TUI 的"第二输入面"。**回答由 engine TUI 在终端渲染，composer 只负责把话打好、投出去**（写-only surface）。机制 = Superset 的 composer→sanitize→PTY 写入管道。

能力：macOS 原生编辑（真 textarea：IME/Cmd+A/Option+←→/多行）；`@` 弹 Coolie 文件模糊选择器插入 `@相对路径`；`/` 弹命令补全（内置 + 扫描 repo 与 `~/.claude/commands/`）；附件（图片存临时目录插路径）；每 workspace 草稿持久化；模型/effort 单选择器（创建时=启动参数，会话中=翻译成 `/model` 投递，能力位控制可用性）。

**发送语义三档 + 打断**：

| 动作 | 键位 | 行为 |
|---|---|---|
| 发送/排队（默认） | `Enter` | 空闲直接投；忙时排队——claude 原生 mid-turn 队列直接投给 TUI，无原生队列的 engine 走 server 端 queue（turn detector 触发投递）；composer 显示"⏳ N 条排队中"可撤回 |
| 打断并发送 | `Cmd+Enter` | 投 `Esc` → 画面稳定检测 → 投正文 |
| 仅插入（insert） | `Option+Enter` | 文本写进 engine 输入行**不回车**，可去终端继续编辑 |
| 换行 | `Shift+Enter` | composer 内换行 |
| 单纯打断 | `Cmd+.`（全局）/ ■ Stop 按钮（忙时显示） | 投 `Esc` 进当前 workspace 的 engine pane |
| 焦点 | `Cmd+L` 聚焦 composer；composer 内 `Esc` 失焦回终端 | 双击 Esc 自然形成"失焦→打断"连击；终端内 Esc 永远原生透传（claude 自己的双击 Esc rewind 不受影响） |

**与创建流的关系**：`Cmd+N` 新建 workspace 时同一 composer 充当首条 prompt 输入，workspace 就绪后自动投递。

### 7.3 快捷键

- 单一 `HOTKEYS_REGISTRY`（绑定/footer/`⌘/` cheatsheet 三处同源渲染）+ LIFO binding stack + 上下文分层（单字母键只在非输入区生效）+ 用户 JSON 覆盖 + `⌘K` 命令面板。
- **终端焦点三层仲裁**（Superset，原样抄）：① 注册表命中的 Cmd chord → app；② 行编辑翻译：`Cmd+←/→ → \x01/\x05`、`Cmd+Backspace → \x15`、`Option+←/→ → ESC b/f`、`Shift+Enter → ESC CR`；③ 其余 Cmd 组合一律不进 PTY。**其它按键全部透传**（Ctrl+A/E 天然由 shell/engine 处理）。
- 全局键约束在 Cmd 空间：`Cmd+N` 新 workspace、`Cmd+T` 新 shell tab、`Cmd+W` 关 tab、`Cmd+1..9` 切 workspace、`Cmd+[/]` 前后切换、`Cmd+L` composer、`Cmd+.` 打断。

## 八、CLI

范本 = kobe：`coolie` 命令 + `coolie api` 脚本化面（分级 schema 发现：紧凑索引/--verb/--group），供 coding agent 自己驱动。M1 基础集：`create/list/enter/archive/delete/api schema` + 下节的 `export/events/doctor`。未知子命令报错退出（不落进 TUI）。M2：fan-out（`--agents claude:2,codex:1`）、`coolie://` deep links（标准 URL 结构）。

## 九、诊断与可观测性（问题排查 + 信息查看 + 事件流导出）

范本 = kobe 的诊断三件套（详见 [kobe.md](../../../refs/research/kobe.md) 补充研究一节），Coolie 在其上叠加 SQLite events 的结构化优势：

- **结构化事件流**：一切状态变化写 `events` 表（durable、seq 游标），server 提供 `GET /events?after=<seq>&workspace=` 游标读取（SSE 推送为其流式视图）。kobe 的 engine 事件只进内存通道不落盘、排查历史只能翻文本日志——Coolie 两者都要。
- **`coolie export <projects|workspaces|events> [--json|--csv|--format table]`**：**daemon-free**——readonly 直开 SQLite 导出，server 挂了也能导（kobe `export` vs `api list` 的分工同款）；三种格式共用单一 COLUMNS 字段真源；CSV 为 RFC-4180 风格带表头。
- **`coolie events tail [--after <seq>] [--follow]`**：经 API 轮询打印事件流，排查时人看。
- **`coolie doctor`**：只读诊断（home/db/server 探活/pid/日志大小/tmux/git），**绝不杀进程、绝不删文件**（kobe doctor 纪律）。
- **诊断日志** `~/.coolie/logs/server.log`：append-only + **10MB 轮转保一代 `.old`**（kobe issue #26：无上限日志曾涨到 736MB）+ fire-and-forget 异步 append（日志失败绝不影响主流程）+ **crash net**（unhandledRejection/uncaughtException 记 stack 后继续服务，不退程——长命 daemon 不能被一个野 promise 打死）。GUI/CLI 客户端日志后续同款纪律（client.log，带 process context + pid）。

## 十、错误处理

- **server**：Effect typed errors 按域建模（`GitError/TmuxError/EngineError/SetupScriptError`），API 统一错误信封。
- **tmux session 丢失**：ensure-or-heal 三段式（observe→decide→apply，kobe）重建 session，engine `--resume` 复活。
- **engine 退出**：keep-alive 包装落回 shell 不塌布局 + 非零退出横幅 + Resume 按钮。
- **server 崩**：客户端指数退避重连并重新拉起 daemon；SSE 从 events 游标 replay；终端画面因 tmux 无损。
- **磁盘**：见第四节 delete 纪律；branch 永不删。

## 十一、测试策略

- **单测**：Effect Layer 注入假 Git/Tmux service + 内存 SQLite（DI 直接红利）。
- **集成**：临时 git repo + 专用 `tmux -L coolie-test` socket，真跑 create→active→archive→delete 状态机。
- **终端 E2E**：发版前 5 分钟人工清单（claude TUI 渲染、Ctrl+A/E 穿透、Cmd 快捷键、中文 IME、resize、WebGL context loss）。

## 十二、磁盘布局与约定

- worktree：`~/coolie/workspaces/<repo>/<园名>`（可浏览，学 `~/conductor` 习惯）
- 数据/配置：`~/.coolie/`（coolie.db、settings、logs、projects/<id>/ 本机覆盖层）
- repo 内约定：`.coolie/`（setup.sh / run.sh / config），经 `.git/info/exclude` 注入
- macOS 打包：关 App Sandbox（spawn CLI 必需）→ DMG + notarization，不上 MAS；claude 二进制发现抄 opcode（多路径 + 版本择优 + env 白名单），不打包 sidecar（锁版本=永远落后）
- tmux 为非自带依赖（`brew install tmux`），首启检测 + 引导

## 十三、里程碑

- **M1（Claude 全链路）**：monorepo + protocol + server（daemon/refcount/SQLite/三通道）+ tmux 链路 + claude adapter + client（左栏/终端 tabs/Changes/Composer 三档发送/核心快捷键）+ lifecycle 四项 + CLI 基础集 + 可观测性三件套（export/events/doctor + 诊断日志）+ Open in iTerm2。
- **M2**：codex adapter、fan-out、diff 行评论写回 PTY、deep links、通知与注意力管理、外部终端模式（per task）、主题/i18n、web client。
- **刻意不做**：自渲染对话流（除非 M3+ 做 headless 兜底三档）、双 UI 栈、云端执行、SSH 远程（CS 架构下近乎免费，后置）。

## 附：关键参考映射

| 设计点 | 出处 |
|---|---|
| 进程拓扑/refcount/engine 归 tmux | [kobe.md](../../../refs/research/kobe.md) |
| API-first contract/SDK/双通道事件 | [opencode.md](../../../refs/research/opencode.md) |
| composer→PTY 写回/键位仲裁/防 scrape | [superset.md](../../../refs/research/superset.md)、[agent-deck.md](../../../refs/research/agent-deck.md) |
| lifecycle 脚本/`.worktreeinclude`/端口段/checkpoint ref | [conductor.md](../../../refs/research/conductor.md)、[conductor-local.md](../../../refs/research/conductor-local.md) |
| 左栏信息架构/worktree 回收 | [cursor.md](../../../refs/research/cursor.md) |
| xterm.js 选型/PTY 放 server 侧 | [tauri-terminal-poc.md](../../../refs/research/tauri-terminal-poc.md) |
| Tauri 工程化/二进制发现/titlebar | [opcode.md](../../../refs/research/opcode.md) |
| codex 集成矩阵（M2） | [codex.md](../../../refs/research/codex.md) |
