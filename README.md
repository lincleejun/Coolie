# Coolie

coding agent 的干净开发环境伴侣（= repo + branch）。

- 当前实现与原始设计：`docs/superpowers/specs/2026-07-11-coolie-design.md`
- 0.1.0 产品需求：`docs/superpowers/specs/2026-07-15-coolie-v0.1.0-prd.md`
- 0.1.0 实施路线图：`docs/superpowers/plans/2026-07-15-coolie-v0.1.0-roadmap.md`
- 架构决策日志：`docs/architecture-decision-log.md`

## 开发快速开始

```bash
bun install
bun run test          # 全部测试
bun run typecheck
```

## 当前本地实现（里程碑 1–6）

Coolie 目前是 local-first 的任务编排器：一个 project 对应一个已有 git checkout；注册项目时会
创建钉在仓库根目录的 `main` task，普通 task 则先保存 intent，第一次 `ensure`/进入时才创建
worktree、tmux session 和 engine。云端执行、SSH remote、自渲染聊天流和独立 PTY Host
不在当前实现内。

`docs/superpowers/plans/2026-07-12-coolie-m2-roadmap.md`
保留为历史计划/验收目标，不作为现状清单；其中 codex hooks 的理想路径、固定 pane 布局等条目
应以本节和 `refs/research/README.md` 的兼容差异/排除项为准。0.1.0 的新增范围与发布门禁
以 `docs/superpowers/specs/2026-07-15-coolie-v0.1.0-prd.md` 为准。

### Task 生命周期与 worktree

```bash
coolie project add ~/some/git/repo
coolie create ~/some/git/repo --name crater-lake --slug fix-login --prompt "修复登录"
coolie list
coolie get <taskId>
coolie set-status <taskId> in_review
coolie set-branch <taskId> coolie/fix-login-v2
coolie ensure-worktree <taskId>
coolie archive <taskId>
coolie unarchive <taskId>
coolie delete <taskId> --force
```

- `POST /workspaces` 只创建 lazy task intent；CLI `coolie create` 随后调用
  `POST /workspaces/:id/ensure`，因此命令行创建会直接物化。
- task 状态为 `backlog | in_progress | in_review | done | canceled | error`；runtime 状态另为
  `creating | active | archived | error`。main task 使用仓库根 checkout、不可改 branch 或删除。
- managed task 的 archive 会移除 worktree/tmux、保留 branch 与 engine 会话元数据；
  unarchive 从 branch 重建。adopted worktree 的 archive/delete 只解除 Coolie 管理，不删除外部目录。
- 命名池、branch 安全改名、pin/排序、adopt、checkpoint、fan-out、finish/PR 和 clean
  main checkout 上的 merge-back 均走 server 生命周期守卫。

### Engines 与 ChatTabs

内置 `claude`、`codex`，也支持持久化 custom engine argv 模板；引擎定义包含能力位、模型/effort、
转录/resume 策略、turn detection 和可选账号探测。GitHub Copilot 作为 custom-engine preset
提供，不伪装成内置 adapter：

```bash
coolie engine list
coolie engine copilot
coolie engine put @./my-engine.json
coolie engine detect copilot
coolie engine switch <taskId> codex --model gpt-5 --effort high

coolie tab list <taskId>
coolie tab create <taskId> --engine claude --title reviewer
coolie tab rename <taskId> <tabId> "reviewer"
coolie tab close <taskId> <tabId>
```

一个 task 可有多个并行 engine ChatTab；每个 tab 独立保存 engine、session id、标题、状态与 tmux
window。GUI 支持新建、关闭、重命名和前后循环；最后一个 engine tab 不可关闭。busy 且
`nativeQueue=false` 的引擎使用 SQLite FIFO，可由
`GET /workspaces/:id/queue` 查看并用 `DELETE /workspaces/:id/queue/:queueId` 撤回。

### tmux 角色、布局与 Zen

- 专属 socket 默认为 `tmux -L coolie`，session 名为 `coolie-<taskId>`；daemon/client 重启不拥有
  或杀死仍在运行的 engine。
- window 与 pane 写入 `@role`、`@workspace_id`/`@task_id`、`@tab_id`。角色词表为
  `tasks | engine | ops | shell`；当前 UI 采用 **ChatTab-per-window**，setup 映射为 `ops`，
  并非固定 tasks rail + 多 pane 三栏。
