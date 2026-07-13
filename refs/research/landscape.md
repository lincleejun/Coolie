# Conductor 同类产品全景扫描（multi-agent coding workspace 管理器）

> 调研日期：2026-07-10。所有事实均来自当日 WebSearch/WebFetch 核实，来源以 URL 标注；本地参考（kobe、agent-deck）以文件路径标注。目的：确认 Coolie（个人向、tux/TUI 优先渲染、CS 架构、macOS 优先）的差异化空间。

---

## 概述

这个品类可以统一描述为：**coding agent 并行编排壳（orchestration shell）**——自己不做 agent，而是给 Claude Code / Codex / Gemini CLI 等 "coding engine" 提供隔离环境（几乎全部基于 git worktree）+ 会话管理 + diff review + 合并/PR 流程。与 Coolie 的定位（"repo + branch 的干净开发环境脚手架"）完全同类。

**市场快照（2026-07 时点）：**

1. **赛道极度拥挤**。社区维护的 awesome-agent-orchestrators 清单中"并行 agent 运行器"一类就列了 56 个项目（https://github.com/andyrewlee/awesome-agent-orchestrators）。
2. **2026 上半年出现一轮洗牌，云端/托管路线普遍死亡，本地优先 + 复用用户已有订阅的路线存活**：
   - Terragon（云端后台 agent 编排）2026-01-16 关停，留下开源快照（https://github.com/terragon-labs/terragon-oss）。
   - Omnara（YC S25，远程遥控 relay）主仓库 2026-02-02 归档，转型 voice-first 平台（https://github.com/omnara-ai/omnara）。
   - Crystal 2026-02 弃用，作者转向继任产品 Nimbalyst（https://github.com/stravu/crystal）。
   - Bloop（vibe-kanban 母公司）2026 年上半年宣布关停（Nimbalyst 博客称 2026-04-10 公告），vibe-kanban 转为 Apache-2.0 社区维护，云端付费服务下线（https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/ 、https://github.com/BloopAI/vibe-kanban）。
   - HumanLayer 把开源 monorepo 变成"deprecated archive"（README 原话："the code here is pretty much all deprecated"），产品闭源重建于 humanlayer.com（https://raw.githubusercontent.com/humanlayer/humanlayer/main/README.md）。
3. **存活且活跃的头部**：Conductor（闭源、免费、macOS）、cmux（24.2k stars）、Superset（12.4k stars）、Emdash（5.1k stars，YC W26）、vibe-kanban（27.3k stars，社区维护）。
4. **商业模式共识**：工具本身免费/开源，复用用户已有的 Claude Pro/Max、Codex 订阅或 API key（Conductor 明确 "doesn't take your API key or sell a subscription"，https://news.ycombinator.com/item?id=44594584 相关报道）。这条赛道很难收钱——对个人向、不打算商业化的 Coolie 反而是利好。

---

## 核心概念与数据模型（各产品的共同模式）

几乎所有产品收敛到同一个数据模型，验证了 Coolie 的 `task = repo + branch (+ worktree + session)` 直觉：

| 产品 | 任务单元叫法 | 隔离机制 | 会话载体 |
|---|---|---|---|
| Conductor | workspace | git worktree | 内嵌 agent 会话 + terminal |
| Sculptor | task / workspace | **Docker container**（含代码副本） | 容器内 agent + 内嵌 terminal |
| Crystal | session | git worktree | Electron 内自渲染 |
| vibe-kanban | task（kanban 卡片）→ workspace | git worktree + branch | workspace 附带 terminal + dev server |
| cmux | workspace（垂直 tab） | 不强制（它是终端，worktree 由用户/脚本管理） | 原生终端 pane（libghostty） |
| Superset | task / workspace | git worktree | 内嵌终端（Electron） |
| Emdash | task | git worktree + branch（可 SSH 远程） | 内嵌终端/自渲染 |
| Claude Squad | instance | git worktree | **tmux session** |
| kobe（本地参考） | task | git worktree | **tmux session**（`refs/kobe/README.md`："Task = git worktree + tmux session + branch"） |
| agent-deck（本地参考） | session（可分组） | 可选 worktree | tmux 风格 TUI 会话 |
| Terragon（已死） | task | 云端 sandbox container | 云端 headless，Web 查看 |

**两条渲染路线**（对 Coolie 最关键的分野）：

