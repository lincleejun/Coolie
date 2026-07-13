# Codex 引擎集成研究：能力矩阵与协议实测

> 研究日期 2026-07-10/11。方法：① 精读 openai/codex 仓库源码（shallow clone @ commit `5c19155`，2026-07-11）；② 本机 `codex-cli 0.139.0`（`/opt/homebrew/bin/codex`）实测 app-server 握手、`exec --json`、resume、fork、archive；③ 官方文档（developers.openai.com → 308 重定向至 learn.chatgpt.com，2026-07-10 抓取成功）；④ 对照精读 refs/kobe 的 codex adapter 与 refs/agent-deck 的 codex 集成代码；⑤ 本机 `~/.codex/` 与 Conductor 数据目录取证。
>
> 注：原计划是在既有 codex.md 末尾追加一节，但 `refs/research/codex.md` 此前并不存在（散落结论在 kobe.md / tux.md / agent-deck.md / conductor-local.md 中），故本文即为 codex 引擎的首份系统研究文档。

## 概述：一句话结论

Codex 的可集成面远比此前碎片认知强：**headless JSONL 流（`codex exec --json`）、完整 JSON-RPC app-server、原生 resume/fork、与 Claude Code 几乎同构的 hooks 系统（已 stable）、可配置的 OSC 终端标题/通知**全部齐备。Coolie 把 codex 当一等引擎，"tux 渲染 + 旁路语义"双通道和"无头自渲染"两条路线都有官方支撑，不需要任何逆向 hack。最大的工程风险不是能力缺失，而是 **app-server 协议的版本漂移速度**（0.139.0 与 HEAD 的方法集已有明显差异，见 §8）。

## 1. 四条驱动路径总览

| 路径 | 形态 | 官方定位 | 谁在用（证据） |
|---|---|---|---|
| `codex exec --json` | 子进程 + stdout JSONL 事件流 | 脚本/CI 的 non-interactive 模式 | 官方 TS SDK 即封装此命令（`sdk/typescript/src/exec.ts:87`）；**Conductor 实际走这条**（见 §7） |
| `codex app-server` | 长驻进程 + JSON-RPC 2.0（stdio JSONL / unix socket / 实验性 ws） | "powers rich interfaces such as the Codex VS Code extension"（`codex-rs/app-server/README.md`） | VS Code 扩展与 ChatGPT 桌面 App 进程列表可见 `codex … app-server`（本机 `ps` 实测） |
| 交互式 TUI + 旁路语义 | tmux/嵌入终端跑原生 TUI；语义走 rollout JSONL + hooks/notify | 默认人用形态 | kobe（`refs/kobe/packages/kobe/src/engine/codex-local/`）、agent-deck |
| `codex mcp-server` | 把 Codex 作为 MCP stdio server 暴露 | `codex --help` 列出 | 未深入（本次未测） |

另一个值得注意的新形态：TUI 自身已经是 app-server 的客户端（`codex-rs/tui/src/app_server_session.rs` 存在），并且 `codex --remote ws://host:port` 可以让本地 TUI 连接远程 app-server（`codex --help`，0.139.0 实测存在该 flag）。这意味着 "UI 进程" 与 "引擎进程" 官方已经解耦——对 Coolie 的 CS 架构是直接利好。

## 2. app-server JSON-RPC 协议实际形态

来源：`codex-rs/app-server/README.md`（2255 行，写得非常完整）+ 本机 0.139.0 实测。

### 传输与握手

- JSON-RPC 2.0，**wire 上省略 `"jsonrpc":"2.0"` 字段**；stdio 传输为 newline-delimited JSON（README §Protocol）。
- 传输选择：`--listen stdio://`（默认）、`unix://`（`$CODEX_HOME/app-server-control/app-server-control.sock`，走 WebSocket-over-unix-socket + HTTP Upgrade）、`ws://IP:PORT`（**experimental/unsupported**，附带 `/readyz` `/healthz` 探针，带 Origin 头的请求 403）、`off`。`codex app-server proxy` 把 stdio 桥接到控制 socket。
- 每连接必须先 `initialize`（带 `clientInfo{name,title,version}`）再发 `initialized` 通知，否则报 "Not initialized"。`capabilities.optOutNotificationMethods` 可按方法名精确退订通知（如 `item/agentMessage/delta`）。`clientInfo.name` 会进入 OpenAI 合规日志的客户端标识。
- 实测握手（0.139.0，发送 initialize 后立即返回）：

