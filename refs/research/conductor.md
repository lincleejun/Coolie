# Conductor（Melty Labs）深度调研

> 调研日期：2026-07-10。Conductor 当前版本 0.74.0（2026-07-09 发布）。所有结论均标注来源 URL；标注"推断"或"未验证"的内容请谨慎引用。

## 1. 概述

**它是什么**：Conductor 是一个 macOS 原生应用，让你在 Mac 上并行运行多个 coding agent（Claude Code、Codex、Cursor、OpenCode），每个 agent 在各自隔离的 workspace 里工作，你可以实时观察、review diff、开 PR、合并。官方口号："Run parallel coding agents on your Mac"。
来源：https://www.conductor.build/ 、https://www.conductor.build/docs

**解决什么问题**：单一 checkout 下多个 agent 会互相踩踏（同一分支、同一份文件、同一个端口）。Conductor 用 git worktree 把每个任务隔离成独立的 workspace（独立分支 + 独立目录 + 独立进程 + 独立上下文），把"workspace 作为委派单元、branch/PR 作为集成单元"的工作流产品化。
来源：https://www.conductor.build/docs/concepts/workspaces-and-branches 、https://www.conductor.build/docs/concepts/workflow

**平台**：仅 macOS（Windows/Linux 只有 waitlist）。安装后自动检查 `gh auth status`、`claude /login`、`codex login`、Cursor API key；"你需要 GitHub 和至少一个 agent provider 才能使用 Conductor"。
来源：https://www.conductor.build/docs/installation

**价格**：Conductor 本体免费，不代收/转售模型用量，harness 用量通过各 provider 账号或 API key 计费。FAQ 明确"目前免费，由种子投资人供养，未来计划对团队协作功能收费"。另有面向企业的 Enterprise 页面（managed settings、data privacy）。
来源：https://www.conductor.build/docs/reference/harnesses 、https://www.conductor.build/docs/faq 、https://www.conductor.build/enterprise

**是否开源**：官网与 docs 未提供应用源码仓库，应用本体为闭源商业产品（GitHub org 为 github.com/meltylabs，但未开源 Conductor 应用——未验证 org 内具体仓库内容）。前身产品 Melty（AI code editor）是开源的。
来源：https://www.ycombinator.com/companies/conductor 、https://github.com/meltylabs （检索结果，未逐仓核验）

**团队与融资**：Melty Labs，YC S24。创始人 Charlie Holtz（CEO，前 Replicate growth、Point72 quant）、Jackson de Campos（CTO，前 Netflix ML infra）。团队页共 7 人（含 founding engineer Guillaume Sabran，ex-Airbnb/Snap staff）。2026-03-30 官宣 Series A：$22M，由 Spark 和 Matrix 领投。2026-04-02 宣布 "cmd joins Conductor"（团队并入）。第三方数据库（PitchBook/StartupIntros）称总融资 $60M/4 轮——未验证，与官方口径不符时以官方 blog 为准。
来源：https://www.conductor.build/team 、https://www.conductor.build/blog/series-a 、https://www.conductor.build/blog/cmd-joins-conductor 、https://www.ycombinator.com/companies/conductor

---

## 2. 核心概念与数据模型

### 2.1 概念层级（从项目到进程）

官方定义的六层模型（这是 Coolie 数据模型最值得直接抄的部分）：

| 概念 | 定义 |
|---|---|
| **Project** | Conductor 里一个 codebase 的条目，容纳 settings、scripts、workspaces |
| **Repository** | Git codebase 本体（local / GitHub / Quick start 三种来源） |
| **Workspace** | 为一个 task/PR 服务的隔离副本，映射到一个 Git branch |
| **Branch** | workspace 当前 checkout 的分支，通常是 PR/review 的单元 |
| **Working tree** | 该 workspace 在磁盘上的文件，用 git worktree 实现 |
| **Running environment** | workspace 内运行的进程（app、server、tests） |

关键论断："**The workspace is the unit of delegation. The branch and pull request are the unit of integration.**"
来源：https://www.conductor.build/docs/concepts/workspaces-and-branches 、https://www.conductor.build/docs/concepts/workflow

### 2.2 Workspace 生命周期

**创建**：
- `⌘N` 新建 workspace，会打开 **Dispatcher**——一个提交 prompt 的入口，可开 `create more` 连续派发多个任务（0.63.0 引入）。
- `⌘⇧N` 从 PR / branch / GitHub issue / Linear issue 创建 workspace（可选目标 repo）。
- 新 workspace 默认基于 repo 的 base branch（如 `origin/main`）；也可选已有分支——但同一分支同时只能被一个 workspace checkout（git worktree 的硬限制）。
- 支持 fork workspace（复制一个 workspace，0.25.6）、从 Linear/GitHub issue 直接开（0.36.5、0.66.0）、`conductor://` deep link 开（见 §8）。
来源：https://www.conductor.build/docs/concepts/workspaces-and-branches 、https://www.conductor.build/changelog/0.63.0-cursor-support-dispatcher 、https://www.conductor.build/changelog/0.25.6-multiple-git-repos-fork-workspaces

