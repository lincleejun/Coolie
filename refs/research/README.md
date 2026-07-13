# Coolie 前期调研总索引与综合分析

> 汇总日期：2026-07-11。本文是 `refs/research/` 下 12 份研究文档的总索引，并将研究结论映射回 [Context.MD](../../Context.MD) 的每个设想。各文档均带来源清单与"未验证"标注，引用请回读原文。

---

## 1. 索引表

| 文档 | 主题 | 一句话核心结论 |
|---|---|---|
| [conductor.md](./conductor.md) | Conductor 官方文档/changelog 全量调研 | 品类定义者：Project→Repository→Workspace(=branch)→Worktree→Running environment 六层模型 + "workspace 是委派单元、branch/PR 是集成单元"；主路线是 headless 自渲染 chat UI，副路线 Big Terminal Mode 直跑 agent CLI，两条路并存。 |
| [conductor-local.md](./conductor-local.md) | 本机 Conductor.app v0.74.0 文件系统考古 | 实证技术栈为 **Tauri 2 + Rust + Bun sidecar**（与 Coolie 计划同栈）；单 SQLite（sqlx，115 次迁移）存全部元数据；agent 以 `--output-format stream-json` headless 驱动；checkpoint 用私有 git ref；`.git/info/exclude` 注入 `.context/` 零污染。 |
| [kobe.md](./kobe.md) | kobe 源码深读（Coolie 功能对标基线） | Task = git worktree + tmux session + branch 的完整参考实现；单写者 daemon + 通道快照 + PTY Host 独立进程；v0.5 headless 自渲染被 v0.6 tmux Handover 整体推翻——Coolie 的 tux-first 路线已被 kobe 验证过一轮。 |
| [opencode.md](./opencode.md) | opencode 源码研究（server 架构与 DI） | Coolie 想要的 CS 形态的最佳参考：protocol 包声明 HTTP contract → SDK 全生成 → 一个 server 按 directory 路由多项目实例；**DI 抄旧不抄新**（ALS context + namespace service + lazy state，不要 Effect 全家桶）。 |
| [agent-deck.md](./agent-deck.md) | agent-deck 源码调研（Go TUI 编排器） | tmux + 不自渲染路线在几十个并发 session 规模下的可用性验证；三层状态检测（hooks→pane pattern→OSC title）；macOS 上必须用 tmux control-mode 持久进程发键（fork+exec 每次 10-50ms）；反面教材：engine 集成无抽象、巨型单体文件。 |
| [opcode.md](./opcode.md) | opcode（原 claudia）源码研究（Tauri+React 壳） | headless 自渲染路线的成本实证：~6500 行 TSX 追着 Claude Code 输出格式跑、字符串级耦合、`--dangerously-skip-permissions` 硬编码；可直接抄的是 claude 二进制发现/env 白名单/kill 三层兜底/双传输适配层。 |
| [cursor.md](./cursor.md) | Cursor Agents Window UI/交互拆解 | 左侧栏两层结构（repo → session）+ 右栏四面板（Changes/Browser/Terminal/Files，默认收起）+ 底部输入框（模型×context×effort 合并为单选择器）是 Coolie client 布局的直接蓝本；过程摘要 UI 依赖自渲染事件流，与 tux 路线正交，不要为它提前做 headless。 |
| [landscape.md](./landscape.md) | 同类产品全景扫描（15+ 产品） | 赛道极度拥挤且 2026 上半年大洗牌：云端/托管路线普遍死亡，本地优先 + 复用订阅存活；"GUI 壳 + tux 原生渲染"的中间态空档正被 Superset 占据；Coolie 最结构性的差异点是真正的 CS 架构（server + 多客户端）与个人向无云包袱。 |
| [tux.md](./tux.md) | "tux" 到底是什么 + 计费前提复核 | 高置信推断：**tux = tmux 笔误/简写**，指 kobe 的 tmux Handover 模型（引擎自渲染 TUI、宿主只 attach/capture/send-keys）；kobe 引用的 Anthropic 计费政策已被暂停，"tux 优先"的论证基础需从"计费事实"换成"政策风险对冲 + 维护成本"。 |
| [codex.md](./codex.md) | Codex 引擎集成实测（app-server/exec/rollout/hooks） | Codex 可集成面比预期强：`exec --json`、JSON-RPC app-server、原生 resume/fork、与 Claude 同构的 hooks（多一道 trust 门）、`turn/diff/updated` 白送聚合 diff；最大风险是 app-server 协议版本漂移；实证 Conductor 走的是 codex-sdk（exec --json），不是 app-server。 |
| [superset.md](./superset.md) | Superset 源码深读（最接近的竞品） | 重要更正：Superset 已是完整 CS（host-service + pty-daemon + tRPC 多客户端），"真 CS 多客户端"不再是 Coolie 独有差异；其终端按键三层仲裁、ModeTracker 模式回放、diff 行评论写回 PTY、presets 双层设计是混合路线的现成避坑地图。 |
| [tauri-terminal-poc.md](./tauri-terminal-poc.md) | Tauri 2 + PTY + xterm.js 渲染 claude TUI 的 PoC 实测 | **路线可行，已跑通全链路**；渲染器选 xterm.js 6（ghostty-web 进观察名单）；tauri-plugin-pty 不能直接生产使用，倾向把 PTY 放 server 侧走 WebSocket；tmux 居中额外绕开了 xterm.js scroll-jump 问题族。 |