```json
{"id":0,"result":{"userAgent":"coolie_probe/0.139.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.11 (coolie_probe; 0.0.1)","codexHome":"/Users/outman/.codex","platformFamily":"unix","platformOs":"macos"}}
```

- 背压：内部有界队列，过载时请求被拒并返回错误码 `-32001`（"Server overloaded; retry later."），客户端应指数退避重试（README §Protocol）。

### 核心原语与生命周期

三层模型 **Thread（会话）→ Turn（一轮）→ Item（消息/工具调用等）**（README §Core Primitives）。

- `thread/start {cwd, model?, approvalPolicy?, sandbox?|permissions?, personality?, ...}` → 返回 thread 对象并发 `thread/started` 通知，自动订阅该 thread 的 turn/item 事件。**副作用注意**：当 cwd + workspace-write 解析成功时，app-server 会把该项目写进用户 `config.toml` 的 trusted projects（README §API Overview）。
- `thread/resume {threadId}`：按 id 重开存量会话，后续 `turn/start` 追加。响应带重建的 `thread.turns`；实验参数 `excludeTurns`/`initialTurnsPage` 支持分页拉历史。
- `thread/fork {threadId, lastTurnId?, ephemeral?}`：复制历史成新 thread id；`lastTurnId` 可截断到某轮（inclusive）。返回 `thread.forkedFromId`。实测见 §5。
- `turn/start {threadId, input}` → `turn/started` → 流式 `item/started` / 各类 delta / `item/completed` → `turn/completed {usage}`。`turn/steer` 向进行中的 turn 追加输入；`turn/interrupt` 中断（turn 以 `status:"interrupted"` 结束）。
- Item 类型（README §Items）：`userMessage / agentMessage / plan / reasoning / commandExecution / fileChange / mcpToolCall / collabToolCall / webSearch / imageView / sleep / enteredReviewMode / exitedReviewMode / contextCompaction`。生命周期恒为 `item/started → 0..n deltas → item/completed`。
- **对 Coolie 直接有用的通知**：
  - `turn/diff/updated {threadId, turnId, diff}`——每次 FileChange 后推送**整轮聚合 unified diff**，官方注释就是给 UI 渲染 "what changed" 视图的（README §Turn events）。Coolie 右侧 diff 面板可以直接吃这个。
  - `turn/plan/updated`（计划步骤 + 状态）、`thread/tokenUsage/updated`（token 用量）、`item/commandExecution/outputDelta`（命令实时输出）。
- 审批流（README §Approvals）：需要批准时 server 反向发起 JSON-RPC **request**（不是通知）：`item/commandExecution/requestApproval` / `item/fileChange/requestApproval`，客户端回 `{"decision":"accept"|"acceptForSession"|"decline"|"cancel"}`（命令审批还有 execpolicy/network amendment 变体），随后 `serverRequest/resolved` + `item/completed`。**这就是 Coolie server 做"待审批"状态位与移动端放行的天然挂点。**
- 辅助面：`model/list`、`command/exec`（不开 thread 直接在沙箱跑命令）、`process/spawn`（带 PTY 的裸进程管理）、`fs/*`（文件读写/watch）、`fuzzyFileSearch/*`、`config/read|value/write|batchWrite`、`account/*`（登录/额度）、`review/start`（跑 code review）。app-server 几乎是一个"编辑器后端"。
- Thread 卸载策略：最后一个订阅者 `thread/unsubscribe` 后，无活动 30 分钟才 unload 并发 `thread/closed`（README §API Overview）。

### Schema 不用手写

`codex app-server generate-ts --out DIR` / `generate-json-schema --out DIR` 按当前 binary 版本生成 TypeScript 类型/JSON Schema（README §Message Schema）。**Coolie 的 codex adapter 应该把这步纳入构建/适配流程，按版本 pin schema**。

### 实测：0.139.0 与 HEAD 的方法集漂移（重要）

向 0.139.0 发送未知方法，错误信息会吐出**完整合法方法枚举**（好用的探测技巧）。对比结果：

- 0.139.0 有而 HEAD 文档化列表里已改名/消失：`thread/turns/items/list`、`thread/increment_elicitation`、`getConversationSummary`、`gitDiffToRemote`、`getAuthStatus`、`fuzzyFileSearch`（v1 遗留）。
- HEAD 有而 0.139.0 没有：`thread/delete`（实测报 unknown variant）、`thread/backgroundTerminals/list|terminate`、`environment/info`、`mcpServer/elicitation` 相关、`attestation/generate`、`turn/moderationMetadata` 等。
- 两版都有的稳定核心：`initialize / thread/start|resume|fork|archive|unarchive|list|read / turn/start|steer|interrupt / review/start / model/list / command/exec / fs/*`。
- 结论：**adapter 必须做按版本能力探测**（initialize 返回的 userAgent 内含版本号；或直接解析 unknown-variant 错误），核心集之外的方法都要有降级路径。（来源：本机实测输出 + `codex-rs/app-server-protocol/src/protocol/common.rs` 方法名宏定义）

