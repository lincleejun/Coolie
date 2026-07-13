# agent-deck 源码调研

- 仓库：https://github.com/asheshgoplani/agent-deck
- 本地：`/Users/outman/workspace/ai/personal_ai/Coolie/refs/agent-deck`
- 调研基线 commit：`f70f19e`（v1.10.9，2026-07-02）
- 规模：约 1150 个 Go 文件，纯 Go 单 binary（`go.mod`：module `github.com/asheshgoplani/agent-deck`，go 1.25）

以下引用形如 `文件:行号`，均相对 repo 根目录。

---

## 1. 概述：它是什么、解决什么问题

Agent Deck 自称 "mission control for your AI coding agents"（README.md:34）：当你在十几个项目上同时跑 Claude Code / OpenCode / Codex 等 agent 时，用一个 TUI（外加可选 Web UI 和 CLI）统一看到每个会话的状态（running / waiting / idle / error），一键切换、fork、分组、搜索、算钱，并可通过手机（Telegram/Slack/Discord）远程指挥一个 "conductor" 编排会话来管理整个 fleet。

与 Coolie 的定位重叠度很高：**它同样不做 coding agent 本身，只做多 engine 会话的"环境伴侣"**，并且同样把 `git worktree + tmux session + branch` 作为隔离单元（与 kobe 的 task 概念一致）。差异在于：agent-deck 以 TUI 为主界面（Go + bubbletea），无桌面客户端，无 server/client 分离，全部逻辑塞在一个 Go 进程/binary 里。

---

## 2. 管理 agent 的方式：tmux（核心结论）

**每个 session = 一个 detached tmux session**，agent 进程作为 pane 初始进程运行：

- 创建：`tmux new-session -d -s <name> -c <workdir> [bash -c '<command>']`（internal/tmux/tmux.go:1086，`startCommandSpec`）。
- Linux 上可选用 `systemd-run --user` 把 tmux 包成 service（`Type=forking` + `Restart=on-failure`）或 scope，实现崩溃自愈；macOS 走 direct tmux（internal/tmux/tmux.go:1103-1140，三层 fallback：service → scope → direct）。
- tmux socket 隔离：session 记录创建时的 `-L <socket>` 选择器并持久化，之后所有生命周期操作固定打同一 socket，避免 config 改动后 session 变孤儿（internal/session/instance.go:239-255，`TmuxSocketName` 字段注释）。
- **发送输入**：不是每次 fork+exec `tmux send-keys`，而是开一个持久的 `tmux -L <socket> -C` control-mode 子进程，把 `send-keys -l` 命令流式写进它的 stdin。注释明确说 macOS 上每次 fork+exec 要 10-50ms，用户能感到逐键延迟，control-mode 降到 <1ms（internal/tmux/keysender.go:11-19、91）。**这是 macOS 上做 tmux 桥接的关键性能细节。**
- **attach**：TUI 直接 attach tmux；Web UI 用 `creack/pty` 起一个 PTY 跑 `tmux attach`，通过 gorilla/websocket 桥到浏览器 xterm.js（internal/web/terminal_bridge.go:43-90、277 `tmuxAttachCommand`）。resize 通过 PTY SIGWINCH 让 tmux 自己仲裁窗口尺寸（terminal_bridge.go:161-190 注释）。
- SSH 远程 session：`SSHHost`/`SSHRemotePath` 字段（instance.go），ssh ControlMaster 复用连接，专门处理 stale ControlPath socket 导致的永久挂死（internal/session/ssh.go:34-62，issue #1421）。

**没有无头/API 模式的自渲染**——agent-deck 完全依赖 agent 自身的 TUI 在 tmux pane 里渲染，自己只做状态侦测和键盘转发。这与 Coolie "优先 tux 渲染" 的路线完全一致，可视为该路线的规模化验证。

## 3. 状态检测（它最重的技术投资）

判断"agent 在干活 / 等输入 / 空闲"是这类工具的灵魂。agent-deck 用了三层信号：

