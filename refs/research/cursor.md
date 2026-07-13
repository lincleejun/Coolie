# Cursor Agents Window：agent UI/交互拆解（Coolie client 参考）

> 研究日期：2026-07-10。截图：`refs/cursor/image.png`（Cursor 3.x 桌面版 Agents Window）。
> 来源标注约定：官方 docs/changelog 用 URL；截图直接观察标注「截图」；第三方文章标注「第三方」；无法确认的标注「未验证」。
> 注意：官方页面经 WebFetch 摘要转述，引用的英文原文以官方页面为准。

## 概述

截图中的界面是 **Agents Window** —— Cursor 3（GA 于 2026-04-02）引入的 "agent-first interface"，与传统 IDE 编辑器并列的第二个顶层界面，通过 `Cmd+Shift+P → Open Agents Window` 打开、`Open IDE` 切回（来源: https://cursor.com/docs/agent/agents-window ）。它的定位：**一个统一工作台，跨 repo、跨环境（local / worktree / cloud / remote SSH）管理并行 agent**（来源: https://cursor.com/changelog/3-0 ）。

演进脉络（对理解设计取舍有用）：

- **Cursor 2.0**（2025-10）：第一次把编辑器改成 "sidebar for your agents and plans" 的 agent 中心布局；单 prompt 最多 8 个并行 agent，用 git worktree 或远程机器隔离；浏览器面板入编辑器；sandboxed terminal（有工作区权限、无网络）（来源: https://cursor.com/changelog/2-0 ）。
- **Cursor 3.0**（2026-04）：Agents Window 独立成窗；`/worktree`、`/best-of-n` 命令；Agent Tabs（多会话 side-by-side / grid）；Design Mode（来源: https://cursor.com/changelog/3-0 ）。
- **Cursor 3.2**（2026-04-24）：`/multitask`（async subagents 并行化队列）、worktree 任务一键拉回 local foreground、multi-root workspaces（一个 agent 会话跨多目录/多 repo）（来源: https://cursor.com/changelog/04-24-26 ）。
- **Cursor 3.4/3.5**（2026-05）：tool call density 可配置（"Compact" 模式 "shows concise results with minimal tool traces"）（来源: https://cursor.com/changelog/3-4 ）；Automations 进 Agents Window、支持多 repo/无 repo（来源: https://cursor.com/changelog/05-20-26 ）。

半年三次大改版，说明这套布局本身还在快速收敛中——抄结构没问题，别抄死细节。

## 信息架构：左侧导航（作者点名要参考的部分）

左侧栏是一个**三段式结构**（截图）：

```
┌──────────────────────────┐
│ ← →  (导航历史)           │
│ ⊕ New Agent              │  固定操作区
│ 🔍 Search                │
│ ⏱ Automations            │
│ ⚙ Customize              │
├──────────────────────────┤
│ Repositories   🔍 ⧩ 📁    │  repo 分组区（搜索/过滤/添加repo）
│ ▾ openmontage            │
│    GIMP skills for …  1d │  ← 会话，选中态高亮
│    Discussion on …    1d │
│    Blender film …     2d │
│ ▸ palmier-pro            │
│ ▸ Home                   │
│ ▸ opencode               │
│ ▾ ies/mag                │
│    Bun in Rust doc…   1d │
│    RDS migration …   11d │
│    …                 1mo │
│    More                  │  ← 折叠更多历史会话
├──────────────────────────┤
│ 👤 Jun Li  [Update] ⚙    │  账户/更新/设置
└──────────────────────────┘
```

要点：

