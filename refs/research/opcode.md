# opcode（原 claudia）源码研究

> 研究对象：本地 clone `/Users/outman/workspace/ai/personal_ai/Coolie/refs/opcode`（upstream: https://github.com/winfunc/opcode ，v0.2.1，AGPL-3.0）。
> 研究目的：验证 Tauri + React 技术路线；搞清它自渲染 Claude Code 输出到底有多重；提取 session/checkpoint/agent/工程化经验供 Coolie 参考。

---

## 概述

opcode 是 Claude Code 的 GUI 桌面壳（"GUI app and Toolkit for Claude Code"，`src-tauri/Cargo.toml:4`）。核心思路：

1. **不做 agent，只做壳**——spawn 系统里已安装的 `claude` CLI，headless 模式跑，自己解析 `stream-json` 输出并用 React 组件重新渲染整个会话 UI。
2. **直接寄生在 `~/.claude` 数据上**——project/session 列表全部来自扫描 `~/.claude/projects/` 下的 JSONL 文件，自己不维护会话存储（`src-tauri/src/commands/claude.rs:138-144`）。
3. 附加价值功能：自建 checkpoint/timeline 系统、CC Agents（自定义 system prompt 的后台 agent）、MCP 管理、usage 成本面板、hooks/slash command 编辑器。

**结论先行**：它确实是 Tauri 2 + React 18；它走的正是 Coolie 想用 tux 避开的"无头 + 自渲染"路线，其渲染层约 6500 行 TSX、充满与 Claude Code 输出格式的字符串级耦合，是这条路成本的最好实证。

---

## 技术栈细节

### 前端

| 项 | 选型 | 证据 |
|---|---|---|
| 框架 | React 18.3.1 + TypeScript ~5.6 + Vite 6 | `package.json:64-65,90-92` |
| Tauri JS API | `@tauri-apps/api` ^2.1.1 + dialog/global-shortcut/opener/shell 插件 | `package.json:39-43` |
| 状态管理 | **zustand 5**（`subscribeWithSelector` 中间件）+ React Context | `package.json:87`；`src/stores/agentStore.ts:1-2`、`src/stores/sessionStore.ts:1-2`；Tab/Theme 用 Context（`src/contexts/TabContext.tsx`、`ThemeContext.tsx`） |
| UI 基建 | Tailwind CSS 4 + Radix UI primitives + framer-motion + lucide-react | `package.json:23-33,50,54` |
| 消息渲染 | react-markdown + remark-gfm + react-syntax-highlighter + ansi-to-html + diff | `package.json:44,66,69,76` |
| 长列表 | `@tanstack/react-virtual` 虚拟化消息列表 | `src/components/ClaudeCodeSession.tsx:263-268` |
| 遥测 | posthog-js（CSP 白名单放行 posthog 域，`src-tauri/tauri.conf.json:27`） | `src/lib/analytics/index.ts:1,31` |

### 后端（Rust / Tauri）

- **Tauri 2**，锁定版本 2.8.5（`src-tauri/Cargo.toml:26`；`src-tauri/Cargo.lock:5407-5408`），启用 `macos-private-api`、`tray-icon`、`protocol-asset` feature。
- 插件：shell、dialog、fs、process、updater、notification、clipboard-manager、global-shortcut、http（`src-tauri/Cargo.toml:27-35`）。
- tokio（进程/IO）、rusqlite bundled（agents.db）、zstd + sha2（checkpoint 压缩/内容寻址）、axum 0.8 + ws（web server 模式）（`src-tauri/Cargo.toml:38-60`）。
- macOS 毛玻璃：`window-vibrancy` crate（`src-tauri/Cargo.toml:71`，`src-tauri/src/main.rs:53-54`）。
- 约 **94 个 `#[tauri::command]`**（claude.rs 40 + agents.rs 28 + mcp.rs 12 + storage.rs 7 + slash_commands.rs 4 + proxy.rs 2 + usage.rs 1，grep 统计），全部在 `main.rs:186` 的 `invoke_handler` 注册——命令面是平铺的大杂烩，没有分层/DI（与 opencode 的 DI 风格相反）。