- **A. 自渲染（headless/SDK 流解析）**：Conductor、Crystal、vibe-kanban、Emdash、Sculptor——把 agent 输出解析成自定义 chat/卡片 UI。优点是 UI 可控、可做结构化 review；缺点是每接一个 engine 都要适配其输出协议，engine 升级即维护负担。
- **B. 终端复用（tux/TUI 直渲染）**：cmux（libghostty 原生渲染）、Claude Squad / kobe / agent-deck（tmux）、Superset（Electron 内嵌终端）——直接跑 engine 自己的 TUI。优点是"任何能在终端跑的 agent 天然支持、零协议适配"（cmux 文档原话："any agent that runs in a terminal works out of the box"，https://cmux.com/）；缺点是难以做结构化提取（如工具调用列表、token 统计）。
- 混合路线正在出现：Superset = 终端渲染 + 独立 diff viewer；cmux = 终端渲染 + sidebar 元数据（git branch、PR 状态、端口、通知）。**Coolie 的 "tux 优先、headless 兜底" 正是这条混合路线。**

---

## 逐个产品分析

### 1. Conductor（conductor.build）——本品类的定义者

- **一句话**：免费 Mac 原生 app，让多个 Claude Code/Codex/Cursor agent 各自在隔离 workspace（git worktree）里并行干活，然后 review & merge。
- **开源/栈**：闭源；官方未公开技术栈（未验证，社区普遍认为是原生/Electron 混合，无可靠来源）。
- **任务模型**：每个 workspace = 一个 git worktree + branch，"zero conflict between them"（https://www.conductor.build/docs）。
- **引擎**：官网明确 "Claude Code, Codex, and Cursor agents"（https://www.conductor.build/ ，2026-07-10 抓取）；第三方报道另提 OpenCode（https://grokipedia.com/page/Conductorbuild ，可信度中等）。
- **亮点**：① 复用本机已有 Claude/Codex 登录，不收 API key、不卖订阅；② GitHub/Linear 集成，一键开 PR、回复 review 评论；③ 官方建议 3–5 个并行 workspace 是甜点区（https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions）。
- **活跃度**：活跃，macOS only。HN Show HN：https://news.ycombinator.com/item?id=44594584 。
- **对 Coolie**：UI 直接参考对象（作者本机已装）。它是自渲染路线；不开源意味着 Coolie 无法借代码，只能借交互。

### 2. Sculptor（Imbue）——容器隔离路线的代表

- **一句话**："The missing UI for coding agents"——每个 agent 跑在自己的 Docker container 里（不是 worktree），安全并行。
- **开源/栈**：MIT 开源（https://github.com/imbue-ai/sculptor）；Python 57.6% + TypeScript 36.9%（桌面壳 + Python 后端）。
- **任务模型**：workspace = "isolated copies of your code"，容器隔离而非共享本地环境；官方点名批评 worktree 方案 "share your local environment and require reinstalling dependencies for every agent"（https://imbue.com/sculptor/）。
- **引擎**：Claude Code + 自家 Pi harness 深度集成；其他终端 agent 通过内嵌 terminal 支持（https://github.com/imbue-ai/sculptor）。
- **亮点**：① **Pairing Mode**——一键把容器内 agent 的工作同步进本地 repo，保持文件和 git 状态同步，在自己 IDE 里接手（https://imbue.com/sculptor/）；② 内置 workflow skills（spec / fix-bug 等）。
- **活跃度**：非常活跃但声量小——v0.42.0 发布于 2026-07-10（就是今天），1718 commits，但仅 197 stars。macOS (Apple Silicon) + Linux。Beta 免费，需 Anthropic API key 或 Pro/Max。
- **对 Coolie**：容器路线是 worktree 路线的主要竞争叙事；Pairing Mode（隔离环境 ↔ 本地环境的双向同步）值得抄概念。

### 3. Crystal（stravu）→ Nimbalyst——已完成一轮产品迭代