## 3. rollout JSONL：`~/.codex/sessions/**/rollout-*.jsonl` schema

### 文件布局与伴生存储

- 路径：`$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO时间戳>-<UUIDv7>.jsonl`（本机实测；kobe 的读法同 `refs/kobe/packages/kobe/src/engine/codex-local/history.ts:4-27`）。文件名内嵌 UUID 即 thread/session id，日期树需扫描反查（kobe `history.ts:118-137` 用 newest-first 扫描 + UUID 全匹配）。
- `CODEX_HOME` 环境变量可整体重定向（agent-deck 用它做每实例隔离，`refs/agent-deck/cmd/agent-deck/codex_hooks_cmd.go:369-378`）。
- 归档：`thread/archive` 把 rollout 移入 `~/.codex/archived_sessions/`（本机实测：archive 后文件从 sessions 树消失、出现在 archived_sessions）。
- 伴生索引（均在 `~/.codex/`，本机实测存在）：
  - `state_5.sqlite`：`threads` 表 = 会话元数据镜像（列含 `id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_sha, git_branch, git_origin_url, cli_version, first_user_message, model, reasoning_effort, preview, recency_at, history_mode` 等；`.schema threads` 实测）。app-server 的 `thread/list`/`thread/metadata/update` 走它。**做会话列表 UI 不必扫 JSONL 树，读这张表（或走 app-server）即可**。
  - `session_index.jsonl`：append-only 的 `{id, thread_name, updated_at}` 流水，最新条目胜出——thread 改名索引（`codex-rs/rollout/src/session_index.rs:19-48`）。
  - `history.jsonl`：跨会话的用户输入历史 `{session_id, ts, text}`（本机实测样例）。

### 行级 schema

每行 `{"timestamp": RFC3339, "ordinal"?: u64, "type": <tag>, "payload": <content>}`（`codex-rs/protocol/src/protocol.rs:3334-3341` `RolloutLine`，serde tag=type/content=payload）。`type` 的合法值即 `RolloutItem` 枚举（`protocol.rs:3139-3154`）：

| type | payload | 说明 |
|---|---|---|
| `session_meta` | SessionMetaLine | 首行。实测字段：`id, timestamp, cwd, originator, cli_version, source("cli"/"exec"/"vscode"), thread_source, model_provider, base_instructions{text}（完整系统提示词全文！）, multi_agent_version, git{commit_hash?,branch?,repository_url?}`；fork 出的会话多一个 `forked_from_id` |
| `response_item` | ResponseItem | 模型可见的对话项：`message(role,content,phase?)`、`reasoning(summary, encrypted_content)`、`function_call(name,arguments,call_id)`、`function_call_output(call_id,output)`、`web_search_call`、`custom_tool_call(_output)`、`local_shell_call` 等（实测 + kobe `history-parse.ts:109-164` 的归一化覆盖列表） |
| `event_msg` | EventMsg | UI 事件冗余：实测见 `task_started(turn_id, model_context_window)`、`user_message`、`agent_message`、`token_count(info, rate_limits)`、`task_complete(last_agent_message, duration_ms, time_to_first_token_ms)`、`web_search_end` |
| `turn_context` | TurnContextItem | 每个真实用户 turn 落一条：`turn_id, cwd, workspace_roots, approval_policy, sandbox_policy, permission_profile, model, effort, collaboration_mode, timezone...`（`protocol.rs:3217-3261`） |
| `compacted` | CompactedItem | 压缩摘要 + `replacement_history` + 窗口链 UUID（`window_id/previous_window_id/first_window_id`，`protocol.rs:3174-3191`） |
| `world_state` | WorldStateItem | 世界状态快照/补丁（`protocol.rs:3157-3162`） |
| `inter_agent_communication`(+metadata) | — | 多 agent 通信遗留（`protocol.rs:3144-3149`） |

坑与要点：