---

## 2. 横向对比表

| 产品 | 任务-workspace 模型 | engine 集成方式 | UI 技术栈 | server 架构 | 开源情况 |
|---|---|---|---|---|---|
| **Conductor** | workspace = git worktree + branch（Project→Repo→Workspace→Worktree→Running env 六层）；目录名用城市名求稳定，branch 名求语义 | **headless**：自管 binary（`agent-binaries/<agent>/<version>/`）+ `--output-format stream-json` 自绘 chat UI；副路线 Big Terminal Mode 直跑 CLI（Claude/Codex/OpenCode/Amp/Pi/Copilot/Gemini preset）；Cursor 走 API | Tauri 2 + Rust + Web SPA（WKWebView）+ Bun sidecar（本机考古实证） | 单机内 CS：Tauri 主进程 + Bun sidecar 本地 HTTP server + 独立 logger；元数据单 SQLite（sqlx） | ✗ 闭源免费（YC S24，$22M A 轮） |
| **kobe** | Task = git worktree + tmux session + branch；worktree 懒分配；动物名 slug；main task = 项目行 | **tux（tmux Handover）**：tmux 拥有交互式 engine 进程，宿主 attach/send-keys/capture-pane；旁路语义走 hooks + 转录 JSONL + turn detector；Engine Registry 六件套抽象（claude/codex/copilot/custom） | TUI：TypeScript + Bun + React 19 + @opentui；另有 web dashboard（React SPA + SSE + node-pty sidecar） | 单写者 daemon（Unix socket RPC + 通道快照推送 + role 化 refcount）；PTY Host 独立进程；engine 进程永不归 daemon | ✓ 开源（npm `@sma1lboy/kobe`） |
| **opencode** | instance = directory（项目目录），非 worktree 中心；有独立 Worktree service（create/list/remove/reset） | 它自己就是 agent：LLM 经 Vercel AI SDK `LanguageModelV3` 三层抽象（models.dev catalog → config 合并 → lazy adapter）；另有 ACP 入口 | TUI（solid-js + @opentui）、desktop（**Electron** + solid-js）、web；全部消费生成 SDK | **API-first CS 标杆**：protocol 包声明 HttpApi contract → server 实现 → SDK 生成；一个 server 按 `?directory=` 路由多项目实例；transport 三态（TCP/worker-RPC/内存直调）；SQLite event sourcing + projector | ✓ 开源 |
| **agent-deck** | session（可分组、组内 max_concurrent 排队）；worktree 可选（含 jujutsu） | **tux（tmux）**：每 session 一个 detached tmux session；发键走 tmux control-mode 持久进程；状态检测三层：hooks 注入（6 家 engine）→ pane pattern 匹配 → OSC title | TUI：Go + bubbletea；Web UI：Preact + htm + xterm.js over WebSocket | 无 CS 分离：单 Go binary，多进程（TUI/CLI/web）共写一个 SQLite（WAL + heartbeats 协调） | ✓ MIT |
| **opcode** | 无自有任务模型：直接寄生 `~/.claude/projects/` JSONL（一文件=一 session） | **headless 自渲染**：每 prompt spawn 一次 `claude -p … --output-format stream-json --dangerously-skip-permissions`，~6500 行 TSX 重绘全部消息 | React 18 + Tauri 2 + zustand + Tailwind + Radix | 无 server：94 个平铺 `#[tauri::command]`；另可编成 axum web server bin（双形态） | ✓ 开源但 **AGPL-3.0**（代码有传染性） |
| **Cursor Agents** | 执行环境四选一：local / worktree / cloud VM / remote SSH；worktree 集中 root + max-count 自动清理 + `worktrees.json` setup 脚本 | 自家 agent（closed）：结构化事件流自渲染（过程摘要/checkpoints/context ring）；`/worktree` `/best-of-n` `/multitask` 命令 | 桌面 IDE（Electron 系）+ Agents Window 独立顶层界面 | 云 agent 有完整后端（VM/分支/PR/多端接续）；本地部分未公开 | ✗ 闭源商业 |
| **Superset** | workspace = worktree \| branch 二型；`~/.superset/worktrees/<projectId>/<branch>`；每 workspace 预分配 10 端口；adopt 外部 worktree | **混合（内嵌终端 + hooks）**：12 家 agent 只是命令模板（`{command, promptTransport: argv\|stdin}`）；结构化状态靠 lifecycle hooks 归一化 POST 回 host-service；diff 行评论消毒后直接写 agent PTY | Electron + React + xterm.js 6.1（WebGL 全家桶 addon）；web/mobile(RN) 客户端 | **完整 CS**：host-service（独立 Node 子进程，Hono + tRPC + Drizzle/SQLite）+ pty-daemon（独立常驻进程，Unix socket 二进制帧协议，fd-handoff 自升级） | △ Elastic License 2.0（source-available，勿抄代码） |
| **cmux** | workspace = 垂直 tab，不管 worktree/branch 生命周期（隔离交给用户） | **tux 原生**：libghostty 直接渲染任意终端 agent；agent 等输入时蓝 ring 通知；socket API 全量可编程 | Swift（AppKit）+ libghostty | 无 server（单机 app + socket API） | ✓ GPL-3.0（思路可借鉴，代码传染） |
| **Emdash** | task = worktree + branch（含 SSH 远程） | headless 自渲染为主；9+ engine CLI 自动探测 | Electron + TypeScript + SQLite | 单体 Electron | ✓ Apache-2.0（可安全参考代码） |
| **Claude Squad** | instance = worktree + tmux session | **tux（tmux）** | Go TUI | 无 | ✓ 开源 |
| **Sculptor** | task = **Docker container**（非 worktree），Pairing Mode 双向同步回本地 | 自渲染 + 内嵌终端；Claude Code / 自家 Pi 深度集成 | 桌面壳 + Python 后端 | Python 后端 | ✓ MIT |
| **vibe-kanban** | kanban 卡片 → workspace（worktree + branch + terminal + dev server） | 自渲染；10+ engine（最广） | Web：Rust 后端 + TS 前端 | Rust HTTP server（自托管） | ✓ Apache-2.0（公司已死，社区维护） |