1. **Hooks（最准）**：向 Claude Code 的 `settings.json` 注入 `agent-deck hook-handler` 命令 hook（internal/session/claude_hooks.go:15、40-68），订阅 SessionStart / UserPromptSubmit / Stop / PermissionRequest / Notification / SessionEnd / PreCompact。hook-handler 是同一 binary 的子命令，把状态写成 `~/.agent-deck/hooks/{instance_id}.json` 原子文件（cmd/agent-deck/hook_handler.go:66-70），TUI 用 fsnotify 监听。Gemini / Codex / Copilot / Cursor / Hermes 也有对应 hooks 注入文件（internal/session/gemini_hooks.go、cmd/agent-deck/codex_hooks_cmd.go 等）。
2. **tmux pane 内容 pattern 匹配（fallback）**：per-tool 的 busy/prompt 字符串与正则，如 Claude 的 `esc to interrupt`、spinner+省略号正则，OpenCode 的 `thinking...` 等（internal/tmux/patterns.go:39-70，`DefaultRawPatterns`）。注释里全是"Claude 2.1.25+ 改了 UI"式的版本适配说明——**极其脆弱，维护成本高**。
3. **tmux pane title（OSC 序列）**：Claude Code 干活时 pane title 是 braille spinner 字符（U+2800-28FF），完成时是 done marker（✳✻✽✶✢）（internal/tmux/title_detection.go:11-22）。

hook→status 的推导逻辑曾在 3 处重复实现后被收敛为单一 `internal/sessionstatus` 包（internal/sessionstatus/sessionstatus.go:1-7），供 CLI 冷加载、web 读路径、TUI watcher、transition daemon 共用——这个教训值得直接吸收。

状态枚举：`running / waiting / idle / error / starting / stopped / queued`（internal/session/instance.go:46-59），另有 Substate（"Honest-Status-v2"）解释原因：model-unavailable、auth-401、idle-at-empty-prompt（instance.go:60-74）。`queued` 配合 group 的 `max_concurrent` 实现组内并发上限排队（statedb.go:392-406）。

## 4. UI 技术栈

| 端 | 技术 | 证据 |
|---|---|---|
| TUI（主界面） | Go + bubbletea v1.3.10 + lipgloss + bubbles | go.mod:10-13 |
| Web UI | 后端 Go 内嵌静态文件；前端 **Preact + htm（无构建步骤）+ signals**；终端用 **xterm.js（+fit/webgl addon）over WebSocket**；PWA（service worker + Web Push，webpush-go） | internal/web/static/app/main.js:1-14；internal/web/static/index.html:41-43；go.mod:9（webpush-go） |
| CLI | 同一 binary 的子命令（`agent-deck add/session/worktree/mcp/skill/conductor/web...`） | cmd/agent-deck/ |
| 桌面 App | 无 | — |

Web server 默认 `127.0.0.1:8420`（cmd/agent-deck/web_cmd.go:23）；绑定非 loopback 且无 token 时**拒绝启动**，必须显式 `--insecure` 确认（internal/web/server.go:29-33 `InsecureBind` 注释，称之为 "unauthenticated RCE surface"）——这个安全默认值设计得很好。

TUI 主模型 `internal/ui/home.go` 有 **17941 行**，`internal/session/instance.go` 有 **8595 行**（wc -l 实测）——单体巨型文件，业务逻辑与 UI 强耦合。

## 5. Session / 任务数据模型

**存储：SQLite 单文件**（纯 Go 驱动 `modernc.org/sqlite`，无 CGO；go.mod:39），WAL + busy_timeout + 应用层 BUSY 重试（internal/statedb/statedb.go:64-80 `withBusyRetry`）。

核心表（internal/statedb/statedb.go:347-510）：

- `instances`：id, title, project_path, group_path, sort_order, command, wrapper, tool, status, tmux_session, tmux_socket_name, created_at, last_accessed, parent_session_id, is_conductor, title_locked, worktree_path / worktree_repo / worktree_branch, account, archived_at, auto_name(+description), pin, `tool_data`(JSON), acknowledged。
- `groups`：path（层级如 `projects/devops`）, name, expanded, sort_order, default_path, **max_concurrent**（组内并发上限，超出的 session 进 queued）。
- `instance_heartbeats`：多进程（TUI/CLI/web 同时跑）的存活协调。
- `recent_sessions`：删除后 30 秒 Ctrl+Z undo 用的软删除区。
- `cost_events`：session_id, model, input/output/cache tokens, **cost_microdollars**（1 USD = 1e6，整型避免浮点）, budget_stop_triggered。
- `watchers` / `watcher_events`：外部事件（GitHub/gmail/webhook）唤醒 conductor 的"门铃"。