**命名（city names，很有特色）**：
- 每个 workspace 分配一个**城市名**（共 295 个城市池），如目录 `san-antonio-v3`。城市名提供"稳定的目录基名"——agent、shell、editor 始终能在同一路径找到文件；而 branch 名/PR 标题作为侧边栏里的"工作内容标识"。双命名体系：**目录名求稳定，分支名求语义**。
- `⌘K` → Passport 可以看你"去过"的所有城市（纯彩蛋向的收集玩法）。
- workspace 可通过侧边栏右键重命名，并可选择同步改本地分支名（0.54.0）。
来源：https://www.conductor.build/docs/reference/cities 、https://www.conductor.build/docs/faq 、https://www.conductor.build/changelog/0.54.0-new-queue-diff-diffs

**状态与组织**：
- workspace 有四种状态：**backlog / in progress / in review / done**（0.35.0），有 PR 时自动用 PR 标题打标签。
- 支持：pin（0.25.3）、按 repo 分组（0.35.2）、标记 unread（0.25.11）、搜索 workspace（0.26.0）、workspace 专属 hub 页（0.28.0）、直接分享 workspace/chat 链接（0.71.0，`⌘⇧C` copy link）。
来源：https://www.conductor.build/changelog/0.35.0-workspace-status 及各对应 changelog 页

**归档与删除**：
- Archive（`⌘⇧A`）把 workspace 移出活跃列表；archive 前执行 `scripts.archive` 清理外部资源；归档后可随时从侧边栏 History pane 恢复，**chat 历史完整保留**。
- `git.delete_branch_on_archive`（bool）：归档时是否删分支；`git.archive_on_merge`（bool）：PR 合并后自动归档。0.46.0 做了 Instant Archiving。
- 文档未明确说明 workspace 的彻底删除流程（未验证）。
来源：https://www.conductor.build/docs/concepts/workflow 、https://www.conductor.build/docs/reference/settings/reference 、https://www.conductor.build/docs/reference/scripts

### 2.3 底层：git worktree

- **目录位置**：`~/conductor/workspaces/<repo name>/<workspace name>`。
- 创建 workspace 时 Conductor 自动：建 git worktree → checkout 分支 → 复制 tracked files。
- **隔离的**：代码改动、生成文件、终端命令、运行进程。**共享的**：git 仓库数据（history、refs、remotes、object database）。
- worktree 的坑及对策（Conductor 把这些都产品化了）：
  - untracked/gitignored 文件不会带进新 worktree → **Files to copy** 机制（见 §3.4）；
  - 依赖安装等动态内容 → setup scripts；
  - 一个分支只能被一个 worktree checkout → 产品层限制。
- 每个 workspace 有 gitignored 的 **`.context` 目录**存 workspace 级笔记（agent 与人共享的上下文，Notes tab 的存储介质）。
来源：https://www.conductor.build/docs/concepts/git-worktrees 、https://www.conductor.build/docs/concepts/workspaces-and-branches

### 2.4 数据存储位置（迁移机器时要拷的东西）

FAQ 给出：`~/Library/Application Support/com.conductor.app`（应用数据+bundled binaries）、`~/conductor`（workspaces）、`~/.claude`、`~/.codex`。
来源：https://www.conductor.build/docs/faq

---

## 3. 配置体系（settings + scripts）

### 3.1 四层 settings 模型

| 层 | 文件 | 用途 |
|---|---|---|
| Managed（org） | `~/.conductor/settings.managed.toml` | 组织强管控，优先级最高 |
| Project overrides | `<repo>/.conductor/settings.local.toml` | 本机私有，不入 git |
| Repository shared | `<repo>/.conductor/settings.toml` | 团队共享，入 git |
| User shared | `~/.conductor/settings.toml` | 个人跨仓库默认 |

优先级：Managed > local > repo > user > 内置默认。UI 里改设置时"UI 会写到正确的层"。每种文件有 JSON schema（`https://conductor.build/schemas/`）做校验。
来源：https://www.conductor.build/docs/reference/settings/user-project 、https://www.conductor.build/docs/reference/settings/reference

历史包袱：最早是 `conductor.json`（0.11.0，2025-09），字段 `scripts.setup/run/archive`、`runScriptMode`、`enterpriseDataPrivacy`；现已 legacy，存在 `.conductor/settings.toml` 时被忽略，且 app 内提供自动迁移 PR。
来源：https://www.conductor.build/docs/reference/conductor-json

### 3.2 三类 scripts + run_mode

| Script | 配置键 | 时机 | 用途 |
|---|---|---|---|
| Setup | `scripts.setup` | workspace 创建后 | 装依赖、生成文件、建 symlink |
| Run | `scripts.run.<id>.*` | 点 Run 按钮（`⌘R`） | 起 app/server/test watcher |
| Archive | `scripts.archive` | 归档前 | 清理外部资源（如 workspace 专属数据目录） |