- reconcile 会重贴元数据并恢复已保存的 tmux layout/尺寸。Zen 是 task 级持久状态：
  `POST /workspaces/:id/zen {zen,tabId?}` 聚焦 engine window，退出时恢复先前 tab/geometry。
- `coolie enter <taskId>` attach，`coolie open <taskId>` 打印 attach 命令；桌面端还支持
  iTerm2、Terminal.app 与 argv-only custom terminal 模板。

### CLI、API 与后台收集

```bash
coolie api schema
coolie api schema --group workspaces --all
coolie collect <taskId>
coolie collect <taskId> --cached
coolie completion zsh
coolie skill export ~/.cursor/skills/coolie/SKILL.md
coolie update
coolie server status
```

- schema 索引来自 `packages/protocol/src/routes.ts`，可按 `--group`/`--verb` 过滤；当前分组为
  `system | projects | events | workspaces | engines | hooks | terminal`。
- canonical Coolie agent skill 可输出到 stdout 或安全导出到目标路径；completion 支持
  zsh/bash/fish；`coolie update` 只读查询 npm registry，永不安装。
- 后台 collector 默认周期采集 runtime/task status、diffstat、`gh pr list` 结果与转录活动/标题，
  并在快照变化时写 durable event。`collect` 可即时刷新，`--cached` 只读当前快照。
- 另有 fan-out、send/dispatch、deep link、doctor、JSON/CSV/table export 与
  daemon start/stop/restart/reset；reset 仅清 runtime 与 Coolie tmux socket，保留 DB/worktree/branch。

### Desktop client

- Tauri 2 + React + xterm.js 客户端只消费 REST/SSE/terminal WS；支持多 ChatTab、diff 行评论写回
  composer、图片附件、Files/Changes 面板、Create PR prompt 和 `coolie://workspace/<id>/tab/<id>`。
- Settings 分为 General / Engines / Accounts / Keybindings / Feedback / Dev：主题、语言、命名池、
  默认 engine/model、通知、turn-complete 声音、custom engine/Copilot、账号探测、诊断均已接入。
- 快捷键来自单一 registry，`⌘K` palette、`⌘/` cheatsheet 与 footer 同源；支持 JSON 覆盖、
  `null` 解绑及 YAML 文本导入/导出。Ctrl chord 继续透传 PTY。
- repo init 契约为 `.coolie/init.sh`（每个物理 worktree 成功一次）与
  `.coolie/init-prompt.md`（和用户首条 prompt 拼接）。server watchdog 由
  `COOLIE_INIT_TIMEOUT_MS` 控制；Dev Settings 中的秒数当前仅保存桌面偏好，尚未同步到 daemon。
- PR composer prompt 优先读取 `.coolie/pr-instructions.md`，其次
  `.github/pull_request_template.md`；`finish --create-pr` 的 PR body 则使用
  `.coolie/pr-template.md`。这是两个不同入口。
- Files/Changes 可在桌面端打开文件：默认调用系统 `open`，可用
  `COOLIE_EDITOR_JSON='["code","--reuse-window"]'` 配置结构化 argv；路径会 canonicalize 并拒绝
  traversal/symlink escape。Web build 不提供 editor launch。
- toast 为应用内错误/降级通道；turn-complete 可选 Web Notification、document/app badge 与短提示音。
  OS notification、badge 和声音均是 capability/permission 驱动的渐进增强。

## CLI 快速开始

```bash
bun x tsx packages/cli/src/main.ts project add ~/some/git/repo
bun x tsx packages/cli/src/main.ts project list
bun x tsx packages/cli/src/main.ts server status && bun x tsx packages/cli/src/main.ts server stop
```

## Workspace 生命周期

```bash
# 创建（repo 路径未注册时自动注册；CLI 创建 intent 后立即 ensure）
bun x tsx packages/cli/src/main.ts create ~/some/git/repo --slug fix-login
bun x tsx packages/cli/src/main.ts list                 # id/name/status/branch/path
bun x tsx packages/cli/src/main.ts archive <wsId>       # 删 worktree、留 branch（脏树需 --force）
bun x tsx packages/cli/src/main.ts unarchive <wsId>     # 从保留的 branch 重建
bun x tsx packages/cli/src/main.ts delete <wsId> --force # 删 worktree+记录，branch 永远保留
```

