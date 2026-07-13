# Superset（superset-sh/superset）研究

> 背景：landscape.md 判定 Superset 是"与 Coolie 假想形态最接近的产品"，但当时只有摘要级扫描（landscape.md:137）。本文档是针对性的源码实证深读。此前不存在独立的 superset.md，本文即为该缺口的补充研究，故全文归入下面这一节。

## 补充研究：Superset 实证深读（终端实现 / worktree 与 presets / diff review / 快捷键 / 混合路线问题清单）

> 调研日期：2026-07-10。方法：`git clone --depth 1 https://github.com/superset-sh/superset`（HEAD = `f00abc10`，commit 时间 2026-07-10 22:12 -0700，"feat(mobile): unified home, attachments sheet, glass composer with voice dictation (#5581)"）。克隆位于本次会话的 scratchpad 临时目录，未纳入 refs/（见下方许可风险）。
> 本机未安装 Superset.app，无法做 conductor-local.md 式的运行时/数据目录考古——本文全部结论来自源码与 repo 内设计文档，行号以该 commit 为准，路径相对 superset repo 根。
> **许可**：Elastic License 2.0（根目录 `LICENSE.md`、`package.json` 的 `"license": "Elastic-2.0"`）。非 OSI 开源：禁止以 hosted/managed service 形式提供、禁止绕过 license key。**本文只提炼概念与架构决策，Coolie 不得复制其代码。**

### 0. 最重要的一个更正：Superset 不是"单体 Electron"

landscape.md:170 的差异化论据之一——"真正的 headless server + CLI + 多客户端（Superset 是单体 Electron）"——**经实证是错的/已过时**。Superset 的 v2 架构已经是完整 CS：

```
┌ clients ─────────────────────────────────────────────┐
│ desktop renderer (React) │ web (apps/web) │ mobile (RN/Expo) │ CLI (packages/cli) │
└──────┬───────────────────────────────────────────────┘
       │ tRPC over HTTP (httpBatchStreamLink) + WebSocket（终端字节流）
┌──────▼──────────────────────────────────────────────┐
│ host-service（独立 Node 子进程，Hono HTTP server）      │
│  tRPC router: workspaces/git/terminal/agents/...     │
│  Drizzle + SQLite（local-db）、EventBus、reaper       │
└──────┬──────────────────────────────────────────────┘
       │ Unix domain socket（自定义二进制帧协议）
┌──────▼──────────────────────────────────────────────┐
│ pty-daemon（常驻 daemon，生命周期独立于 app）           │
│  node-pty spawn/kill/resize、输出缓冲、fd-handoff 升级 │
└─────────────────────────────────────────────────────┘
```

证据：

- host-service 是 Electron main 用 `childProcess.spawn(process.execPath, [host-service.js])` 拉起的**独立子进程**，Hono `serve()` 监听 HTTP 端口（apps/desktop/src/main/lib/host-service-coordinator.ts:376；apps/desktop/src/main/host-service/index.ts:1-27）。
- 端口按 organizationId 做 FNV hash 稳定映射到 48000–48999（host-service-coordinator.ts:57-69），配 PSK secret 鉴权，并写 manifest 文件供 CLI 发现（同文件 :82-86 注释："Manifests are still written by the child for the CLI's benefit"）。
- 客户端统一走 `@superset/workspace-client`：tRPC `httpBatchStreamLink` 指向 `${hostUrl}/trpc`（packages/workspace-client/src/providers/WorkspaceClientProvider/WorkspaceClientProvider.tsx:76-84）。
- 另有 relay（apps/relay + packages/host-service/src/tunnel）把 host-service 暴露给远端 web/mobile（settings 表有 `exposeHostServiceViaRelay` 开关，packages/local-db/src/schema/schema.ts:234-236），云侧用 ElectricSQL 同步（desktop 依赖 `@electric-sql/client`、`@tanstack/electric-db-collection`，apps/desktop/package.json）。
- CLI 命令面：agents/automations/hosts/projects/tasks/terminals/workspaces/start/stop/status（packages/cli/src/commands/ 目录）。

**对 Coolie 的直接冲击**：landscape.md 给出的三点差异化里，"真 CS 多客户端"这一点 Superset 已经做到且做得深（连移动端都有）。Coolie 剩下的实质差异只有：Tauri 更轻（Superset 是 Electron 40 + Bun monorepo，desktop 依赖近 200 个）、**个人向/无账号/无云依赖**（Superset 强绑 organization、better-auth、Stripe、PostHog、Sentry、cloud sync），以及"符合我个人风格"。差异化叙事需要重写。

### 1. 内嵌终端的具体实现

#### 1.1 终端仿真器选型：xterm.js 6.1 beta + 全家桶 addon