**渲染路线分野速记**（详见 [landscape.md](./landscape.md)）：自渲染派 = Conductor/Crystal/vibe-kanban/Emdash/Sculptor/opcode；tux 派 = cmux/Claude Squad/kobe/agent-deck；混合派 = Superset（内嵌终端 + hooks + diff 面板）。**Coolie 的 "tux 优先、headless 兜底" 属于混合派，与 Superset 同构。**

---

## 3. 对 Coolie 的设计启示（逐项映射 Context.MD）

### 3.1 CS 架构（client / server / CLI）

**研究支持**：这是 Coolie 最结构性的差异点，但已不再独有。
- 架构蓝本按优先级：**opencode**（API-first：protocol contract → server → SDK 全生成；一个 server 按 directory 路由多项目实例，`InstanceStore` 的 Deferred 并发去重 + reload/dispose 状态机值得逐行搬，[opencode.md](./opencode.md) §3.2）→ **kobe daemon**（单写者 + 通道快照 + `role:"gui"/"pane"` refcount 惰性关停，[kobe.md](./kobe.md) §3.2）→ **Superset**（三层进程拓扑：薄 UI 壳 → host-service → pty-daemon，PTY 存活与 UI 和 server 升级都解耦，[superset.md](./superset.md) §0/§7）。
- 事件流采用 opencode 的**双通道语义**：live SSE（heartbeat/disposed，不承诺 replay）+ durable per-session 事件（seq 游标 replay），不要用一条流满足两种语义。
- 存储：单 SQLite（Conductor 的 sqlx + migration_rollbacks、opencode 的"索引列提升 + JSON data 列"折衷、agent-deck 的防误删三件套：拒绝空 sweep / 破坏性写前 .bak / 幂等 ALTER）。
- **修正建议**：① PTY 服务放 server 侧（node-pty + WebSocket），Tauri client 纯做渲染——PoC 实测 tauri-plugin-pty 有 tokio 线程耗尽缺陷，且 server 侧 PTY 天然让 GUI/CLI/浏览器三端看同一 session（[tauri-terminal-poc.md](./tauri-terminal-poc.md) 结论 2）；② 终端字节走 WS 二进制帧、控制面走 HTTP API，不要把 PTY 输出塞进 JSON（Superset 教训）；③ server 暴露端口时照抄 agent-deck 的安全默认值：非 loopback 无 token 拒绝启动。