- **合成 user 行**：repo instructions（AGENTS.md 等）与 environment envelope 都以 `role:"user"` 的 `response_item` 持久化，但 live 流不会重放它们——kobe 专门做了 `isSyntheticCodexUserRow` 过滤（`history-parse.ts:118-124`、`codex-local/synthetic.ts`），Coolie 复刻历史渲染时必须同样过滤。
- **reasoning 是加密的**：`encrypted_content`，只有 `summary` 可读（实测）。
- **兼容性**：`SessionMetaLine` 反序列化兼容旧字段名（`session_id` ↔ `id` 双写，`protocol.rs:3120-3136`）；行内未知字段被宽容忽略，但 schema 无显式版本号——**按行 best-effort 解析、失败跳过**（kobe `history-parse.ts:66-76` 的做法）是正确姿势。
- **空会话会被清理**：实测 `thread/start` 后不发任何 turn，进程结束后该 rollout 文件消失（sqlite `has_user_event=0` 相关；具体触发时机未深究，标注未验证细节）。
- token 用量：rollout 里 `event_msg:token_count` 与 exec 流 `turn.completed.usage` 双源；kobe 选择解析后者（`history-parse.ts:87-103` + `usage.ts`）。

## 4. `codex exec --json`（headless）事件 schema

来源：`codex-rs/exec/src/exec_events.rs:11-`（`--json` 的 flag 定义在 `exec/src/cli.rs:66`，`--experimental-json` 现在只是 alias）+ 本机实测 + 官方文档 https://learn.chatgpt.com/docs/non-interactive-mode 。

顶层事件（tag=`type`）：`thread.started{thread_id}` / `turn.started` / `turn.completed{usage{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}` / `turn.failed{error}` / `item.started|item.updated|item.completed{item}` / `error{message}`。

item（`{id, type, ...}`）：`agent_message / reasoning / command_execution(status: in_progress|completed|failed|declined, exit_code, aggregated_output) / file_change(add|delete|update) / mcp_tool_call / collab_tool_call / web_search / todo_list / error`（`exec_events.rs:100-130+`）。

实测最小样例（0.139.0）：

```
{"type":"thread.started","thread_id":"019f4fe0-2fea-73f0-9453-171807d42083"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}
{"type":"turn.completed","usage":{"input_tokens":17839,"cached_input_tokens":2432,"output_tokens":6,"reasoning_output_tokens":0}}
```

关键 flags（`codex exec --help` 实测）：`--json`、`-C/--cd <dir>`、`--add-dir`、`-s/--sandbox read-only|workspace-write|danger-full-access`、`--skip-git-repo-check`、`--ephemeral`（**不落盘 session 文件**）、`--ignore-user-config`/`--ignore-rules`（自动化隔离用户配置）、`--output-schema <json-schema>`（结构化输出）、`-o`（末条消息写文件）、`-i/--image`、`-c key=value` 任意配置覆盖、`CODEX_API_KEY` 环境变量。

**局限（与 Claude Code 的关键差异）**：exec 是"一轮即退出"的模型，多轮要靠 `codex exec resume <id>` 再起进程；没有等价于 `claude --input-format stream-json` 的**常驻双向 stdin 流**，也**不能预指定 session id**（对比 claude `--session-id`）——id 只能从 `thread.started` 事件或 rollout 文件名回读。需要常驻+双向的场景应直接上 app-server。

## 5. resume / fork 语义（实测）

- **resume**：
  - 交互式：`codex resume`（picker）/ `codex resume --last` / `codex resume <SESSION_ID|名称> [PROMPT]`；`--all` 取消按 cwd 过滤（默认 picker 按当前目录过滤）；`--include-non-interactive` 把 exec 产生的会话也纳入（`codex resume --help` 实测）。
  - headless：`codex exec resume <SESSION_ID|thread名> [PROMPT]` / `--last`。
  - **实测行为**：resume 复用同一 thread_id，`thread.started` 返回原 id，**追加写同一个 rollout 文件**（文件 56269B → 59683B，无新文件）。
  - app-server：`thread/resume`，可带与 start 相同的覆盖参数；恢复后立即补发 `thread/tokenUsage/updated`。
- **fork**：
  - 交互式：`codex fork [SESSION_ID] [PROMPT]`（picker/--last，`codex fork --help` 实测存在于 0.139.0）。
  - app-server：`thread/fork {threadId, lastTurnId?, ephemeral?}`。**实测**：返回新 UUIDv7 + `forkedFromId` 指向源 thread，落一个**新 rollout 文件**，内容为全量复制的历史（含源会话的 session_meta，新 session_meta 带 `forked_from_id`；实测新文件行类型统计里 session_meta 出现 2 次）。fork 是**文件级复制**而非 COW——超长会话高频 fork 会翻倍磁盘。
  - `lastTurnId` 截断式 fork 是官方推荐的"回滚"方案（`thread/rollback` 已标 deprecated，README §API Overview）。
  - 版本门槛：agent-deck 自述需要 `codex-cli 0.137.0+`（`refs/research/agent-deck.md:145`，上游自述）；0.137.0 的 release notes 已在修 fork 相关 bug（说明命令更早就存在；确切引入版本未考证）。本机 0.139.0 全部验证可用。来源：https://github.com/openai/codex/releases 、https://developers.openai.com/codex/changelog 。