### 双形态：桌面 + Web server

- 同一份 Rust 代码编出两个 bin：`opcode`（Tauri 桌面）和 `opcode-web`（axum HTTP + WebSocket，供手机/浏览器访问）（`src-tauri/Cargo.toml:11-21`；`src-tauri/src/web_server.rs:252-310`；设计文档 `web_server.design.md`）。
- 前端用 `src/lib/apiAdapter.ts:1-50` 做环境探测（`window.__TAURI__` 等），在 Tauri `invoke` 和 REST/WS 之间切换。**这个"同一前端、双传输层"的适配层写法对 Coolie 的 CS 架构（client 既连本地也可能连 server）有直接参考价值。**

---

## 与 Claude Code 的进程交互（核心）

### 模式：headless 一次性进程 + stream-json，无 PTY、无交互 stdin

每次用户发 prompt = spawn 一个新的 `claude` 进程，跑完即死；会话连续性完全靠 CLI 自身的 `-c`/`--resume`：

- 新会话：`claude -p <prompt> --model <m> --output-format stream-json --verbose --dangerously-skip-permissions`（`src-tauri/src/commands/claude.rs:935-944`）
- 继续：前插 `-c`（`claude.rs:966-976`）；恢复指定会话：`--resume <session_id>`（`claude.rs:1000-1011`）
- Agent 执行再加 `--system-prompt <agent.system_prompt>`（`src-tauri/src/commands/agents.rs:757-768`）
- stdin 不接管：agent 进程直接 `Stdio::null()`（`agents.rs:794-798`），交互式会话也只 pipe stdout/stderr（`claude.rs:301-306`）。**权限审批被 `--dangerously-skip-permissions` 硬编码绕过**——这是 headless 自渲染路线绕不开的取舍：要么 skip，要么自己实现 permission prompt 协议（opcode 选择了前者，全局无审批）。

### 输出流转管线

1. tokio 逐行读 stdout，每行先尝试 parse JSON，抓 `type=system, subtype=init` 消息里的 `session_id`（`claude.rs:1226-1238`）——**session id 是 Claude 自己生成后从流里"捞"出来的**，spawn 时并不知道。
2. 拿到 session_id 后注册进内存 `ProcessRegistry`（`HashMap<run_id, ProcessHandle>`，含 live_output 缓冲，`src-tauri/src/process/registry.rs:35-38,472-493`）。
3. 每行原样通过 Tauri 事件双通道发给前端：`claude-output:{session_id}`（隔离）+ 裸 `claude-output`（兼容），`claude.rs:1267-1272`；stderr 同理走 `claude-error`；进程退出发 `claude-complete`（`claude.rs:1309-1314`）。
4. 前端 `listen()` 接收：**先挂 generic 监听器，等 init 消息给出真实 session_id 后再动态切换到 session-scoped 监听器**——代码注释明确说这是因为 `--resume` 可能发新 session_id，只听旧 id 会丢流（`src/components/ClaudeCodeSession.tsx:526-537`）。前端同时维护两份状态：原始 JSONL 行数组 + parse 后的消息数组（`ClaudeCodeSession.tsx:453-458`）。

### 取消/杀进程

三层兜底：ProcessRegistry 按 session 查 child handle kill → 全局 `ClaudeProcessState` 里的 child kill → 按 PID 系统 `kill`/`taskkill`（`claude.rs:1028-1110`；`registry.rs:239-436`）。同一时刻只支持一个前台 Claude 进程（spawn 前会 kill 已存在的，`claude.rs:1209-1213`）。

### claude 二进制发现（macOS GUI 应用的 PATH 死穴，Coolie 必抄的部分）

macOS GUI app 的 PATH 环境极简，直接 `Command::new("claude")` 会找不到。opcode 的方案（`src-tauri/src/claude_binary.rs`）：

