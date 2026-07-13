# tux 研究：它到底是什么

> 调研日期：2026-07-10。检索面：WebSearch 多组关键词、GitHub API（repo/code search）、npm registry、HN Algolia、本地 refs/ 源码 grep、kobe 源码与设计文档精读。

> **✅ 已与作者确认（2026-07-11）：tux = tmux**（作者以 https://github.com/tmux/tmux/wiki 作答）。本文的"高置信推断"升级为事实：Coolie 的引擎渲染路线即 kobe 式 tmux Handover（tmux-hosted engine TUI）。下文其余分析（落地技术路线、headless 兜底）继续有效。

## TL;DR

**截至 2026-07-10，公开世界不存在一个名为 "tux"、且被 Claude Code 和 Codex 原生支持的库或协议。** 综合所有证据，Context.MD 里的 "tux" **极大概率是 tmux 的笔误/简写**，指的是 kobe 的 "tmux 接管模型"（v0.6 tmux handover）：把交互式 `claude` / `codex` CLI 跑在每任务一个的 tmux session 里，让引擎**用自己的 TUI 完成渲染**，宿主只做 attach / capture-pane / send-keys，而不是走无头模式自己重画聊天 UI。这个判定与 Context.MD 中"逻辑可以参考 kobe""task = git worktree + tmux session + branch"完全自洽。**此判定未与作者当面确认，标注为高置信推断而非事实。**

同名项目（2389-research/tux 等）全部排除，证据见下文候选清单。

## 判定依据：为什么 tux ≈ tmux（kobe 的 tmux 接管模型）

### 1. Context.MD 原文与 kobe 设计文档语义 1:1 对应

Context.MD 的两处 "tux"：

- "优先使用 tux进行使用coding agent，而不是自渲染"（`/Users/outman/workspace/ai/personal_ai/Coolie/Context.MD:5`）
- "优先集成tux，内置使用claude、codex自身对tux的支持，完成UI渲染，其次才接受无头模式自行渲染"（`/Users/outman/workspace/ai/personal_ai/Coolie/Context.MD:10`）

kobe 的 v0.6 设计文档（中文，作者显然读过 kobe）：

- "claude / codex 自身的交互式 TUI 已经覆盖等价交互, kobe 不重做" —— `refs/kobe/docs/design/v2-tmux-handover.md:73`。这句与 Context.MD:10 的"使用claude、codex自身……完成UI渲染，而不是自渲染"几乎逐字对应。
- tmux session 布局图中左 pane 就是 "claude / codex 原生 TUI 占用" —— `refs/kobe/docs/design/v2-tmux-handover.md:25-26`。
- kobe 的任务公式 "Task = git worktree + engine session + branch" —— `refs/kobe/CLAUDE.md:10`；Context.MD:20 写的是 "kobe的task = git worktree + tmux session + branch"。作者在同一份文档里把 tmux 拼对了（line 20），把 "tux" 单独拼出来（line 5/10），最可能是口头简写或输入脱字（tmux → tux），而非另一个专有名词。

### 2. kobe 的 tmux 接管模型就是"引擎自渲染、宿主不重画"的完整实现