- 渲染端 `@xterm/xterm 6.1.0-beta.220` + addons：`webgl`（GPU 渲染）、`serialize`、`unicode11`、`image`、`ligatures`、`search`、`clipboard`、`fit`、`progress`；服务端另用 `@xterm/headless`（apps/desktop/package.json dependencies）。
- 没有用 tmux、没有用 ghostty——持久化问题用自研 pty-daemon + headless xterm 解决（见 1.3/1.4）。kobe 的 "task = worktree + tmux session" 里 tmux 承担的角色，在 Superset 里被 pty-daemon（进程存活）+ FIFO replay + ModeTracker（状态恢复）三件套替代。

#### 1.2 PTY 桥：三层进程链与两套线协议

数据通路：`renderer xterm.js ↔ WebSocket（二进制帧）↔ host-service ↔ Unix socket（自定义帧协议）↔ pty-daemon ↔ node-pty`。

**pty-daemon**（packages/pty-daemon，仅依赖 node-pty，约 1600 行核心代码）：

- 独立进程、Unix socket 监听，socket 文件 `chmod 0600` 即整个鉴权边界（src/Server/Server.ts:82-83）。刻意跑在 Node 而非 Bun："node-pty + Bun's tty.ReadStream don't get along"（src/main.ts:2-3）。
- 线协议：`[u32 totalLen][u32 jsonLen][JSON header][binary payload]`，PTY 输入/输出字节放二进制尾巴而非 base64 进 JSON——"~33% less wire ... zero encode/decode passes"；单帧 8MB 硬上限防内存耗尽（src/protocol/framing.ts:1-18）。消息集：hello/open/input/resize/close/list/subscribe(replay)/unsubscribe/prepare-upgrade（src/protocol/messages.ts）。
- node-pty spawn 参数：`name: "xterm-256color"`、**`encoding: null`（raw bytes，保字节保真）**（src/Pty/Pty.ts:186-194）；有专门的 `byte-fidelity` 和 `no-encoding-hops` 集成测试（package.json test scripts）。
- kill 策略：默认 SIGHUP 信号整棵进程树+进程组，1 秒后未退则升级 SIGKILL（src/Pty/Pty.ts:93-133）。
- spawn 失败诊断：node-pty 原生错误 "posix_spawnp failed" 吞 errno，Superset 预检 cwd 存在性（worktree 被删的常见故障）+ 用 spawnSync 重探真实 errno（src/Pty/Pty.ts:160-207）。
- **daemon 自升级（fd-handoff）**：新版本 daemon 由旧 daemon spawn，PTY master fd 通过 stdio 继承传给继任者，shell 进程全程不死；依赖 node-pty 私有属性 `_fd`，为此把 node-pty 钉死在 1.1.0 并在 spawn 时断言（src/Pty/Pty.ts:66-80）；继任者对被收养的 PTY 无法走 node-pty 的 TIOCSWINSZ，resize 用"spawn `stty cols X rows Y`、把 master fd 当它的 stdin"这个 hack 兜底（src/Pty/Pty.ts:292-314）。升级模式信号走 argv 而非 env——因为 bundler 会静态内联 `process.env` 并 DCE 掉分支（src/main.ts:53-66，踩坑注释非常具体）。
- Electron 重启后 PTY 仍存活的根据：coordinator 注释 "PTYs survive across Electron restarts via the pty-daemon layer host-service supervises"（apps/desktop/src/main/lib/host-service-coordinator.ts:82-86）。

**host-service 终端层**（packages/host-service/src/terminal/terminal.ts）：

- renderer 连 `ws://127.0.0.1:<port>/terminal/<terminalId>`；**PTY 输出字节走二进制 WS 帧，renderer 直接 `xterm.write(Uint8Array)` 零解码**；控制消息（input/resize/dispose/attached/exit/title）走 JSON（terminal.ts:150-160 注释 + 类型定义）。
- 回放缓冲 64KiB FIFO（terminal.ts:162）；重连时先发一条灰色 "─── Session Contents Restored ───" 分隔线（terminal.ts:164-168，学 VS Code 的 "History restored"）。
- **慢消费者防线**：无 ACK 流控，renderer 停止 drain（卡顿/死 tab）时 WS send buffer 超 8MB 直接断开该 socket，让它重连重放——**关键是永不暂停 PTY**，"a stalled renderer can't wedge the shell"（terminal.ts:169-178）。默认终端 120x32（terminal.ts:180-181）。
- PTY 生命周期与 socket 生命周期解耦，"sockets detach/reattach freely"（terminal.ts:273）。

（注：apps/desktop/src/main/terminal-host/ 是 v1 遗留的另一套 in-Electron 终端栈（PTY subprocess + emulator 背压水位 1MB/250KB，session.ts:66-77），正在被 v2 host-service 栈取代；两套并存本身就是"架构迁移中"的证据。）

#### 1.3 断线/重启后 TUI 状态恢复：ModeTracker（Superset 最值得抄的设计之一）