- run script 支持**多个命名脚本**（0.70.0），每个可配 `command`（必填）、`args`、`options.cwd`、`default`、`icon`（Lucide 图标名）、`hide`、`available_in`（`local`/`cloud`）。
- `scripts.run_mode`：`concurrent`（多脚本并行）或 `nonconcurrent`（起新的先停旧的）。
- `scripts.auto_run_after_setup`：setup 完成后自动执行 run script（0.63.0）。
- setup script 可重跑（0.32.1），setup 日志可查看（0.31.0）。
- **进程终止协议：先发 `SIGHUP`，等 200ms，还活着就 `SIGKILL`**。多进程建议用 `concurrently` 而非 shell `&` 后台，否则清不干净。
来源：https://www.conductor.build/docs/reference/scripts

### 3.3 环境变量

内置注入到所有 terminal、scripts、agents：

| 变量 | 含义 |
|---|---|
| `CONDUCTOR_WORKSPACE_NAME` | workspace 名（即城市名目录名） |
| `CONDUCTOR_WORKSPACE_PATH` | workspace 目录 |
| `CONDUCTOR_ROOT_PATH` | 仓库主 checkout 根目录（可 `ln -s "$CONDUCTOR_ROOT_PATH/.env" .env`） |
| `CONDUCTOR_DEFAULT_BRANCH` | 默认分支 |
| `CONDUCTOR_PORT` | 分配的端口段（**每 workspace 10 个连续端口**）的第一个 |
| `CONDUCTOR_IS_LOCAL` | 本地=1 / cloud=0 |

自定义变量在 `[environment_variables]`（全局）/ `[environment_variables.local]` / `[environment_variables.cloud]` 配置；机器本地的 secrets 放 `settings.local.toml`。
来源：https://www.conductor.build/docs/reference/environment-variables

### 3.4 Files to copy（gitignored 文件带入 worktree）

- 解决"新 worktree 只有 tracked files，`.env.local`、证书、本地数据库带不过去"的问题。
- 判定：文件被 gitignore **且** 匹配配置的 pattern 才复制。
- 三种配置途径，优先级：repo 根的 **`.worktreeinclude`**（gitignore 语法） > settings.toml 的 `file_include_globs` > 默认 pattern `.env*`。
- 明确不复制：tracked 文件、`node_modules`、构建产物（这些归 setup script 管）。
来源：https://www.conductor.build/docs/reference/files-to-copy

### 3.5 Shell 环境捕获（对 Coolie 很重要的实现细节）

- Conductor 在每个 workspace 目录里**起一次交互式 login shell（`$SHELL -ilc`）捕获环境变量**，之后复用；但**实际执行 setup/run scripts 用的是 `zsh`**。
- shell 启动如果读输入会挂死；**shell 配置加载限时 5 秒，超时中止**（可用 `time "$SHELL" -ilc env` 自测）。支持 direnv（0.38.4）。
来源：https://www.conductor.build/docs/reference/shells 、https://www.conductor.build/changelog/0.38.4-direnv-support-opus-4-6-1m

### 3.6 Prompt 定制（把 agent 动作模板化）

repo settings 可配六种 prompt，注入到对应动作：`prompts.general`（每个 session 都加）、`prompts.code_review`、`prompts.create_pr`、`prompts.fix_errors`、`prompts.resolve_merge_conflicts`、`prompts.rename_branch`（指导自动分支命名）。另外 Conductor 会注入 system prompt 解释"你在 Conductor workspace 环境里"（FAQ，均可在 Settings 定制）。持久约定推荐放 `AGENTS.md` / `CLAUDE.md` / `.claude/commands` / skills；任务级细节放 chat 或 `.context`。
来源：https://www.conductor.build/docs/reference/settings/reference 、https://www.conductor.build/docs/reference/agent-behavior 、https://www.conductor.build/docs/faq

---

## 4. Coding engine 集成（Harness）

### 4.1 Harness 概念与四家支持

官方术语 **harness**："写代码的 agent runtime；Conductor 是围绕它的 workspace 层"。——这与 Coolie "只做伴侣不做 agent" 的定位完全一致，术语可直接借用。

| Harness | 集成方式 | 认证 |
|---|---|---|
| Claude Code | **bundled binary**（随 app 内置，也可用系统版），路径 `~/Library/Application Support/com.conductor.app/bin` | 复用本机已有 token：Claude Pro/Max 订阅或 API key；注意 `ANTHROPIC_API_KEY` 存在时可能覆盖订阅计费 |
| Codex | bundled binary（同上，可指定系统版） | `codex login` 或 OpenAI API key |
| OpenCode | bundled（0.69.0 加入） | 用 OpenCode 自身的 provider 配置 |
| Cursor | **不 bundle**，走 **Cursor API**（Cursor Agent / Composer） | 需 `CURSOR_API_KEY`（Settings → Harnesses） |

