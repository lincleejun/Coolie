# Conductor.app 本机文件系统考古（数据模型与 workspace 实现）

> 调研日期：2026-07-10。对象：本机安装的 Conductor.app **v0.74.0**（`/Applications/Conductor.app/Contents/Info.plist` 中 `CFBundleShortVersionString = 0.74.0`）。
> 方法：严格只读。SQLite 检查是把 `conductor.db` + WAL/SHM 复制到 scratchpad 后再读的，原库未被触碰。

## 概述

Conductor 是一个 macOS 原生 app，用来并行跑多个 coding agent（目前支持 Claude Code 与 Codex），每个 workspace 是一个独立的 git worktree + 独立分支。它自渲染 chat UI（headless 驱动 agent），不走 tux/TUI 渲染。核心元数据集中在一个 SQLite 库里，agent 二进制由 app 自行下载、按版本管理。

一句话总结本次考古的四个核心问题：

| 问题 | 结论 | 关键证据 |
|---|---|---|
| workspace 在磁盘上是什么 | **git worktree**（不是 clone），一个 workspace = 一个 worktree + 一个分支 | `~/conductor/workspaces/Quickstart/atlanta/.git` 内容为 `gitdir: /Users/outman/conductor/repos/Quickstart/.git/worktrees/atlanta` |
| 元数据存哪 | **单个 SQLite 库** `~/Library/Application Support/com.conductor.app/conductor.db`（WAL 模式，sqlx 管 migration，已迁移 115 版） | `.tables` 输出 + `_sqlx_migrations` 表 |
| 会话/聊天记录存哪 | **也在 conductor.db**（`sessions` + `session_messages`，`full_message` 列存 agent 的原始 stream-json）；同时 Claude Code 自己的 transcript 照常写 `~/.claude/projects/` | `session_messages` schema；`~/.claude/projects/-Users-outman-conductor-workspaces-OpenMontage-yeosu/5d24771e….jsonl` |
| 技术栈 | **Tauri 2（Rust 后端）+ Web 前端 + Bun 编译的 sidecar 运行时**，非 Electron | 无 `Contents/Frameworks/`，单一 57MB Mach-O；binary strings 含 `tauri-plugin-updater/2.10.1`、`tao-0.35.2`、`conductor-rust`；sidecar 二进制 strings 含 `bun-lockfile-format-v` |

---

## 1. 磁盘布局：`~/conductor/`

```
~/conductor/
├── repos/
│   └── Quickstart/            # 仅"由 Conductor 克隆"的 repo 放这里（onboarding 示例）
└── workspaces/
    ├── Quickstart/
    │   ├── atlanta/           # workspace = git worktree，目录名是随机城市名
    │   ├── auckland/
    │   ├── tunis/
    │   └── washington/
    ├── Personal_AI_Infrastructure/
    │   ├── muscat/ helsinki/ cody/ …
    ├── OpenMontage/yeosu/ …
    └── caffinate-app/ljubljana/
```

关键点：

- **repo 根目录不必在 `~/conductor/repos/` 下**。对已有本地仓库，Conductor 直接把用户原有 checkout 当 root：`conductor.db` 的 `repos.root_path` 有 `/Users/outman/workspace/ai/Personal_AI_Infrastructure` 这类路径；只有示例项目 Quickstart 的 root 在 `~/conductor/repos/Quickstart`。（证据：`repos` 表查询结果）
- **workspace 永远放 `~/conductor/workspaces/<repo名>/<目录名>/`**，即使 repo root 在别处。`muscat` workspace 的 `.git` 文件指回用户自己的仓库：`gitdir: /Users/outman/workspace/ai/Personal_AI_Infrastructure/.git/worktrees/muscat`。
- 目录名默认用**城市名**（atlanta/tunis/muscat…），但 schema 里 `DEPRECATED_city_name` 说明这个概念已淡化为 `directory_name`；后来用户可命名（`user_set_workspace_name` 列），此时目录名就是语义化名字（如 `change-default-claude-model`、`conductor-json-setup`）。

### worktree 验证（`~/conductor/repos/Quickstart`）

`git worktree list`：