- **架构原则**："tmux owns interactive engine processes. Entering a task is a Handover: kobe ensures the Worktree and tmux Session, suspends the outer renderer, and attaches the user's real TTY" —— `refs/kobe/docs/ARCHITECTURE.md:72-76`。
- **动机（重要）**：kobe v0.5 曾用 `claude` 的 stream-json 无头子进程自渲染聊天 UI，v0.6 整体砍掉，原因是 "Anthropic 2026-06-15 计费政策: `claude -p` / Agent SDK / 第三方程序化用量走独立的 $200/月额度, 不再占订阅额度; 只有交互式 Claude Code……继续走订阅" —— `refs/kobe/docs/design/v2-tmux-handover.md:9`。**（此计费政策为 kobe 文档的声称，我未在 Anthropic 官方渠道独立验证，标注"未验证"；但它解释了为什么"优先引擎自渲染、其次无头"这个优先级本身。）**
- **实现位置**：
  - 每任务 tmux session `kobe-<task-id>`，pane 布局策略：`refs/kobe/packages/kobe/src/tmux/session-layout.ts`（纯策略）+ `refs/kobe/packages/kobe/src/tmux/client.ts`（命令 Adapter）。
  - 宿主读引擎画面：`tmux capture-pane -t <pane> -p` —— `refs/kobe/packages/kobe/src/tmux/client.ts:73`（外层 sidebar 的 live preview 就靠它）。
  - 宿主向引擎注入输入：`tmux send-keys -t <target> -l -- <text>` / `send-keys <key>` —— `refs/kobe/packages/kobe/src/tmux/client.ts:90` 与 `:95`。
  - 引擎相关代码退化为 Adapter（找二进制、读 JSONL 历史、hook 归一化），不再 spawn/stream —— `refs/kobe/docs/ARCHITECTURE.md:100-104`、`refs/kobe/docs/design/v2-tmux-handover.md:17-40`（删除清单）。

### 3. 反向检索：不存在"官方 tux"

以下检索全部为 2026-07-10 执行，均未找到被 Claude Code / Codex 支持的 "tux"：

- WebSearch 多组：`tux terminal claude code codex embed`、`"tux" sst opencode`、`"tux" Claude Code support announcement 2026`、`"tux" protocol terminal agents render GUI`、`codex CLI "tux" support` 等——命中的全是 tmux 周边工具（unitmux、dux、wmux、cmux、tmuxcc、herdr）或 Linux 吉祥物，无一名为 tux。
- GitHub repo search（API `search/repositories?q=tux…`）：按名称/描述/agent 关键词交叉查询，唯一沾边的是 2389-research/tux（见候选清单）。
- npm registry search（`registry.npmjs.org/-/v1/search?text=tux`）：只有 2018 年的 React SSR 框架 `tux`、2021 年弃更的 `@cto.ai/tux`（"CTO.ai Terminal User Experience Library"）等，无 agent 相关新包。
- HN Algolia（story 全文检索 "tux"，含 2025-2026 时间过滤）：无相关条目。
- Claude Code 官方文档/更新日志、openai/codex 仓库 docs 目录（`authentication/config/exec/sandbox/skills…`，via GitHub API）：均无 "tux" 字样。

## 候选清单（均已排除或标弱）