### 3.2 React + Tauri client

**研究支持**：路线已双重验证——Conductor 本体就是 Tauri 2 + Web SPA（[conductor-local.md](./conductor-local.md) §4），PoC 已实测 Tauri 2 + PTY + xterm.js 跑通 claude TUI 全链路。
- 终端渲染器选 **xterm.js 6（WebGL + canvas/DOM fallback）**；ghostty-web 五项硬伤（滚轮无坐标、Cmd+A 漏写、WASM 内存损坏、attach 停滞、addon 缺失）进观察名单（[tauri-terminal-poc.md](./tauri-terminal-poc.md) 结论 1）。
- 桌面质感组合：`decorations:false + transparent + macOSPrivateApi + window-vibrancy` 自绘 titlebar（opcode 验证，[opcode.md](./opcode.md) 工程化经验 1）。
- **修正建议**：① macOS entitlements 必须关 App Sandbox 才能 spawn 任意 CLI → 上不了 Mac App Store，走 DMG + notarization（opcode 教训）；② 自定义菜单必须保留 Edit 子菜单系统角色项，否则 Cmd+C/V/A 全废（Tauri #2397 一族）；③ 双传输适配层（Tauri invoke / REST+WS）参考 opcode 的 apiAdapter.ts，但 server 是第一公民、Tauri 只是壳。

### 3.3 TS + 依赖注入 server（参考 opencode）

**研究支持**：opencode 的 DI 本质是"ALS 传 instance 级上下文 + namespace service + lazy state + dispose 注册表"，[opencode.md](./opencode.md) §4.1 给了 ~40 行可用简版。
- **修正建议（重要）**：**抄旧不抄新**。opencode 当前版已全面迁移 Effect 4.0 beta（LayerNode/ManagedRuntime/EffectBridge），那是 50+ service 大团队迁移期的产物，对单人项目是负资产。Coolie service 数量预计 <15，ALS 简版足够。运行时选型注意：node-pty 不能跑在 Bun 下（kobe/Superset 都被迫用 Node sidecar）——server 若要内置 PTY，直接选 Node 或把 PTY 拆独立进程。

### 3.4 CLI

**研究支持**：kobe 的 CLI 面是最完整范本——`kobe api` 分级 schema（紧凑索引/--verb/--group）+ fan-out（一个 prompt 并行 N 任务）+ 配套 skill 让 coding agent 自己驱动 orchestrator（[kobe.md](./kobe.md) §9.1/9.2）。
- **修正建议**：① 同时做 URL scheme（`coolie://prompt=…`），Conductor deep links 证明这是 Raycast/脚本接入的最短路径，但注意其格式不统一的教训，设计成标准 URL 结构；② 未知子命令报错退出而非落进 TUI（kobe 纪律）；③ CLI 走 opencode 式"内嵌 transport"（内存直调同一 API），本地零端口。

### 3.5 tux 优先（引擎自渲染 TUI），headless 兜底