```
/Users/outman/conductor/repos/Quickstart                  ff5caa0 [main]
/Users/outman/conductor/workspaces/Quickstart/atlanta     ff5caa0 [atlanta]
/Users/outman/conductor/workspaces/Quickstart/auckland    ff5caa0 [1-start-here-c140807a]
/Users/outman/conductor/workspaces/Quickstart/tunis      ff5caa0 [3-next-steps-c140807a]
/Users/outman/conductor/workspaces/Quickstart/washington ff5caa0 [2-your-first-parallel-agent-c140807a]
```

- **分支命名**：默认分支名 = workspace 目录名（`atlanta`）；示例任务的分支是 `<slug>-<8位hex>`（如 `1-start-here-c140807a`）。用户级设置 `~/.conductor/settings.toml` 里有 `[git] branch_prefix_type = "github_username"`，即真实使用中分支会加 GitHub 用户名前缀（本机 settings 表也有 `branch_prefix_type=github_username`）。分支与 workspace 名解耦（`workspaces` 表分别有 `branch`、`directory_name`、`user_set_branch_name` 列）。
- **`.git/config` 特征**（`~/conductor/repos/Quickstart/.git/config`）：
  - `[extensions] worktreeConfig = true` —— 启用 per-worktree 配置；
  - 每个 workspace 分支都写了 `[branch "xxx"] remote = origin / merge = refs/heads/main` —— 让 `git pull` 在 worktree 分支上默认对齐 main。
- **per-worktree 配置**（`.git/worktrees/atlanta/config.worktree`）：`[push] autoSetupRemote = true` —— 首次 push 自动建远端分支。
- worktree 创建时 `initialization_parent_branch`（db 列）记录父分支（本机均为 `main`）；SKILL.md 说明创建前会先 `git fetch origin`，从最新远端 commit 出分支，且不动 root checkout（见 `.agents/skills/conductor/SKILL.md` "Core model" 一节）。

### workspace 内部的注入物

每个 workspace 里除了代码还有（以 `~/conductor/workspaces/Quickstart/atlanta/` 为例）：

- `.conductor/settings.toml` —— repo 级共享设置（随 git 带过来），`$schema = https://conductor.build/schemas/settings.repo.schema.json`，内容是 `[scripts] setup / run`（Quickstart 里 `run = "open index.html"`）。另有 `.conductor/settings.local.toml`（个人级，被 `.gitignore` 排除，见 Quickstart `.gitignore` 中的 `.conductor/settings.local.toml` 行）。
- `.context/` —— **gitignored 的共享 agent 上下文目录**（本机见 `.context/todos.md`，空文件）。它不是通过 `.gitignore` 排除的，而是写进了 `~/conductor/repos/Quickstart/.git/info/exclude`（末行 `.context/`）—— 这招不污染用户仓库，值得抄。
- `.agents/skills/conductor/SKILL.md` + `.claude/skills/conductor -> ../../.agents/skills/conductor`（**symlink**）—— Conductor 把自己的使用说明书作为 skill 注入 workspace，让 agent 会回答"怎么用 Conductor"。skill 母本在 app bundle：`/Applications/Conductor.app/Contents/Resources/conductor-skill/skills/conductor/SKILL.md`（还有 `.claude-plugin/plugin.json`，是个 Claude plugin）。db 里有 `symlinks_pending_deletion` 表专门管理这些 symlink 的清理（本机为空）。

### 设置文件层级（来自注入的 SKILL.md，与本机文件互相印证）

1. `<repo>/.conductor/settings.toml` —— repo 共享（commit）
2. `<repo>/.conductor/settings.local.toml` —— repo 个人（gitignore）
3. `~/.conductor/settings.toml` —— 用户全局（本机存在，schema `settings.schema.json`，内容：`[git] branch_prefix_type`、`[models] default = "sonnet"`、`[models.codex] default_thinking_level = "high"` 等）
4. `~/.conductor/settings.managed.toml` —— 组织管控（本机不存在）
5. 旧版 `conductor.json` 为 legacy（settings 表里有 `repo_conductor_config_file_migration_v2_complete` 等迁移标记，可见其从"配置进 db"迁到"配置进文件"的演化）

另外 `~/.conductor/projects/--Users--outman--conductor--workspaces--Quickstart--atlanta/` 这类按 workspace 路径转义命名的目录存在但**全部为空**——用途未验证（推测为 per-project 状态预留，命名方式模仿 Claude Code 的 `~/.claude/projects/`）。