- agent-deck 的用法佐证：fork 就是在新 tmux pane 里跑 `CODEX_HOME=... codex fork <parent-sid>`（`refs/agent-deck/internal/session/instance_codex_fork_test.go:71-104`）。

## 6. hooks / notify（Claude Code hooks 的等价物——现在是真等价了）

### hooks（**stable**，0.139.0 `codex features list` 实测 `hooks stable true`）

- **事件表**（`codex-rs/hooks/src/lib.rs:19-31` `HOOK_EVENT_NAMES`，与官方文档一致）：`PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, UserPromptSubmit, SubagentStart, SubagentStop, Stop` —— 命名与 Claude Code 几乎逐字相同（多 `PermissionRequest/PostCompact/SubagentStart`，少 `SessionEnd/Notification/PreToolUse 的部分变体`）。其中 8 个支持 matcher（`lib.rs:37-48`）。
- **配置位置**（官方文档 https://learn.chatgpt.com/docs/hooks + `hooks/src/engine/discovery.rs:303-307`）：
  - 用户级 `~/.codex/hooks.json` **或** `~/.codex/config.toml` 的 `[hooks]` 表；
  - 项目级 `<repo>/.codex/hooks.json` 或 `.codex/config.toml`；
  - 插件包 `hooks/hooks.json`（`hooks/src/declarations.rs:54-60`）；
  - 企业托管 `requirements.toml`（`allow_managed_hooks_only` 可锁死非托管 hook，`docs/config.md:9-15`）。
- **hooks.json 的 shape 与 Claude Code settings.json 完全同构**（kobe 直接复用同一 JsonHookAdapter，`refs/kobe/packages/kobe/src/engine/codex-local/hook-adapter.ts:3-9`）：

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash",
    "hooks": [{ "type": "command", "command": "python3 script.py", "statusMessage": "…", "timeout": 30 }] } ] } }