**研究支持**：这是被验证最充分的决策，但注意两点前提修正。
- **命名**："tux" 高置信为 tmux 笔误，实指 kobe 的 tmux Handover 模型；建议把 Context.MD 措辞改为 "tmux-hosted engine TUI" 消除歧义（[tux.md](./tux.md)）。
- **论证基础更换**：kobe 引用的 Anthropic 2026-06-15 计费政策**已被暂停从未生效**；tux 优先的理由改为 ① 政策风险不对称（交互式使用穿越了 Anthropic 四次政策变动始终安全，headless 恰好落在被封杀过一次的类目）② 维护成本（kobe v0.5 自渲染被整体推翻；opcode 6500 行渲染层常年 breakage）③ 当前 headless 无额外成本，可放心做旁路语义通道（[tux.md](./tux.md) 补充研究）。
- **渲染红利**：tmux 居中还绕开了 xterm.js 的 scroll-jump 问题族（claude TUI 暴力重画被 tmux 吸收为增量流，3MB 输出只透传 145KB），也让 PTY 插件吞吐瓶颈无关紧要（[tauri-terminal-poc.md](./tauri-terminal-poc.md)）。
- **旁路语义三件套**（tux 模式下拿结构化状态，kobe/agent-deck/Superset 三家共识）：① engine hooks 注入（Claude settings.json / Codex hooks.json——同构 schema 一个 adapter 通吃，但 Codex 有 trust 门需 UI 引导）；② Codex `notify` / OSC title（`-c tui.terminal_title=["activity","thread-title"]` 白送状态指示）；③ 转录 mtime 轮询兜底。**绝不 scrape 屏幕 pattern**（agent-deck 60+ 个按 issue 编号命名的测试就是代价）。
- **headless 兜底的正确姿势**：Claude 走 `-p --output-format stream-json`；Codex 直接上 app-server（`turn/diff/updated` 聚合 diff、审批反向 request、`thread/list` 都是白送的，[codex.md](./codex.md)）；将来做统一自渲染抽象优先押 ACP 而非逐引擎适配。若做兜底渲染，只做三档：markdown / 通用 tool 卡片 / diff，不按工具枚举 widget（opcode 反面教材）。
- **engine 抽象**：kobe Engine Registry 六件套（identity/capabilities/history/hooks/turn-detector/terminal-title）+ Noop/Unknown/EMPTY 降级模式 + "engine-owned UI data"（UI 禁止硬编码 vendor 字符串）；id 生命周期差异要进抽象（claude=客户端造 id via `--session-id`，codex=服务端造 id 需"先启动后回填"）。agent-deck 的每 engine 一组硬编码字段是反面教材。

### 3.6 workspace = repo + branch（kobe 的 task = worktree + tmux session + branch）

**研究支持**：全品类收敛到同一数据模型，直觉正确。完整配方 = Conductor 六层模型 + kobe 懒物化：
- 目录：集中 root（`~/.coolie/worktrees/<repo>/<name>`），repo root 用用户已有 checkout 不强制迁移；双命名体系（目录名用随机池求稳定、branch 名求语义，Conductor 城市名 / kobe 动物名）。
- 创建：懒 worktree（createTask 只记意图，首次进入才落盘）+ slug 分配器 + 自清理回滚（失败绝不留孤儿目录）；`git fetch` → 从 `origin/<base>` 建分支 → `worktree add --no-track -b`；先 `git worktree prune`（Superset 踩坑）；写 `branch.<name>.base` 记录 base 供 diff 面板用（Superset）；`extensions.worktreeConfig` + per-worktree `push.autoSetupRemote`（Conductor）。
- worktree 三痛点的标准解：**setup scripts**（三层合并：repo 共享 → 本机覆盖 → local overlay，注入 `$ROOT_PATH` 变量，可见终端里执行）+ **`.worktreeinclude`**（gitignore 语法声明要复制的 gitignored 文件，Conductor/agent-deck/Claude Desktop 三家同名约定）+ **每 workspace 端口段**（Conductor/Superset 都是 10 个）。
- 工具目录注入用 `.git/info/exclude` 而非 `.gitignore`（Conductor 的 `.context/` 手法，零仓库污染）。
- 清理：archive（翻 flag 非破坏）与 delete（脏树二次确认、失败保留索引条目）分离；branch 一律保留；adopt 外部 worktree（kobe/Superset 都支持）。
- **修正建议**：checkpoint 语义直接用 git（Conductor 的 `refs/<app>-checkpoints/<id>` 私有 ref 方案，不动 HEAD、可恢复 untracked），不要学 opcode 自建 content pool。

### 3.7 右侧 diff / terminal 面板

**研究支持**：diff review 是 Conductor 打磨最狠、也是 Coolie 相对纯终端派（cmux/kobe）的核心增值。
- 布局抄 Cursor：右栏默认收起为一列文字入口（Changes/Terminal/Files），不抢中央 tux 终端宽度；Browser 面板第一阶段砍掉（[cursor.md](./cursor.md) 建议 3）。
- **diff 数据是引擎无关的**：git CLI in worker 线程（大 repo 不卡主进程）+ 四分区（against-base/committed/staged/unstaged）+ `git diff --shortstat` 轮询在 sidebar 显示 `+N −M`（Superset/Cursor 做法，这是不依赖 engine 就有的最有信息量状态位，优先做）。
- 渲染候选 `@pierre/diffs`（全文对比 + shiki 高亮，Superset 在用；许可需复核）。
- **混合路线闭环（Superset 已验证）**：diff 行内评论 → 格式化为 `In <path>:L<start>-L<end>: <comment>` → `sanitizePromptForPty` 消毒 → 写回 agent PTY。不自渲染对话流也能做出"圈行评论 → agent 改"的核心体验。数据模型参考 Conductor `diff_comments` 表（thread/reply/resolved/outdated）。
- terminal 面板：ZDOTDIR 包装（不破坏用户 zsh 配置）+ OSC 633 命令边界上报 + `rehydrate_sequences` 序列重放持久化（Conductor 三件套）；"Open in iTerm/Warp" 轻集成（`default_open_in` + MRU）；**"用 $EDITOR/VS Code 打开 worktree" 的逃生舱必须有**（Cursor 有 IDE 兜底，Coolie 没有自己的编辑器）。