---

## 2. 元数据库：`conductor.db`（SQLite, WAL, sqlx）

路径：`~/Library/Application Support/com.conductor.app/conductor.db`（+ `-wal`/`-shm`）。`_sqlx_migrations` 表有 115 条迁移记录（version 1→115），说明后端是 **Rust + sqlx**，schema 平滑演进了 100+ 次；还有一张 `migration_rollbacks(version, down_sql)` 存回滚 SQL——**app 自带降级能力**，这个设计对桌面 app 很实用。

全部表：`repos, workspaces, sessions, session_messages, terminal_sessions, settings, attachments, diff_comments, env_vars, port_forwards, symlinks_pending_deletion, migration_rollbacks, _sqlx_migrations`。

### repos 表（节选 schema）

```sql
repos(id TEXT PK /*uuid*/, remote_url, name, default_branch DEFAULT 'main',
  root_path, setup_script, archive_script, run_script, run_script_mode DEFAULT 'concurrent',
  remote, storage_version DEFAULT 1, display_order, icon, hidden,
  custom_prompt_code_review, custom_prompt_create_pr, custom_prompt_rename_branch,
  custom_prompt_general, custom_prompt_fix_errors, custom_prompt_resolve_merge_conflicts,
  conductor_config, file_include_globs, spotlight_testing, created_at, updated_at)
```

要点：repo 级有 6 个**可定制 prompt 槽位**（code review / create PR / rename branch / fix errors / resolve merge conflicts / general）——Conductor 的内置 git 工作流动作都是 prompt 驱动的。`updated_at` 用 SQLite TRIGGER 自动维护（workspaces/sessions/settings 同样）。本机 4 个 repo 的 `storage_version=3`。

### workspaces 表（核心，节选）

```sql
workspaces(id TEXT PK, repository_id, directory_name, branch,
  DEPRECATED_city_name, DEPRECATED_archived,
  active_session_id, state DEFAULT 'active',            -- 本机值: 'ready'
  derived_status DEFAULT 'in-progress',                 -- 本机值: 'in-progress' | 'in-review'
  manual_status, initialization_parent_branch, intended_target_branch,
  workspace_path, workspace_name, user_set_workspace_name, user_set_branch_name,
  placeholder_branch_name, unread, pinned_at, notes,
  setup_log_path, initialization_log_path, initialization_files_copied,
  linked_workspace_ids, linked_directory_paths, secondary_directory_name,
  archive_commit, pr_title, pr_description, big_terminal_mode,
  -- 云 workspace 方向（v0.74 已出现）:
  hosting_server_url, sandbox_provider, remote_file_sync_enabled,
  organization_id, creator_user_id, creator_client_id, assignee_user_id, watcher_user_ids,
  permission_level)
```

要点：
- workspace 状态两层：`state`（生命周期，ready/active…）+ `derived_status`（看板语义，in-progress/in-review，由 PR 状态等推导）+ `manual_status`（手工覆盖）。
- `archive_commit`：归档时记住 commit，配合 `repos.archive_script`，说明 archive 是"删 worktree 但保留可恢复点"。
- 尾部一串云字段（`organization_id`、`sandbox_provider`、`assignee_user_id`、`watcher_user_ids`）对应迁移 112-115（"track which client created each workspace"、"track owning organization for cloud workspaces"、"track workspace assignee and watchers"）——**正在从纯本地转向云/协作**。

### sessions / session_messages（聊天记录）

```sql
sessions(id TEXT PK, workspace_id, agent_type /*'claude'|'codex'*/, model,
  status DEFAULT 'idle', title DEFAULT 'Untitled', claude_session_id,
  permission_mode DEFAULT 'default', fast_mode, agent_personality,
  claude_effort_level, codex_thinking_level,
  context_token_count, context_used_percent, unread_count,
  is_compacting, freshly_compacted, resume_session_at, feed_offset, queue_paused_at, …)

session_messages(id TEXT PK, session_id, role, content /*纯文本*/,
  full_message /*原始 SDK JSON*/, sent_at, cancelled_at, model,
  sdk_message_id, turn_id, last_assistant_message_id,
  is_resumable_message, queue_order, sender_id, created_at)
```

实测数据要点（本机 11 个 session、135 条消息）：