- worktree 落在 `~/coolie/workspaces/<repo>/<name>`（`COOLIE_WORKSPACES_ROOT` 可覆盖）；命名池支持 national-parks、cities、animals 与自定义，生成后不变。
- 每个 workspace 分配 10 个端口（`$COOLIE_PORT_0..9`，40000 起步），setup script 可直接使用。
- setup script 三层合并：repo `.coolie/setup.sh`（可提交）→ `~/.coolie/projects/<projectId>/setup.sh`（本机覆盖）→ repo `.coolie/setup.local.sh`（本地 overlay，不入库）。
- gitignored 文件按 repo 根 `.worktreeinclude`（gitignore 语法，缺省 `.env*`）带入新 worktree。
- 创建失败自动回滚（不留半成品 worktree），workspace 落 `error` 态，可 `POST /workspaces/:id/retry` 重试。

### Checkpoint（P2）

`coolie checkpoint create <wsId> [--label "..."]` 会把当前 worktree 的全部非 ignored
状态（tracked staged/unstaged 与 untracked）写成 commit，并仅更新
`refs/coolie-checkpoints/<workspaceId>/<checkpointId>`。实现使用临时 index，不改变真实
index、worktree、HEAD 或 branch；checkpoint 不另建快照数据库。`list` 与 `delete` 同时支持
active/archived workspace，创建只支持 active。

```bash
coolie checkpoint create <wsId> --label "before refactor"
coolie checkpoint list <wsId>
coolie checkpoint delete <wsId> <checkpointId>
git diff <returned-ref-or-oid> HEAD
```

Checkpoint API/CLI 会返回 `ref` 和 `oid` 供人工 `git show`/`git diff`。目前**不提供 restore**，
避免任何破坏性 index/worktree 写入；删除 checkpoint 也只删除对应私有 ref，不移动 branch。

### Fan-out、adopt 与 finish

```bash
# 一条任务并行派发多个独立 workspace
coolie create <repo> --agents claude:2,codex:1 --prompt "实现并测试该需求"

# 发现并收养已有外部 worktree（Coolie 永不删除 adopted worktree）
coolie adopt <projectId-or-path> --list
coolie adopt <projectId-or-path> --path /absolute/existing/worktree

# 创建 PR；或在双方 checkout 都 clean 时合回主 checkout
coolie finish <wsId> --create-pr --title "feat: ..."
coolie finish <wsId> --merge-back
```

`finish --create-pr` 使用 argv-only 的 `git push` 与 `gh pr create`，不会自动合并 PR；`merge-back`
遇到脏树或冲突会停止且不自动 reset。外部 adopted workspace 的 archive/delete 只取消 Coolie
运行时或登记，原 worktree、branch 与未提交改动保持不动。

### GUI / Web 完成度

- Changes 支持 unified diff、选行评论写回 composer；Composer 支持图片粘贴/拖拽。
- setup 在可见 setup tab 中执行；engine 固定 window 0，用户可按需创建 shell tab。
- `⌘K` 命令面板、用户 JSON 键位覆盖、footer cheatsheet、主题与中英文切换已接入。
- `coolie://workspace/<id>[/tab/<id>]` 深链及可配置外部终端模式可用。
- `bun --cwd packages/client run build:web` 构建纯 Web client；Web 只连接用户显式指定的 loopback server，不具备任意文件系统权限。

### 事件流（SSE）

先取 canonical snapshot，再用 `asOfSeq` 作为 SSE 游标，避免 snapshot 与 live stream 之间的丢失窗口：

```bash
INFO=~/.coolie/server.json
TOKEN=$(jq -r .token $INFO)
PORT=$(jq -r .port $INFO)

# 1) 读取 current-state snapshot
SNAPSHOT=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/state")
AS_OF=$(echo "$SNAPSHOT" | jq -r .asOfSeq)

# 2) 从 asOfSeq 订阅 durable replay + live 推送
curl -N -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/events/stream?after=$AS_OF"
# ?workspace=<id> 过滤；15s 心跳注释行
```