- 依次探测：`which claude` → NVM 各版本目录 `~/.nvm/versions/node/*/bin` → homebrew → `~/.claude/local`、`~/.local/bin` 等标准位置（`claude_binary.rs:35-166`，错误提示列全了路径清单 `claude_binary.rs:77`）。
- 对每个安装跑 `--version`，**按版本号排序选最高版**，版本相同再按来源优先级（`claude_binary.rs:99-133`）；也允许用户在设置里手工指定并存入 SQLite（`agents.rs:1582-1607`）。
- spawn 时只**白名单继承**环境变量（PATH/HOME/SHELL/LANG/LC_*/NVM_*/HOMEBREW_*），并在二进制位于 nvm/homebrew 目录时把该目录追加进 PATH（`claude.rs:234-291`）。

---

## 自渲染消息流：成本与坑（Coolie 想用 tux 避开的那条路）

这是本次调研最有信息量的部分。opcode 把 Claude Code 的 stream-json 全量重新渲染成富 UI，代价如下：

### 代码量

- `src/components/ToolWidgets.tsx`：**3000 行**，20+ 个手写 widget（Todo/Edit/MultiEdit/Bash/Read/Write/Grep/Glob/LS/Task/MCP/WebSearch/WebFetch/Thinking/SystemReminder/Command/CommandOutput/Summary…），另有一个未完成的 `ToolWidgets.new.tsx`。
- `src/components/StreamMessage.tsx`：739 行的分派器，按 `type/subtype/content[].type` 逐层 switch（`StreamMessage.tsx:86-717`）。
- `ClaudeCodeSession.tsx` 1762 行 + `AgentExecution.tsx` 999 行。仅消息渲染直接相关代码约 6500 行 TSX（wc -l 实测）。
- **每新增/变更一个工具，就要新写一个 widget 并在分派器登记**——`renderToolWidget()` 里是一长串 `if (toolName === "edit")...`（`StreamMessage.tsx:183-270`），未识别工具退化为 JSON dump（`StreamMessage.tsx:281-297`）。

### 与 CLI 输出格式的字符串级耦合（最脆的部分）

tool_result 只是文本，opcode 靠**启发式字符串匹配**猜它是什么：

- Edit 结果：`contentText.includes("has been updated. Here's the result of running \`cat -n\`")`（`StreamMessage.tsx:454`）
- MultiEdit 结果：三种英文提示语的 `includes`（`StreamMessage.tsx:470-472`）
- Read 结果：正则 `/^\s*\d+→/` 匹配行号箭头（`StreamMessage.tsx:538-539`）
- LS 结果：树形缩进正则 + `"NOTE: do any of the files"` 尾注（`StreamMessage.tsx:517-521`）
- slash command：正则抠 `<command-name>/<command-message>/<command-args>` XML 标签（`StreamMessage.tsx:342`）；`<system-reminder>` 同样手动 regex（`StreamMessage.tsx:416`）
- **Claude Code CLI 任何一次输出措辞/格式变更都会静默击穿这些 widget**（退化为原始文本 dump）。这是自渲染路线的长期维护税。

### tool_use ↔ tool_result 配对的复杂度

stream-json 里 tool_use（assistant 消息）和 tool_result（user 消息）分离，UI 要自己配对：

- 每个 `StreamMessage` 用 `useEffect` 全量扫描 `streamMessages` 建 `tool_use_id → result` Map（`StreamMessage.tsx:63-78`）——每条消息组件各扫一遍全量消息，O(n²)。
- 判断某条 tool_result "是否已被 widget 消化不必重复渲染"，又要从消息列表**反向线性扫描**找对应 tool_use（`StreamMessage.tsx:376-390`；`ClaudeCodeSession.tsx:200-261` 的 `displayableMessages` 过滤同样是嵌套反向扫描）。
- 会话一长（几百条消息 × 每条数个 content block）就是明显的性能负担，所以才必须上 `@tanstack/react-virtual` 虚拟化 + `React.memo`（`StreamMessage.tsx:739`）。

### 滚动/布局 hack