```

  TOML 等价形式：`[[hooks.PreToolUse]] matcher="^Bash$"` + `[[hooks.PreToolUse.hooks]] type="command" command="…"`（`codex-rs/core/src/config/config_loader_tests.rs:324-333`）。
- **stdin payload**：`session_id, cwd, hook_event_name, model, transcript_path, permission_mode` + 事件字段（如 PostToolUse 的 `tool_name/tool_input/tool_response`）；**输出**：`continue/stopReason/systemMessage/suppressOutput` + 事件特定（PreToolUse 可 `permissionDecision:"deny"`、`updatedInput` 重写输入）（官方文档；wire 结构见 `hooks/src/schema.rs:87-134`）。
- **信任模型（Coolie 必须处理）**：非托管 hook 写进配置后**不会自动运行**，用户需在 TUI `/hooks` 里 trust 一次，或进程带 `--dangerously-bypass-hook-trust`（`codex exec --help` 实测有此 flag）。kobe 的策略是"只写定义、绝不代跳信任"（`hook-adapter.ts:24-28`）。
- app-server 侧配套：`hooks/list` 方法 + `hook/started`/`hook/completed` 通知（方法名列表）。
- kobe 的事件→中性动词映射可直接抄：`SessionStart→session-start, UserPromptSubmit→turn-start, Stop→turn-complete`；并特意**不挂 PermissionRequest**（它是决策 hook，观察者身份误挂会干扰审批流，`hook-adapter.ts:17-22`）。

### notify（legacy 单事件通知）

- `config.toml` 顶层 `notify = ["program", "arg1", ...]`（`codex-rs/core/src/config/mod.rs:737`）。唯一事件 `agent-turn-complete`，JSON 作为**最后一个 argv 参数**传入（非 stdin）：`{"type":"agent-turn-complete","thread-id":…,"turn-id":…,"cwd":…,"input-messages":[…],"last-assistant-message":…}`（`codex-rs/hooks/src/legacy_notify.rs:12-41`；内部已重构为 hooks 引擎的一个内置 hook，命名 `legacy_notify` 暗示未来会被 hooks 取代）。
- 实战用例：本机用户 config.toml 就有 `notify = [".../SkyComputerUseClient", "turn-ended"]`；agent-deck 注入 `notify = ["agent-deck", "codex-notify"]` 并用 marker 注释块管理这行配置（`codex_hooks_cmd.go:13-21,224-294`），其解析器同时兼容 argv-JSON 和 stdin、以及多代事件名变体（`codex_hooks_cmd.go:34-127`）——**notify 只有 turn-complete 一个信号，做"running/waiting"状态机还需 hooks 或轮询 rollout mtime 兜底**（kobe 两条都做了，`codex-local/history.ts:242-273` 的 mtime 轮询）。

## 7. Conductor 到底用什么协议驱动 codex（conductor-local 未验证项 → 已定性）

conductor-local.md 原推测"走 proto/app-server 模式，未验证"。本次本机取证**推翻该推测**：

1. `~/.codex/sessions/**` 中 cwd 位于 Conductor workspace（`/Users/outman/conductor/workspaces/Personal_AI_Infrastructure/helsinki`）的会话，其 `session_meta.originator` = **`codex_sdk_ts`**（cli_version 0.130.0，2026-06-06；另有一条 `codex_exec`）。
2. `codex_sdk_ts` 是官方 TypeScript SDK 的 originator 常量（`sdk/typescript/src/exec.ts:43-44`，经 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 环境变量注入）。
3. 该 SDK 的实现就是 spawn **`codex exec --experimental-json`**（`exec.ts:87`），resume 则追加 `resume <threadId>` 子命令（`exec.ts:151-153`），并通过 `-c key=value` 传 model/sandbox/effort 等。
4. Conductor 自带 codex binary：`~/Library/Application Support/com.conductor.app/bin/codex → agent-binaries/codex/0.144.0/codex`（symlink 实测），沙箱信任通过往用户 config.toml 写 `[projects."…"] trust_level="trusted"` 实现（本机 config.toml 可见 Conductor 路径条目）。

结论：**Conductor = @openai/codex-sdk（即 exec --json 子进程流）+ 自管 binary + 消息归一入库**，不是 app-server。注意样本较旧（0.130.0 时期），Conductor 新版是否迁移 app-server 未验证——但这条证据链足够 Coolie 参考："用 exec --json 起步完全能撑起 Conductor 级产品"。

## 8. 交互式 TUI 在 tmux/嵌入终端下的行为

来源：`codex-rs/tui` 源码 + kobe 实战配置。

- **鼠标**：TUI **不开启 mouse capture，直接跳过所有 crossterm mouse 事件**（`tui/src/tui/event_stream.rs:175-179,236`）。含义：滚轮/选择由宿主终端或 tmux 自己处理；嵌入到 xterm.js/tmux 时不存在"引擎抢鼠标"问题（对比一些开 mouse capture 的 TUI）。
- **屏幕模型**：默认 inline viewport（聊天历史直接写入终端 scrollback，非全屏 alt-screen）；仅特定 overlay 才 `EnterAlternateScreen`，且进入时开启 "alternate scroll"（滚轮转箭头键），退出时恢复（`tui/src/tui.rs:734-762`）。含义：tmux `capture-pane` 能拿到完整历史文本；scrollback 归终端管。
- **终端标题**：通过 OSC 0（`ESC]0;…BEL`）写标题（`tui/src/terminal_title.rs:56-90`）。配置 `tui.terminal_title = [items]`（`core/src/config/mod.rs:779` `tui_terminal_title`），item 词汇表：`app-name / project-name(project) / current-dir / activity(spinner) / run-state(status) / thread-title(thread)`（`tui/src/bottom_pane/title_setup.rs:39-55`，TUI 内还有交互式 title setup UI）。kobe 的注入实践：启动参数追加 `-c tui.terminal_title=["activity","thread-title"]`，避免同 repo 多任务标签全叫项目名（`refs/kobe/packages/kobe/src/engine/registry.ts:220-222`；注意该值含引号，须整段作为单个 argv，`interactive-command.ts:115-117`）。**Coolie 的 tmux 集成可直接用 title 作为轻量状态通道**（activity spinner 出现在标题 = 正在跑）。
- **终端通知**：`tui.notifications` 支持 `method = auto|osc9|bel` + `condition = unfocused|always`（`codex-rs/config/src/types.rs:595-640`；后端实现 `tui/src/notifications/{osc9,bel}.rs`）。嵌入终端（xterm.js/tmux）想接住"轮次完成"提醒需要透传 OSC 9 / BEL，或干脆用 hooks/notify 旁路。
- **TUI 即 app-server 客户端** + `--remote ws://…` 可连远程 server（见 §1）——未来 Coolie 甚至可以"server 起一个 app-server daemon，tmux 里的官方 TUI 与 GUI 同连一个引擎实例"。此形态标 experimental（`codex --help` 原文），未实测，仅记录可能性。

## 9. 能力矩阵：codex vs claude（Coolie engine adapter 设计输入）

| 能力位 | Claude Code | Codex (0.139.0 实测) | Coolie 降级策略 |
|---|---|---|---|
| headless 单轮流 | `claude -p --output-format stream-json` | `codex exec --json` | 两者等价可用 |
| headless 常驻双向流 | `--input-format stream-json` | **无**；用 app-server 替代 | codex 侧能力位=via-app-server |
| 长驻 server 协议 | 无官方（SDK 内嵌） | `codex app-server` JSON-RPC | claude 侧走 SDK/ACP |
| 预指定 session id | `--session-id <uuid>` | **不支持**，id 服务端生成（UUIDv7），从 `thread.started`/rollout 文件名回读 | codex 侧"launch→捕获 id"异步绑定（kobe 模式） |
| resume | `--resume <id>` | `codex resume` / `exec resume` / `thread/resume`；同文件追加 | 等价 |
| fork | `--fork-session` | `codex fork` / `thread/fork{lastTurnId}`；新文件全量复制 | 等价；codex 还多"截断 fork" |
| hooks | settings.json hooks | `~/.codex/hooks.json` / config.toml `[hooks]`，10 事件同构，**多一道 trust 门** | 同一套 JsonHookAdapter 抽象 + trust 提示 UI |
| 轻量 notify | 无（用 Stop hook） | `notify=[argv]`（仅 turn-complete） | codex 独有的低成本兜底 |
| 会话转录 | `~/.claude/projects/<cwd>/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + sqlite + session_index | reader 按引擎实现 |
| 会话列表源 | 扫目录 | **state_5.sqlite threads 表** 或 `thread/list` | codex 优先 sqlite/app-server |
| 聚合 diff 事件 | 无（自算 git diff） | `turn/diff/updated`（app-server） | claude 侧降级为 git diff |
| 审批回调 | PermissionRequest hook / `--permission-prompt-tool` | app-server 反向 request；hooks PermissionRequest | 均可挂"等待审批"状态位 |
| TUI 嵌入友好度 | 开 alt-screen；吃鼠标（部分模式） | inline viewport、**不吃鼠标**、OSC0 标题可配、OSC9 通知 | codex 嵌入成本更低 |
| 结构化输出 | `--output-format json` | `--output-schema <schema>` | 等价 |
| 无痕会话 | 无直接等价 | `--ephemeral` / `ephemeral:true` | codex 独有 |

## 与 Coolie 相关的可借鉴点（浓缩）

1. **第一阶段（tux/tmux 渲染）**：tmux 跑原生 `codex` TUI + 三路旁路语义——① `~/.codex/hooks.json` 写 SessionStart/UserPromptSubmit/Stop 观察者（注意 trust 门，UI 要引导用户 `/hooks` 确认）；② `notify=[coolie-cli, codex-notify]` 兜底 turn-complete；③ rollout mtime 轮询做最后防线（kobe 三件套照搬）。标题注入 `-c tui.terminal_title=["activity","thread-title"]` 即免费获得任务状态指示。
2. **第二阶段（无头自渲染）**：直接上 app-server（stdio 或 unix socket），`generate-ts` 生成协议类型进仓库、按引擎版本 pin。`turn/diff/updated` 喂 diff 面板、审批反向 request 喂"待放行"队列、`thread/list` 喂会话侧栏——这三件事 Claude 侧都要自己拼，codex 侧是白送的。
3. **adapter 接口设计**：上表每行就是一个能力位；kobe 的 Noop/Unknown/EMPTY 降级模式（`refs/kobe/packages/kobe/src/engine/registry.ts` copilot 条目）+ "engine-owned UI data"（模型目录、effort 档位 `none/low/medium/high/xhigh`、身份文案全部由 adapter 提供，`codex-local/capabilities.ts`）可整体沿用。
4. **id 生命周期差异要进抽象**：claude=客户端造 id，codex=服务端造 id。Coolie 的 Task↔EngineSession 绑定要支持"先启动、后回填 id"。
5. **`--ephemeral` 适合 Coolie 的"临时问一句"场景**（不污染会话列表）。

## 风险与注意事项

- **协议漂移**：app-server 自标 experimental，0.139→HEAD 方法集差异肉眼可见（§2）；ws transport 明文"unsupported，勿用于生产"。对策：pin 版本 + generate-json-schema + unknown-variant 探测。Conductor 的"自带 binary 按版本隔离"策略（`agent-binaries/<agent>/<version>/`）值得抄。
- **rollout schema 无版本字段**，新字段持续追加（`ordinal`、`phase`、`world_state` 都是近期物）；解析必须逐行宽容。reasoning 加密不可读，别在 UI 上承诺"完整思考过程"。
- **hooks trust 门**是 codex 与 claude hooks 最大的行为差异：写完配置≠生效，自动化里只有 `--dangerously-bypass-hook-trust`（危险）或引导用户手动信任两条路。
- **PermissionRequest 是决策 hook**，观察者别挂（kobe 的教训注释，`hook-adapter.ts:17-22`）。
- **fork = 全量文件复制**，长会话+高频 fork 的磁盘成本；空会话 rollout 会被自动清理，别把 rollout 文件存在性当强不变量。
- **`thread/start` 会写用户 config.toml 的 project trust**——Coolie 以 app-server 驱动时要意识到这个全局副作用。
- Conductor 协议定性基于 2026-06 的单会话样本（0.130.0），新版未复核；`codex fork` 的确切引入版本未考证（0.137.0 时已存在）。均标注为部分验证。

## 来源清单

**本机实测（2026-07-10/11，codex-cli 0.139.0）**
- `codex --help` / `exec --help` / `resume --help` / `fork --help` / `exec resume --help` / `app-server --help` / `features list`
- app-server stdio 握手、`thread/start`、`thread/fork`、`thread/archive`、unknown-method 枚举探测（脚本于 scratchpad）
- `codex exec --json` + `codex exec resume` 真实跑通（PONG/PONG2 双轮，同文件追加验证）
- `~/.codex/`：sessions 树、rollout 逐行 schema、config.toml、history.jsonl、session_index.jsonl、`state_5.sqlite`（.schema threads）、archived_sessions
- `ps aux`（VS Code 扩展与 ChatGPT.app 的 `codex … app-server` 进程）；`~/Library/Application Support/com.conductor.app/bin/`（codex 0.144.0 symlink）
- 全部 rollout `session_meta.originator` 统计（codex-tui / codex_exec / codex_vscode / codex_sdk_ts / Codex Desktop / codex_cli_rs）

**openai/codex 源码（shallow clone @ `5c19155`，2026-07-11）**
- `codex-rs/app-server/README.md`（协议全文）；`codex-rs/app-server-protocol/src/protocol/common.rs`（方法名定义）
- `codex-rs/protocol/src/protocol.rs:3120-3355`（RolloutLine/RolloutItem/TurnContextItem/CompactedItem/GitInfo）
- `codex-rs/hooks/src/{lib.rs,types.rs,schema.rs,legacy_notify.rs,engine/discovery.rs,declarations.rs}`；`codex-rs/core/src/config/mod.rs:737,779`；`core/src/config/config_loader_tests.rs:324-333`
- `codex-rs/exec/src/{exec_events.rs,cli.rs}`；`codex-rs/rollout/src/session_index.rs`
- `codex-rs/tui/src/{tui.rs:734-762, tui/event_stream.rs:175-236, terminal_title.rs:56-90, bottom_pane/title_setup.rs:39-55, app_server_session.rs, notifications/}`；`codex-rs/config/src/types.rs:595-640`
- `sdk/typescript/src/exec.ts:43-44,87,151-153`；`docs/{config.md,exec.md}`

**官方文档（2026-07-10 抓取）**
- https://learn.chatgpt.com/docs/hooks （developers.openai.com/codex/hooks 308 重定向）
- https://learn.chatgpt.com/docs/non-interactive-mode （…/codex/noninteractive 重定向）
- https://github.com/openai/codex/releases 、https://developers.openai.com/codex/changelog （fork 版本线索）

**参考实现**
- kobe：`refs/kobe/packages/kobe/src/engine/codex-local/{binary,capabilities,history,history-parse,hook-adapter,normalize,synthetic,usage}.ts`、`engine/registry.ts:195-240`、`engine/interactive-command.ts:100-172`
- agent-deck：`refs/agent-deck/cmd/agent-deck/codex_hooks_cmd.go`、`internal/session/instance.go:38,186-221,1400-1530`、`internal/session/instance_codex_fork_test.go:71-104`
- 既有研究：`refs/research/{conductor-local.md,agent-deck.md,kobe.md,tux.md}`（本文修正了 conductor-local.md 第 240 行关于 codex 驱动协议的推测）