- 可用 `claude_code_executable_path` / `codex_executable_path` 覆盖内置 binary。
- provider 可切换：`claude_provider` = Anthropic / Bedrock / Vertex（配 `bedrock_region`、`vertex_project_id`）；自定义 provider 走环境变量（0.13.6）。
- 会话结构：**一个 chat tab = 一个 harness + 一个 model**；一个 workspace 可开多个 chat tab（0.17.0），共享同一份代码状态。
来源：https://www.conductor.build/docs/reference/harnesses 、https://www.conductor.build/docs/reference/harnesses/claude-code 、https://www.conductor.build/docs/reference/harnesses/codex 、https://www.conductor.build/docs/faq 、https://www.conductor.build/docs/reference/settings/reference

### 4.2 渲染方式：自渲染 chat UI，而非终端/tux 透传（推断+证据）

Conductor 的主交互界面是**自己渲染的 chat UI**，不是把 claude/codex 的 TUI 嵌进来。证据链：
- changelog 0.36.3 提到修 "SDK Memory Leaks"（说明 Claude Code 走 SDK/程序化接口）；
- 自建 UI 才可能有的功能：tool approval 界面（0.41.0）、AskUserQuestion 渲染（0.31.3）、plan approve with feedback（0.25.5）、message queue、模型/thinking picker、LaTeX/markdown 渲染、"Garry mode"展开 tool calls（`⌃O`）、native compact support（0.54.0）、checkpoints 与消息级 revert。
- Codex 具体走什么协议（app-server / MCP / exec JSON）官方未说明——**未验证**。
（以上"自渲染"为基于官方功能列表的推断，无官方架构文档背书。）
来源：https://www.conductor.build/changelog/0.36.3-submit-a-prompt-sdk-memory-leaks 及各对应 changelog 页

**但注意**：Conductor 同时留了第二条路——**Big Terminal Mode**（见 §6），在内置终端里直接跑任意 agent CLI（含 preset），等价于 Coolie 计划的 tux 路线。**两条路并存**是 Conductor 的实际形态。

### 4.3 Agent 运行控制

- **Plan Mode**（`⇧Tab` 切换）：先出计划再动手；plan 可以"hand off"到新 chat / 其他 agent（0.22.7、0.30.0），可带反馈批准（0.25.5），`⌘⇧↵` approve plan。
- **Fast Mode**：牺牲深度换速度（0.40.1）。
- **Manual Mode™**（0.37.0）：手动挡，更细粒度控制。
- **Thinking/effort levels**：`⌥T` 循环切换；settings 里 `models.claude_code.default_effort_level`、`models.codex.default_thinking_level` 等分别控制新 chat 与 review 的档位。
- **Codex 特有**：Personalities（0.45.0，定制工作风格）、Goals（0.65.0，跨多轮持续目标，仅 local workspace）、Codex checkpoints（0.44.0）。
- **ultracode**（0.61.0）：extended effort + 动态 workflow 编排的实验特性（官方原话"We don't know if it's better yet but it's cool"）。
- **Skills**：Claude Code、Codex、OpenCode 均支持；**slash commands**（0.1.1/0.25.0）、**MCP**（0.1.0 起）。
- **Tool approvals**：`tool_approvals_enabled`，逐 tool call 审批（`↵` 允许 / `⌫` 拒绝）；可审 shell 命令、文件改动、MCP、web fetch。
- **Checkpoints**：每轮 agent 响应前"把 working branch 状态捕获进一个 **private Git ref**"（本地存储、独立于分支历史）；revert 会永久删除该轮之后的所有消息并回滚代码；多 chat 同 workspace 时慎用。
- **Message queue**：agent 忙时消息排队，可编辑/删除/立发队列中消息，编辑时队列暂停（0.54.0 重做）。
- **同 workspace 多 agent 协作**：官方支持"多个 agent 共享一个 workspace"的模式（如一个实现一个 review、前后端同分支协作），与"每任务一个 workspace"二选一，docs 给了决策表。
来源：https://www.conductor.build/docs/concepts/agent-modes 、https://www.conductor.build/docs/reference/agent-behavior 、https://www.conductor.build/docs/reference/checkpoints 、https://www.conductor.build/docs/concepts/parallel-agents 、https://www.conductor.build/docs/reference/mcp 及对应 changelog 页

### 4.4 MCP 配置

- 按 harness 各自加载：Claude Code / Codex 在 Conductor 内加载各自的 MCP 配置（`~/.claude.json`、repo 根 `.mcp.json` / `.cursor/mcp.json`、本机私有配置三个 scope）；Cursor 的 MCP 在 Cursor 侧配置。
- 支持 stdio、Streamable HTTP（bearer/OAuth/API key/自定义 header）、SSE（deprecated）。
来源：https://www.conductor.build/docs/reference/mcp

---

## 5. Diff / Code Review 面板

这是 Conductor 打磨最狠的部分（从 0.3.0 一路迭代到 0.73.0 的 PR page）：