- 一个 workspace 可有**多个 session**（`idx_sessions_workspace_id`；helsinki 有 2 个），`workspaces.active_session_id` 指当前活跃者。
- `agent_type` 值为 `claude` / `codex`；`model` 如 `sonnet`、`sonnet-4-6-1m`、`gpt-5.5`。每 session 独立选 model / permission_mode / effort（`claude_effort_level`、`codex_thinking_level`、`fast_mode`）——和 Coolie 输入框的"模型选择、effort 选择"需求一一对应。
- `claude_session_id` 存 Claude Code 的 session id 用于 resume；有一行里它**等于 Conductor 自己的 session UUID**（`865465a9-…` 两边一致），说明 Conductor 是把自己的 UUID 通过 `--session-id` 传给 Claude Code，让两边 id 统一（此推断基于数据一致性，参数名未验证）。
- `content` 存纯文本；`full_message` 存**Claude Code stream-json 原始信封**：`{"type":"assistant","session_id":"…","message":{"role":"assistant","content":[{"type":"text","text":"…"}]}}`。**codex session 的消息也是这个信封格式**（样例来自 codex session `c2a50950-…`），即 Conductor 把不同 engine 的输出归一到 Claude-Code-SDK 风格的消息模型再入库。
- `turn_id` / `sdk_message_id` / `queue_order`：支持一个 turn 多条消息、消息队列（排队发送）与取消（`cancelled_at`）。
- 附件独立成表 `attachments`（含 `is_draft`，草稿附件先入库再关联消息）。
- **Claude Code 自己的 transcript 不受影响**，照常写 `~/.claude/projects/<转义路径>/<session>.jsonl`（本机可见 conductor workspace 对应目录）。也就是说 Conductor 的 db 是 UI 视图的存储，agent 原生会话文件是 resume 的事实来源。

### 其他表

- `diff_comments`：**diff 评论/行内 code review**（workspace_id + file_path + line_number + end_line_number + body + thread_id + reply_to_comment_id + is_resolved + is_outdated + author…）。本地实现了类 GitHub 的 review 线程模型；Coolie 右侧 diff/code review 面板可直接抄这个表设计。
- `terminal_sessions`：终端会话恢复（cwd/cols/rows + `rehydrate_sequences`（存转义序列以重放画面）+ `alternate_screen`/`bracketed_paste` 标志）。本机为空表，但 schema 说明其思路：**terminal 状态持久化靠序列重放**。
- `settings`：KV 表（key/value/deprecated_at）。本机键值样例：`default_model=gpt-5.5`、`default_open_in=iterm`、`open_in_mru_order=["iterm","warp"]`、`branch_prefix_type=github_username`、`graphite_disabled=true`、各类 onboarding/migration 标记。`deprecated_at` 列配合 "file-backed settings migration"（迁移 111）——设置正从 db 迁往 `~/.conductor/settings.toml`。
- `env_vars(key, scope, context, value)`：作用域化环境变量（本机为空）。
- `port_forwards`：端口转发（workspace_id + remote_port + local_port，local_port 全局唯一索引）——配合云 workspace。

---

## 3. Application Support 其余内容

`~/Library/Application Support/com.conductor.app/`：

```
conductor.db(+wal/shm)          # 上述主库
agent-binaries/                 # 自管 agent 二进制
  claude/2.1.201/claude         # 完整 Claude Code 可执行文件（232MB）
  codex/0.144.0/codex           # 完整 Codex（260MB）
  .meta/claude-2.1.201.json     # {"sha256":…,"size":…,"downloaded_at_unix_ms":…,"verified_mtime_unix_ms":…}
bin/                            # 注入 workspace PATH 的工具目录
  claude, codex                 # Mach-O 包装器（内嵌 JS 的 Bun 编译产物，负责转发到 agent-binaries 对应版本）
  gh                            # 自带 GitHub CLI（53MB，不依赖用户安装）
  conductor                     # sh shim → .internal/conductor-runtime cli
  checkpointer.sh git-busy-check.sh spotlighter.sh watchexec
  .internal/
    conductor-runtime           # 72MB Bun 编译的多命令二进制（cli/actions/sidecar/logger/internal 子命令）
    node                        # 完整 Node.js 二进制(117MB) + cursor-node-worker.mjs + node_modules/@cursor
app-icons/ iterm.png warp.png antigravity.png   # "Open in" 集成
terminal-shell-integration/zsh/ .zshrc .zshenv…  # ZDOTDIR 劫持式 shell 集成
local-storage.entries/ + local-storage.metadata.json  # 前端持久化 KV（分 subsystem，带 sizeLimit）
logs/latest-server.json         # {"url":"http://127.0.0.1:60574","pid":…} —— sidecar HTTP server 服务发现
.window-state.json              # tauri 窗口状态
.bin-source-markers.json        # bin/ 文件的版本指纹（size+mtime），用于增量更新自带工具
```