- **Crystal 一句话**：Electron 桌面 app，多个 Claude Code/Codex session 并行跑在 git worktree 里。MIT，TypeScript 96.8%。3.1k stars。**2026-02 弃用**，最后版本 v0.3.5（2026-02-26）（https://github.com/stravu/crystal）。
- **继任者 Nimbalyst**：MIT 开源（https://github.com/nimbalyst/nimbalyst ），定位从"并行会话管理"扩展为"visual workspace"——markdown/mockup/Excalidraw/CSV/数据模型的可视化编辑 + session 管理 + kanban；worktree 变为**可选**（"Any session can opt into its own git worktree with one click"，https://nimbalyst.com/）。引擎：Codex、Claude Code，OpenCode/Copilot alpha。桌面三平台 + iOS/Android companion。
- **对 Coolie**：Crystal→Nimbalyst 的演化说明纯"worktree 管理器"不够形成留存，作者选择往"可视化协作画布"逃逸。Coolie 不需要留存（个人向），可以不跟。

### 4. vibe-kanban（Bloop）——最高 stars，公司已死、项目社区续命

- **一句话**：kanban 任务板驱动的 agent 编排：卡片 → workspace（branch + terminal + dev server）→ diff review → PR。
- **开源/栈**：Apache-2.0；**Rust 后端（50.3%）+ TypeScript 前端（46%）**，Web UI，自托管 Docker（https://github.com/BloopAI/vibe-kanban）。
- **引擎**：最广之一——Claude Code、Codex、Gemini CLI、GitHub Copilot、Amp、Cursor、OpenCode、Droid、CCR、Qwen Code（同上）。
- **亮点**：① 内置浏览器 preview（带 DevTools、设备模拟）；② diff 行内评论 review。
- **活跃度**：27.3k stars / 2.9k forks，但 Bloop 关停、项目 "Sunsetting" 转社区维护，最后版本 v0.1.44（2026-04）（https://github.com/BloopAI/vibe-kanban 、https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/）。
- **对 Coolie**：它证明了"任务先行（kanban）"和"环境先行（workspace）"是两种产品心智；Coolie 是后者。Rust+TS 的 CS 分离架构可参考，但其命运提示：做重的任务管理层收益存疑。

### 5. cmux（manaflow-ai）——tux 路线的头部，与 Coolie 哲学最近

- **一句话**：基于 libghostty 的原生 macOS 终端，为并行 AI agent 设计：垂直 tab、通知、内嵌浏览器、socket API。
- **开源/栈**：GPL-3.0-or-later（另售商业授权）；**Swift 80%（AppKit）+ libghostty 渲染**——明确"不是 Ghostty fork，像用 WebKit 一样用 libghostty"（https://github.com/manaflow-ai/cmux）。
- **任务模型**：workspace = 垂直 tab（不强制 worktree，隔离交给用户）；sidebar 显示 git branch、关联 PR 状态、工作目录、监听端口、最新通知。
- **引擎**：任意终端 agent 开箱即用（Claude Code、Codex、OpenCode、Gemini CLI、Aider、Amp、Cursor Agent……）（https://cmux.com/ 、https://dev.to/arshtechpro/cmux-the-native-macos-terminal-built-for-running-ai-coding-agents-in-parallel-52il）。
- **亮点**：① **agent 感知通知**——agent 需要输入时 pane 出现蓝色 ring、sidebar tab 点亮；② **socket API 全量可编程**（开 tab、split、导航内嵌浏览器、读 DOM/console/network），agent 可以自己驱动浏览器验证改动。
- **活跃度**：24.2k stars，48 releases（v0.64.17），macOS only，iOS beta（https://github.com/manaflow-ai/cmux）。
- **对 Coolie**：**最直接的哲学同类**（tux 优先、macOS 优先、engine 无关）。差异在于 cmux 是"终端 + 元数据"，不管 worktree/branch 生命周期，也没有 diff review 面板；Coolie = cmux 的渲染哲学 + Conductor 的 workspace/review 模型。它的"agent 等待输入检测 + 通知"是 tux 路线必须解决的核心问题，实现值得读（GPL 注意传染性，只借鉴思路勿抄代码）。

### 6. Terragon（已关停）——云端后台 agent 路线的墓碑

- **一句话**：云端 sandbox 容器里跑 Claude Code/Codex/Amp/Gemini 的后台任务编排，自动 branch/commit/PR，Web/CLI(terry)/GitHub 评论/手机下发任务。
- **开源/栈**：关停后放出 Apache-2.0 快照：TypeScript 95.7%、Docker、PostgreSQL、Redis、Stripe；理论可自托管但依赖外部 sandbox 供应商/GitHub App/R2，无人维护（https://github.com/terragon-labs/terragon-oss）。
- **活跃度**：2026-01-16 关停快照声明；247 stars。
- **对 Coolie**：反面教材——云端托管 + 收费在这个品类没有跑通；Coolie 的本地优先是正确侧。其 TS 全栈 + 任务队列的代码可作为 server 端参考（Apache-2.0 可安全借鉴）。