1. **导航层级只有两层：repo → agent session**。没有 project/workspace/folder 的中间层，认知成本极低。repo 即分组，会话按最近活动倒序，右侧对齐相对时间（`1d`/`2d`/`11d`/`1mo`），超出数量折叠进 `More`（截图）。
2. **单一收件箱**：sidebar 汇聚所有来源的 agent —— "local agents, cloud agents, and the ones you kicked off from mobile, web, the desktop app, Slack, GitHub, and Linear" 全在一个列表（来源: https://www.digitalapplied.com/blog/cursor-3-agents-window-complete-guide ，第三方，与官方 changelog 3-0 表述一致）。
3. **Multi-workspace**：顶部 agent pane 可以在一个实例里打开多个 workspace/repo，每个 workspace 有自己的 co-located indexing（来源: cursor.com/changelog 3.x 系列，经搜索摘要，未逐字定位到具体条目）。
4. **动词入口和名词容器分离**：New Agent/Search/Automations/Customize 是固定的"动作/功能页"入口，Repositories 是内容容器。Search 是跨会话的全局搜索入口（截图；具体搜索范围未验证）。
5. **Automations** = 定时（cron）或事件（GitHub/GitLab PR、push、comment、Slack、webhook、Linear、Sentry、PagerDuty）触发的 cloud agent，创建流程五步：trigger → prompt → 可选 tools → 绑定 0/1/N 个 repo → 激活；产出可以是开 PR、发 Slack、评论 PR（来源: https://cursor.com/docs/automations ）。
6. **Customize** = Plugins、skills、MCP 的集中管理页（"The new Customize page brings them into one place"，来源: cursor.com/changelog 3.x，经搜索摘要）。
7. 会话标题是自动生成的短句（如 "GIMP skills for openmontage"），不是分支名也不是 prompt 原文（截图）。

## Agent 会话的状态呈现

### 会话级状态

- sidebar 中的 agent 条目有 running / completed / waiting 等状态区分，方便追踪并行任务（来源: https://cursor.com/changelog/2-0 "a sidebar for your agents and plans"；细粒度状态词来自第三方 https://www.cometapi.com/cursor-2-0-what-changed-and-why-it-matters/ ，未在官方文档逐字验证）。
- 截图中已完成会话只显示相对时间，无进度指示——**空闲态不打扰**是明确的设计选择（截图）。

### 对话流内的过程摘要（截图中部）

这是 Cursor 很成熟的一块：**把 agent 的工作过程压缩成可折叠的摘要行**：

- `Worked for 1m 44s ⌄` —— 一轮工作的总耗时，折叠头（截图）。
- `Thought briefly` / `Explored AGENT_GUIDE.md` / `Explored 2 searches` / `Explored bg_remove.py, 2 searches` —— 工具调用被聚合成一行行"过程条目"，穿插 agent 的自然语言叙述（截图）。
- 密度可配置：tool call density 的 "Compact" 选项 "shows concise results with minimal tool traces"（来源: https://cursor.com/changelog/3-4 ）。
- **Checkpoints**：时间线上每次大改动前自动快照，点击任意 checkpoint 可预览/回滚 codebase，且不污染 git history（来源: https://cursor.com/docs/agent/overview ）。

### diff / 分支状态

- 有改动时，当前 branch 显示在右上和 review tab 上（"The current branch shows top-right and on the review tab (top-left once there are changes)"，来源: https://www.learncursor.dev/learn/cursor-agents/agents-window ，第三方）。
- 截图底部状态条：`⑂ main`（分支徽标）、`⌸ This Mac`（执行机器）、`◔ 31%`（context 占用环）。context ring 点击可展开 token 用量分类（system prompt / tools / rules / history / 压缩摘要）（来源: https://cursor.com/docs/agent/prompting ）。
- 消息队列：agent 工作中按 `Enter` 排队 follow-up，顺序执行；`Cmd+Enter` 跳过队列立即插入当前任务；队列消息可拖拽排序（来源: https://cursor.com/docs/agent/overview ）。

## 底部输入框

截图元素：`＋`（附件）| 占位符 `Send follow-up` | 模型选择 `Opus 4.8 1M High ⌄` | 🎤 语音。输入框上方悬浮 `Create Branch & Commit ⌄` 按钮和滚动到底箭头。

1. **@ mentions**（来源: https://cursor.com/docs/agent/prompting ）：
   - `@file` / `@folder`（如 `@auth.ts`、`@src/components/`）
   - `@Docs`（索引过的文档，含自建文档）
   - `@Terminals`（终端输出入 context）
   - `@Past Chats`（引用历史会话）
   - `@Browser`（内置浏览器的上下文）
   - git diff 选项（未提交改动 / 分支对比）
   - 省略 mention 时 agent 自动找相关文件。2.0 起刻意**做减法**：移除 @Definitions/@Web/@Link 等菜单项，让 agent "self-gather context"；文件/目录在输入框内渲染为 pills（来源: https://cursor.com/changelog/2-0 ）。