逐项要点：

- **agent 版本管理**：`agent-binaries/<agent>/<version>/` + `.meta/<agent>-<version>.json`（sha256 校验、下载时间、mtime 验证）。Conductor 不依赖用户的 `claude`/`codex` 安装，自己下载、校验、按版本隔离。主 binary strings 里有 `agent_binary_progress`、`gzip executable not found`（下载解压流程）。
- **运行时进程模型**（`ps` 实测）：
  1. `/Applications/Conductor.app/Contents/MacOS/conductor` —— Tauri 主进程；
  2. `conductor-runtime sidecar` —— Bun sidecar，即 `logs/latest-server.json` 里那个 `127.0.0.1:60574` 本地 HTTP server（TS/JS 侧业务逻辑）；
  3. `conductor-runtime logger` —— 独立日志进程；
  4. `…/agent-binaries/claude/2.1.201/claude --output-format stream-json` —— **agent 以 headless stream-json 模式被驱动**。
  也就是说架构 ≈ Tauri(Rust, 窗口/DB/git) + Bun sidecar(HTTP, 业务) + headless agent 子进程。主 binary 还链接了 `tokio-tungstenite`（WebSocket）。**Conductor 没有用 tux/PTY 渲染 agent 自身 UI，chat 界面完全自绘**。
- **checkpointer.sh**（9.4KB bash）：用 **`refs/conductor-checkpoints/<id>` 私有 ref** 做快照——保存不动 HEAD/工作区，恢复时还原 HEAD+index+工作树含 untracked；明确处理 merge/rebase 进行中（退出码 101/102）和"workspace 丢失自己的 checkout 会波及祖先仓库"的护栏（退出码 103）。`git-busy-check.sh` 抄的是 git 官方 `git-prompt.sh` 的检测逻辑（rebase/merge/cherry-pick/revert/squash-merge）。`spotlighter.sh` + `watchexec`：监听 workspace 变化 → checkpoint save → 在 `$CONDUCTOR_ROOT_PATH`（repo root）restore——这是它 "Spotlight/预览 workspace 改动到 root" 功能的实现：**用 checkpoint ref 把 worktree 状态镜像到 root checkout**。
- **shell 集成**：`terminal-shell-integration/zsh/.zshrc` 通过 `CONDUCTOR_USER_ZDOTDIR`/`CONDUCTOR_INTEGRATION_ZDOTDIR` 双 ZDOTDIR 包装用户自己的 zsh 配置，再注入 `PATH=$CONDUCTOR_PATH_PREFIX:$PATH`（让 workspace 终端优先用它 bin/ 里的 claude/codex/gh），并用 **OSC 633**（VS Code 同款转义序列 `\033]633;Conductor;…\a`）上报 prompt/命令边界给内嵌终端。
- **前端本地存储**：`local-storage.metadata.json` 管理各 subsystem（terminal tabs、composer-drafts（每 session 输入框草稿）、route-user-state（UI 路由态）、claude-context-windows（模型上下文窗口大小缓存）、lottie-sprite-cache、git-service-pr-v1 / git-service-workspace-changes-v1（**按 workspace UUID 缓存 PR 状态和 diff 概要**，含 mergeBase、diffTargetBranch、gitForge:"github" 等字段））。git 状态缓存放文件、结构化元数据放 SQLite 的分层值得注意。
- `defaults read com.conductor.app` 只有 NSNavPanel 之类系统项，**无业务配置**（业务配置全部在自管文件/db 中）。

## 4. App bundle（技术栈判定）