### 3.8 底部输入框（模型选择、effort、附件）

**研究支持**：需求与 Conductor sessions 表字段一一对应（每 session 独立 model/permission_mode/effort/fast_mode）。
- **关键架构判断（Cursor 研究）**：tux-first 下会话中输入发生在 engine 自己的 TUI 里，外面不要再套聊天输入框（双输入焦点混乱）；Coolie 的富输入框定位是 **New Task 创建框**：prompt + 模型/effort（映射为启动参数）+ 附件 + base branch + 执行环境。
- 模型×context×effort 合并为单选择器（Cursor "Opus 4.8 1M High"），选项由 per-engine adapter 提供（codex effort 档位 none/low/medium/high/xhigh 已实测）。
- prompt 投递抄 kobe 踩坑结晶：画面稳定检测 → bracketed paste → **延迟 150ms 再发 Enter**；`send-keys -l --`；prompt 消毒（剥 CSI/OSC/控制字符，Superset `sanitizePromptForPty`）。
- 底部状态条三件套：`⑂ branch`、`⌸ This Mac`、context 占用环（tux 模式拿不到 context，headless 再做）。
- 参考 opcode FloatingPromptInput（模型选择/图片附件/斜杠命令 picker）与 Conductor 的 composer-drafts（每 session 输入框草稿持久化）。

### 3.9 快捷键（丰富 + macOS 原生 ctrl+a/ctrl+e）

**研究支持**：三家成熟范本可拼成完整 spec。
- **结构**：单一注册表（kobe KobeKeymap / Superset 77 键 HOTKEYS_REGISTRY，帮助页/footer/绑定三处从表渲染）+ LIFO binding stack + modal barrier（kobe）+ 上下文分层（Conductor：每个键声明生效上下文，单字母键只在非输入区生效）+ YAML/JSON 用户覆盖 + `⌘/` cheatsheet + `⌘K` palette 兜底。
- **终端焦点仲裁（Superset 三层，tux 渲染必抄）**：`attachCustomKeyEventHandler` 里 ① 注册表反查命中 → bubble 给 app；② 行编辑翻译表：Shift+Enter/Cmd+Enter → `ESC CR`、Cmd+Backspace → `\x15`、Cmd+←/→ → `\x01/\x05`、Option+←/→ → `ESC b/f`——**这正是 Context.MD 要的 macOS 原生行编辑键的翻译表**；③ macOS 所有 Cmd chord 一律不进 PTY（Ghostty/VS Code/Superset 三家共识）。其余最大化透传给 engine TUI。
- **Ctrl+A/E 本身**：终端 pane 内天然进 PTY 由 shell/readline 处理（PoC 已验证 JS 层 Ctrl+A/E/K/C 正确产生控制字节）；自绘输入框由 WebKit textarea 天然提供 emacs 键位——把全局快捷键约束在 Cmd 空间即可避开冲突。
- 键位选型铁律（kobe 决策记录）：ctrl+字母是唯一零协商可靠的 chord；shift+字母终端表达不了；alt+数字被 Raycast 吃掉。高频操作单修饰键梯度照抄 Cursor（Cmd+N/T/W/[/]/1-9）。
- 嵌入终端统一 `TERM=xterm-256color` + 剥 `TERM_PROGRAM`（kobe Terminal Identity Boundary）。

### 3.10 macOS 优先

**研究支持**：品类头部（Conductor/cmux/Superset）全部 macOS 优先，正确侧。
- macOS 专属工程细节已集齐答案：GUI app PATH 死穴 → opcode claude_binary.rs 的多路径发现 + 版本择优 + env 白名单；tmux 发键延迟 → agent-deck control-mode；TCC 弹窗以宿主 app 名义出现；`ANTHROPIC_API_KEY` 覆盖订阅计费的坑要显式提示。
- agent binary 管理抄 Conductor：`agent-binaries/<agent>/<version>/` + sha256 meta + PATH shim（或第一阶段直接用系统二进制 + 发现逻辑，opcode 的 sidecar 教训：打包锁版本 = 永远落后）。
- 无沙箱就在文档明示（Conductor 同款声明）；tmux 是 macOS 非自带依赖（`brew install tmux`），用专用 `-L` socket 隔离。