问题（plans/20260507-terminal-mode-replay.md 全文）：Codex 等 kitty-keyboard TUI 只在启动时发一次 `\x1b[>7u`；64KiB FIFO 把它挤掉后，renderer 刷新重连拿不到这个序列，Shift+Enter 从"插入换行"变回"提交"。同类隐患：bracketed paste、focus reporting、mouse tracking、app cursor。该文档还横向对比了 VSCode（headless xterm 但 `serialize({excludeModes:true})` 故意剥模式，只部分解决）/ Tabby（无）/ Wave（256KiB FIFO，无）/ cmux（scrollback string，无）——**全行业都没完整解决，Superset 的做法是"抄 VSCode 的脚手架、改它的策略"**。

实现（packages/host-service/src/terminal/terminal-mode-tracker.ts:1-14）：每个 PTY 输出 chunk 同时喂给一个 `@xterm/headless` 实例；重连回放前先 `buildPreamble()` 生成把新 xterm 拉回当前模式的字节序列（kitty flags、?2004h、?1004h、鼠标模式、?1h、?25h/l）。已知残留缺口：mouse *encoding*（?1006/?1015/?1016）xterm 公共 API 不暴露，不在回放范围（plan 文档明说 "revisit if it bites"）。

#### 1.4 按键透传：三层仲裁（Coolie 做 tux 渲染必抄的作业）

核心文件 apps/desktop/src/renderer/lib/terminal/terminal-key-event-handler.ts（含两段高密度注释，:30-38）：

1. **问题**：xterm 的 `_keyDown` 处理完按键后调 `stopPropagation()`，事件死在 target phase，app 级快捷键（react-hotkeys-hook 挂 document）永远收不到——TUI 里 Cmd+T 全部失灵（apps/desktop/plans/20260409-tui-hotkey-forwarding.md 用插桩确认）。
2. **解法（VSCode 模式）**：`attachCustomKeyEventHandler` 返回 false 让 xterm 提前 bail。仲裁顺序（terminal-key-event-handler.ts:47-79）：
   - `resolveHotkeyFromEvent(event)` 命中注册表 → 返回 false，让事件 bubble 给 app（**精确匹配，未注册的 Ctrl+R/Ctrl+L 等仍进 TUI**——比 v1 "所有 ctrl/meta 全放行" 的粗暴做法精确，v1 的做法会饿死 TUI 的 Ctrl+R）；
   - 行编辑翻译（line-edit-translations.ts:40-59）：**Shift+Enter / Cmd+Enter → `ESC CR`**（即 Claude Code `/terminal-setup` 安装的换行序列，Codex/Gemini/OpenCode 也解析为 Alt+Enter 插行；直接注入绕过 xterm 编码器，"newline never depends on the kitty handshake"）；Cmd+Backspace→`\x15`(kill line)、Cmd+←→`\x01`(^A)、Cmd+→→`\x05`(^E)、Option+←/→→`ESC b/f`——**这正是 Context.MD 要的 "macOS 原生行编辑键" 的翻译表**；
   - Cmd+A → `terminal.selectAll()`（VS Code 同款）；
   - 剪贴板仲裁（clipboard-shortcuts.ts:30-52）：macOS 规则 = **所有 Cmd chord 一律 bubble 给宿主**（显式引用 Ghostty `key_encode.zig:534-545` "on macOS, command+keys do not encode text"——否则 kitty 协议开启时每个 Cmd 键都被 CSI-u 编码成字面字符漏进 TUI）；Win/Linux 上 Ctrl+C 只有存在选区时才 bubble（它兼任 SIGINT）。
3. **打印字符按 `event.code`（物理键）而非 `event.key` 匹配**，规避 Dvorak/QWERTZ 布局漂移；语义键（Backspace/Arrow）才用 `event.key`（line-edit-translations.ts:25-31 的 CONTRACT 注释）。

未做（plan "Remaining work"）：`sendKeybindingsToShell` 用户偏好（tmux/emacs 重度用户想把一切喂给 shell）；alt-buffer gate（TUI 占用备用屏时收缩 app 快捷键表，让 Cmd+F 进 nvim 而不是触发 FIND_IN_TERMINAL）。

#### 1.5 xterm 渲染质量问题清单（plans/20260425-v2-terminal-rendering-divergences.md）

对照 VS Code/Hyper/Tabby 逐项审计自家 xterm 配置，8 个议题：字体加载竞态（首帧 WebGL atlas 用错字体度量）、DPR 监控（xterm 6.1 内置已够）、subpixel 容器尺寸、ResizeObserver 未去抖的 `fit()`、resize 不保滚动位置、缺省 xterm options、renderer 侧无 PTY 背压、WebGL context loss 恢复。**做 xterm 嵌入前值得通读**，它标了每项"确认成立/部分成立/无效假设"。

### 2. worktree 生命周期与 presets 机制