- **Diff Viewer**（`⌘⇧D`）：看 workspace 的变更；unified view / 按 commit 过滤（sequential review）；按文件夹分组、过滤 whitespace-only 变更（0.54.0）；文件间导航 `J`/`K`；`⌃V` 标记文件已看（mark as viewed，0.29.1）；revert 不想要的改动；历史 diff（0.22.0，看任意历史时点的 diff）。0.36.0 引入 "Pierre Diffs"（更好的 diff 渲染，细节未验证）。
- **行级评论 → 喂给 agent**：comment 挂在具体行上，"给 agent 的上下文比笼统消息精确得多"；`⌘⌥J`/`⌘⌥K` 在评论间跳转；支持多行评论（0.38.3）。Claude 也能反向在你的代码上留评论（0.29.0）。
- **Agent Review**：`⌘⇧R` 触发 Review action，让一个 agent review 当前 diff；review 可用单独的模型（`models.review`、custom review models 0.22.6）和单独的 prompt（`prompts.code_review`）。
- **GitHub 双向同步**：GitHub review comments 拉进 Conductor（0.25.4/0.25.11），可在本地 resolve；PR 元数据可编辑（0.34.1）；PR checks/CI/GitHub Actions 状态直接看（0.31.1、0.33.2）；failing checks 可一键转给 agent 修（0.12.0，`⌘⇧X` fix errors）。
- **Checks tab**：聚合 merge readiness——git status、PR metadata、CI/status checks、deployments（Vercel 0.29.2）、GitHub 评论线程、**todos**（0.28.4，merge-blocking 任务清单）。有未完成项时阻止/劝阻 merge。
- **PR 流**：`⌘⇧P` 创建 PR（agent 起草描述，提供当前 diff+repo 上下文）；`⌘⇧M` merge；支持 Graphite stacks（0.32.0）、change target branch（0.28.7）、PR page（0.73.0）。
来源：https://www.conductor.build/docs/reference/diff-viewer 、https://www.conductor.build/docs/reference/checks 、https://www.conductor.build/docs/guides/review-and-merge 及对应 changelog 页

---

## 6. Terminal 集成

- 每个 workspace 有终端面板（`⌘J` 切换），多 tab（`⌘⇧T` 新 tab），会话在 app 重启后**自动恢复**；scrollback 上限可配（默认 10MB，0.63.0）。
- **Big Terminal Mode**（`⌘⇧T`/Settings → Experimental）：把中央面板整个变成终端，"terminal-first workflow"。**新终端 tab 可带 preset 自动启动 agent CLI**：Claude、Codex（approvals 关闭时以 full-access 模式跑，开启时用 CLI 默认）、OpenCode、Amp、Pi、Copilot、Gemini、或空白。——这实际上就是 Coolie 想做的 tux 集成路线：PTY 里直接跑 agent 的 TUI。
- **终端与 chat 打通**：把终端输出作为上下文加进 chat（0.7.2）；Claude 可以直接读你的终端（0.29.5）；chat 里 `@terminal` 引用（0.46.0）。
- 其他：`⌘F` 终端内搜索、`⌘⇧B` 打开 localhost URL、shell 诊断工具（0.54.0）。终端实现为自研/重写过（0.38.1 "New Terminal"），具体 emulator 技术栈未公开——未验证。
来源：https://www.conductor.build/docs/reference/big-terminal-mode 、https://www.conductor.build/docs/concepts/testing 及对应 changelog 页

**Spotlight Testing**（worktree 隔离的补充方案）：把一个 workspace 的 **tracked 变更单向同步回 repo root**，在 root 起终端测试。适用于：必须从 repo root 跑的应用、首次构建昂贵、固定端口/单数据库、Docker/微服务太重没法每 workspace 起一套。限制：一次只能测一个 workspace。配置 `spotlight_testing = true`（可 per-repo，0.55.0）。
来源：https://www.conductor.build/docs/reference/scripts/spotlight-testing

---

## 7. 快捷键体系（完整表）

来源：https://www.conductor.build/docs/reference/keyboard-shortcuts （`⌘/` 打开 in-app cheatsheet）

**General**：`⌘K` command palette；`⌘⌥T` 切主题；`⌘/` 快捷键帮助；`⌘,` settings；`⌘⌥F` 反馈；`⌘⌥I` debug tools；`⌘⇧L` sidecar logs；`⌃O` Garry mode（展开 tool calls）。

**View**：`⌘B`/`[` 左侧栏；`⌘⌥B`/`]` 右侧栏；`⌘J` 终端面板；`⌘.`/`⌃Z` zen mode；`⌘=`/`⌘-`/`⌘0` 缩放。

**Navigation**：`⌘[`/`⌘]` 前进后退；`⌘⇧[`/`⌘⇧]`（或 `⌃Tab`）切 tab；`⌘W` 关 tab；`⌘⇧T` 重开 tab；`⌘P` quick open file；`⌘⌥A` 加仓库。