2. **附件**：拖拽图片或 `Cmd+V` 粘贴截图（来源: https://cursor.com/docs/agent/prompting ）。
3. **语音**：麦克风图标进入 dictation，说完可校对转写文本再发（来源: https://cursor.com/docs/agent/prompting ）。
4. **模型 + effort 合并为一个选择器**："Opus 4.8 1M High" = 模型（Opus 4.8）× context 档位（1M）× effort（High）打包成一个下拉项。effort 档位是模型属性：Opus 4.6 有 low/medium/high(默认)/max，4.7+ 增加 xhigh，效果变体直接出现在 model picker 里（来源: https://cursor.com/docs/models/claude-opus-4-6 ；picker 中的 effort 变体形式另见 https://forum.cursor.com/t/opus-4-7-thinking-effort-variants-low-medium-high-max-gone-from-the-chat-agent-model-picker-on-cursor-stable-v3-3-27-windows-ui-regression-vs-v3-0-12-linux/160112 ，社区帖）。`Cmd+/` 循环切换模型，改动只对当前会话之后的消息生效（来源: https://cursor.com/docs/agent/prompting ）。
5. **slash commands**（在输入框内触发）：
   - worktree 相关：`/worktree`（在隔离 checkout 里跑任务）、`/best-of-n`（同一任务多模型并行、每个 run 一个 worktree、比较后择优应用）、`/apply-worktree`（把 worktree 改动带回主 checkout）、`/delete-worktree`（来源: https://cursor.com/docs/configuration/worktrees ）
   - cloud 相关：`/in-cloud`、`/babysit`（把长任务交给 cloud subagent）（来源: https://cursor.com/docs/agent/agents-window ）
   - 并行：`/multitask`（把请求拆给 async subagents 并行，替代排队）（来源: https://cursor.com/changelog/04-24-26 ）
   - 其他：`/summarize`（按需压缩 context）、`/models`（来源: https://cursor.com/changelog/1-6 ）；`/create-skill`、`/migrate-to-skills`、`/[skill-name]` 运行自定义 skill（来源: https://cursor.com/docs/context/commands ）
6. **`Create Branch & Commit`**：review 动作按钮悬浮在输入框上方；若改动落在 main 上，commit 按钮旁的箭头可"creates a new branch and commits there instead"（来源: https://www.learncursor.dev/learn/cursor-agents/agents-window ，第三方 + 截图）。**把 git 收尾动作放在输入框旁边**，是"对话即工作流"的关键一笔。

## 右侧面板

截图右栏标题 `On OpenMontage`（当前 workspace 名），下挂四个入口，均为按需展开的 inspector（截图 + 来源: https://www.learncursor.dev/learn/cursor-agents/agents-window ，第三方）：

| 面板 | 能力 |
|---|---|
| **Changes** | review pane：逐 diff 审查每一处编辑、commit、管理 PR，"review and commit changes, and manage PRs without leaving Cursor"（来源: https://cursor.com/docs/agent/agents-window ）；agent 也能在 review pane 里复查自己的工作 |
| **Browser** | 内嵌浏览器：打开/导航本地站点、选取元素并把 DOM 信息转发给 agent（来源: https://cursor.com/changelog/2-0 ）；Design Mode 直接在页面上标注 UI 元素（`Cmd+Shift+D`）（来源: https://cursor.com/changelog/3-0 ） |
| **Terminal** | 每个 agent 一个 sandbox terminal，隔离 shell；2.0 的 sandboxed terminal 有工作区权限但默认无网络（来源: https://cursor.com/changelog/2-0 ） |
| **Files** | 文件浏览器，像经典 explorer 一样浏览该 workspace（第三方: learncursor.dev） |

设计要点：右栏默认**收起为一列文字入口**（截图），不抢对话流的宽度；四个面板都是"以 agent 会话为中心的检查工具"，而不是常驻 IDE 组件。

## 与 git 分支 / worktree 的关系

这部分与 Coolie 的核心模型（task = worktree + branch + session）直接对应：