内存模型 `session.Instance`（internal/session/instance.go:104-260）字段极丰富，重点：

- 谱系：`ParentSessionID`（fork/子会话链）、`IsConductor`、`TitleLocked`、`AutoName`（机器生成名 + 用 Claude pane title 实时显示任务描述，instance.go:127-137）。
- worktree 四元组：`WorktreePath / WorktreeRepoRoot / WorktreeBranch / WorktreeType`（"git" | "jujutsu"）（instance.go:146-150）。
- **每个 engine 一组硬编码字段**：`ClaudeSessionID / GeminiSessionID / OpenCodeSessionID / CodexSessionID / CopilotSessionID` + 各自 DetectedAt / 扫描节流时间戳（instance.go:186-221）。engine 的会话 ID 靠反查各工具自己的存储获得，例如 Codex 用正则从 `~/.codex/sessions/**/rollout-*.jsonl` 路径提取 UUID（instance.go:38）。
- 其他：`Account`（多账号 → CLAUDE_CONFIG_DIR 解析链）、multi-repo、Docker `Sandbox`、`SSHHost`、`Color`、`Notes`、`LatestPrompt`。

**数据安全教训（值得直接抄）**：`SaveInstances` 曾因空 payload 触发 `DELETE FROM instances` 全表清空，发生过三次数据丢失事故；现在空 sweep 直接返回 `ErrRefusingEmptySweep`，且每次破坏性 sweep 前自动 WAL checkpoint + 拷贝 `.bak`（internal/statedb/statedb.go:24-63）。

## 6. 支持的 engine

内置 tool 注册表（internal/session/builtins.go:56-68，单一事实来源，含命令字符串探测规则）：

`claude`、`opencode`、`gemini`、`codex`、`pi`、`copilot`、`crush`、`cursor`（cursor-agent CLI）、`hermes`、`aider`（仅名字保留，无探测规则）、`shell`（catch-all），另支持 config.toml 自定义 `[tools.<name>]`。

各 engine 的能力不均等：fork 仅支持 Claude / OpenCode / Pi / Codex（README.md:137-141）；cost 解析有 claude / gemini / openai / minimax 四个 parser（internal/costs/parser_*.go）；hooks 注入覆盖 claude / gemini / codex / copilot / cursor / hermes。

## 7. 亮点功能（细节）

1. **Fork session（原生续会话）**：quick fork 默认"comprehensive"——新 worktree + 新 branch + 携带父会话未提交的工作区状态 + 匹配父的 Docker 沙箱 + 继承启动参数（README.md:428-436）。Claude 用 `claude --session-id <new> --resume <parent> --fork-session`（internal/session/instance.go:3075-3076），Codex 用 `codex fork <session-id>`。未提交状态搬运在 internal/git/fork_with_state_destination.go；jj 仓库 fork 到新 workspace。
2. **Worktree 生命周期**：`CreateWorktreeWithSetup`（internal/git/setup.go:109）；`.worktreeinclude` 文件用 gitignore 语法声明要复制进新 worktree 的被忽略文件（.env 等，internal/git/worktreeinclude.go，语义对齐 Claude Code Desktop）；`.agent-deck/worktree-setup.sh` / `worktree-destruction.sh` 钩子（`sh -e`、60s 超时、失败不阻断，README.md:275-330）；`worktree finish` 自动 merge 回目标分支并清理（internal/git/mergeback.go）；支持 bare-repo 两种布局与 jujutsu。
3. **Conductor（编排者）**：本身就是一个普通的 claude/codex session（`is_conductor=true`），职责是监控其余 session、按 `POLICY.md` 自动回复、拿不准的升级到手机。目录含 CLAUDE.md/AGENTS.md、POLICY.md、LEARNINGS.md、state.json、task-log.md（docs/conductor/README.md:1-80）。远程通道是一个嵌入 binary 的 Python `bridge.py` 守护进程（internal/session/conductor_bridge.py，经 go:embed 物化到数据目录，conductor/README.md:8-28），支持 Telegram/Slack/Discord，`name: message` 前缀路由到指定 conductor。busy 的 conductor 通过**同步 Stop hook 注入 inbox 消息**实现"干完当前活马上处理排队指令"（claude_hooks.go:47-57 注释）。
4. **Cost tracking**：Claude 的 Stop hook payload 直接带 usage（internal/costs/parser_claude.go:12-40），入 `cost_events` 表，microdollars 整型计价（internal/costs/costs.go:8-19），有 per-session/daily 聚合、预算停止（budget.go）、TUI `$` Cost Dashboard 和 web 端图表。
5. **MCP Manager + Socket Pool**：config.toml 里声明 MCP，一键 per-session/global attach（TUI `m`）；`pool_all = true` 时用 Unix socket 代理让所有 session 共享同一 MCP 进程，号称省 85-90% 内存，崩溃后 ~3s 自动重连（README.md:224-226；internal/mcppool/socket_proxy.go、pool_simple.go）。
6. **Skills Manager**：从 pool 目录（`~/.config/agent-deck/skills/pool`）attach/detach skill，状态写 `.agent-deck/skills.toml` 并物化到项目 `.claude/skills`（README.md:152-159）。
7. **Docker sandbox**：session 可跑在容器里，项目目录 bind-mount，host 的 claude/codex 凭据自动共享进容器（macOS 从 Keychain 提取）（README.md:400-415；internal/docker）。
8. **多账号/Profile**：`CLAUDE_CONFIG_DIR` 六级解析链 env > conductor > group > profile > global > default（README.md:210-222）；`session switch-account` 能把会话文件迁移到另一账号的 config dir 并 `--resume` 重启（README.md:236-238）。
9. **通知**：waiting session 显示在 tmux status bar 并可按数字跳转（README.md:262-268）；Web Push；Telegram。
10. **组织性功能**：层级 groups + 组内并发上限排队、archive（保留 worktree 与对话，仅停进程）、pin、行颜色、fuzzy search + 状态过滤（`!`/`@`/`#`/`$`）+ 跨全部 Claude 对话的全局搜索 `G`（README.md:228-233）。