`/Applications/Conductor.app/Contents/`：只有 `MacOS/conductor`（57MB 单一 Mach-O arm64）+ `Resources/`（icon、bin 母本、conductor-skill），**没有 Frameworks/ 目录**（无 Electron Framework、无 Chromium）→ 使用系统 WKWebView。

binary strings 证据：`tauri-plugin-updater/2.10.1`、`tauri-plugin-http/2.4.3`、`tauri-plugin-store-2.4.3`、`tao-0.35.2`（Tauri 的窗口库）、`clipboard-manager`、`A Tauri App`、`conductor-rust`、sqlx 痕迹（`_sqlx_migrations`）、`tokio-tungstenite-0.24.0`。lottie 缓存键里出现 `tauri://localhost/assets/typing-B3OGN0TG.json` —— 前端是打包的 SPA 资产。

结论：**Tauri 2 + Rust 后端 + Web(SPA) 前端 + Bun sidecar**。与 Coolie 计划的 React+Tauri 客户端同栈，参考价值直接。

Info.plist 其他值得记的：URL scheme `conductor://`；麦克风权限描述（"speech-to-text input in chat"）；Desktop/Documents/Downloads 三个文件夹权限描述（agent 需要读写任意位置的 repo）。

---

## 5. 与 Coolie 相关的可借鉴点

1. **workspace = worktree 的完整配方**（可直接照抄）：
   - repo root 可以是用户已有 checkout（不强制迁移），worktree 统一放 `~/coolie/workspaces/<repo>/<name>`；
   - 创建流程：fetch origin → 从 `origin/<base>` 建分支 → `git worktree add`；
   - `extensions.worktreeConfig=true` + per-worktree `config.worktree`（`push.autoSetupRemote=true`）；
   - 为 worktree 分支写 `branch.<name>.remote/merge` 指向 base 分支；
   - 用 `.git/info/exclude`（而非 `.gitignore`）注入 `.context/` 这类工具目录，零仓库污染；
   - 需要给 agent 的注入物用 symlink（`.claude/skills/x -> ../../.agents/skills/x`）并在 db 里登记待清理。
2. **单 SQLite + sqlx migration + rollback 表**：桌面场景够用且极简；`migration_rollbacks` 存 down_sql 支持降级安装，值得抄。
3. **消息模型归一**：不管 engine 是 claude 还是 codex，入库统一为 Claude-Code stream-json 信封（`content` 纯文本冗余列便于列表渲染/搜索，`full_message` 保原始 JSON）。Coolie 的 server 抽象 coding engine 时可直接用这个"以 Claude Code SDK 消息格式为规范格式"的策略。
4. **agent 自管**：`agent-binaries/<agent>/<version>/` + sha256 meta + PATH shim。解决"用户机器上 claude/codex 版本混乱"的问题；同时 resume 依赖 agent 原生 session 文件（`~/.claude/projects`），自己 db 只存 UI 层。
5. **注意：Conductor 实际是 headless 驱动（`--output-format stream-json`）+ 自绘 UI**，与 Coolie "优先 tux 渲染" 的路线不同。这说明 tux 路线是差异化点，但 Conductor 用 stream-json 也顺便拿到了结构化消息（diff、token 计数、turn 管理）；tux 路线下这些结构化数据如何获得需要另行设计（如 hooks / transcript tail）。
6. **checkpoint 用私有 ref 而非 stash**：`refs/conductor-checkpoints/<id>`，不动 HEAD、可 diff、可恢复 untracked；配 `watchexec` 实现 workspace→root 的实时镜像预览。kobe 的 task 模型如果要加"预览/还原"，这是现成方案。
7. **repo 级 prompt 槽位**（create PR / code review / fix errors / resolve conflicts…）：把 git 工作流按钮做成可定制 prompt，表结构简单效果好。
8. **diff_comments 表**：本地行内 review 线程（thread/reply/resolved/outdated），Coolie 的 code review 面板数据模型可直接参考。
9. **终端集成三件套**：ZDOTDIR 包装（不破坏用户 zsh 配置）+ OSC 633 命令边界上报 + `rehydrate_sequences` 持久化重放。Coolie 要做 iterm2/终端接入时全部用得上；`default_open_in`/`open_in_mru_order` + app-icons 的"Open in iTerm/Warp"轻集成也很讨巧。
10. **设置分层**：repo 共享 toml（带 JSON schema URL，编辑器有补全）→ repo local → user global → managed，加 db 内迁移标记做旧格式迁移。Coolie 可直接采用同样的四层 + `$schema`。