1. **执行环境四选一**：agent 启动时选 local（直接改主 checkout）/ worktree / cloud / remote SSH（来源: https://cursor.com/changelog/3-0 ）。截图底部的 `This Mac` 就是机器/环境选择器；桌面端 agent dropdown 里选 "Cloud" 即转 cloud agent（来源: https://cursor.com/docs/cloud-agent ）。
2. **worktree 生命周期**（来源: https://cursor.com/docs/configuration/worktrees ）：
   - 集中在**机器级 root 目录**统一管理，不散落在项目里；用 mtime checkpoint 做增量发现（3.5），避免反复全盘扫描。
   - **setup 脚本**：`.cursor/worktrees.json`，键 `setup-worktree-unix` / `setup-worktree-windows` / `setup-worktree`（fallback），值为命令数组或脚本路径；典型用途：`npm ci`、用 `$ROOT_WORKTREE_PATH` 变量从主 checkout 拷 `.env`、跑 migration。官方明确**不推荐 symlink 依赖**（"This can cause issues in the main worktree"）。
   - **自动清理**：全机保留最新 N 个（`cursor.worktreeMaxCount` 默认 25），按 `cursor.worktreeCleanupIntervalHours` 周期清理；每轮清理会重新发现 root 下所有 worktree，外部创建的也会被纳入清理。
   - **回收改动**：从 worktree checkout 直接 commit/PR，或 `/apply-worktree` 带回主 workspace；Agents Window 里可把任意分支上的后台任务"一键拉到 local foreground"（来源: https://cursor.com/changelog/04-24-26 ）。
   - setup 失败排查走编辑器 Output panel → `Worktrees Setup` channel。
3. **cloud agent**：跑在隔离 VM，clone repo、装依赖、注入 secrets；在**独立分支**上工作，完成后 push 并产出 merge-ready PR；本地机器断网也不影响；一处发起、多端接续（desktop/web/iOS/Slack/GitHub/Linear/API），会话状态跨端一致（来源: https://cursor.com/docs/cloud-agent ）。
4. **best-of-n 的隔离哲学**：并行尝试的单位就是 worktree——"Each run gets its own worktree, so the candidates stay isolated from each other and from your main checkout"（来源: https://cursor.com/docs/configuration/worktrees ）。

## 快捷键

来源: https://cursor.com/docs/configuration/kbd （agent/chat 相关子集）：

| 键位 | 动作 |
|---|---|
| `Cmd+E` | Toggle Agent layout |
| `Cmd+I` / `Cmd+L` | Toggle Sidepanel |
| `Cmd+N` / `Cmd+R` | New chat |
| `Cmd+T` | New chat tab |
| `Cmd+[` / `Cmd+]` | Previous / Next chat |
| `Cmd+W` | Close chat |
| `Cmd+/` | Loop between AI models |
| `Cmd+Opt+/` | Model toggle |
| `Enter` | Nudge（默认；agent 运行中= 排队） |
| `Ctrl+Enter` | Queue message |
| `Cmd+Enter`（输入中） | Force send |
| `Cmd+Shift+Backspace` | Cancel generation |
| `Cmd+Enter`（有 suggested changes） | Accept all changes |
| `Cmd+Backspace` | Reject all changes |
| `Tab` / `Shift+Tab` | 消息循环 / Agent 模式轮换 |
| `Esc` | Unfocus field |

Agents Window 内保留 IDE 习惯键位：`Cmd+P` 文件搜索、`Cmd+Shift+F` 全局搜索（来源: https://cursor.com/docs/agent/agents-window ）。Design Mode：`Cmd+Shift+D` 开关、`Shift+drag` 选区、`Cmd+L` 元素入 chat、`Opt+click` 元素入输入框（来源: https://cursor.com/changelog/3-0 ）。

设计规律：**高频操作全部单修饰键（Cmd+单键）**；`Cmd+Enter`/`Cmd+Backspace` 这对"接受/拒绝全部"是 review 流的核心；同一键（Enter、Cmd+Enter）按上下文（输入中/运行中/有 diff）复用语义。

## 对 Coolie client 布局的具体建议

结合 Context.MD（coolie = repo + branch 干净环境脚手架；task = worktree + tmux session + branch；tux-first 渲染）：

### 1. 左侧栏直接抄三段式，语义换成 Coolie 的

```
[New Task] [Search] [Settings/Engines]      ← 固定动作区
Repositories
  ▾ repo-a
     task "fix login race"   ●running  2m
     task "bun docs"         ✓ +120 −8  1d
  ▸ repo-b                              More
[账户/版本/设置]                          ← 底部常驻
```