### 7. Omnara（YC S25，已转型）——"遥控器"而非"工作台"

- **一句话**：agent 命令中心 relay——terminal 里跑的 Claude Code/Codex 会话同步到 Web/手机/Apple Watch，随时随地监控、审批、语音对话。
- **开源/栈**：Apache-2.0；Python 后端（38.4%）+ TS 前端（57.7%）+ 原生 iOS/Android；架构为中心化 relay：agent 推送更新到 API server（PostgreSQL），多端实时同步，用户回复路由回 agent（https://github.com/omnara-ai/omnara）。
- **活跃度**：主仓库 **2026-02-02 归档**；2.6k stars；公司转向 omnara.com 的 voice-first 平台（基于 Claude Agent SDK）。原定价 Free / $9 Pro。
- **对 Coolie**：它做的是"移动端在场"，与 Coolie 正交。价值在架构参考：**session relay 协议**（本地 agent ↔ server ↔ 多客户端）与 Coolie 的 CS 结构同构——Coolie 的 server 若设计好，未来加手机端就是加一个 client。

### 8. CodeLayer（HumanLayer，YC）——"Superhuman for Claude Code"，已闭源

- **一句话**：键盘优先的 Claude Code 编排 IDE，卖点是 context engineering 工作流（ACE-FCA：research → plan → implement）而非环境管理。
- **开源/栈**：曾经开源（monorepo：`hld` Go daemon + `humanlayer-wui` Web UI + `claudecode-go` SDK；TS 59.2% + Go 33.6%，11.1k stars），**现 README 明言 "the code here is pretty much all deprecated"，产品闭源重建于 humanlayer.com**（https://github.com/humanlayer/humanlayer 、https://raw.githubusercontent.com/humanlayer/humanlayer/main/README.md）。
- **引擎**：深绑 Claude Code（worktree、并行 session、remote 执行）（https://www.ycombinator.com/companies/humanlayer）。
- **亮点**：① 键盘优先交互（Superhuman 式）；② 把方法论（advanced context engineering，https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md）产品化。商业上有收入（Tracxn 称 2025-09 月收入 $660K，未独立验证）。
- **对 Coolie**：`hld`（Go daemon）+ WUI 的 **daemon/客户端分离架构与 Coolie 的 CS 设计完全同构**，其历史代码（archive 里仍可读）是最接近 Coolie server 形态的开源参考之一。键盘优先与 Coolie 的快捷键要求同频。

### 9. Verdent / Verdent Deck——不同物种：自带 agent 的商业套件

- **一句话**：自研 coding agent（VS Code 插件 + Verdent Deck 桌面 app），带 Plan Mode、代码 review、并行隔离 workspace 与合并。
- **开源/栈**：**闭源商业**；创始人 Zhijie Chen（前 TikTok 算法负责人）（https://thenewstack.io/tiktoks-ex-algorithm-chief-launches-verdent-ai-coding-tool/）。定价 $19/$59/$179 每月（credits 制）+ 7 天试用（https://makerstack.co/reviews/verdent-review/）。Mac/Windows。
- **对 Coolie**：不构成直接竞争（它卖的是 agent 本身，Coolie 明确不做 agent）。列入仅为完整性；其 Deck 的并行任务 UX 可作 UI 参考（https://www.verdent.ai/verdent-deck）。

### 10. Emdash（generalaction，YC W26）——开源 Conductor 的当前标杆