#### 2.1 数据模型（packages/local-db/src/schema/schema.ts，Drizzle + SQLite）

- `projects`（:26-60）：mainRepoPath、defaultBranch、workspaceBaseBranch、branchPrefixMode/Custom、worktreeBaseDir（项目级 worktree 根覆盖）、defaultApp。
- `worktrees`（:68-95）：path、branch、baseBranch、gitStatus/githubStatus（JSON 缓存列）、**`createdBySuperset` 布尔——外部导入的 worktree 防误删**。
- `workspaces`（:103-153）：type = `"worktree" | "branch"`（后者直接工作在主 checkout 上，一个 project 只允许一个 branch 型，migration 0006 部分唯一索引）、`deletingAt` 软删除标记（删除中先隐藏再清理）、**`portBase`——每 workspace 预分配 10 个端口给 dev server**（:134-136）、sectionId（侧栏分组）。
- `workspace_sections`（:161-179）：用户自定义分组（名称/颜色/折叠）。
- `settings` 单行表（:184-237）：terminalPresets（JSON 数组）、terminalPersistence、branchPrefix、字体、confirmOnQuit、exposeHostServiceViaRelay 等。

#### 2.2 worktree 生命周期（packages/host-service/src/trpc/router/workspaces/workspaces.ts）

- **路径约定**：`~/.superset/worktrees/<projectId>/<branch>`；刻意放主 checkout 之外——"editors, file watchers, and ignore rules treat worktrees as separate trees"（workspace-creation/shared/worktree-paths.ts:5-9）；branch 名做 path-traversal 校验（同文件 :41-58）。可被 settings/项目级 worktreeBaseDir 覆盖。
- **创建流水线**（workspaces.ts:527-599）：并行预热 cloud 注册 + **并行 LLM 起名**（用户给了 prompt 但没起名时，~700ms 的 AI 命名调用与 git 工作重叠，:540-558）→ `ensureMainWorkspace` → **先 `git worktree prune`**（清理目录已丢的注册，否则 `worktree add` 报 "branch is already used by worktree at <missing-path>"，:571-578）→ `addBranchWorktree`。
- **branch 三种来源**（:356-408）：已有本地分支 → `worktree add`；remote-tracking → `--track -b`（否则 detached HEAD）；新分支 → `worktree add --no-track -b <branch> <path> <start>`（`--no-track` 让 ahead/behind 指向未来 `push.autoSetupRemote` 设置的自家 upstream）。创建后写 `git config branch.<name>.base <baseBranch>` 记录 base（:410-430）——diff 面板的 against-base 依据。
- **adopt 外部 worktree**："tools other than Superset can also `git worktree add`, and their worktrees are valid adoption targets"（:344-346）——把别的工具（或手工）建的 worktree 收编为 workspace。
- **PR checkout**（:585-698）：`gh` CLI 拉 PR 元数据 → 本地同名分支 OID 与 PR head 比对：匹配→adopt，不匹配→CONFLICT 报错并附人工清理指引（`git worktree remove` + `branch -D`）。失败路径有 `rollbackWorktree`（`worktree remove --force`）。
- **local-first 写库**：本地行是 authoritative record，cloud 镜像 best-effort，失败不回滚 worktree，留 cloud-dirty 由 reconciler 补推（:444-497）。
- 删除：teardown scripts → worktree remove →（可选 `deleteLocalBranch`）；有专门的 workspace-cleanup 路由与 reaper（packages/host-service/src/trpc/router/workspace-cleanup/、test/workspace-cleanup.test.ts）。

#### 2.3 presets：两个正交概念

**① Terminal presets**（用户级，存 settings.terminalPresets JSON）——schema（packages/local-db/src/schema/zod.ts:107-121）：

```ts
{ id, name, description?, cwd, commands: string[],
  projectIds?: string[] | null,        // 定向到特定项目
  pinnedToBar?, useAsWorkspaceRun?,
  applyOnWorkspaceCreated?, applyOnNewTab?,   // 自动应用时机
  executionMode?: "split-pane" | "new-tab" }  // 多命令并行：分屏或分 tab
```

即"打开终端时自动跑什么命令、在哪个子目录、怎么摆"（docs：apps/docs/content/docs/terminal-presets.mdx）。内置 quick-add 模板即 12 家 agent 的启动命令（见 §3）。

**② 项目级 setup/teardown/run scripts**（repo 内声明，packages/host-service/src/runtime/setup/config.ts:186-217）：