| 候选 | 是什么 | 证据强度 | 排除理由 |
|---|---|---|---|
| **tmux 笔误/简写（kobe tmux 接管模型）** | 见上 | **强（推断）** | 未与作者确认，但语义、上下文、反向检索三方面自洽 |
| [2389-research/tux](https://github.com/2389-research/tux) | Harper Reed 的 2389 Research 出的 Go TUI 库："Terminal UI for multi-agent applications"，bring-your-own-agent：你实现 `Agent` 接口（`Run/Subscribe/Cancel`，`refs/tux/tux.go:27`），它渲染 Chat/Tools tab。MIT（`refs/tux/README.md:117`） | 弱 | 方向相反：它是给**你自己的 agent**画 TUI，不是把 claude/codex 的 TUI 嵌进宿主；代码中 "claude" 仅作为示例模型字符串出现（`refs/tux/examples/minimal/main.go:57`）；Go 语言（Coolie 是 TS）；1 star，最后提交 2026-01-12（`git log`，commit 736e330）。已 shallow clone 到 `/Users/outman/workspace/ai/personal_ai/Coolie/refs/tux` 备查 |
| `@cto.ai/tux`（npm） | "CTO.ai Terminal User Experience Library"，v0.0.5，2021-05 后无更新 | 极弱 | 弃更、与 coding engine 无关 |
| 其它同名（tuxi、cldwalker/tux、ESP32-TUX、tux-copilot…） | CLI 问答/ Sinatra shell / 嵌入式 UI 模板等 | 无 | 全部无关 |

**明确结论：如果作者所指是某个未公开/圈内私传的 "tux"，本次调研没有找到它——该情形下以下技术方案部分仍然成立（因为无论叫什么，要达成的目标就是"引擎自渲染 TUI 嵌入宿主"）。**

## 按此判定，Coolie 的 "tux 集成" 实际是什么：技术形态

### 核心模型（照抄 kobe 即可）

```
Coolie task = git worktree + tmux session + branch
tmux session `coolie-<task-id>`
  pane 0: claude / codex 交互式 TUI（引擎自渲染，订阅计费）
  pane n: worktree-bound shell / ops pane（可选）
宿主三种消费方式：
  1) TUI/终端形态：tmux attach / switch-client（kobe 的 Handover）
  2) 预览/监控：tmux capture-pane -p（低频轮询即可）
  3) 注入输入：tmux send-keys -l（kobe 的 prompt-delivery：refs/kobe/packages/kobe/src/tmux/prompt-delivery.ts）
```

免费获得的性质：session 持久（GUI 崩了引擎还活着）、多客户端同时 attach（GUI + 终端 + SSH 远程看同一个 session）、每任务隔离、`kill-session` 即清理。

### React + Tauri client 里怎么嵌（GUI 渲染层）

tmux 是服务端会话层，GUI 里还需要一个终端仿真器把 `tmux attach -t coolie-<id>`（跑在 PTY 里）的字节流画出来：

- **PTY**：Tauri 侧用 [tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty)（Tauri 2 插件）或直接 Rust `portable-pty`；每 pane 一个 PTY，跑 `tmux attach`。
- **前端渲染**：
  - [xterm.js](https://github.com/xtermjs/xterm.js)：事实标准（VS Code 同款）。
  - [ghostty-web](https://github.com/anomalyco/ghostty-web)（sst/anomalyco org 托管）：Ghostty 终端核心编译成 ~400KB WASM，**xterm.js API 兼容的 drop-in 替代**（`@xterm/xterm` → `ghostty-web` 改一行 import），MIT。README 明确说它最初是给 **Coder 的 Mux**（并行 agent 桌面应用）做的——与 Coolie 场景完全同构，优先评估它。
- 参考实现：kobe 自己的 web dashboard 就是 "browser SPA + PTY sidecar"（`refs/kobe/CLAUDE.md` Orientation 节，`packages/kobe-web/`）；社区还有 tauri-plugin-pty + xterm.js 跑 Claude Code 的完整例子（[CBannink/claude-terminal](https://github.com/CBannink/claude-terminal)、[StoreFrame 博客](https://www.storeframe.io/blog/claude-code-in-browser-xterm-tmux-node-pty)）。

### "其次才接受的无头模式"对应的官方接口（自渲染路线）

- **Claude Code**：`claude -p` + `--output-format stream-json`（NDJSON 事件流，含 `--include-partial-messages` token 级流式）、`--json-schema` 结构化输出、`--continue/--resume` 续会话；Agent SDK（TS/Python）同引擎。来源：[官方 headless 文档](https://code.claude.com/docs/en/headless)（2026-07-10 验证）。注意其中提示 `/login` 等纯终端命令在 `-p` 模式不可用——**登录这种事永远需要一个真终端，这正是 Conductor 也内嵌 claude /login 终端的原因**（[Conductor troubleshooting 文档](https://www.conductor.build/docs/troubleshooting/issues)，搜索摘要提及，未逐句核对）。
- **Codex**：`codex exec`（无头，`docs/exec.md`）；**App Server**——JSON-RPC 协议 + 长驻进程，openai/codex 仓库内有完整 crate 族 `codex-rs/app-server{,-protocol,-daemon,-client,-transport}`（GitHub API 目录列表验证），官方博客 [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)（抓取 403，标题与摘要来自搜索结果，未验证正文）称 TUI/IDE 扩展/桌面 app 都构建其上。第三方 UI 走 app-server 是 Codex 侧最正统的自渲染路径。
- **ACP（Agent Client Protocol）**：Zed 发起的跨引擎标准；Claude Code 有官方 adapter（zed 的 claude-code-acp），opencode 也有 ACP 支持（[anomalyco/opencode-zed-extension](https://github.com/anomalyco/opencode-zed-extension) 自述 "powered by OpenCode's ACP support"）；2026-06 有文章称 Microsoft Intelligent Terminal 的 agent pane 通过 ACP 自动探测 Claude Code / Codex CLI / Gemini CLI（[codex.danielvaughan.com](https://codex.danielvaughan.com/2026/06/10/agent-client-protocol-microsoft-intelligent-terminal-codex-cli-multi-agent-ide-ecosystem/)，二手来源，未验证）。如果 Coolie 将来要做统一的自渲染抽象，ACP 是比逐引擎适配更值得押注的协议。

## 与 Coolie 相关的可借鉴点

1. **优先级判断本身是对的，且 kobe 已经验证过一轮**：kobe v0.5 走无头自渲染、v0.6 整体推翻改 tmux 接管，删除清单里砍掉了整个自渲染 chat pane（composer、markdown 渲染、审批弹窗、context meter……见 `refs/kobe/docs/design/v2-tmux-handover.md:17-40`）。Coolie 直接从"引擎自渲染"起步，可以跳过 kobe 踩过的整个 v0.5 弯路。
2. **分层照抄 kobe 的 seam**：Orchestrator 只管任务生命周期，不 spawn 引擎进程；tmux Adapter 独立（纯策略 `session-layout.ts` + 命令执行 `client.ts` 分离）；引擎代码收缩为 Adapter（binary 发现、历史 JSONL 读取、hook 归一化）——`refs/kobe/docs/ARCHITECTURE.md:69-76`。这与 Coolie 计划的 "server = TS + 依赖注入" 天然契合。
3. **GUI 与 TUI 共享同一 session**：Coolie 的 Tauri client、CLI、以及用户随手开的 iTerm2 都 attach 同一个 `coolie-<task-id>`，这是 tmux 方案独有的（无头方案做不到"随时接管一个真终端"）。
4. **capture-pane 做卡片预览**：Conductor 式任务卡片上的"引擎正在干嘛"预览，不需要引擎事件流，低频 `capture-pane -p` 即可（kobe 外层 live preview 即此实现）。
5. **引擎无关的 UI 数据契约**：kobe 的 "Engine-owned UI data" 规则（名称/模型目录/用量都从 engine adapter 拿，UI 不硬编码 Claude/Codex 字符串）值得整条搬进 Coolie 的 server 设计——`refs/kobe/CLAUDE.md`（Hard rules → Engine-owned UI data 节）。

## 风险与注意事项

- **先跟作者确认命名**：本文档所有方案建立在 "tux = tmux 接管模型" 的推断上。若作者实际指某个私有工具，方案主体不变，但集成 API 需重查。建议把 Context.MD 里的 "tux" 统一改写成明确措辞（如 "tmux-hosted engine TUI"），消除歧义。
- **tmux 是硬依赖**：macOS 不自带（`brew install tmux`）；且要用独立 socket（kobe 用 `KOBE_TMUX_SOCKET`）避免污染用户自己的 tmux server；daemon 关闭绝不能顺手 tear down tmux server（`refs/kobe/docs/ARCHITECTURE.md:360-364` 有专门告诫）。
- **渲染保真度**：GUI 内嵌路线的体验上限取决于终端仿真器。xterm.js 对部分序列（如 XTPUSHSGR）支持不全，ghostty-web 宣称覆盖更好（其 README）；真彩、鼠标事件（claude/codex TUI 都吃鼠标滚动）、resize 抖动（tmux attach 多客户端时以最小客户端为准，需注意 `aggressive-resize` / `window-size` 配置——此条为常识性提示，未验证 kobe 如何处理）。
- **capture-pane 拿到的是画面不是语义**：预览可用，但做 diff 审查、通知（"引擎在等审批"）这类语义功能仍要靠引擎侧数据：Claude Code hooks / JSONL 历史（kobe 的做法，`refs/kobe/docs/ARCHITECTURE.md:100-102`）或 Codex app-server 事件。即"自渲染 UI + 旁路语义数据"双通道，不是二选一。
- **计费政策是移动靶**：kobe 文档声称的 Anthropic 2026-06-15 政策（交互式走订阅、程序化走独立额度）是本优先级的经济学基础，但我未独立验证，且政策可能再变；落地前应向 Anthropic/OpenAI 当前条款复核。
- **命名污染**：这个生态里已有 cmux、dux、wmux、unitmux、tmuxcc、herdr 等一堆 *ux/*mux 工具，检索 "tux" 时几乎全部命中它们；未来沟通/文档中避免再造易混词。

## 来源清单

本地代码（均为绝对路径可达）：

- `/Users/outman/workspace/ai/personal_ai/Coolie/Context.MD:5,10,20`
- `/Users/outman/workspace/ai/personal_ai/Coolie/refs/kobe/docs/design/v2-tmux-handover.md:1,9,25-26,73`
- `/Users/outman/workspace/ai/personal_ai/Coolie/refs/kobe/docs/ARCHITECTURE.md:60-104,181-230,349-364`
- `/Users/outman/workspace/ai/personal_ai/Coolie/refs/kobe/CLAUDE.md:10`
- `/Users/outman/workspace/ai/personal_ai/Coolie/refs/kobe/packages/kobe/src/tmux/client.ts:73,90,95`
- `/Users/outman/workspace/ai/personal_ai/Coolie/refs/tux/`（2389-research/tux shallow clone；`README.md`、`tux.go:27`、`examples/minimal/main.go:57`）

网页：

- https://code.claude.com/docs/en/headless （Claude Code 无头模式，2026-07-10 抓取验证）
- https://github.com/openai/codex （codex-rs/app-server* crate 族，GitHub API 目录验证）
- https://openai.com/index/unlocking-the-codex-harness/ （App Server 官方博客；抓取 403，仅标题/摘要，未验证正文）
- https://github.com/anomalyco/ghostty-web （xterm.js 兼容的 WASM Ghostty，MIT，为 Coder 的 Mux 而生；README 抓取验证）
- https://github.com/2389-research/tux （候选 B，已 clone）
- https://github.com/Tnze/tauri-plugin-pty 、https://github.com/CBannink/claude-terminal 、https://www.storeframe.io/blog/claude-code-in-browser-xterm-tmux-node-pty （Tauri/浏览器内嵌 claude 的参考实现，来自搜索，未逐一精读）
- https://codex.danielvaughan.com/2026/06/10/agent-client-protocol-microsoft-intelligent-terminal-codex-cli-multi-agent-ide-ecosystem/ （ACP 生态现状，二手来源，未验证）
- https://www.conductor.build/docs/troubleshooting/issues （Conductor 内嵌 claude /login 终端，来自搜索摘要）
- 检索存证（均无 "tux" 命中）：GitHub API `search/repositories`、npm `registry.npmjs.org/-/v1/search?text=tux`、HN Algolia `hn.algolia.com/api/v1/search?query=tux`

## 补充研究：计费前提复核（2026-07-10）——kobe 声称的 "2026-06-15 计费政策" 已被 Anthropic 暂停，"tux 优先" 需换论证基础

> 本节针对上文两处标注"未验证"的计费声称（判定依据第 2 条、风险第 5 条）做独立核实，并补 Codex 侧计费现状。本节结论以 Anthropic 官方 Help Center 与 OpenAI 官方 Codex 文档为准，二手媒体仅作时间线佐证。

### TL;DR

**kobe 文档的计费声称（`refs/kobe/docs/design/v2-tmux-handover.md:9`）按字面是不成立的**：该政策 2026-05-13 宣布、原定 2026-06-15 生效，但 **Anthropic 在生效当天（2026-06-15）宣布暂停，至今（2026-07-10）未生效**。官方 Help Center 原话："We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed."（https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan ，2026-07-10 抓取）。**当前现实：`claude -p` / Agent SDK / 第三方 app 用量与交互式 Claude Code 一样，都计入订阅额度，不存在独立额度池。**

但"tux 优先"的排序**不需要反转，需要换理由**：从"计费事实"（已失效）换成"政策风险对冲 + 维护成本"（下详）。半年内 Anthropic 对"程序化/第三方订阅用量"这一类目先封杀（4 月）、再限额（5 月宣布）、再暂停（6 月），而**交互式 Claude Code 在每一版政策里都安然无恙**——这正是把引擎跑在交互式 TUI 里的最强理由。

### Anthropic 侧：完整时间线（逐条带来源）

| 日期 | 事件 | 来源 |
|---|---|---|
| 2026-02-20 | Anthropic 更新法律条款，明确禁止在第三方工具中使用订阅 OAuth token | 二手来源（apiyi.com、mindstudio.ai 综述），未核对条款原文，**标注二手** |
| 2026-04 初（~04-04） | 执行封杀：Pro/Max 订阅不再覆盖 OpenClaw 等第三方 harness，用户被迫转 API 计费 | https://www.theregister.com/2026/04/06/anthropic_closes_door_on_subscription/ |
| 2026-05-13 | 宣布"带条件的恢复"：新设 Agent SDK 独立月度 credit，覆盖 `claude -p`、Agent SDK（Python/TS）、Claude Code GitHub Actions、经 Agent SDK 认证的第三方 app；原定 2026-06-15 生效 | https://thenewstack.io/anthropic-agent-sdk-credits/ （2026-05-14 刊）；https://www.conductor.build/blog/claude-subscription-update （Conductor 复述 5/13 与 6/15 两个日期） |
| （宣布的额度） | **Pro $20 / Max 5x $100 / Max 20x $200** / Team 标准 $20/席、高级 $100/席 / Enterprise $20 或 $200；credit 用尽后按标准 API 费率走 usage credits，且 credit 不滚存；交互式 Claude Code、web/desktop/mobile、Cowork 不受影响、继续走订阅 | https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan （官方，政策全文仍挂在页面上但标注已暂停）；https://the-decoder.com/claude-subscriptions-get-separate-budgets-for-programmatic-use-billed-at-full-api-prices/ |
| **2026-06-15** | **生效当天宣布暂停**："We're pausing the changes… For now, nothing has changed." Agent SDK / `claude -p` / 第三方 app 用量继续走订阅额度 | 同上官方 Help Center；https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/ ；https://news.ycombinator.com/item?id=48545980 |
| 截至 2026-07-10 | 仍处暂停状态；Anthropic 称正在重做方案（"to better support how users build with Claude subscriptions"），承诺变更前会提前通知。媒体判断"delayed, not dead" | 官方 Help Center（2026-07-10 抓取仍为暂停措辞）；https://the-decoder.com/anthropic-backs-off-unpopular-billing-overhaul-as-price-war-with-openai-looms/ |

### 与 kobe 声称的逐条对照

kobe 原文（`refs/kobe/docs/design/v2-tmux-handover.md:9`）："Anthropic 2026-06-15 计费政策: `claude -p` / Agent SDK / 第三方程序化用量走独立的 $200/月额度, 不再占订阅额度; 只有交互式 Claude Code / Cowork / chat 继续走订阅."

1. **"2026-06-15 计费政策"——不成立**。政策从未生效，生效当天被暂停，当前 `claude -p` 与交互式同池计费（官方 Help Center）。kobe 文档大概率写于 5/13 宣布之后、未跟进 6/15 的暂停。
2. **"$200/月额度"——以偏概全**。$200 只是 Max 20x 一档；Pro 只有 $20、Max 5x $100（官方 Help Center）。
3. **"不再占订阅额度"——方向对但表述误导**。宣布版政策是"小额独立 credit、用尽后按全价 API 费率计费"，对重度用户是**变贵**而非"另有一份免费额度"；kobe 据此推出"headless 经济性劣于交互式"的方向判断，在宣布版政策下是对的，在当前（暂停）现实下两者无差别。
4. **"只有交互式继续走订阅"——在每一版政策中均为真**。这是唯一穿越了 2 月条款、4 月封杀、5 月限额、6 月暂停全部四次变动而始终不变的部分。

### Codex 侧：订阅 vs API 计费现状

来源：OpenAI 官方 Codex 文档（`developers.openai.com/codex/pricing` 与 `/codex/auth`，两者 308 重定向至 `learn.chatgpt.com/docs/pricing`、`/docs/auth`，2026-07-10 抓取）。

- **两条认证即两条计费轨**：Sign in with ChatGPT → 用 ChatGPT 订阅内含额度（Free/Go/Plus/Pro/Business/Edu/Enterprise 均含 Codex，Plus 约 15-110 条本地消息/5 小时窗，Pro 5x/20x 依档放大；超限可购买按 token 计的 credits）；API key → 走 Platform 账户按 API token 价计费。
- **关键差异（对比 Anthropic）：OpenAI 目前没有"交互式 vs 程序化"的计费切分**。ChatGPT 登录态下，交互式 TUI 与 `codex exec`（headless）从同一个订阅池扣量，文档只有一句**建议**而非计费规则："Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs"（learn.chatgpt.com/docs/auth）。也未见对第三方经官方 CLI/app-server 驱动的明文禁令。
- 但订阅侧同样是移动靶：GPT-5.3-codex 曾被无通知地从订阅账户下架（仍标注"订阅支持"），见 https://github.com/openai/codex/issues/25839 ；opencode 侧则于 v1.1.11+ 官方支持 ChatGPT 订阅登录（https://github.com/numman-ali/opencode-openai-codex-auth 使用与官方 CLI 相同的 OAuth 方法）——说明 OpenAI 目前对第三方复用订阅态度宽松，但没有承诺。

### 对 Coolie 第一号架构决策的影响：排序保留，论证重写

原论证（"headless 走独立 $200 额度、经济性差"）失效。替换为三条仍然成立的理由，按强度排序：

1. **政策风险不对称（最强）**。Coolie 若走 tmux 内跑交互式 `claude`/`codex`，用户行为在两家条款里都属于"官方 CLI 的交互式使用"——Anthropic 四次政策变动均未触及、OpenAI 无任何限制信号。Coolie 若走 headless（`claude -p`/Agent SDK/app-server 自渲染），在 Anthropic 侧恰好落进被封杀过一次、被限额过一次、目前仅靠"暂停"维持现状的类目，且 Anthropic 明言方案是重做而非放弃。Conductor 在风波期间专门发博客安抚用户（https://www.conductor.build/blog/claude-subscription-update ），本身就是这条风险真实存在的存证；conductor.md:324 记录的 `ANTHROPIC_API_KEY` 覆盖订阅计费的坑同属此类。
2. **维护成本（已有本仓库内证据）**。kobe v0.5 headless 自渲染整体被 v0.6 推翻（`refs/kobe/docs/design/v2-tmux-handover.md:17-40` 删除清单）；opcode 自渲染层约 6500 行且随引擎版本漂移（见 `refs/research/opcode.md`）。引擎自渲染路线把这整层成本归还给引擎厂商。
3. **当前 headless 无额外成本 = 双通道白送（好消息）**。因为政策暂停，今天 `claude -p` 与交互式同池计费，Coolie 的"headless 其次"备胎路线目前不花额外的钱——可以放心把 stream-json/app-server 做成旁路语义通道（通知、diff、状态），同时保留随时降级为主通道的能力；只需在设计上把"计费归属"当作可再变的外部参数，不要写死。

**若未来政策落地（宣布版或其变体）**：headless 主通道对 Pro 用户几乎不可用（$20/月 credit），对 Max 20x 用户是 $200/月 的硬上限外加 API 全价——届时"tux 优先"从对冲变成硬约束，与 kobe 的结论重合。**若政策彻底取消**：排序仍由理由 2（维护成本）支撑，但优先级差距缩小，值得届时重估。

### 未关闭事项

- **tux 命名确认仍未关闭**：本次为无交互的调研任务，无法当面询问作者。上文"tux = tmux 笔误"仍是高置信推断。作者读到此处请自行确认，并建议顺手把 Context.MD:5,10 改成明确措辞。
- **`claude -p` 额度归属未做本机实测**：本机装有 Claude Code 2.1.207（`~/.local/bin/claude`），但 `-p` 输出不含计费归属字段，客户端侧不可观测；权威口径即上引官方 Help Center（当前计入订阅），实测无增量信息，故未消耗额度执行。
- **Anthropic "重做后的方案"长什么样**：未知。唯一承诺是提前通知。建议把 https://support.claude.com/en/articles/15036540 列入定期复查清单（政策一变，本节结论 3 即失效）。
- 2026-02-20 条款修改的原文未核对（仅二手来源）。

### 本节来源清单

官方（权威口径）：

- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan （Anthropic Help Center：政策全文 + 暂停声明，2026-07-10 抓取）
- https://learn.chatgpt.com/docs/pricing 、https://learn.chatgpt.com/docs/auth （OpenAI Codex 计费/认证文档，自 developers.openai.com/codex/* 308 重定向，2026-07-10 抓取）
- https://code.claude.com/docs/en/costs （Claude Code 成本页：订阅用户用量含在订阅内、`/usage-credits` 超额机制，2026-07-10 抓取；页面无任何 `-p`/交互式计费切分表述）

时间线佐证（媒体/社区）：

- https://thenewstack.io/anthropic-agent-sdk-credits/ （2026-05-14，宣布版政策细节）
- https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/ （生效当天暂停）
- https://the-decoder.com/claude-subscriptions-get-separate-budgets-for-programmatic-use-billed-at-full-api-prices/ 、https://the-decoder.com/anthropic-backs-off-unpopular-billing-overhaul-as-price-war-with-openai-looms/
- https://www.theregister.com/2026/04/06/anthropic_closes_door_on_subscription/ （4 月封杀）
- https://www.conductor.build/blog/claude-subscription-update （Conductor 官方：5/13 宣布、6/15 无限期推迟，"You can keep using your Claude subscription in Conductor the same way you do today"）
- https://news.ycombinator.com/item?id=48545980 （HN：官方暂停声明讨论）
- https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch （抓取 403，仅标题/搜索摘要佐证"4 月封杀→5 月带条件恢复"叙事，未验证正文）
- https://github.com/openai/codex/issues/25839 （GPT-5.3-codex 无通知下架订阅账户）
- https://github.com/numman-ali/opencode-openai-codex-auth （第三方复用 ChatGPT 订阅 OAuth 的现状）

本地：

- `/Users/outman/workspace/ai/personal_ai/Coolie/refs/kobe/docs/design/v2-tmux-handover.md:9,35`（被核实的原始声称）
- `/Users/outman/workspace/ai/personal_ai/Coolie/refs/research/conductor.md:16,167,324`（Conductor 计费边界与 `ANTHROPIC_API_KEY` 坑）