- **一句话**："Open-Source Agentic Development Environment"——跨平台 Electron app，每个 task 一个 worktree，支持本地与 SSH 远程。
- **开源/栈**：Apache-2.0；TypeScript 99.3%，Electron + pnpm workspace + Nx，**本地 SQLite 存储、不上传代码**（https://github.com/generalaction/emdash）。
- **引擎**：Claude Code、Codex、Cursor、OpenCode、Amp、Devin、Qwen Code、Droid、GitHub Copilot + CLI 自动探测（同上）。
- **亮点**：① **SSH/SFTP 远程 workspace**（凭据存 keychain）；② issue 导入：Linear/GitHub/Jira/GitLab/Asana/Monday/Forgejo 等一键喂给 agent。
- **活跃度**：5.1k stars，141 releases，最新 2026-07；官网称 840k+ 下载（官方口径，未独立验证）（https://emdash.sh/）。macOS/Windows/Linux。
- **对 Coolie**：**功能集与 Coolie 计划最重叠的开源项目**，适合精读其 worktree 生命周期管理、多 engine CLI 探测/适配层。差异：它是 Electron + 自渲染为主，Coolie 是 Tauri + tux 优先。

### 11. 搜索中新发现的重要同类

- **Superset**（superset-sh/superset）：**与 Coolie 假想形态最接近的产品**。"Code Editor for the AI Agents Era"，Electron + React + Tailwind，tRPC + Drizzle；每 task 一个 worktree，**内嵌终端跑任意 CLI agent（终端渲染路线）+ 独立 diff review + 一键在 VS Code/Cursor/Xcode/JetBrains 打开 worktree + workspace presets（环境预配脚本）+ 可自定义快捷键**。Elastic License 2.0（source-available，非 OSI 开源）。12.4k stars，v1.14.3 发布于 2026-07-10，macOS 优先（Win/Linux 未测试）（https://github.com/superset-sh/superset 、https://superset.sh/）。引擎列表：Claude Code、Amp、Codex、Cursor Agent、Droid、Gemini CLI、Copilot、Mastra、OpenCode、Pi、Polygraph + 任意 CLI agent。
- **Claude Squad**（smtg-ai/claude-squad）：Go 写的 TUI，**tmux session + git worktree** 管理 Claude Code/Codex/Gemini/Aider/Amp 等实例，`brew install claude-squad`（https://github.com/smtg-ai/claude-squad）。与 kobe 同构，是终端派最知名项目。
- **agent-deck**（本地已 clone：`refs/agent-deck/README.md`）：Go + MIT 的 TUI 会话指挥中心：分组/全局搜索/会话 fork/worktree/成本仪表盘/MCP 与 skills 管理器/内置 Web UI（`agent-deck web`，127.0.0.1:8420）/手机遥控 "conductor" 模式。macOS/Linux/WSL。
- **kobe**（本地已 clone：`refs/kobe/README.md`）：作者的核心逻辑参考。SSH 友好 TUI，"Task = git worktree + tmux session + branch"；engine 可选 claude/codex/gemini/copilot/自定义命令；`kobe api` 支持脚本化 fan-out。
- **长尾**（均见 https://github.com/andyrewlee/awesome-agent-orchestrators ，未逐一深入验证）：mux（"desktop app for isolated, parallel agentic development"）、Pane（跨平台开源，https://runpane.com/）、aizen / clave / supacode / constellagent（macOS 原生系）、dmux（tmux+worktree）、1code（Claude Code UI）等。

---

## 横向对比表