自动滚底要三段式 hack：`setTimeout(50ms)` → virtualizer `scrollToIndex` → `requestAnimationFrame` 再 `scrollTo(scrollHeight)`（`ClaudeCodeSession.tsx:306-326`）；因为虚拟列表行高是估算的（`estimateSize: () => 150`），直接滚会滚不到底。回滚顶部还有更脏的 "smooth scroll 完成后 scrollTop=1 再 =0 触发重渲" hack（`ClaudeCodeSession.tsx:1454-1473`）。

### 小结

**自渲染 = 一个永远追着 Claude Code 输出格式跑的渲染引擎**。opcode 用 ~6500 行换来一个"还不错但常年有 breakage"的 UI。这正面印证了 Coolie 的判断：优先 tux（复用 claude/codex 自带 TUI 渲染），headless 自渲染只做兜底。若 Coolie 将来做兜底自渲染，建议只做三档：markdown 文本 / 通用 tool 卡片（JSON 折叠）/ diff 视图，不要按工具枚举 widget。

---

## Session / Project / Checkpoint / Agent 实现

### Project & Session：零存储，直接读 `~/.claude`

- `Project { id, path, sessions, created_at }`：id 即 `~/.claude/projects/` 下的目录名（路径编码），真实路径从该目录任一 JSONL 的 `cwd` 字段反解（`claude.rs:26-39,146-150`）。
- `Session { id, project_id, first_message, ... }`：一个 JSONL 文件即一个 session，首条 user 消息做列表摘要（`claude.rs:41-58`）。
- 历史加载 = 逐行读 JSONL parse 成 JSON 数组丢给前端（`claude.rs:902-916`）。
- 好处：与 Claude Code CLI 完全同源，CLI 里开的会话 GUI 都能看到、能 resume；代价：数据模型被钉死在 Claude 私有格式上，接第二个 engine（codex）就得另起一套。**Coolie 是多 engine 定位，不能照抄，需要自己的 session 元数据层（kobe 的 task 模型更合适），engine 原生存储只作为附属视图。**
- Tab 系统：多 tab 会话，上限 20，localStorage 持久化（`src/contexts/TabContext.tsx:40,101,147`；`src/services/tabPersistence.ts:51-99`）。
- Usage 面板：扫全部 JSONL 聚合 token，**价格表硬编码在 Rust 里**（`src-tauri/src/commands/usage.rs:67-74`）——又一个格式耦合+维护税的例子。

### Checkpoint / Timeline（自建的"穷人版 git"）

存储在 `~/.claude/projects/{project_id}/.timelines/{session_id}/`（`src-tauri/src/checkpoint/mod.rs:222-234`）：

- 一个 checkpoint = 当时的 `messages.jsonl` 快照（zstd 压缩，level 3）+ 项目文件快照；文件快照走 **content-addressable pool**（按 SHA-256 存 `files/content_pool/{hash}`，checkpoint 只存引用），相同内容跨 checkpoint 去重（`src-tauri/src/checkpoint/storage.rs:23,66-71,100-126`）。
- Timeline 是树，支持从任意 checkpoint **fork**（`mod.rs:68-96`；`checkpoint/manager.rs:661`）。
- 自动策略：`Manual / PerPrompt / PerToolUse / Smart`，Smart = 在 write/edit/multiedit/bash/rm/delete 工具调用后触发（`mod.rs:99-110`；`manager.rs:683-746`）。
- 数据流较绕：**前端收到每条 stream 消息后再回传给后端** `track_session_messages`/`check_auto_checkpoint` 做文件追踪（`claude.rs:2024-2054`；`src/lib/api.ts:1285-1390`；`ClaudeCodeSession.tsx:774`）——消息绕了 Rust→JS→Rust 一圈，纯属架构债。
- restore = 恢复文件快照 + 截断 messages.jsonl + 清扫多余文件（`manager.rs:452-540`）。
- **对 Coolie 的启示：不值得抄。** Coolie 的 workspace = git worktree + branch，checkpoint 语义直接用 git（commit/stash/reflog）实现即可，免费获得 diff、fork、GC；opcode 是因为不控制工作区才被迫自建 content pool。它的 timeline 树 UI（`TimelineNavigator.tsx`）交互概念可参考。