**Workspace**：`⌘N` 新建（Dispatcher）；`⌘⇧N` 从 PR/branch/issue 建；`⌘I` create-from picker；`⌘⇧A` 归档；`⌘O` open in app；`⌘⌥O` 远程打开 cloud workspace；`⌘⇧C` copy link；`⌘R` 启停 run script；`⌘E` 文件编辑模式；`⌘⇧P` 建 PR；`⌘⇧Y` commit+push；`⌘⇧L` pull main；`⌘⇧M` merge PR；`⌘⇧X` fix errors；`⌘⇧G` 在 GitHub 打开 PR；`⌘⇧R` 开始 review；`⌥C` 看 changes；`⌥U` 看 uncommitted；`⌥F` 所有文件；`⇧⌥C` 看 PR；`⌥N` notes；`⌘1-9` 切 workspace。

**Chat**：`⌘T` 新 chat tab；`⌘L` 聚焦输入框；`⇧Tab` plan mode；`⌘⇧↵` approve plan；`↵` 批准 tool；`⌫` 拒绝 tool；`⌘⇧⌫` 取消 agent；`⌘U` 附件；`⌥P` model picker；`⌥T` thinking level；**`⌥L`/`⌥H` 下一个/上一个"需要注意的 chat"**；`⌘F`/`⌘G` 搜索；`⌘⌥C` 复制精简 transcript；`⌘D` 语音输入；`↵` 发送、`⇧↵` 换行。

**Code review**：`⌘⇧D` diff view；`J`/`K` 文件间跳；`⌘⌥J`/`⌘⌥K` 评论间跳；`⌃V` 标记已看。

**Terminal**：`⌘T` 新终端 tab（终端聚焦时）；`⌘⇧B` 打开 localhost；`⌘F` 终端搜索。

设计观察：**单字母快捷键（J/K/⌥C/⌥N）只在"outside inputs"上下文生效**，官方给每个快捷键都标了"Works when"上下文（Global / Default context / Terminal focus / dialog 内）——上下文分层是这套体系可用的关键。

---

## 8. 并行调度、通知与外部集成

**调度模型**：没有中心化的"任务队列调度器"——并行的单位就是 workspace（每个各自跑各自的 agent），加上每个 chat 内的 message queue。人是调度者，产品给的是：Dispatcher 连续派发（`create more`）、`⌥L`/`⌥H` 在"需要注意的 chat"间轮转、Next Workspace 导航（0.36.4）、workspace 四状态看板、unread 标记。
来源：https://www.conductor.build/changelog/0.63.0-cursor-support-dispatcher 、https://www.conductor.build/docs/reference/keyboard-shortcuts

**通知**：任务完成播放提示音（0.52.0 加了 SNCF/巴黎地铁风格的三种音效）；workspace unread 标记；侧边栏 git status（0.17.4）。系统级推送通知机制文档未详述——未验证。
来源：https://www.conductor.build/changelog/0.52.0-sounds-colors 、https://www.conductor.build/changelog/0.25.11-fetch-comments-from-github-mark-workspaces-as-unread

**GitHub**：依赖 `gh` CLI 认证；fine-grained permissions（0.0.21）；GH_TOKEN（0.25.5）；GitHub Enterprise（0.22.4）；issues、Actions、PR comments 双向同步。**Linear**：连接账号后可从 issue 开 workspace、deep link 直达。**Graphite**：stacked PRs。**Vercel**：部署状态进 Checks。
来源：https://www.conductor.build/docs/installation 及对应 changelog 页

**Deep links（`conductor://` URL scheme）**——对 Coolie 的 CLI/自动化接口设计很有参考价值：
- `conductor://prompt=<encoded>`：在第一个可用 repo 新建 workspace 并预填 prompt
- `conductor://prompt=<encoded>&path=<repo path>`：指定 repo
- `conductor://linear_id=<id>&prompt=<optional>`：拉 Linear issue，自动匹配 repo，已有该 issue 分支的 workspace 则直接跳转，否则新建
- `conductor://async?repo=<name>&plan=<base64>`：新建 workspace 并附上 base64 的 plan markdown
注意其格式不统一：前三种是 `conductor://key=value&...`（无 host），async 用标准 URL 结构——设计新 scheme 时应避免这种混杂。
来源：https://www.conductor.build/docs/reference/deep-links

**Conductor Cloud**（2026 年中新推）：hosted workspace，把 agent 跑在云上、review 流程留在本地 Mac app；settings 里已有大量 local/cloud 双轨设计（`available_in`、`environment_variables.cloud`、`ssh_key_path`、`CONDUCTOR_IS_LOCAL`）。定价与技术细节未公开——未验证。
来源：https://www.conductor.build/cloud 、https://www.conductor.build/docs/reference/settings/reference