- 三层合并：`<repo>/.superset/config.json`（canonical，可提交）→ `~/.superset/projects/<id>/config.json`（每机器覆盖）→ `<repo>/.superset/config.local.json`（overlay，支持 `{before:[], after:[]}` 插入或整体替换）。
- `setup` 在 workspace 创建后于一个**可见的 "Workspace Setup" 终端**里跑，命令用 ` && ` 串联短路（workspace-creation/shared/setup-terminal.ts:23-36, 89-107）；fallback 兼容旧的 `.superset/setup.sh`。**读的是主 repo 的 config 而非 worktree 的**——"worktrees skip gitignored files, the main repo is authoritative"，脚本可用注入的 `$SUPERSET_ROOT_PATH` 访问主 repo（同文件注释）。典型用途：`cp "$SUPERSET_ROOT_PATH/.env" .env`、`bun install`（docs/setup-teardown-scripts.mdx）。
- `run` 是可重启的 dev server 命令，绑定 Run 按钮和专用 pane。

**Coolie 结论**：worktree 最烦的两件事（gitignored 文件不跟随、依赖要重装）Superset 用"可提交的项目级声明 + 本机 overlay + 可见终端执行"解决，这套分层比 Conductor 的 conductor.json 更细。

### 3. 引擎集成：CLI 命令模板 + lifecycle hooks（不是协议适配）

- **12 个内置 terminal agent**（packages/shared/src/builtin-terminal-agents.ts:59-156）：claude（`claude --dangerously-skip-permissions`）、codex（`codex --dangerously-bypass-approvals-and-sandbox`，promptCommand 加 `--`）、gemini（`--approval-mode=auto_edit`）、amp（promptTransport: "stdin"）、copilot、opencode、cursor-agent、droid、vibe、mastracode、pi、polygraph。每个 agent 只是 `{command, promptCommand?, promptTransport?: "argv"|"stdin"}` 的命令模板；transport 枚举刻意只有两个——"add a new transport only when a real agent requires it. Avoid arbitrary per-agent shell templates"（packages/shared/src/agent-prompt-launch.ts:1-8）。
- **Prompt 注入即打字**：launch command 像用户敲进 shell 一样写入 PTY，所以 prompt 必须消毒——CRLF 归一、整段剥 CSI/OSC 序列、剥控制字符、tab 展开（否则 ESC 触发 keybinding、裸 CR 提前提交、tab 触发补全；agent-prompt-launch.ts:10-33 的 `sanitizePromptForPty`）。
- **结构化状态不靠解析终端输出，靠 hooks**：`~/.superset/hooks/notify.sh` 被注入到各 agent 的 hook 体系（Claude 直接 merge `~/.claude/settings.json` 的 hooks；Codex 用 wrapper script；opencode 装 plugin；gemini 用 wrapper——apps/desktop/src/main/lib/agent-setup/ 每家一个文件）。notify.sh 解析 hook JSON（兼容 Claude 的 `hook_event_name` 与 Codex 的 `type`），归一化成 Start/Stop/PermissionRequest，连同 Superset 注入的 `$SUPERSET_TERMINAL_ID/$SUPERSET_WORKSPACE_ID` 等 env POST 到 `http://127.0.0.1:<port>/trpc/notifications.hook`（templates/notify-hook.template.sh:1-40；packages/host-service/src/terminal/terminal.ts:143）。安全细节："Never default to 'Stop' on parse failure — silent drop is safer than a false completion notification"（模板 :39-41）。
- hook 事件建立 `TerminalAgentBinding`（terminalId ↔ agentId ↔ agentSessionId，packages/host-service/src/terminal-agents/types.ts:8-22），驱动侧栏状态徽标、提示音、unread 标记。辅助信号：OSC 133 shell-ready 扫描器（写入时序门控，重 direnv 环境 15s 超时）与 terminal-title 扫描器（packages/shared/src/shell-ready-scanner.ts、terminal-title-scanner.ts）。
- **对 Coolie 的启示**：这就是 landscape.md 说的混合路线的实现细节——"终端渲染保证任意 agent 可用（零协议适配），hooks 提供最小结构化信号（何时开始/结束/要权限）"。Coolie 计划的 "tux 优先" 与此同构；Claude Code hooks + Codex notify 是现成的低成本结构化通道，不必先做 headless 自渲染。

### 4. diff review 面板：数据来源与交互

#### 4.1 数据来源：纯 git CLI，worker 线程隔离

- 计算在 Node `worker_threads` 里跑（apps/desktop/src/main/git-task-worker.ts:1-50），避免大 repo 的 git 调用卡 tRPC/主进程。
- 一次 `computeStatus`（apps/desktop/src/lib/trpc/routers/changes/workers/git-task-handlers.ts:248-279）并行取：`git status`（staged/unstaged/untracked 解析）、`diff --cached --numstat`、`diff --numstat`、branch 对比（`rev-list --left-right --count origin/<default>...HEAD` 得 ahead/behind、`log origin/<default>..HEAD --max-count=500`、`diff --name-status/--numstat origin/<default>...HEAD`，:165-215）、upstream push/pull 计数。untracked 文件手工数行 + 前 512B 含 NUL 判二进制（:100-160）。
- 四个分区：**against-base / committed / staged / unstaged**（renderer/stores/changes/store.ts:71-76），分区可折叠、可拖拽排序；侧栏两个 tab：`"diffs" | "review"`（同文件 :18）。
- host-service 侧有对应的 v2 diff surfaces（packages/host-service/src/trpc/router/git/，含 v2-diff-surfaces.integration.test.ts），文件变更事件经 `@parcel/watcher` + EventBus 推给客户端（packages/workspace-client/src/hooks/useGitChangeEvents/）。