### CC Agents

- SQLite（app_data_dir/agents.db）两张主表：`agents`（name/icon/system_prompt/default_task/model/enable_file_read/enable_file_write/enable_network/hooks，`agents.rs:229-244`）和 `agent_runs`（含 session_id/status/pid/process_started_at，`agents.rs:268-285`）。
- 执行 = `claude -p <task> --system-prompt <prompt> ...`（`agents.rs:757-768`）；agent 自带 hooks 时写入目标项目 `.claude/settings.json`（`agents.rs:697-733`）。
- **注意：`enable_file_read/write/network` 权限字段是摆设**——Rust 代码中已无任何 sandbox 实现（grep "sandbox" 零命中；claudia 时代的 gaol sandbox 已删），实际执行仍是 `--dangerously-skip-permissions`。
- 分发：`.opcode.json` 导入导出 + 从 GitHub repo（`cc_agents/` 目录）拉取（`agents.rs:1531-1566,1826-1930`）。
- run 的指标（token/成本）不落库，从 session JSONL 实时算（`agents.rs:101,195-215`）。
- 对 Coolie：这个 "agent = system_prompt 预设 + 模型 + 图标" 的轻量定义、`.json` 导入导出、GitHub 市场雏形，是低成本高感知的功能，可借鉴到 Coolie 的 engine 预设/profile 上。

---

## Tauri 桌面工程化经验（对 Coolie client 直接可用）

1. **窗口**：`decorations: false + transparent: true + macOSPrivateApi: true`（`src-tauri/tauri.conf.json:12-24`）+ 自绘 `CustomTitlebar.tsx` + `window-vibrancy` 的 `NSVisualEffectMaterial` 毛玻璃（`main.rs:53-54`）。这是做 Conductor/Cursor 质感 UI 的标准组合。
2. **权限（Tauri 2 capabilities）**：`src-tauri/capabilities/default.json` 里给 main 窗口 `shell:allow-execute/spawn`，并显式声明允许 spawn 名为 `claude` 的非-sidecar 程序、`args: true`；fs scope 直接放开 `$HOME/**`（`tauri.conf.json:37-52`）——务实但粗放，Coolie 可以更细。
3. **macOS entitlements**（`src-tauri/entitlements.plist`）：`app-sandbox=false`、network client/server、`com.apple.security.inherit`（子进程）、allow-jit/unsigned-executable-memory/disable-library-validation（Hardened Runtime 下跑 node 系 CLI 所需）。**给 Coolie 的关键提示：要 spawn 用户机器上的任意 CLI，App Sandbox 必须关，意味着上不了 Mac App Store，走 DMG + notarization。**
4. **Sidecar 教训**：claudia 曾把 claude 打成 sidecar 随 app 分发（package.json 里残留 `build:executables` 脚本、pin 1.0.41，`package.json:11-16`，脚本文件已删除），现已**彻底转向"用户系统二进制 + 多路径发现"**（`agents.rs:772` 注释 "Always use system binary execution (sidecar removed)"；`tauri.conf.json:76` `externalBin: []`）。原因不难推断：CLI 更新频繁，打包锁版本 = 永远落后。**Coolie 应直接采用系统二进制路线。**
5. **打包**：bundle targets `deb/rpm/appimage/app/dmg`，macOS 最低 10.15，dmg 布局参数化（`tauri.conf.json:57-101`）；`tauri-plugin-updater` 做自更新；`bun` 做包管理/构建（`bun.lock`、README 开发要求）。
6. **CSP**：默认 self + 为 posthog 开洞 + `asset:` 协议放行本地资源（`tauri.conf.json:27-33`）。
7. **代码卫生反面教材**：仓库里散落 `ClaudeCodeSession.refactored.tsx`、`App.cleaned.tsx`、`ToolWidgets.new.tsx`、`UsageDashboard.original.tsx` 等半途重构副本——vibe-coding 痕迹重，读代码时须以 `main.rs` 注册表和 `components/index.ts` 为准。