---

## 4. kobe 功能追平清单

提炼自 [kobe.md](./kobe.md) §9（完整细节见原文），按 Coolie 里程碑分组。勾选表示 Coolie 已实现对等能力（当前全部未实现）。

### M1 核心循环（task 生命周期）
- [ ] 创建 task（懒 worktree：先记意图，首次进入才 `worktree add`）
- [ ] slug 分配器（随机名池 + 占用集去重 + 失败回滚）
- [ ] 自动 branch 命名（`coolie/<title-slug>-<id6>` 式）+ 手动改 branch
- [ ] 进入/切换 task（ensure-or-heal session → attach；observe→decide→apply 三段式）
- [ ] task 状态机：backlog / in_progress / in_review / done / canceled / error
- [ ] archive（非破坏翻 flag）/ delete（脏树二次确认、失败保留索引）/ pin
- [ ] main task（项目行：钉在 repo 根、无 worktree、不可删）
- [ ] 自动标题（转录首条 user 消息派生，无模型调用）
- [ ] adopt 已有 worktree（`worktree list --porcelain` 枚举 + 收养）
- [ ] 保存/忘记项目（`add` / `remove`，canonical key 匹配）

### M2 engine 集成
- [ ] Engine Registry：claude / codex（/ copilot）+ custom engine（id + 启动命令）
- [ ] 能力位六件套：defaultCommand / history reader / detectAccount / hook adapter / turn detector / capabilities（+ Noop/Unknown/EMPTY 降级）
- [ ] 启动命令流水线：用户覆盖 → default → effort 注入 → terminal title 注入 → session-id 注入（claude）→ system prompt 协议注入
- [ ] keep-alive 包装（engine 退出落 shell 不塌布局 + 非零退出横幅）+ SIGINT guard
- [ ] 首条消息投递（画面稳定检测 + bracketed paste + 150ms 延迟 Enter）
- [ ] hooks 注入（幂等、可 opt-out、绝不拉起 daemon、永远 exit 0）→ 活动徽标
- [ ] turn 状态检测（hook 事件 + 转录 mtime 轮询兜底 + tab 状态 ●/✓/!/○）
- [ ] vendor 切换（respawn engine pane 保住兄弟 tab）
- [ ] 会话 resume（死 engine tab 用 `--resume <sessionId>` 拉回）

### M3 会话层（tmux/PTY）
- [ ] 专用 tmux socket（`-L coolie`）+ session 命名 `coolie-<task-id>`
- [ ] ChatTab（一 worktree 多条并行 engine 会话）+ 新开/关闭/重命名/循环切换
- [ ] pane 角色标签（`@role=tasks|engine|ops|shell`）+ session 标签反查任务
- [ ] 布局：固定宽 rail + engine 主 pane + ops/shell 列；用户拖动几何持久化
- [ ] attach 前 fit + heal 布局（防首帧 reflow 闪烁）+ resize hook 自愈三件套
- [ ] Zen 模式（折叠到 engine pane，会话级持久）
- [ ] PTY Host 独立进程（ring buffer 重放 + idle 自退 + PTY parking）——GUI 路线的 tmux 替代层
- [ ] daemon 重启不杀 engine 会话（进程所有权分离）

### M4 daemon / CLI / API
- [ ] 单写者 daemon + Unix socket RPC + 通道快照推送（last-value replay）
- [ ] role 化 refcount（gui 持有生命周期 / pane 不持有）+ 惰性关停
- [ ] `coolie api` 脚本化面：list/get/collect/add/fan-out/send/dispatch/rename/set-status/archive/pin/delete/ensure-worktree/adopt…
- [ ] fan-out（一个 prompt 并行 N 任务，`--agents claude:2,codex:1`）
- [ ] 分级 schema 发现（紧凑索引 / --verb / --group）+ agent skill 分发
- [ ] daemon start/stop/status/restart、doctor（只读诊断）、reset（永不碰 worktree）
- [ ] 后台 collector：PR 状态、worktree 未提交变更计数、转录活动、auto-title
- [ ] shell 补全、自更新检查、export（csv/json）