CLI 等价：`coolie state` 或 `coolie state <taskId>` 输出 JSON snapshot；`coolie events tail --after <asOfSeq> --follow` 轮询增量事件。

## 排查与导出

```bash
bun x tsx packages/cli/src/main.ts doctor                        # 只读体检（home/db/server/tmux/git/claude）
bun x tsx packages/cli/src/main.ts export projects --format table
bun x tsx packages/cli/src/main.ts export events --json --after 0   # daemon-free，server 挂了也能导
bun x tsx packages/cli/src/main.ts events tail --follow          # 实时看事件流
```

server 数据在 `~/.coolie/`（`COOLIE_HOME` 可覆盖）；诊断日志在 `~/.coolie/logs/server.log`（10MB 自动轮转，保一代 `.old`）。

## tmux 链路与 engine

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
| `COOLIE_DISABLE_HOOKS` | `1` = 不注入 hooks（claude/codex 同款） | 注入 |

## Engine 抽象与 codex 接入

engine 经能力位（`EngineCapabilities`）与注册表抽象，**UI/调用方禁止硬编码 vendor 字符串**——引擎清单、模型、effort 档位一律由 `GET /config` 的 `engines[]` 下发。当前注册表含 `claude`、`codex` 与启用的 custom engines。

### 创建 codex workspace

- **GUI**：新建 Workspace 时可选择 engine、model 和 effort。
- **CLI**：`coolie create <repo> --engine codex --model gpt-5 --effort high --prompt "回答 PONG"`。
- **REST**：`POST /workspaces {projectId, engineId:"codex", model:"gpt-5", effort:"high", initialPrompt}`；create 失败后的 retry 会保留这些选项。
  ```bash
  INFO=~/.coolie/server.json
  curl -sX POST -H "Authorization: Bearer $(jq -r .token $INFO)" -H 'content-type: application/json' \
    -d '{"projectId":"<pid>","engineId":"codex","model":"gpt-5","effort":"high","initialPrompt":"回答 PONG 两个字"}' \
    "http://127.0.0.1:$(jq -r .port $INFO)/workspaces"
  ```
- **`COOLIE_CODEX_CMD`** 是启动命令整体覆写 seam（原样使用、绝不追加 flag）——测试/调试用 `cat` 之类顶替真 binary。

### codex 与 claude 行为差异