#### 4.2 渲染：@pierre/diffs（全文对比，非 patch）

- 用 Pierre 团队的 `@pierre/diffs 1.2.2` 的 `MultiFileDiff`：喂 `oldFile.contents / newFile.contents` **两份全文**（不是 unified patch），组件自己做 diff + shiki 语法高亮 + split/unified 切换 + `hideUnchangedRegions`（apps/desktop/src/renderer/screens/main/components/WorkspaceView/ChangesContent/components/LightDiffViewer/LightDiffViewer.tsx:1-62）。字体/主题与编辑器设置联动。
- 交互（docs/diff-viewer.mdx + ChangesContent 代码）：stage/unstage、commit、push/pull、Create PR；**Focus Mode**（单文件 + Prev/Next + 分区跳转 + "2/5 in Staged" 计数）；diff 行双击或右键 "Edit Here" 直接跳原文件编辑器对应行。

#### 4.3 混合路线的闭环：diff 行内评论 → 写回 agent PTY

这是 Superset 在"终端渲染 + 结构化 review"上最关键的打通：

- DiffPane 支持选中行区间挂评论 composer（useDiffCommentComposer.ts:17-43），提交目标是一个 `AgentTarget`——**已有的 terminal agent 会话，或新建 agent 会话（placement: "split-pane" | "new-tab"）**。
- 评论被格式化为 `In <path>:L<start>-L<end> (deleted lines|across deletions and additions)?: <comment>`（useSendToTerminalAgent.ts:31-46），deletions 侧行号显式标注（因为指的是 pre-diff 文件）。
- 经 `sanitizePromptForPty` 消毒后走 host-service `terminal.writeInput` mutation 直接写进 agent 的 PTY——**review 意见变成敲进 Claude Code/Codex 输入框的键击**（useSendToTerminalAgent.ts:66-91）。
- "review" tab 则是 PR 维度：`gh` CLI 拉 PR 状态/checks/评论（10s/30s 轮询），支持 resolve thread（apps/desktop/plans/20260413-1600-v2-review-tab.md:100-151）。

**Coolie 结论**：不需要自渲染 agent 对话流，也能做出"在 diff 上圈行评论 → agent 改"的核心体验；成本只是 prompt 消毒 + PTY 写入。这与 Context.MD "右侧 diff review + tux 渲染" 的设想完全兼容，且是已被验证的产品形态。

### 5. 快捷键体系

- **中央注册表**：77 个快捷键定义在单一 `HOTKEYS_REGISTRY`（apps/desktop/src/renderer/hotkeys/registry.ts:45 起），每条含 per-platform chord、label、category、description。类别覆盖：Navigation（Cmd+[ / ] 历史、Cmd+P quick open）、Workspace（Cmd+1..9 直跳、Cmd+N 新建、Ctrl+Cmd+R run command）、Pane（Cmd+D 分屏右、Cmd+Shift+D 分屏下、Cmd+Alt+方向键焦点移动、split with chat/browser）、Terminal（Cmd+F 终端内搜索、Cmd+K 清屏、rich input 切换）、Tab（Cmd+T/W、Ctrl+Tab、reopen tab）等（registry.ts 全文 grep）。
- **logical vs physical 双模式**：打印字符 chord 标记为 "logical"，开启 adaptive layout 后跟随键帽字符而非物理位置（QWERTZ 上 ⌘Z 落在键帽 Z＝物理 KeyY；registry.ts:26-39 注释），主进程用 `native-keymap` 读系统布局（apps/desktop/src/main/lib/keyboardLayout.ts；desktop package.json 依赖 native-keymap 3.3.9）。
- **用户可重绑**：hotkeyOverridesStore + useRecordHotkeys 录制 UI（renderer/hotkeys/stores/、hooks/）；匹配引擎是 react-hotkeys-hook 5.x。
- **与终端的冲突仲裁**见 §1.4——注册表被反向索引成 `Map<normalizedChord, HotkeyId>` 供 `resolveHotkeyFromEvent` O(1) 查询，且刻意复用 react-hotkeys-hook 的 normalize 函数防两套匹配漂移（plans/20260409 文档）。
- 另有 command palette（renderer/commandPalette/，模块化 command provider）兜底所有动作。
- **对 Coolie**：Context.MD 要求的"丰富快捷键 + macOS 原生 ctrl+a/ctrl+e"在 Superset 里被拆成两层——app 快捷键走注册表，行编辑键走 PTY 翻译表（§1.4）；ctrl+a/ctrl+e 本身天然进 PTY 由 shell 处理，Superset 额外把 **Cmd** 系（Cmd+←/→/Backspace）也翻译成 readline 序列。这个"两层拆分 + 单一注册表 + 反向索引给终端仲裁用"的结构值得直接借鉴（概念层面）。