| 产品 | 形态 | 开源 | 技术栈 | 任务=worktree? | 渲染路线 | 引擎范围 | 平台 | 状态（2026-07） |
|---|---|---|---|---|---|---|---|---|
| **Conductor** | 桌面 GUI | ✗ 闭源免费 | 未公开 | ✓ workspace=worktree | 自渲染 | Claude Code/Codex/Cursor | macOS | 活跃，品类标杆 |
| **Sculptor** | 桌面 GUI | ✓ MIT | Python+TS | ✗ **container** | 自渲染+内嵌终端 | Claude Code/Pi/终端 agent | macOS(AS)/Linux | 很活跃（今日发版），星少 |
| **Crystal→Nimbalyst** | 桌面 GUI | ✓ MIT | Electron/TS | ✓（Nimbalyst 可选） | 自渲染（可视化画布） | Claude Code/Codex(+alpha) | mac/Win/Linux+移动 | Crystal 已死；Nimbalyst 活跃 |
| **vibe-kanban** | Web/自托管 | ✓ Apache-2.0 | Rust+TS | ✓ 卡片→workspace | 自渲染 | 10+（最广） | 跨平台(Web) | 公司死，社区维护 |
| **cmux** | 原生终端 app | ✓ GPL-3.0 | Swift+libghostty | ✗（终端，不管 worktree） | **tux 原生** | 任意终端 agent | macOS(+iOS beta) | 很活跃，24.2k★ |
| **Terragon** | 云端 | 快照 Apache-2.0 | TS+Docker+PG | 云 sandbox | headless+Web | Claude Code/Codex/Amp/Gemini | Web | **已关停** |
| **Omnara** | relay+移动 | ✓ Apache-2.0 | Python+TS+原生移动 | ✗（遥控现有会话） | 自渲染(消息流) | Claude Code/Codex/SDK | Web/iOS/Android/Watch | **归档，已转型** |
| **CodeLayer** | 桌面/daemon+WUI | 曾开源→闭源 | Go daemon+TS | ✓ | 自渲染 | Claude Code 深绑 | macOS 为主 | 活跃但闭源化 |
| **Verdent Deck** | 桌面（自带 agent） | ✗ 商业订阅 | 未公开 | ✓ 隔离 workspace | 自渲染 | 自研 agent | Mac/Win | 活跃，不同物种 |
| **Emdash** | 桌面 GUI | ✓ Apache-2.0 | Electron/TS+SQLite | ✓（含 SSH 远程） | 自渲染为主 | 9+ | mac/Win/Linux | 活跃，YC W26 |
| **Superset** | 桌面（终端+IDE） | △ ELv2 source-available | Electron+React+tRPC | ✓ | **内嵌终端**+diff 面板 | 11+ 及任意 CLI | macOS 优先 | 很活跃（今日发版） |
| **Claude Squad** | TUI | ✓ | Go+tmux | ✓ | **tux (tmux)** | 终端 agent | mac/Linux | 活跃 |
| **agent-deck** | TUI+Web UI | ✓ MIT | Go | 可选 | **tux (tmux 式)** | 任意 CLI | mac/Linux/WSL | 活跃（本地参考） |
| **kobe** | TUI | ✓ | Bun/TS+tmux | ✓（定义即如此） | **tux (tmux)** | claude/codex/gemini/copilot/自定义 | 终端/SSH | 活跃（本地参考） |

---

## Coolie 的差异化机会

结合定位（个人向、tux 优先渲染、CS 架构、macOS 优先）：

1. **"GUI 壳 + tux 原生渲染" 的空档真实存在，但正在收窄。** 现状是两极：GUI 派（Conductor/Emdash/Crystal）自渲染，终端派（cmux/Claude Squad/kobe）纯终端。中间态只有 Superset（内嵌终端 + diff 面板）真正占位，且它 macOS 优先、迭代极快（今日仍在发版）。**Coolie 相对 Superset 的差异只剩三点：Tauri 而非 Electron（轻）、真正的 headless server + CLI + 多客户端（Superset 是单体 Electron）、个人向不受 ELv2 商业化包袱。** 这三点要做实，否则就是重造 Superset。
2. **CS 架构（server + GUI/TUI/CLI 多客户端）在本品类几乎无人做对。** 最接近的先例：CodeLayer 的 `hld` Go daemon + WUI（已闭源，历史代码可读）、opencode 的 client/server（本地 `refs/opencode`）、agent-deck 的 TUI+Web 双端、Omnara 的 relay 协议。做好 server 意味着：SSH 场景免费获得（kobe 的核心卖点）、未来手机端/Watch 遥控免费获得（Omnara 验证过的需求）、agent 可通过 CLI/API 自我 fan-out（kobe api、cmux socket API 都验证过）。**这是 Coolie 最结构性的差异点。**
3. **tux 路线必须解决的两个硬问题，竞品已给出答案可抄**：① agent 空闲/等待输入检测 + 通知（cmux 的蓝 ring + sidebar 点亮；agent-deck 的 running/waiting/done 状态列表）；② 终端渲染引擎选型——cmux 用 libghostty（Swift 原生，GPL），Electron 系用 xterm.js；Tauri 下现实选择是 xterm.js + Rust 侧 portable-pty（未验证具体 crate 组合，需 PoC）。
4. **个人向 = 可以砍掉所有竞品的"团队/云"包袱**：不做 kanban（vibe-kanban 之死）、不做云 sandbox（Terragon 之死）、不做多人协作。留下的最小内核就是 Conductor 已验证的循环：**新建 workspace → engine 干活 → diff review → merge/PR → archive**，加上 kobe 已验证的 task 三元组。把这个循环在 macOS 上做到零摩擦 + 全键盘（CodeLayer 验证了键盘优先的价值），就是完整产品。
5. **引擎适配层照抄 opencode + 终端兜底**：竞品经验表明"任意 CLI agent"（cmux/Superset）比"逐个深度适配"（CodeLayer 深绑 Claude Code）存活性更好；Coolie 的 tux 优先天然站在正确一侧，headless 自渲染只对 Claude Code/Codex 两家做即可。