---

## 与 Coolie 相关的可借鉴点（按优先级）

1. **抄**：`claude_binary.rs` 的二进制发现 + 版本择优 + env 白名单注入（macOS GUI PATH 问题的完整答案）；kill 的三层兜底；`ProcessRegistry` 内存注册表 + live_output 缓冲（支持"关掉 UI 再回来接上输出流"，`agents.rs:1342-1350`）。
2. **抄思路**：事件通道设计（`claude-output:{session_id}` 命名空间隔离 + 从 init 消息捞 session_id + generic→scoped 监听器切换的坑，`ClaudeCodeSession.tsx:526-537`）——Coolie server 的 event bus 设计要一开始就把 "engine 会自己换 session id" 建模进去。
3. **抄形态**：`apiAdapter.ts` 的 Tauri invoke / REST+WS 双传输适配层——与 Coolie 的 CS 架构天然吻合，但 Coolie 应反过来：server 是第一公民，Tauri 只是壳。
4. **参考 UI**：Tab 会话管理、TimelineNavigator、FloatingPromptInput（模型选择/图片附件/斜杠命令 picker，对应 Context.MD 的底部输入框需求）、UsageDashboard。
5. **明确不抄**：3000 行 ToolWidgets 式自渲染（tux 路线的反面教材）；自建 checkpoint content pool（用 git worktree 代替）；`--dangerously-skip-permissions` 全局硬编码；把 session 存储钉死在单一 engine 私有目录格式上。

## 风险与注意事项

- **License：AGPL-3.0**（`package.json:5`、`LICENSE`）。借鉴架构思路安全，**直接复制代码会传染 Coolie**，Coolie 若不打算 AGPL 开源需重写。
- 与 Claude Code CLI 的耦合全是**未版本化的隐式契约**（stream-json 字段、tool_result 文案、`~/.claude` 目录布局、定价表），CLI 升级随时破坏功能；opcode 自己也频繁被 breaking change 打断（残留的 1.0.41 pin 即证据）。
- 无交互式权限审批：headless + skip-permissions 意味着 agent 可以无确认执行任意 bash。Coolie 若走 tux 路线，权限审批天然由 engine 自己的 TUI 完成——这是 tux 路线又一个隐藏优势。
- 单前台进程模型（新会话 kill 旧会话，`claude.rs:1209-1213`）与 Coolie "多 workspace 并行" 的目标不符，并行会话管理要看 kobe 而不是 opcode。
- 未验证项：web server 模式的完成度（`web_server.design.md` 自述为设计文档，代码含大量 `[TRACE]` println，疑似未产品化）；`AgentRunMetrics` 实时性；Windows/Linux 路径下的行为。

## 来源清单

- 本地源码 `/Users/outman/workspace/ai/personal_ai/Coolie/refs/opcode`（git HEAD `70c16d8`），关键文件：
  - `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock:5407-5408`、`src-tauri/tauri.conf.json`、`src-tauri/entitlements.plist`、`src-tauri/capabilities/default.json`
  - 进程交互：`src-tauri/src/commands/claude.rs`（spawn/args/事件：935-1015、1174-1340；env：234-291）、`src-tauri/src/claude_binary.rs`、`src-tauri/src/process/registry.rs`
  - 渲染：`src/components/StreamMessage.tsx`、`src/components/ToolWidgets.tsx`、`src/components/ClaudeCodeSession.tsx`
  - Checkpoint：`src-tauri/src/checkpoint/{mod,manager,storage}.rs`
  - Agents：`src-tauri/src/commands/agents.rs`
  - Web 模式：`src-tauri/src/web_server.rs`、`web_server.design.md`、`src/lib/apiAdapter.ts`
  - 状态：`src/stores/{agentStore,sessionStore}.ts`、`src/contexts/TabContext.tsx`、`src/services/tabPersistence.ts`
- 上游仓库：https://github.com/winfunc/opcode （README 定位描述）