### 6. "终端渲染 + 结构化 review" 混合路线：已解决 / 未解决清单

**已解决（可当避坑地图）**：

| 问题 | 方案 | 证据 |
|---|---|---|
| TUI 吞掉 app 快捷键 | customKeyEventHandler + 注册表反查，精确放行 | plans/20260409；terminal-key-event-handler.ts:47-49 |
| kitty 协议下 Cmd 键泄露成 CSI-u | macOS 全部 Cmd chord bubble（Ghostty 规则） | clipboard-shortcuts.ts:30-52 |
| 重连后 TUI 模式丢失（Shift+Enter 失效等） | headless xterm ModeTracker + 回放前 preamble | plans/20260507；terminal-mode-tracker.ts:1-14 |
| Electron 重启杀死 agent 进程 | pty-daemon 独立进程 + Unix socket | pty-daemon 全包；coordinator.ts:82-86 |
| daemon 自身升级杀会话 | PTY master fd stdio 继承 handoff | Pty.ts:66-80、main.ts:92-190 |
| 慢 renderer 拖垮 host（OOM/卡 shell） | 8MB WS 缓冲上限，断开重连而非暂停 PTY | terminal.ts:169-178 |
| PTY 字节保真（多跳编码损坏） | 全链路 binary（encoding:null + 二进制帧 + 二进制 WS） | Pty.ts:192-193、framing.ts:12-14、terminal.ts:150-155 |
| prompt 注入被 shell/TUI 误解 | sanitizePromptForPty + OSC133 shell-ready 门控 | agent-prompt-launch.ts:10-33、shell-ready-scanner |
| agent 状态结构化 | lifecycle hooks → 本地 HTTP 归一化事件 | notify-hook.template.sh、terminal-agents/types.ts |
| worktree 的 gitignored 环境文件 | setup scripts 三层合并 + $SUPERSET_ROOT_PATH | setup/config.ts:186-217 |
| review→agent 闭环 | diff 行评论格式化后写 PTY | useSendToTerminalAgent.ts:31-91 |

**未解决 / 明示的 gap（Coolie 同样会撞上）**：

1. adopted PTY 的 resize 只有 stty hack，无真 TIOCSWINSZ（Pty.ts:222-226 注释自认 "known gap"）。
2. mouse encoding 模式（?1006 等）不可回放，xterm 公共 API 不暴露（plans/20260507 "Notes"）。
3. `sendKeybindingsToShell` 偏好与 alt-buffer 快捷键收缩未实现（plans/20260409 "Remaining work"）——tmux/emacs 用户仍会被 app 快捷键抢键。
4. xterm 渲染细节 8 项审计多数仍处 "suggested fix" 状态（plans/20260425）。
5. 结构化程度天花板：hooks 只有 Start/Stop/PermissionRequest 粒度，**没有工具调用列表、token 统计、对话结构**——这是终端渲染路线的固有边界（要突破只能走 headless/stream-json，Superset 也在 chat 方向另起了 packages/chat + mastracode 自研 agent，说明他们自己也不满足于纯终端渲染）。
6. v1/v2 两套终端栈并存迁移中（apps/desktop/src/main/terminal-host vs packages/host-service/src/terminal），大量 plans/ 文档在处理 v1→v2 的 parity/迁移——单体起步后改 CS 的重构税，Coolie 直接 CS 起步可以避免。

### 7. 与 Coolie 相关的可借鉴点（概念层）

1. **进程拓扑就是答案**：`UI 壳（薄）→ host-service（HTTP+WS+tRPC，一切业务）→ pty-daemon（只管进程存活）` 三层，PTY 存活与 UI、甚至与 server 升级解耦。Coolie 的 Tauri client + TS server + CLI 可以一比一映射，且 Coolie 若从第一天就这么分层，就没有 Superset 的 v1/v2 迁移税。
2. **终端字节通道单独走 WS 二进制帧，控制面走 tRPC**——不要把 PTY 输出塞进 JSON/tRPC。
3. **持久化三件套**：daemon 进程存活 + 有限 FIFO 回放 + headless xterm 模式回放。若 Coolie 不想自研 daemon，tmux 可以替代第一件（kobe 路线），但后两件（restored 分隔线、mode preamble）仍值得做；反过来 Superset 证明了"无 tmux 依赖"的自研成本 ≈ 1600 行核心 + 大量测试。
4. **按键三层仲裁表**（app 注册表反查 → 行编辑翻译 → 剪贴板/Cmd bubble 规则）可直接作为 Coolie 键盘设计的 spec 起点；macOS "所有 Cmd chord 不进 PTY" 是 Ghostty/VS Code/Superset 三家一致的共识规则。
5. **presets 双层设计**（用户级 terminal presets + repo 级 setup/run/teardown 三层合并）优于 Conductor 的单一 conductor.json。
6. **agent 集成的最小结构化**：命令模板 + promptTransport 枚举 + hooks 事件，不做协议适配也能有状态徽标/通知/review 闭环。
7. **diff 面板**：git CLI in worker + 全文对比渲染组件 + against-base 用 `branch.<name>.base` config 记录——都是低成本高收益的做法。`@pierre/diffs` 本身 MIT 发布在 npm（未验证其仓库许可细节，使用前需复核），可作为 Coolie diff 渲染候选。