## 8. 与 Coolie 相关的可借鉴点

1. **路线验证**：agent-deck 证明了 "tmux 多路复用 + 不自渲染 agent UI + 反查 engine 自身会话存储" 在几十个并发 session 规模下可用。Coolie 的 tux 优先策略与其完全同构，可以放心走。
2. **Web/桌面端嵌终端的现成模式**：`PTY(tmux attach) ↔ WebSocket ↔ xterm.js`（terminal_bridge.go），resize 交给 tmux 仲裁。Tauri client 完全可以复用这个模式对接 Coolie server。
3. **KeySender**：macOS 上逐键 `tmux send-keys` fork+exec 会造成可感知延迟，必须用持久 control-mode client（keysender.go:11-19）。Coolie server 的 tmux 桥要一开始就这么设计。
4. **状态检测分层**：hooks（结构化、准）→ pane pattern（fallback）→ pane title OSC。并且把推导逻辑收敛成单一纯函数包（internal/sessionstatus），避免多端各写一份。Coolie 有 server 层，天然适合把它做成 server 内唯一 owner。
5. **Claude hooks 注入清单**可直接参考：SessionStart / UserPromptSubmit / Stop(sync) / PermissionRequest(sync) / Notification(matcher: permission_prompt|elicitation_dialog) / SessionEnd / PreCompact（claude_hooks.go:40-68）。同步 Stop hook 还能实现"给忙碌 agent 排队注入消息"。
6. **worktree 工程细节直接抄**：`.worktreeinclude`（gitignore 语法、只复制"被忽略且匹配"的文件）、setup/destruction 脚本约定（env 变量 `*_REPO_ROOT`/`*_WORKTREE_PATH`、`sh -e`、超时、失败不阻断）、worktree finish 的 merge-back、sibling/subdirectory/custom 三种落位策略。
7. **SQLite 防误删三件套**：拒绝空 sweep（ErrRefusingEmptySweep）、破坏性写前自动 .bak、schema 迁移"每个新列必须有 idempotent 的 ALTER TABLE"（statedb.go:24-63、513-520 注释）。
8. **cost 用整型 microdollars**、fork 的 "comprehensive by default, tweak down" 交互、删除的 30s undo 窗口、archive 与 delete 分离——都是打磨过的产品决策。
9. **安全默认值**：web server 非 loopback 无 token 直接拒绝启动（server.go:29-33）。Coolie server 对 client 暴露端口时应照抄。
10. **MCP socket pool** 的思路（多 session 共享 MCP 进程）在 Coolie 多 workspace 场景同样适用。