**安全模型**：agent 以你的用户账号权限跑，**无沙箱**；tool approvals 是唯一闸门；担心安全建议用专机/VM。macOS TCC 弹窗（Downloads/Desktop 等）会以 Conductor 名义出现（因为它是启动进程的 app）。`enterprise_data_privacy` 可禁用需要外部 AI 的功能（AI 起标题、自定义 MCP servers）。
来源：https://www.conductor.build/docs/reference/security-and-permissions 、https://www.conductor.build/docs/faq

---

## 9. 产品演进时间线（看优先级）

来源：https://www.conductor.build/changelog （2025-07 至 2026-07，摘关键节点）

| 阶段 | 时间 | 主线 |
|---|---|---|
| 起步 | 2025-07~08 | GitHub 集成、attachments、MCP、slash commands、local repos、**Git Diff View（0.3.0）**、UI 重做 |
| 打地基 | 2025-09~10 | run scripts/hooks（0.9.0）、**Code Review（0.10.0）**、终端性能、conductor.json（0.11.0）、command palette（0.14.0）、Linear（0.15.0）、**Diff Viewer + File Explorer（0.16.0）**、多 chat（0.17.0）、**Codex 接入（0.18.0）** |
| 深化 review | 2025-11~12 | checkpoints（0.19.0）、plan mode（0.21.0）、历史 diff（0.22.0）、GitHub Enterprise、fork workspaces、PR comments 同步、Workspaces hub（0.28.0）、todos |
| agent 交互精细化 | 2026-01~02 | 行级评论↔agent、customize prompts、读终端、Claude Code for Chrome、GitHub issues/Graphite、tasks、**workspace status（0.35.0）**、Pierre Diffs |
| 模式与性能 | 2026-03~04 | Manual Mode、fast mode、tool approval、command palette 重做、新 sidebar/composer、Codex skills/plan、**Allegro 全 app 性能重写（0.49.0，快 2 倍）**、Big Terminal Mode 回归 |
| 多引擎+云 | 2026-05~07 | Steering（0.50.0）、音效、**Cursor + Dispatcher（0.63.0）**、from-issue、**OpenCode（0.69.0）**、多 run scripts、分享链接、PR page、**Conductor Cloud** |

规律：**先把 diff/review 做深（最早的大功能是 Git Diff View），再扩 harness 数量（Codex→Cursor→OpenCode），模型跟发布日追新（新模型 1~2 天内上线），性能问题严重到需要一次全量重写（Allegro）**。

---

## 10. 与 Coolie 相关的可借鉴点

1. **数据模型直接可抄**：Project → Repository → Workspace(=branch) → Working tree(=git worktree) → Running environment 六层，加上"workspace 是委派单元、branch/PR 是集成单元"这句纲领。与 kobe 的 task = worktree + tmux + branch 完全同构，Conductor 多了 Project 和 Running environment 两层显式建模。
2. **双命名体系**：目录用稳定随机名（城市名），语义用 branch 名/PR 标题承载。避免"重命名任务导致路径变化、agent/终端引用全断"的坑。Coolie 值得直接采用（可以换成自己的命名池风格）。
3. **worktree 三件套**：setup scripts（动态初始化）+ files-to-copy/`.worktreeinclude`（静态 gitignored 文件）+ 独立端口段（`CONDUCTOR_PORT`，每 workspace 10 个端口）。这三个机制覆盖了 worktree 隔离的全部痛点，是最小完备集。Spotlight testing 是第四个补丁（repo-root 单向同步），微服务/Docker 重的项目会需要。
4. **harness 抽象**："agent runtime 写代码，我做 workspace 层"。bundled binary + 可覆盖路径 + 复用本机认证 token（不代管认证、不代收费用）是阻力最小的集成姿势。Coolie 走 tux 渲染时，Big Terminal Mode 的 preset 设计（per-agent 启动命令 + 依据 approval 设置切换 full-access flag）可直接参考。
5. **两条渲染路线并存**：Conductor 主路线是自渲染 chat UI（换来 tool approval、行级评论、checkpoints、message queue 等深度功能），副路线是终端里直接跑 CLI。Coolie 反过来（tux 优先）成立，但要意识到：**diff review、checkpoint、行级评论这些差异化功能大多依赖程序化接口，纯 tux 透传做不了**，长期可能仍需 headless/SDK 通道。
6. **四层 settings + TOML + JSON schema + UI 写正确层**：managed/local/repo/user 分层与 opencode 风格接近，`settings.local.toml` 不入 git 的约定值得抄。Conductor 从 conductor.json 迁到 settings.toml 的教训：一开始就选好格式。
7. **快捷键上下文分层**：每个快捷键声明生效上下文（Global / outside inputs / terminal focus / dialog），单字母键只在非输入区生效；`⌘/` in-app cheatsheet；`⌘K` palette 作为兜底。这是 Context.MD 里"丰富快捷键"需求的成熟范本，整表在 §7。
8. **进程管理细节**：SIGHUP → 200ms → SIGKILL；login shell 捕获 env（5s 超时）但用 zsh 执行；终端会话跨重启恢复；scrollback 限额。这些都是 server 端要踩的坑，Conductor 已给出答案。
9. **deep link / Dispatcher**：`conductor://` scheme + "prompt 预填新建 workspace"是外部工具（Raycast、Linear、脚本）接入的最短路径；Coolie 有 CLI 更该做好 `coolie new --prompt` 与 URL scheme 两个入口。
10. **注意力管理**：workspace 四状态 + unread + `⌥L/⌥H` 轮转"需要注意的 chat" + 完成音效。并行 agent 的真正瓶颈是人的注意力切换，这套组合拳比"通知中心"更轻更有效。