## 6. 风险与注意事项

- conductor.db 处于 WAL 模式且 app 常驻，直接用 sqlite3 打开原库可能触发 checkpoint 写入；本次全部通过副本读取。后续若想持续观察，建议同样复制后再查。
- schema 演进很快（115 个 migration，大量 `DEPRECATED_*` 列），本文列出的列以 v0.74.0 为准，勿当稳定 API。
- workspace 尾部云字段（organization/assignee/watchers/sandbox_provider）表明 Conductor 正在做云端/团队方向；Coolie 定位个人本地，不必跟。
- worktree 方案的固有坑（Conductor 用 SKILL.md 与脚本明确处理过的）：merge/rebase 进行中不能 checkpoint；workspace 目录失去 checkout 后 git 命令会落到祖先仓库（checkpointer 退出码 103 的护栏）；嵌套 workspace 问题在其 SKILL.md 的 troubleshooting 范围里。
- 未验证项：`~/.conductor/projects/**`（空目录）的真实用途；Conductor 传给 claude 的完整命令行参数（ps 只见 `--output-format stream-json`，`--session-id` 等为推断）；codex 的驱动协议（推测走 codex 的 proto/app-server 模式，本机无运行中的 codex 进程可证）；日志文件实际落盘位置（`logs/` 下仅见 latest-server.json）。

## 7. 来源清单（本机路径）

| 证据 | 路径 |
|---|---|
| worktree 布局 | `~/conductor/repos/Quickstart`（`git worktree list`、`git branch -a`、`.git/config`）；`~/conductor/workspaces/Quickstart/atlanta/.git`；`~/conductor/workspaces/Personal_AI_Infrastructure/muscat/.git` |
| worktree 元数据 | `~/conductor/repos/Quickstart/.git/worktrees/atlanta/{config.worktree,HEAD,gitdir}` |
| `.context` 排除 | `~/conductor/repos/Quickstart/.git/info/exclude` 末行 `.context/` |
| repo 设置 | `~/conductor/repos/Quickstart/.conductor/settings.toml`；`~/.conductor/settings.toml` |
| 注入 skill | `~/conductor/workspaces/Quickstart/atlanta/.agents/skills/conductor/SKILL.md`；symlink `~/conductor/workspaces/Quickstart/atlanta/.claude/skills/conductor`；母本 `/Applications/Conductor.app/Contents/Resources/conductor-skill/` |
| 主数据库 | `~/Library/Application Support/com.conductor.app/conductor.db`（经 scratchpad 副本读取；`.tables`/`.schema`/数据查询） |
| agent 二进制管理 | `~/Library/Application Support/com.conductor.app/agent-binaries/**`（`.meta/claude-2.1.201.json` 等） |
| 工具与脚本 | `~/Library/Application Support/com.conductor.app/bin/{conductor,checkpointer.sh,git-busy-check.sh,spotlighter.sh,.internal/*}` |
| sidecar 服务发现 | `~/Library/Application Support/com.conductor.app/logs/latest-server.json` |
| 前端存储 | `~/Library/Application Support/com.conductor.app/local-storage.metadata.json` 及 `local-storage.entries/**`、`local-storage.subsystem.*.json` |
| shell 集成 | `~/Library/Application Support/com.conductor.app/terminal-shell-integration/zsh/.zshrc` |
| 技术栈 | `/Applications/Conductor.app/Contents/Info.plist`（plutil -p）；`Contents/MacOS/conductor` strings（tauri/tao/sqlx/tungstenite）；`bin/.internal/conductor-runtime` strings（bun）；无 `Contents/Frameworks/` |
| 运行时进程 | `ps aux`（Tauri 主进程、conductor-runtime sidecar/logger、claude `--output-format stream-json`） |
| Claude 原生 transcript | `~/.claude/projects/-Users-outman-conductor-workspaces-OpenMontage-yeosu/5d24771e-6e7b-448d-8859-99032eddd72a.jsonl` |
| 官方文档（SKILL.md 内引用，未逐一访问） | https://conductor.build/docs/concepts/workspaces-and-branches 等 |