## 9. 风险与应避免的点

1. **无抽象的 engine 集成**：`Instance` 结构体上每个 engine 一组硬编码字段（ClaudeSessionID/GeminiSessionID/CodexSessionID/CopilotSessionID... instance.go:186-221），加一个 engine 就要改核心 struct + statedb `tool_data` + 十几处 switch。Coolie 应按计划参考 opencode 做 provider/engine 接口抽象，这是与 agent-deck 拉开质量差距的关键点。
2. **UI 字符串 pattern 检测极脆弱**：patterns.go 里满是"Claude 2.1.25+ 改版"式补丁；仓库里有大量 `issue*_test.go`（internal/session 下按 issue 编号命名的测试超过 60 个），大部分与状态误判/竞态相关。启示：能走 hooks / 结构化事件就绝不 scrape 屏幕；pattern 只做最后兜底且要可配置。
3. **单体巨型文件**：home.go 17941 行、instance.go 8595 行、tmux.go 5380 行。TUI 事件循环、业务规则、持久化混在一起。Coolie 的 server + DI 分层要坚持住。
4. **多进程共写一个 SQLite** 带来 heartbeats 表、BUSY 重试、原子文件等大量防御性代码（statedb.go:64-80、instance_heartbeats 表）。Coolie 采用常驻 server 独占状态、client/CLI 走 API，可整体规避这类复杂度。
5. **conductor bridge 是嵌入的 Python 脚本**（conductor_bridge.py 经 go:embed 物化，conductor/README.md:8-28）——跨语言部署面（用户机器要有 python3 + venv），教训是远程通道最好用宿主语言实现。
6. tmux 依赖的固有限制：Windows 只能 WSL（README.md:44）；tmux server 版本差异、socket 管理、zombie 清理都要自己兜（internal/tmux/zombie_reap.go、ensure_pids_dead.go、version_warning.go）。Coolie 以 macOS 优先，风险可控，但要预留 socket 隔离（`-L`）与固化 socket 名的设计。
7. **它没有 Coolie 想要的东西**：没有 diff/code review 面板（web 有 worktree finish 但无 diff 视图）、没有富输入框（模型选择/effort/附件）、没有桌面 app。这些正是 Coolie 相对它的差异化空间；反过来 agent-deck 的 fleet 管理（conductor/watcher/telegram）超出 Coolie 个人定位，不必跟进。

## 10. 来源清单

- 代码（本地 clone，commit f70f19e）：
  - README.md（定位、功能清单、快捷键、worktree/fork/conductor 文档）
  - internal/session/instance.go:38,46-74,104-260,3075-3076（数据模型、状态、fork 命令）
  - internal/session/builtins.go:56-68（engine 列表）
  - internal/session/claude_hooks.go:15,40-68（hooks 注入）
  - cmd/agent-deck/hook_handler.go:20-70（hook-handler 状态文件）
  - internal/sessionstatus/sessionstatus.go:1-7（状态推导收敛）
  - internal/tmux/tmux.go:1020-1160（tmux 启动、systemd 模式）
  - internal/tmux/keysender.go:11-19,91（control-mode 键入）
  - internal/tmux/patterns.go:39-70、internal/tmux/title_detection.go:11-22（pattern/title 检测）
  - internal/statedb/statedb.go:24-80,347-510（SQLite schema、防误删）
  - internal/web/server.go:20-33、terminal_bridge.go:43-90,277、static/index.html:41-43、static/app/main.js:1-14（Web 栈）
  - internal/git/setup.go:109、worktreeinclude.go、mergeback.go、fork_with_state_destination.go（worktree）
  - internal/costs/costs.go:8-19、parser_claude.go:12-40（cost）
  - internal/session/ssh.go:29-62（SSH remote）
  - conductor/README.md、docs/conductor/README.md（conductor 架构）
  - go.mod:10-13,39（bubbletea/lipgloss/sqlite 依赖）
- 项目主页：https://github.com/asheshgoplani/agent-deck （未另行抓取网页；结论均以本地源码为准）

（未验证项：README 宣称的 MCP 池 "85-90% 内存节省" 与 Codex fork 所需 `codex-cli 0.137.0` 版本，均为上游自述，未实测。）