- 层级严格两层 repo → task，不引入 workspace 中间概念（Cursor 验证过这个认知模型成立）。
- Cursor 的 Automations/Customize 对 Coolie 第一阶段是噪音，可替换为 Engines（coding engine 管理：claude/codex 的安装、账号、默认参数）——这是 Coolie 独有的一级实体，Cursor 没有（它只有一个 agent）。
- 每个 task 条目：自动生成的短标题 + 相对时间 + 状态。标题生成可以在 task 创建后让 engine 起名，或降级用 branch 名。

### 2. 状态呈现按"能拿到什么数据"分级

- Cursor 的 `Worked for 1m 44s` / `Explored …` 过程摘要依赖**结构化 agent 事件流**。Coolie 走 tux 渲染时拿不到这层数据——终端里滚的是 claude 自己的 TUI。所以：
  - **tux 模式**：状态只做 session 级——running（tmux session 有活跃输出）/ idle（等输入）/ exited，加"最后活动时间"和运行时长。检测手段：tmux pane 活动、进程状态。
  - **headless 模式**（第二优先级）：再做 Cursor 式过程摘要（claude 的 stream-json 输出有完整 tool call 事件）。
- **diff 数是引擎无关的**：`git diff --shortstat` 对着 task 的 worktree 轮询即可，在 sidebar task 条目上显示 `+N −M`。这是 Coolie 不依赖 engine 就能做到的最有信息量的状态位，优先做。

### 3. 右侧面板：Changes 是 Coolie 的主战场

- Cursor 右栏四件套里，**Changes（diff review）和 Terminal 对 Coolie 价值最高**，且都不依赖 engine：Changes = 对 worktree 跑 git diff 自渲染（对应 Context.MD "方便做 code review"）；Terminal = 附加的 tmux pane / 集成终端（Context.MD 已提 iterm2 + oh-my-zsh）。
- Files（只读文件树）成本低可顺带做；Browser 面板第一阶段砍掉。
- 抄"默认收起为一列文字入口"的形态：右栏不常驻展开，中间区域（tux 终端）保持最大宽度。

### 4. 输入框：区分"任务创建输入框"和"会话输入框"

- tux-first 意味着会话进行中的输入发生在 claude 自己的 TUI 里，Coolie 不应该在外面再套一个聊天输入框（会产生两个输入焦点的混乱）。
- 但 **New Task 的创建输入框**完全可以做成 Cursor 底栏这样：prompt + 模型/effort 选择（映射为 `claude --model opus` 等启动参数）+ 附件 + 目标 branch/base 选择 + 执行环境（先只有 This Mac）。参考 `refs/input.png` 的要求正好落在这里。
- Cursor 把 model × context 档 × effort 打包成一个下拉项（"Opus 4.8 1M High"）值得抄——一个选择器解决三个维度，但注意每个 engine 的档位不同，需要 per-engine 的选项描述（server 端由 engine adapter 提供，类似 opencode 的 provider 抽象）。
- 底部状态条三件套照抄：`⑂ branch`、`⌸ 机器`（第一阶段固定 This Mac）、context 占用（tux 模式下拿不到，headless 再做；未验证 claude tux 是否有可解析的 context 指标）。

### 5. worktree 管理策略直接借鉴 docs/configuration/worktrees

- 集中 root（如 `~/.coolie/worktrees/<repo>/<task>`）而不是散在项目里；
- 等价 `worktrees.json` 的 setup hook（per-repo 配置：拷 `.env`、`pnpm install`），提供 `$ROOT_WORKTREE_PATH` 类变量；
- 全机 max-count + 定期清理，且清理时重新扫描 root（容忍外部创建/删除）；
- 明确不 symlink node_modules；
- 收尾动作学 Cursor：`Create Branch & Commit` 一类按钮放在 task 视图显眼处，以及"apply 回主 checkout"与"直接 commit/PR"两条路径都要有。

### 6. 快捷键

- 照抄 Cursor 的单修饰键梯度：`Cmd+N` 新 task、`Cmd+T` 新 tab、`Cmd+[`/`Cmd+]` 切 task、`Cmd+W` 关闭、`Cmd+E` 切换布局焦点（sidebar/terminal/右栏）、`Cmd+Enter`/`Cmd+Backspace` 接受/放弃 diff（Changes 面板内）。
- Context.MD 要求的 `Ctrl+A`/`Ctrl+E`：macOS WebKit 的 text input 原生支持 emacs 键位，Tauri（WKWebView）里默认可用，但要确保自定义快捷键系统不吞掉 Ctrl 系按键——把全局快捷键约束在 Cmd 空间即可避开冲突（此条为工程判断，未验证 Tauri 具体行为）。
- tux 终端获得焦点时快捷键透传给 claude TUI，只保留少数逃逸键（如 `Cmd+[`/`]`）——这一点 Cursor 没有对应物（它不嵌 TUI），是 Coolie 要自己解决的焦点路由问题。