## 11. 风险与注意事项

- **本报告的 docs 内容多经 WebFetch 摘要**，个别措辞可能与原文有出入；关键实现（如 Codex 集成协议、终端 emulator 技术栈、通知机制细节）官方未公开，已标注未验证。
- **changelog 中的模型名（GPT-5.6、Claude Sonnet 5、Grok 4.5 等）** 超出我的知识截止时间，按官网 changelog 原样转述，未独立核实。
- Conductor 免费策略由融资支撑（$22M Series A），且团队 7 人迭代速度极快（52 周约 90 个 release）；Coolie 作为个人项目**不应对标其功能面**，应聚焦 workspace 脚手架内核（§10 第 1-4、7-9 条），review 深水区（行级评论、checkpoints）可以后置。
- Conductor 无沙箱、agent 以用户权限裸跑，只靠 tool approvals；Coolie 若同样选择不做沙箱，至少要在文档里同样明示。
- 单分支单 worktree 是 git 硬限制，产品层要提前处理"选了已被占用的分支"的报错体验。
- `ANTHROPIC_API_KEY` 环境变量覆盖订阅计费的坑（用户会被意外扣 API 费），Coolie 集成 Claude Code 时同样会遇到，需要显式提示。

## 12. 来源清单

**官网/产品**
- 首页：https://www.conductor.build/
- Cloud：https://www.conductor.build/cloud
- Enterprise：https://www.conductor.build/enterprise
- Team：https://www.conductor.build/team
- Blog：https://www.conductor.build/blog （Series A：/blog/series-a；cmd 并入：/blog/cmd-joins-conductor；Claude 订阅政策：/blog/claude-subscription-update）
- Changelog（全量，0.0.16→0.74.0）：https://www.conductor.build/changelog

**Docs — Getting started / Concepts**
- https://www.conductor.build/docs
- https://www.conductor.build/docs/installation
- https://www.conductor.build/docs/first-workspace
- https://www.conductor.build/docs/configure-your-project
- https://www.conductor.build/docs/concepts/workspaces-and-branches
- https://www.conductor.build/docs/concepts/workflow
- https://www.conductor.build/docs/concepts/parallel-agents
- https://www.conductor.build/docs/concepts/testing
- https://www.conductor.build/docs/concepts/git-worktrees
- https://www.conductor.build/docs/concepts/agent-modes

**Docs — Reference**
- https://www.conductor.build/docs/reference/scripts （含 /scripts/setup、/scripts/run、/scripts/spotlight-testing）
- https://www.conductor.build/docs/reference/files-to-copy 、/docs/reference/worktreeinclude
- https://www.conductor.build/docs/reference/environment-variables
- https://www.conductor.build/docs/reference/shells
- https://www.conductor.build/docs/reference/settings/reference 、/settings/user-project 、/settings/managed 、/settings/example
- https://www.conductor.build/docs/reference/conductor-json （legacy）
- https://www.conductor.build/docs/reference/harnesses （及 /harnesses/claude-code、/harnesses/codex、/harnesses/cursor、/harnesses/opencode）
- https://www.conductor.build/docs/reference/agent-behavior
- https://www.conductor.build/docs/reference/checkpoints
- https://www.conductor.build/docs/reference/mcp
- https://www.conductor.build/docs/reference/diff-viewer
- https://www.conductor.build/docs/reference/checks 、/docs/reference/todos
- https://www.conductor.build/docs/reference/big-terminal-mode
- https://www.conductor.build/docs/reference/keyboard-shortcuts
- https://www.conductor.build/docs/reference/deep-links
- https://www.conductor.build/docs/reference/cities
- https://www.conductor.build/docs/reference/security-and-permissions 、/docs/reference/privacy
- https://www.conductor.build/docs/faq

**Docs — Guides**
- https://www.conductor.build/docs/guides/review-and-merge 、/guides/issue-to-pr 、/guides/use-files-to-copy 、/guides/configure-settings 、/guides/configure-mcp-servers 、/guides/providers 、/guides/repositories/monorepos 、/guides/repositories/linking-multiple-directories 、/guides/migrate-from-cursor

**第三方（辅证，未逐一核验）**
- YC 公司页：https://www.ycombinator.com/companies/conductor
- GitHub org：https://github.com/meltylabs
- PitchBook：https://pitchbook.com/profiles/company/641785-69 （总融资 $60M/4 轮，未验证）