| 维度 | claude | codex |
|---|---|---|
| session id 生命周期 | 客户端造 id：`launchCommand` 传 `--session-id <uuid>` | **服务端造 id**（`serverGeneratedId:true`）：bootstrap 起始存 `engineSessionId=null`，首个 `SessionStart` hook 经 `POST /hooks/codex` 回填真 UUIDv7（C4） |
| hooks trust 门 | 无（`seedFolderTrust` 预置 `~/.claude.json` 跳过 trust dialog） | **有**——双保险：① 起 session 前 `seedCodexTrust` 原子 UPSERT `config.toml` 的 `[projects."<realpath>"] trust_level="trusted"`（merge-only、幂等，实测有效——TUI 首启不再弹目录 trust 对话框）；② `launchCommand` **无条件**追加 `--dangerously-bypass-hook-trust`。**⚠ bypass-flag 结论被真机冒烟修正**：0.139.0 实测该 flag 只抑制 hook review 对话框，**不会激活未信任的 hooks**（详见下方「已知缺陷」） |
| 转录位置 | `~/.claude/...`（`COOLIE_CLAUDE_HOME`） | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*-<sessionId>.jsonl`（文件名内嵌 UUIDv7，日期树 newest-first 反查；`COOLIE_CODEX_HOME`） |
| effort 档位 | 无（`effort:false`，Noop） | `effort:true`，档位 `low`/`medium`/`high`/`xhigh`（`-c model_reasoning_effort=<档>`；`COOLIE_CODEX_MODELS` 只覆写 models，effort 档固定） |
| nativeQueue | `true`——TUI 原生 mid-turn 排队，忙时直投 | **`false`**——忙时 `send` 进入 SQLite 持久 FIFO；turn-complete 后逐条投递，GUI 可查看与撤回 queued 项 |
| resume | `claude --resume <sessionId>` | `codex resume <sessionId>` |
| 模型选择 | `default`/`opus`/`sonnet`/`haiku` | 从 `~/.codex/models_cache.json` 读取当前账号可见模型（`COOLIE_CODEX_MODELS` 逗号分隔覆写） |
| OSC title | engine 自写 | engine-owned；由 `-c tui.terminal_title=["activity","thread-title"]` 注入 |

- **per-engine monitor**：mtime 兜底轮询按 `tab.engineId` 解析引擎与转录目录。hooks 具备 10 分钟权威窗；旧版 codex 的 notify/interrupt 只有 5 秒防抖窗，随后 mtime 恢复裁决权。
- **注入产物进 info/exclude**：codex 的 `.codex/hooks.json`（去 `PermissionRequest` 决策 hook，只留 `SessionStart`/`UserPromptSubmit`/`Stop` 观察事件）写入后随即 `git update-index` 排除，避免 isDirty 守卫误伤 archive/delete。

### codex hooks 版本兼容

真机冒烟（Task 12）证实 **Task 8 F3 的 bypass-flag 假设不成立**，codex 的 hooks→id 回填→徽标链路在 0.139.0 上全断，四个独立原因：

1. **`[features] hooks` 在 0.139.0 默认关**——不开则 hooks 完全不加载（`/hooks` 面板全 0）。Coolie 未 seed 此键。
2. **项目级 `<worktree>/.codex/hooks.json` 不被 0.139.0 发现**——即使 `features.hooks=true` 且目录已 trusted，`/hooks` 面板仍 Installed=0；只有用户级 `~/.codex/hooks.json` 被发现（官方文档描述的项目级发现应属更新版本）。
3. **`--dangerously-bypass-hook-trust` 不激活未信任 hooks**——它只抑制启动时的「Review hooks / Trust all / Continue without trusting」对话框；未信任 hook 依旧不跑（banner 原文「*Enabled* hooks may run without review」，enabled = 已 trust）。真正的信任在 `config.toml [hooks.state."<file>:<event>:<i>:<j>"] trusted_hash = "sha256:…"`（哈希算法未公开，非平凡不可预 seed）。
4. **即便 hooks 已信任，SessionStart 也不在 TUI 启动时执行**——实测延迟到首个 turn 才与 UserPromptSubmit/Stop 一起触发，故「`engine.session.started` 先于 `prompt.delivered`」的就绪门控在 0.139.0 上结构性不可达，首条 prompt 恒走 90s 超时降级（`prompt.delivery.degraded`，投递本身仍成功——codex composer 不吞字）。

Coolie 启动时探测 codex 版本：`>=0.144` 使用 hooks lane；旧版或探测失败时使用 per-session `notify` + rollout watcher + mtime lane。旧版 lane 不等待 SessionStart，首条 prompt 走稳定画面检测；rollout 出现后回填 session id 和标题。可用 `COOLIE_CODEX_HOOKS=1|0` 显式覆盖判定。

### Server 队列与注意力

- 非 nativeQueue engine 的忙时 prompt 持久化到 `prompt_queue`，采用 `queued/inflight` 原子 claim；daemon 重启会恢复 inflight 并继续投递。
- `GET /workspaces/:id/queue` 查看，`DELETE /workspaces/:id/queue/:queueId` 撤回尚未 inflight 的消息。
- turn-complete 会在 GUI 显示「需要你」横幅、workspace 角标和标题计数；系统 Notification/App Badge 仅在运行时能力与权限允许时渐进启用。

### codex 环境变量

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `COOLIE_CODEX_HOME` | codex 数据目录（rollout 转录所在） | `~/.codex` |
| `COOLIE_CODEX_CONFIG` | trust 预置写入的 `config.toml` 路径 | 缺省回落 `<COOLIE_CODEX_HOME>/config.toml` |
| `COOLIE_CODEX_CMD` | engine 启动命令整体覆写（原样使用，测试/调试用） | 无（发现真 binary） |
| `COOLIE_CODEX_BIN` | codex 二进制显式路径 | 多路径自动发现（`/opt/homebrew/bin/codex` 等） |
| `COOLIE_CODEX_MODELS` | GUI 模型选择器选项（逗号分隔覆写） | 缺省读取 Codex 模型缓存；缓存缺失时仅使用 CLI 默认模型 |
| `COOLIE_CODEX_HOOKS` | `1/true` 强制 hooks lane；`0/false` 强制 notify lane | 按 codex 版本探测 |

> **零泄漏纪律**：测试**必须**同设 `COOLIE_CODEX_HOME` **和** `COOLIE_CODEX_CONFIG` 指临时目录。否则 `seedCodexTrust` 会写进真实 `~/.codex/config.toml`、转录 reader 会读真实 `~/.codex/sessions/`。真机冒烟（用真 codex binary、不设这两变量、seeding 落真实 `config.toml`）须先快照 `~/.codex/config.toml`、事后逐段还原——清单见 `docs/superpowers/plans/2026-07-12-coolie-m2-plan1-codex-adapter.md`。

## daemon 生命周期与自愈

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

## Client GUI

Tauri 2 + React 18 + xterm.js 6 桌面壳，纯 protocol 消费者（REST + WS 二进制 + SSE 三通道，绝不自己碰 git/tmux）。

```bash
bun install
cd packages/client && bunx tauri dev   # 自动发现/拉起 coolie-server（读 ~/.coolie/server.json）
# 等价：cd packages/client && bun run dev（package.json 的 "dev": "tauri dev"）
# 纯前端热更（不起 Tauri 壳）：bun run dev:vite；打包前端产物：bun run build:vite
```

- 左栏：project → workspace 两层列表；状态徽标（●工作中 ✓等输入 !错误 ○空闲）+ `+N−M`（server `git/diffstat` 端点 5s 轮询，client 无 git 访问）；搜索、pin 排序、归档区。
- 中央：xterm.js 6（WebGL 渲染，context loss 时回落 DOM canvas）挂 tmux window；tabs = engine / setup / shell；`↗ Open in iTerm2`（osascript attach 同一 tmux session）同画面逃生舱。**惰性挂载**：只有被看过的 tab 才建会话/WS，未看过的后台 tab 是零连接占位符；切走保活（只摘 DOM，scrollback/连接不丢）；workspace 归档/删除时其全部 tab 连接一并回收。
- Composer 三档：Enter 发送/排队（engine 忙时 `skipStable` 直投 claude nativeQueue）、⌘Enter 打断并发送、⌥Enter 仅插入、⇧Enter 换行；⌘. 打断；@文件（模糊排序 Enter 插入）、/命令（内置 + repo `.claude/commands` 扫描）、每 workspace 草稿（持久化，重启仍在）、模型选择器（切模型后 `/model` 补投，midSessionModelSwitch）。
- 快捷键：⌘N 新建（composer 变首条 prompt）、⌘T/⌘W 开关 shell tab、⌘1..9 跳 workspace、⌘[/⌘] 上/下一个 workspace、⌘L 聚焦 composer、⌘/ 快捷键表（cheatsheet）；终端聚焦时 Cmd 系全局键不进 PTY，Ctrl 系全透传（三层仲裁 + LIFO 注册表）。
- server 崩溃：SSE fetch 流指数退避（500ms→8s 封顶）+ `getInfo()` 自动重新拉起 daemon；offline 横幅 → 恢复即消；终端画面因 tmux 无损。GUI 的 SSE 连接带 `role=gui`（持有 server 惰性退出生命周期）。
- 依赖：macOS + tmux（首启 Rust 侧 `binary_on_path` 检测缺失即出 TmuxGuide 引导，装回 Recheck 通过）+ rustc/cargo（开发构建）。

新增 server 端点（本计划）：`GET /config`、`GET /workspaces/:id/git/{diffstat,changes}`、`GET /workspaces/:id/{files,commands}`；`POST /workspaces/:id/{tabs,input}`、`DELETE /workspaces/:id/tabs/:tabId`。全部经 loopback + Bearer 鉴权，CORS 放行 webview/vite-dev 跨源（token 是唯一安全边界）。

M2 已补齐附件、命令面板、键位覆盖、footer、行级 diff 评论、engine Resume、主题/i18n 与
Web 构建目标。GUI 生命周期 lease 以 SSE `role=gui` 连接为唯一真源，不使用会在崩溃后泄漏的
独立心跳注册。

GUI 手工冒烟清单（spec §十一 扩展版）与执行结果见 `docs/superpowers/plans/2026-07-11-coolie-m1-plan5-client.md` 末尾「冒烟记录」一节。