### M5 面板与 UX
- [ ] Tasks 面板全键位（n 新建/a 归档/d 删除/r 改名/b 改分支/v 换引擎/搜索/项目过滤/手动排序/置顶）
- [ ] Ops/Files 面板：文件树 + diff 查看 + `@<path>` 注入 engine + Create PR prompt 模板（可被 repo 内文件覆盖）
- [ ] Settings 六节：General / Engines / Accounts / Keybindings / Feedback / Dev
- [ ] keymap 单表 + binding stack + modal barrier + keybindings.yaml 用户覆盖（平台 overlay / null 解绑 / 校验拒绝坏键）
- [ ] repo init 契约：`.coolie/init.sh` + `init-prompt.md` + watchdog 超时 + once-per-worktree 标记
- [ ] 主题 / i18n / toast / 声音
- [ ] web dashboard（同 daemon 的浏览器前端，可后置）

### 刻意不追（kobe 有但 Coolie 不需要）
- 双 UI 栈并存（tmux Handover + Workspace Host 的 parity 维护税——Coolie 定死 Tauri client 避开）
- dispatcher/field-notes 知识路由（实验特性）
- SSH 远程项目（后置；CS 架构做好后近乎免费）

---

## 5. 开放问题汇总

各文档 open questions 中仍未解决的，按影响排序：

1. **"tux" 命名未与作者当面确认**（[tux.md](./tux.md)）——全部方案建立在 "tux = tmux Handover" 的高置信推断上。行动项：确认后把 Context.MD:5,10 改成明确措辞（如 "tmux-hosted engine TUI"）。
2. **Anthropic 计费政策是移动靶**（[tux.md](./tux.md)）——Agent SDK 订阅政策处于"暂停"态，官方明言会重做。行动项：把 support.claude.com 政策页列入定期复查；设计上把"计费归属"当可变外部参数，不写死。
3. **Tauri 终端的 5 分钟人工清单未跑**（[tauri-terminal-poc.md](./tauri-terminal-poc.md)）——真实中文 IME、真实键盘 Ctrl+A/E 穿透、Cmd+C/V 菜单在场/缺席、死键布局、长会话 WebGL context loss。均为低风险但需人工验证。
4. **Codex app-server 协议漂移**（[codex.md](./codex.md)）——0.139.0 与 HEAD 方法集已明显不同；`codex fork` 确切引入版本未考证；Conductor 新版是否已从 exec --json 迁去 app-server 未复核。对策：pin 版本 + generate-json-schema + unknown-variant 探测。
5. **opencode 旧版 `App.provide`/`Instance.state` 原始实现未验证**（[opencode.md](./opencode.md)）——shallow clone 无历史；§4.1 简版语义基于训练知识重构。需要时 `git fetch --unshallow` 核对。
6. **Conductor 若干实现细节未验证**（[conductor.md](./conductor.md)/[conductor-local.md](./conductor-local.md)）——codex 驱动协议已由 codex.md 定性为 codex-sdk（旧样本），但新版未复核；`~/.conductor/projects/**` 空目录用途、传给 claude 的完整命令行参数、通知机制细节仍未知。
7. **`@pierre/diffs` 许可与离线可用性未复核**（[superset.md](./superset.md)）——作为 diff 渲染候选使用前必须确认。
8. **Superset 运行时行为未考古**（[superset.md](./superset.md)）——数据目录布局、daemon socket 路径、fd-handoff 升级真实成功率；需要时装 app 后按 conductor-local.md 方法补。
9. **xterm.js 7.0 PR #5770（synchronized output）时间表为二手信息**（[tauri-terminal-poc.md](./tauri-terminal-poc.md)）——落地后 scroll-jump 问题域会变化，建议每季度重跑 PoC 剧本。
10. **agent-deck / kobe 若干长尾未读**（[agent-deck.md](./agent-deck.md)/[kobe.md](./kobe.md)）——MCP 池内存节省数字未实测；kobe 的 export/theme/skill 实现、web dashboard 完整页面清单未读。优先级低。
11. **opencode `packages/cli`（bin 名 `lildax`）用途不明**（[opencode.md](./opencode.md)）——与主 CLI 关系未查明，优先级低。
12. **上游风险持续项**（[landscape.md](./landscape.md)）——Anthropic/OpenAI 官方 UI 扩张可能吞掉品类基本盘；Superset/Sculptor 迭代极快（调研当天均发版），Coolie 差异化叙事（Tauri 轻量、无账号无云、个人品味）需持续校验。