### 8. 风险与注意事项

- **ELv2 许可**：本文所有引用仅为概念研究。Coolie 是个人工具、不提供 hosted service，直接"使用" Superset 无风险；但**复制其代码进 Coolie 代码库有传染性风险**（ELv2 非宽松许可），实现须独立完成。克隆的源码放在临时 scratchpad，未入库。
- **差异化重估（本文最重要输出）**：landscape.md 的三点差异化中"真 CS 多客户端"已失效（§0）。Superset 迭代速度极快（调研当天发版 + 当天 commit），功能竞赛不可取。Coolie 站得住的差异：**无账号/无云/无遥测的纯本地个人工具**（Superset 强制 organization/auth/PostHog/Sentry/Stripe 全家桶）、Tauri 体积与内存、以及按个人品味裁剪的交互。若这三点也不成立，"重造 Superset"的警告成立。
- **Superset 的复杂度警示**：desktop 依赖约 200 项、monorepo 10 个 app + 22 个 package、plans/ 里 100+ 设计文档——这是 15 人级团队的工程量。Coolie 应只取其骨架（三层进程 + 键盘仲裁 + presets 分层），砍掉 cloud/org/mobile/relay/chat 全部维度。
- **未验证项**：① 运行时行为（数据目录布局、daemon socket 实际路径、升级 handoff 的真实成功率）未做本机验证——需要时可安装 app 后按 conductor-local.md 方法补一次考古；② `@pierre/diffs` 的许可与离线可用性未复核；③ 12.4k stars / v1.14.3 发布信息沿用 landscape.md 当日快照，未重新抓取。

### 9. 来源清单

- 仓库：https://github.com/superset-sh/superset （ELv2，shallow clone @ f00abc10，2026-07-10）
- 官网/文档：https://superset.sh/ 、https://docs.superset.sh （docs 源码：apps/docs/content/docs/*.mdx）
- 关键源码（路径相对 repo 根，行号 @ f00abc10）：
  - 终端：packages/pty-daemon/src/{main,Pty/Pty,Server/Server,protocol/framing,protocol/messages}.ts；packages/host-service/src/terminal/{terminal,terminal-mode-tracker}.ts；apps/desktop/src/renderer/lib/terminal/{terminal-key-event-handler,line-edit-translations,clipboard-shortcuts}.ts
  - worktree/presets：packages/host-service/src/trpc/router/workspaces/workspaces.ts；workspace-creation/shared/{worktree-paths,setup-terminal}.ts；packages/host-service/src/runtime/setup/config.ts；packages/local-db/src/schema/{schema,zod}.ts
  - diff：apps/desktop/src/lib/trpc/routers/changes/workers/git-task-handlers.ts；renderer/stores/changes/store.ts；ChangesContent/components/LightDiffViewer/LightDiffViewer.tsx；hooks/host-service/useSendToTerminalAgent/useSendToTerminalAgent.ts；DiffPane/hooks/useDiffCommentComposer/useDiffCommentComposer.ts
  - agent 集成：packages/shared/src/{builtin-terminal-agents,agent-prompt-launch}.ts；apps/desktop/src/main/lib/agent-setup/（notify-hook.template.sh 等）；packages/host-service/src/terminal-agents/types.ts
  - 快捷键：apps/desktop/src/renderer/hotkeys/registry.ts
  - 架构：apps/desktop/src/main/lib/host-service-coordinator.ts；apps/desktop/src/main/host-service/index.ts；packages/workspace-client/src/providers/WorkspaceClientProvider/WorkspaceClientProvider.tsx；AGENTS.md；apps/desktop/package.json
- 仓库内设计文档（问题清单主要来源）：plans/20260425-v2-terminal-rendering-divergences.md；plans/20260507-terminal-mode-replay.md；apps/desktop/plans/20260409-tui-hotkey-forwarding.md；apps/desktop/plans/20260413-1600-v2-review-tab.md
- 本项目既有研究：refs/research/landscape.md（Superset 摘要与竞品坐标，:36-47、:137、:159、:170-181）