## 风险与注意事项

1. **UI 迭代速度**：2.0（2025-10）→ 3.0（2026-04）→ 3.5（2026-05）连续重构，截图布局属于 3.x 快照，细节（如 @ 菜单项、effort 变体展示方式）在小版本间反复变动（例证: forum.cursor.com/t/160112 报告 effort 变体从 picker 消失的 UI regression）。抄信息架构，不抄像素。
2. **过程摘要的前提是自渲染**：Cursor 的 `Worked for`/`Explored`/checkpoints 全部建立在"agent 事件流由自己解析渲染"上，与 Coolie 的 tux-first 路线正交。不要为了复刻这层 UI 被迫提前做 headless 自渲染。
3. **第三方来源**：learncursor.dev、digitalapplied.com 的 UI 细节描述未经官方文档逐条印证，标注处仅作旁证。
4. **WebFetch 转述**：本文英文引句来自摘要模型对官方页面的转述，个别措辞可能与页面原文有出入；关键实现决策前建议直接打开对应 URL 复核。
5. **Cursor 有官方 IDE 兜底**：Agents Window 右上有 `IDE ↗` 一键跳回完整编辑器（截图）。Coolie 没有自己的编辑器，对应动作应是"用 $EDITOR/VS Code/Cursor 打开该 worktree"，这个逃生舱必须有。

## 来源清单

官方文档：
- https://cursor.com/docs/agent/agents-window — Agents Window 定位、能力清单、Cmd+Shift+P 入口、/in-cloud、/babysit
- https://cursor.com/docs/agent/overview — Agent 组成、checkpoints、消息队列
- https://cursor.com/docs/agent/prompting — @ mentions、附件、语音、模型选择、context ring
- https://cursor.com/docs/configuration/worktrees — worktree 生命周期、worktrees.json、清理策略、/worktree、/best-of-n、/apply-worktree
- https://cursor.com/docs/cloud-agent — cloud agent VM/分支/PR/多端接续
- https://cursor.com/docs/automations — Automations 触发器与产出
- https://cursor.com/docs/context/commands — /create-skill、/migrate-to-skills、/[skill-name]
- https://cursor.com/docs/configuration/kbd — 快捷键全表
- https://cursor.com/docs/models/claude-opus-4-6 — effort 档位（low/medium/high/max）、1M context

官方 changelog / blog：
- https://cursor.com/changelog/2-0 — 2.0 agent 界面、8 并行、@ 菜单精简、sandboxed terminal、浏览器面板
- https://cursor.com/changelog/3-0 — Agents Window、Agent Tabs、/worktree、/best-of-n、Design Mode 快捷键
- https://cursor.com/changelog/04-24-26 — /multitask、worktree 一键拉回 foreground、multi-root workspaces
- https://cursor.com/changelog/3-4 — tool call density（Compact）
- https://cursor.com/changelog/05-20-26 — Automations 进 Agents Window、多 repo/无 repo automations
- https://cursor.com/changelog/1-6 — /summarize、/models

第三方（旁证）：
- https://www.learncursor.dev/learn/cursor-agents/agents-window — 右栏四面板、Create Branch 按钮、branch 显示位置
- https://www.digitalapplied.com/blog/cursor-3-agents-window-complete-guide — sidebar 单一收件箱
- https://forum.cursor.com/t/opus-4-7-thinking-effort-variants-low-medium-high-max-gone-from-the-chat-agent-model-picker-on-cursor-stable-v3-3-27-windows-ui-regression-vs-v3-0-12-linux/160112 — picker 中 effort 变体形态（及其不稳定性）

本地：
- /Users/outman/workspace/ai/personal_ai/Coolie/refs/cursor/image.png — 截图（Cursor 3.x Agents Window）
- /Users/outman/workspace/ai/personal_ai/Coolie/Context.MD — Coolie 需求