## 风险与注意事项

1. **赛道洗牌速度极快**：本次调研的 9 个指定候选中 4 个已死/转型/闭源（Terragon、Omnara、Crystal、CodeLayer 开源版）。个人项目无存活压力，但选依赖时要避开半死项目（如 vibe-kanban 的社区维护前景未知）。
2. **头部竞品仍在高速迭代**：Superset 与 Sculptor 都在调研当天（2026-07-10）发了新版本。Coolie 的价值必须锚定在"符合我个人风格"而非功能竞赛。
3. **上游风险**：Anthropic/OpenAI 官方 UI 的扩张（Claude Code 桌面化、Codex app 化）可能吞掉这个品类的基本盘；tux 复用路线受 engine TUI 行为变化影响（如 Claude Code 改版 TUI 交互），需要接口层缓冲。
4. **许可注意**：cmux 是 GPL-3.0（借鉴思路可以，抄代码会传染）；Superset 是 ELv2（非 OSI，注意条款）；可安全参考代码的：Emdash/vibe-kanban/Terragon 快照/Omnara（Apache-2.0）、Sculptor/Crystal/agent-deck（MIT）。
5. **未验证项**：Conductor 技术栈；Emdash "840k 下载"（官方口径）；HumanLayer 收入数字（Tracxn 单一来源）；Grokipedia 称 Conductor 支持 OpenCode；Tauri 下 PTY + xterm.js 的具体工程可行性（需 PoC 验证，是 Coolie 第一优先级技术风险）。

---

## 来源清单

**指定候选**
- Sculptor: https://github.com/imbue-ai/sculptor ; https://imbue.com/sculptor/ ; https://news.ycombinator.com/item?id=45427697
- Crystal: https://github.com/stravu/crystal ; Nimbalyst: https://github.com/nimbalyst/nimbalyst ; https://nimbalyst.com/
- vibe-kanban: https://github.com/BloopAI/vibe-kanban ; https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/
- cmux: https://github.com/manaflow-ai/cmux ; https://cmux.com/ ; https://dev.to/arshtechpro/cmux-the-native-macos-terminal-built-for-running-ai-coding-agents-in-parallel-52il
- Terragon: https://github.com/terragon-labs/terragon-oss ; https://docs.terragonlabs.com/docs/agent-providers/claude-code
- Omnara: https://github.com/omnara-ai/omnara ; https://www.ycombinator.com/companies/omnara
- CodeLayer/HumanLayer: https://github.com/humanlayer/humanlayer ; https://raw.githubusercontent.com/humanlayer/humanlayer/main/README.md ; https://www.ycombinator.com/companies/humanlayer ; https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md
- Verdent: https://www.verdent.ai/ ; https://thenewstack.io/tiktoks-ex-algorithm-chief-launches-verdent-ai-coding-tool/ ; https://makerstack.co/reviews/verdent-review/
- Emdash: https://github.com/generalaction/emdash ; https://emdash.sh/ ; https://docs.emdash.sh/

**基准与新发现**
- Conductor: https://www.conductor.build/ ; https://www.conductor.build/docs ; https://news.ycombinator.com/item?id=44594584
- Superset: https://github.com/superset-sh/superset ; https://superset.sh/ ; https://news.ycombinator.com/item?id=46368739
- Claude Squad: https://github.com/smtg-ai/claude-squad
- 长尾清单: https://github.com/andyrewlee/awesome-agent-orchestrators
- 品类综述: https://www.augmentcode.com/tools/open-source-agent-orchestrators ; https://nimbalyst.com/blog/best-agent-management-tools-2026/

**本地参考**
- kobe: refs/kobe/README.md（"Task = git worktree + tmux session + branch"）
- agent-deck: refs/agent-deck/README.md
- 需求文档: /Users/outman/workspace/ai/personal_ai/Coolie/Context.MD
