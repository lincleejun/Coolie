# kobe 深度研究（Coolie 对标基线）

> 研究对象：本地 clone `refs/kobe`（https://github.com/Sma1lboy/kobe ，`@sma1lboy/kobe` v0.7.94）。
> 本文所有代码引用路径均相对于 `refs/kobe/`，格式 `文件:行号`。未读源码、仅凭文档推断的内容标注"未验证"。
> 面向读者：Coolie 作者。目标：功能至少追齐 kobe。

---

## 1. 概述：它是什么、解决什么问题

kobe 是一个 **SSH 友好的 TUI orchestrator**：把 AI coding 工作拆成隔离的 git worktree + 持久 tmux session，让你在任何终端里并行跑多个 coding agent（"AI agents are useful one at a time. kobe is for when you want five attempts running at once"）。核心公式：

```text
Task = git worktree + tmux session + branch
```

来源：`README.md:6-7, 50-54`；`packages/kobe/package.json`（version 0.7.94, bin `kobe`, engines bun>=1.3.11）。

关键定位决策（对 Coolie 直接相关）：

- **kobe 不做 coding agent，不自渲染 chat**。v0.6 起放弃了 stream-json 子进程驱动 claude 的方案，变成"task launcher"：每个 Task 一个 tmux Session，里面跑原生交互式 `claude`/`codex`，"进入任务"= attach 真实 TTY（叫 **Handover**）。`CONTEXT.md:5`。这正是 Coolie "优先 tux 渲染、不自渲染" 的同款结论——kobe 曾走过自渲染（v0.5）和 AI-SDK native chat（2026-07 探索）两条弯路，都退役了（`CONTEXT.md:177-203`）。
- **两条 UI 栈并存**：默认 `kobe` = tmux Handover 路径；`KOBE_TUI=1` 启动纯 React 单进程 **Workspace Host**（中央嵌 in-process PTY 包住 engine 自己的 TUI）。`docs/ARCHITECTURE.md:193-257`、`src/env.ts:43-51`。
- **daemon 是任务索引的单写者**，但**从不拥有 engine 进程**（engine 归 tmux 或独立 `kobe pty-host`），重启 daemon 不杀会话。`docs/ARCHITECTURE.md:57-90`、`CONTEXT.md:129-131`。

---

## 2. 核心概念与数据模型

### 2.1 词汇表（`CONTEXT.md` 是术语的 source of truth）

| 术语 | 含义 | 出处 |
|---|---|---|
| **Task** | 一个工作单元，1:1 拥有一个 Worktree；tmux 模式下另拥有一个 tmux Session。持久化在 `~/.kobe/tasks.json` | `CONTEXT.md:15-17` |
| **Worktree** | Task 检出的 git worktree，**懒分配**（首次进入才落盘） | `CONTEXT.md:19-21` |
| **Session** | engine 在磁盘上的会话转录（claude: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`），kobe 只读不写 | `CONTEXT.md:23-25` |
| **tmux Session** | 每 Task 一个，名为 `kobe-<task-id>`，跑在专用 `-L kobe` socket 上（与用户自己的 tmux 隔离） | `CONTEXT.md:31-33` |
| **ChatTab** | tmux Session 里的一个 **window** = 同一 worktree 上一条独立 engine 会话；每个 ChatTab 都是四窗格布局 | `CONTEXT.md:36` |
| **Handover** | 进入 Task = `tmux attach`/`switch-client` 真实 TTY；`Ctrl+Q` 两段式 detach | `CONTEXT.md:39-41` |
| **Workspace Host** | `KOBE_TUI=1` 的单进程 React app：Sidebar｜Terminal Tabs｜Files | `CONTEXT.md:65-67` |
| **Terminal Tab / Split** | Workspace Host 里的 PTY 版 ChatTab（registry key `${taskId}::${tabId}`）；Tab 内可再分裂 Split 树 | `CONTEXT.md:69-75` |
| **PTY Host** | 独立 `kobe pty-host` 进程，持有裸 PTY 子进程（kobe 的"tmux server 类比物"），TUI 退出/daemon 重启都不死；按 session 保留字节 ring buffer，重连回放 | `CONTEXT.md:85-87` |
| **Orchestrator** | Task 生命周期 + worktree 分配 + 响应式任务列表快照；从不碰交互式 engine 进程 | `CONTEXT.md:115-117` |
| **Daemon / RemoteOrchestrator** | daemon 持有 Orchestrator、经 Unix socket 服务 N 个客户端；客户端用 RemoteOrchestrator 门面镜像任务状态 | `CONTEXT.md:129-139` |

### 2.2 Task 数据模型（`src/types/task.ts`）

```ts
interface Task {
  id: TaskId            // ULID，时间前缀可排序 (task.ts:98)
  title: string
  repo: string          // 源 repo 绝对路径（非 worktree）
  branch: string        // 懒分配任务创建时为 ""
  worktreePath: string  // 懒分配时为 ""; kind:"main" 时 === repo
  kind?: "main" | "task"  // main = 钉在 repo 根检出的"项目行"，无 worktree add (task.ts:113-121)
  status: "backlog"|"in_progress"|"in_review"|"done"|"canceled"|"error"  // (task.ts:43)
  archived: boolean     // 与 status 正交，非破坏 (task.ts:123-127)
  pinned?: boolean
  vendor?: VendorId     // engine 提示，缺省 "claude" (task.ts:35)
  prStatus?: TaskPRStatus  // provider/lifecycle/checkState/url... (task.ts:79-92)
  position?: number     // 仅 web 看板的手工排序键 (task.ts:140-146)
  modelEffort?: string  // codex: none/low/medium/high/xhigh (task.ts:147-154)
  createdAt / updatedAt: string  // ISO-8601
}
```

- 磁盘清单 `TaskIndex.version: 3`；v1/v2（含 `sessionId`/`tabs`）加载时自动迁移剔除（`task.ts:159-169`、`docs/ARCHITECTURE.md:448-450`）。
- `main` task 是"saved repo 的投影"：sidebar 的 PROJECTS 行就是 main task；删除 main 被拒绝（`CannotDeleteMainTaskError`），唯一移除方式是 `forgetProject`（`src/orchestrator/core.ts:354-421`）。

### 2.3 磁盘持久化布局（`docs/ARCHITECTURE.md:423-450`、`src/env.ts`）

| 路径 | 所有者 | 内容 |
|---|---|---|
| `~/.kobe/tasks.json` (+`.tmp` 原子写 + lockfile) | `TaskIndexStore` | 任务清单 |
| `~/.config/kobe/state.json` | `src/state/store.ts`（读-合并-写事务，多进程安全） | UI 状态 + 用户偏好 KV（theme、engineCommand.* 等） |
| `~/.kobe/settings/keybindings.yaml` | 用户手写 | 键位覆盖（见 §7.4） |
| `~/.kobe/worktrees/<repo-key>/<slug>/` | `GitWorktreeManager` | 每任务 worktree；`<repo-key>=basename-sha1(12)`（`paths.ts:253-258`）；兼容旧的 repo-local `.kobe/worktrees`、`.claude/worktrees` |
| `~/.claude/projects/**`、`~/.codex/sessions/**` | engine 自己 | 会话转录，kobe 只读 |
| `~/.kobe/daemon.sock` / `daemon.log` | daemon | socket 超长时回退 `$TMPDIR/kobe-<tag>-<role>.sock`（`kobe-daemon/src/daemon/paths.ts:53-59`） |
| `~/.kobe/worktree-init/<hash>` | init 系统 | "该 worktree 的 init.sh 已跑过" 标记（`env.ts:148-157`） |
| `~/.kobe/attachments/`、`~/.kobe/issue-assets/`、`~/.kobe/ssh/*.sock` | 各功能 | 粘贴截图、issue 附件、SSH ControlMaster（`env.ts:110-144`） |

刻意**不持久化**：聊天消息（转录即真相）、tmux 进程状态、engine 活动徽标、daemon 运行时状态（`docs/ARCHITECTURE.md:437-445`）。

---

## 3. 架构

### 3.1 分层（`docs/ARCHITECTURE.md:31-90`）

```
TUI clients + panes (React + @opentui/react)   src/tui-react/** + src/tui/{direct.ts,ops/,panes/}
RemoteOrchestrator（客户端门面）                src/client/remote-orchestrator.ts
Daemon（任务索引单写者）                        packages/kobe-daemon/src/daemon/{server,handlers}.ts
Orchestrator + tmux handover                   src/orchestrator/{core,worktree/,index/} + src/tmux/
Types + engine adapters                        src/types/* + src/engine/*/
```

四条 load-bearing 边界：
1. 所有任务写操作走 daemon RPC（UI 直接 import `TaskIndexStore` 视为泄漏）。
2. daemon 包不 import kobe 实现；kobe 侧提供 `DaemonRuntimeAdapter` 注入（ADR 0003）。
3. Orchestrator 只管任务生命周期，从不 spawn engine。
4. **tmux 拥有交互式 engine 进程**；daemon 关闭绝不 teardown tmux。

### 3.2 Daemon（`packages/kobe-daemon/`）

- 每用户一个，`kobe daemon start|stop|status|restart` 管理（`src/cli/index.ts:421-425`）。
- **生命周期 refcount**：只有 `role:"gui"` 订阅者（attach 的 TUI、打开的浏览器 SSE）持有 daemon 存活；in-tmux 帮助面板订阅 `role:"pane"` 不持有；无 GUI 后惰性关停（`CONTEXT.md:141-143`、`src/tui/direct.ts:113-118`）。
- RPC verb 表（`kobe-daemon/src/daemon/handlers-task.ts:17-224`、`handlers-worktree.ts:27-106`、`handlers.ts:210-312`）：
  `task.list/get/create/archive/rename/setBranch/setVendor/delete/pin/move/status/reorder/ensureMain/ensureWorktree/setActive`、`project.forget`、`worktree.discoverAdoptable/adopt/reconcile/archiveRemoved/list/remove`、`daemon.status/stop`、`issue.list/mutate`、`session.deliver`、`engine.reportEvent`。
- 推送通道（last-value replay，`kobe-daemon/src/daemon/channels.ts:28-190`）：`task.snapshot`、`issue.snapshot`、`active-task`、`update`、`engine-state`、`ui-prefs`、`keybindings`、`task.jobs`、`worktree.changes`、`transcript.activity`、`session.deliver`。
- daemon 内后台 collector：auto-title 轮询（`auto-title-poller.ts`）、PR 状态收集（`pr-status-collector.ts`）、worktree 未提交变更计数（`worktree-changes-collector.ts`）、转录活动（`transcript-activity-collector.ts`）。

### 3.3 PTY Host（Workspace Host 模式的"tmux server"）

独立进程 `kobe pty-host`（`kobe-daemon/src/daemon/pty-server.ts`，CLI shim `src/cli/pty-host-cmd.ts`；`src/cli/index.ts:426-433`）。特性：字节 ring buffer 重放、OSC title/pid/command 跟踪（`kobe api pty-list`）、零会话时 idle 退出；只有 `pty.kill`（关 tab/归档任务）或 `kobe reset` 会杀子进程（`CONTEXT.md:85-87`）。TUI 侧 `PtyRegistry` 做 acquire/release/detachAll + **PTY parking**（无人观看 2 分钟后丢弃本地 xterm 实例，子进程继续跑；切回时 reattach+replay）（`CONTEXT.md:81-83`）。

### 3.4 Web dashboard（`kobe web`）

同一 daemon 的浏览器前端：React SPA（TanStack Router）+ 一条 SSE 流 + `POST /api/rpc`（走 daemon handler registry 的 web allowlist），PTY 走 Node sidecar（node-pty 不支持 Bun）WebSocket，默认 5173/5174(daemon web)/5175(pty)（`docs/design/web-dashboard.md:1-58`、`README.md:104-113`）。含看板（`task.reorder`/`position` 字段）与 Issues 页（daemon-owned issue store）。

---

## 4. Task = worktree + tmux session + branch：完整代码路径

### 4.1 创建

1. **`createTask`**（`src/orchestrator/core.ts:204-236`）：只记录意图——`branch:""`、`worktreePath:""`、`status:"backlog"`；先 `ensureMainTask(repo)` 保证项目行存在；可选 `baseRef` 存入 side-map（不进 Task，属于一次性输入）。**故意不预生成 branch**：占位标题的任务会撞名，且 branch 要跟随首次进入前的重命名（core.ts:213-220 注释）。
2. **`ensureWorktree`**（懒物化，`core.ts:281-289` → `WorktreeCoordinator.ensure`，`src/orchestrator/worktree-coordinator.ts:117-172`）：
   - `SlugAllocator.allocate(repo)`：从 ~410 个动物名池随机挑一个未占用 slug（占用集 = store 中非归档任务 slug ∪ 磁盘已有目录 ∪ 进行中 pending）；池耗尽则 `panda-v2` 版本后缀；allocate 串行化防并发撞名（`src/orchestrator/worktree/slug-allocator.ts:1-176`）。**明确模仿 Conductor 的城市名方案**（slug-allocator.ts:10）。
   - branch = `task.branch || autoBranch(title, id)` = `kobe/<title-slug(≤32)>-<ulid后6位>`（`src/orchestrator/title.ts:36-45`）。
   - 路径 = `~/.kobe/worktrees/<repo-key>/<slug>`（`paths.ts:78-129`；用户可在 Settings 里改 worktree base，支持 `$project_dir` 展开，`paths.ts:56-69`）。
   - `GitWorktreeManager.create`（`src/orchestrator/worktree/manager.ts:97-155`）：幂等（同路径同 branch 直接返回；同路径异 branch 抛错"never hijack"）；branch 不存在 → `git worktree add -b <branch> <path> [baseRef]`，存在 → 复用且**忽略 baseRef**（绝不悄悄 rebase）。
   - **自清理回滚**：slug 只在 store 写成功后 commit；任何一步失败 → 删掉刚建的 worktree + 释放 slug（worktree-coordinator.ts:146-172）。
3. **收养已有 worktree**（`adoptWorktree`，core.ts:443-460 + worktree-coordinator.ts:215-255）：`git worktree list --porcelain` 全量枚举（含 kobe 管理根之外的），排除主检出/detached/bare，按最近活跃排序（manager.ts:295-325）；同路径并发收养用锁去重；`ifExists:"return"` 供 hook 幂等。`kobe add` 会自动扫描并收养 repo 的全部未关联 worktree（`src/cli/index.ts:202-214`）。

### 4.2 进入 / 切换（Handover）

冷启动路径 `startDirectTmux`（`src/tui/direct.ts:97-223`）：
1. 装全局 hooks（fire-and-forget，见 §6.4）→ 检查 tmux 在 PATH → `connectOrStartDaemon()` + `RemoteOrchestrator(role:"gui")`。
2. `chooseInitialTask`：active > persisted(`lastSelectedTaskId`) > cwd 的 main task > pinned > 第一个非归档（direct.ts:46-58）。零任务 → 附加到 `kobe-home` 兜底会话（direct.ts:129-148）。
3. `cwd = task.worktreePath || ensureWorktree()` → `setActiveTask`（写 last-active + 触发 recency） → main task 的 vendor 与"实际在跑的 vendor"对账（防止 daemon 重启把健康的 codex respawn 回 claude，direct.ts:158-169）。
4. `ensureSession({name: kobe-<taskId>, cwd, command: interactiveEngineCommand(vendor), ...})` → `applyTmuxChromeTheme` → `syncSessionZen` → `prepareWindowForAttach`（**attach 前**把 window resize 到本终端尺寸并 heal 布局，消除首帧 reflow 闪烁，`tmux.ts:199-223`）→ `tmux attach`。
5. attach 返回后：占位标题的任务从转录里取首条用户消息自动命名（`deriveTitleFromSession`，direct.ts:211-219、`src/monitor/auto-title.ts`）。

**`ensureSession` = observe → decide → apply**（`src/tui/panes/terminal/tmux-session.ts:111-262`）：
- observe：一次 `list-panes -s -F "#{window_id}\t#{window_active}\t#{@kobe_role}\t#{@kobe_worktree}\t#{@kobe_vendor}"` 拿到全部事实（tmux-session.ts:123-171）。
- decide（纯函数 `decideSessionAction`，`src/tmux/session-decision.ts:114-161`）：
  - 无 session → `create`；
  - engine pane 活着（按 `@kobe_role=claude` 标签而非 pane 计数——在 shell pane 里敲 `exit` 曾误判"会话坏了"）+ worktree/vendor 匹配 → `reuse`；
  - 仅 vendor 漂移（用户 `setVendor` 换引擎）→ `respawn-engine`：在**每个 window 原地 respawn engine pane**，保住兄弟 ChatTab；
  - 多窗但活动窗 engine 没了 → 仍 `reuse`（不为一个坏窗丢兄弟 tab）；
  - 其余（legacy 无标签、worktree 漂移、单窗 engine 已死）→ `rebuild`（kill + 重建）。
- 并发进入用 per-session-name in-flight 锁合并（tmux-session.ts:90-121）。

Tasks pane 里切换任务 = `enterTask`（`src/tui/lib/task-enter.ts`）：ensure-or-heal session → zen 对账 → mark active → `enterWindow`：**fit 焊死在 switch 前**（`prepareWindowForSwitch` + `switch-client -t =session`，`tmux.ts:277-301`），保证任何调用方都不可能切进未 fit 的窗口。

### 4.3 命名

- tmux session：`kobe-<task-id>`（`CONTEXT.md:31-33`）。
- worktree 目录：动物 slug（旧任务是 ULID）。
- branch：`kobe/<slug>-<id6>`（title.ts:36-45）。
- 任务标题：占位 `(new task)` → attach 结束后由转录首条 user message 派生（纯字符串截断，无模型调用；auto-title.ts:1-23）；daemon 里还有 auto-title 轮询器兜底（`kobe-daemon/src/daemon/auto-title-poller.ts:16`）。
- ChatTab 标题：手动 F2 > 引擎 OSC 动态标题 > 首 prompt 自动名 > vendor 默认（`CONTEXT.md:69-71`）。ChatTab window 上还挂 `@kobe_session_id`（kobe 给 claude 强制 `--session-id <uuid>`，把 window 映射到转录；`interactive-command.ts:151-172`、`tmux-session-create.ts:57-59,135`）。

### 4.4 清理

- **archive**（`a` 键 / `kobe api archive`）：仅翻 flag，非破坏；同时杀掉该任务缓存的 tmux session（`docs/KEYBINDINGS.md:120` 末句）。归档任务再打开可进"只读历史回放 pane"（beta，`experimental.archivedHistoryPreview`，`tmux-session.ts:63-88`）。
- **delete**（`d` 键 / `kobe api delete`，`core.ts:354-383`）：脏 worktree（含 untracked，`manager.ts:353-365`）不带 `force` 直接抛 `DirtyWorktreeError` 让 UI 二次确认；`git worktree remove` 失败则**保留索引条目**（防"看不见的磁盘残骸"）；成功后补 `git worktree prune`（manager.ts:194-236）。**branch 一律保留**，生命周期归调用者。
- **forgetProject**（`kobe remove`）：从 savedRepos 删 + 删对应 main 行；按 canonical key（git toplevel realpath）匹配，绝不 `git worktree remove`（core.ts:404-421）。
- **`kobe reset [--hard]`**：停 daemon（graceful→SIGTERM→SIGKILL）+ 删 socket/pidfile + 停 pty host + 杀全部 kobe tmux session；`--hard` 才额外删 tasks.json 和 state.json；**永不碰 worktrees**（`src/cli/maintenance.ts:337-347`）。
- **`kobe kill-sessions`**：只拆 tmux server（先 TERM 每个 pane 进程组，防 HUP 泄漏到 launchd，`src/cli/commands-tui.ts:163-181`）。
- **`kobe doctor`**：只读诊断，绝不杀/删（maintenance.ts:141-145）。

---

## 5. tmux 集成方式

### 5.1 专用 server + 单一 client 模块

- 一切 tmux 交互经 `-L kobe` 专用 socket（与用户 tmux 完全隔离；沙箱开发再用 `KOBE_TMUX_SOCKET=kobe-sandbox` 隔离一层，`CLAUDE.md` Orientation）。
- `src/tmux/client.ts` 是唯一公共入口，分层：`client-spawn`（socket/argv/run）、`client-options`（session/server 选项、pane 角色标签）、`client-teardown`、`client-home`（兜底会话）。**pane 一律按 id (`%N`) 定位**，绝不用 `:0.0`——`base-index 1` 的用户配置曾两次烧掉数小时（client.ts:10-14）。
- `send-keys` 必带 `-l --`（字面文本；否则 `Enter`/`C-x` 形状的 token 会被 tmux 当键名重解析，client.ts:80-95）。

### 5.2 四窗格布局（每个 ChatTab 相同）

```
┌────────┬──────────────────┬───────────────┐
│ tasks  │   engine CLI     │  ops (files)  │
│ 32格固定│  (@kobe_role=    │───────────────│
│        │    claude) 60%   │  shell        │
└────────┴──────────────────┴───────────────┘
```

- 纯布局策略在 `src/tmux/session-layout.ts`：Tasks rail **固定 32 cells**（百分比会漂，session-layout.ts:22-31）；engine 60%（`CLAUDE_PANE_PERCENT`）；右列上下各 50%（`OPS_PANE_PERCENT`）。用户拖动的全局几何存 server 级 tmux 选项 `@kobe_tasks_width` / `@kobe_right_width_pct` / `@kobe_ops_height_pct`，跨任务共享（session-layout.ts:66-165）。
- 建 pane：`buildPanesAround(claudePane)`（`src/tui/panes/terminal/chattab.ts:159-260`）—— 一串 `split-window -P -F` 批量执行并回收 pane id，然后打角色标签 `@kobe_role=tasks|claude|ops|shell` + 版本标签 `@kobe_pane_version`（升级后 `ensureSession` 原地 respawn 过期的 kobe 自有 pane，engine pane 不动；`docs/KEYBINDINGS.md:122`）。
- session 级标签：`@kobe_task` / `@kobe_worktree` / `@kobe_vendor` / 远程任务的 remote key（`tmux-session-create.ts:139-144`）——这是"从 tmux 反查任务"的持久化机制，Ctrl+T 新开 tab 只凭 session 名就能重建同样的 workspace（chattab.ts:271-325）。
- 全窗口"surface"页（settings/new-task/update/quick-task/help/worktrees）打 `@kobe_surface=1` window 选项，导航 chord 在这些页面一律 no-op，防止把用户从填了一半的对话框里拽走（`client.ts:99-149`、`commands-tui.ts:116-119`）。

### 5.3 engine pane 的 launch line（纯字符串构建，`src/tmux/launch-line.ts`）

- **keep-alive 包装**：`<cmd>; rc=$?; [非0则打横幅]; exec "$SHELL"` —— engine 退出后 pane 落到 shell 而不是塌掉布局；非零退出打出"⚠ Engine exited (code N). Check Settings → Engines"横幅（launch-line.ts:21-59）。engine pane 版本带 `onExit`：shell 也退出后跑 `kobe engine-tab-exit` 关掉/替换这个 tab（launch-line.ts:82-93）。
- **SIGINT guard**：`trap ':' INT` 防启动期 Ctrl+C 杀死整个 wrapper（launch-line.ts:11-19）。
- **repo init watchdog**：`.kobe/init.sh` 在 engine 前同 shell 运行（`export` 能传到 engine），手写 POSIX watchdog（macOS 无 timeout(1)）：后台子 shell + stdin=/dev/null + `sleep N && kill` + 成功时 `export -p` dump 回外层 source；默认 120s，`KOBE_REPO_INIT_TIMEOUT_SECONDS` 可调 5–3600（launch-line.ts:117-230）。once-per-worktree 语义靠 `~/.kobe/worktree-init/<hash>` 标记（env.ts:148-157）。
- **首条消息投递**：fresh session 创建后 fire-and-forget `deliverFirstEngineMessage`（`src/tmux/prompt-delivery.ts:32-84`）：轮询等 engine pane 出现且画面连续两帧稳定（24×250ms 预算）→ tmux paste buffer + **bracketed paste**（多行 prompt 不会在第一个换行就提交）→ **延迟 150ms 再发 Enter**（否则 `\e[201~` 和 `\r` 合并进一次 tty read，回车被当成粘贴内容）。这段是踩坑结晶，Coolie 直接抄。

### 5.4 attach / detach / 布局自愈

- attach argv 由 `attachArgv(session)` 生成，`Bun.spawn(stdin/out/err: inherit)` 前台等待退出（direct.ts:60-73）。
- `Ctrl+Q` 两段式：先聚焦 Tasks pane（rail 隐藏则先恢复），第二次才 detach 回启动 shell；`prefix d` 仍一步 detach（`docs/KEYBINDINGS.md:104`、`tmux.ts:351-385`）。
- 三个 tmux hook 驱动的自愈闭环（全部经 `kobe <subcmd>` 回调 + 防抖合并，`src/cli/commands-tui.ts:214-292`）：
  - `window-resized`/`pane-exited` → `heal-layout`（重钉 rail 宽度/右列几何）；
  - `client-resized` → `resync-window`（覆盖 manual 尺寸后"变大"方向不触发 window-resized 的坑）；
  - `window-layout-changed` → `capture-layout`（把用户手拖的几何写进全局选项；resize 期间用时间戳 guard 防误捕获）。
- **Zen 模式**：session 级选项 `@kobe_zen` + 每窗 `@kobe_zen_panes` 记录被藏的 pane 角色，跨 tab 持久，新 tab 也折叠；恢复时精确还原（session-layout.ts:40-54）。

### 5.5 与 coding agent 进程的关系

- kobe **从不**以子进程方式驱动 engine；engine 是 tmux pane 里的普通交互 CLI，崩溃/退出由 keep-alive shell 兜底。
- kobe 与 engine 的通信通道只有四条：(1) 启动时 argv 注入（session-id、system prompt、terminal title 配置）；(2) tmux send-keys/paste-buffer 投递文本（`kobe api send`）；(3) engine 的 hook 回调 `kobe hook`（见 §6.4）；(4) 读磁盘转录。

---

## 6. Coding engine 支持

### 6.1 支持列表

内置三家：**claude / codex / copilot**（`src/types/vendor.ts:24-28`）；v0.5 的 gemini 已删（"无值得包装的交互 TUI"，vendor.ts:1-10；注意 README.md:42 仍写着 gemini，属文档滞后）。VendorId 类型是**开放的** `string & {}`：用户可注册任意 custom engine（一个 id + 启动命令，存 `customEngineIds` + `engineCommand.<id>`，vendor.ts:15-24）。

### 6.2 Engine Registry（`src/engine/registry.ts`）——每 vendor 一行的接线表

| 能力 | claude | codex | copilot | custom |
|---|---|---|---|---|
| defaultCommand | `["claude"]` | `["codex"]` | `["copilot"]` | `[<id>]` |
| history reader（转录路径） | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `~/.codex/sessions/**/rollout-*.jsonl` | `~/.copilot/session-state` | EMPTY（防误读他家转录） |
| detectAccount（二进制+登录探测） | ✓ | ✓ | ✓ | 无 |
| hook adapter（活动事件） | ✓ | ✓ | Noop | Noop |
| turn detector（回合完成检测） | ✓ | ✓ | Unknown | Unknown |
| capabilities（模型目录/权限模式） | ✓ | ✓ | 无 | 无 |
| effortLevels | — | none/low/medium/high/xhigh | — | — |
| terminalTitle 策略 | ownsStatus | ownsStatus + `-c tui.terminal_title=["activity","thread-title"]` | — | — |

来源：registry.ts:187-253。硬规则（`CLAUDE.md` "Engine-owned UI data"）：中性层（TUI/web/orchestrator）**禁止**硬编码 vendor 字符串或自己解析转录——一切经 registry。`vendorFromTerminalTitle` 还能从 OSC 标题反推"用户自己在 shell 里敲了 claude"，让手动启动的 engine 也进入统一的 turn 状态管理（registry.ts:277-286）。

### 6.3 启动命令构建（`src/engine/interactive-command.ts`）

流水线：`engineCommand.<vendor>` 用户覆盖串（带引号的 shell-ish 解析）→ registry defaultCommand → `withEngineEffort`（codex 映射 `-c model_reasoning_effort=<level>`）→ `withEngineTerminalTitle` → （创建 session 时再包）`withClaudeSessionId`（claude 强制 `--session-id <uuid>`，已带 `--resume/--continue` 等旗标则跳过）→ `withWorktreeProtocol` / `withDispatcherProtocol`（经 `--append-system-prompt` 注入，见下）。全部有"用户自定义命令已带同名 flag 则不动"的守卫（interactive-command.ts:100-143,151-172,264-329）。

**System prompt 注入的两个协议**（实验开关控制）：
- worktree 任务（`experimental.autoStatus`）：教 agent 干完活自己跑 `kobe api set-status --status in_review`（interactive-command.ts:199-213）；
- main 会话（`experimental.dispatcher`）：把 repo 主会话变成"调度员"——worktree 会话用 `kobe api note` 上报一行 gotcha，daemon 转给 dispatcher，dispatcher 用 `kobe api dispatch` 转发给受益任务（interactive-command.ts:287-329）。为什么用 flag 不用文件：CLAUDE.local.md 会永久弄脏 worktree 的 ± 计数，且系统提示能活过 context compaction（interactive-command.ts:249-263）。

### 6.4 Hook 系统（活动徽标）

- 启动时 `ensureGlobalKobeHooks()` 把活动 hooks 装进**全局** `~/.claude/settings.json`（幂等、可 opt-out、fire-and-forget，direct.ts:99-103）。
- engine hook（Stop/Notification/PostToolUse/WorktreeCreate…）触发 `kobe hook <verb>`：读 stdin JSON → vendor adapter 归一化 → 上报 daemon `engine.reportEvent` → daemon 按 cwd 映射任务 → 折叠进 `engine-state` 通道广播（sidebar 徽标）。两条铁律：**绝不拉起 daemon**（会破坏 refcount 惰性关停）、**永远 exit 0**（`src/cli/hook-cmd.ts:1-22`）。hook 不在 ensureSession 里装（无 per-worktree 写入，`tmux-session.ts:188-193`）。
- 轮询兜底：Ops pane 看转录 mtime 点亮活动徽标（registry.ts:66-74）；turn-detector 结合转录标记 + pane 静默判定回合结束，驱动 ChatTab window 的 `@kobe_tab_state`（●运行/✓完成/!错误/○空闲，chattab.ts:148-151）。

---

## 7. TUI/CLI 技术栈与代码组织

### 7.1 技术栈（锁定，`CLAUDE.md` Orientation）

TypeScript + **Bun**（>=1.3.11）+ `@opentui/core`/`@opentui/react` 0.4.3 + **React 19** + `@xterm/headless`（嵌入终端 VT 解析）+ `node-pty`（web sidecar）+ `ws`。Solid TUI 于 2026-07-07 (0.7.73) 删除，React 是唯一 UI；**核心响应式状态是 framework-free 的**（`createStateCell` + `useSyncExternalStore` 消费，orchestrator 不依赖任何渲染框架——daemon 拆分正是挂在这条缝上，`docs/ARCHITECTURE.md:84-90`）。

### 7.2 入口与模块地图

- `src/cli/index.ts` 是唯一 bin 入口：子命令全部动态 import（非 TUI 命令不加载 opentui）；**未知子命令报错退出而非落进 TUI**（index.ts:479-484）。
- 裸 `kobe` → `src/tui/index.tsx` → 默认 `startDirectTmux`（direct.ts），`KOBE_TUI=1` → `startWorkspaceHost`（`src/tui-react/workspace/host.tsx`）。
- 目录约定：`src/tui-react/**` 全部渲染组件；`src/tui/**` framework-free 核心（keymap dispatch、split-core、terminal-tabs-core、ops 逻辑）；`src/tmux/**` 纯策略 + client；`src/orchestrator/**` 任务域；`src/engine/<vendor>-local/**` 引擎适配。
- in-tmux 面板是**独立 OS 进程**：`kobe tasks`（左栏）、`kobe ops`（文件树/diff）、`kobe settings/new-task/quick-task/worktrees/help-page/update-page/history`（全窗口页），各自连 daemon 订阅 `role:"pane"`（commands-tui.ts:337-450）。
- 工程纪律：**每文件 ≤ 500 行 CI 硬门槛**（触碰即负责拆分）；每个 bug fix 必须带回归测试；PR-only mainline；测试三层（type-level / unit / daemon socket / PTY behavior）（`CLAUDE.md` Hard rules、`README.md:149-164`）。

### 7.3 状态管理

- 任务态：daemon 单写者 → `task.snapshot` 通道 → RemoteOrchestrator 客户端镜像 → React `useSyncExternalStore`。
- UI 态：`~/.config/kobe/state.json`，`src/state/store.ts` 原子读-合并-写（TUI 的 KVProvider 与 CLI 的 `getPersistedString/setPersistedString` 都是它的适配器）——多进程（TUI/Tasks pane/CLI）不互相覆盖（`CONTEXT.md:123-125`）。
- 焦点/选中任务等 view-local 态归各客户端进程自己。

### 7.4 Keymap 架构（Coolie"丰富快捷键"需求的最佳参考）

- 单一 chord 表 `KobeKeymap`（`src/tui/context/keybindings.ts` + sidebar/chat/files 分表），**禁止在表外硬编码 chord 字符串**；F1 帮助、状态栏 footer、绑定注册全部从表渲染——改一行三处联动（`docs/KEYBINDINGS.md:4`）。
- 运行时是模块级 LIFO **binding stack** + 纯函数 dispatcher（`src/tui/lib/keymap-dispatch.ts`）；打开对话框压入 **modal barrier**，结构性切断之前注册的一切绑定——面板永远不用自己判断"有没有对话框开着"（`docs/ARCHITECTURE.md:303-320`）。
- **边界规则**：裸字母绑定必须 pane-scoped（gate 在焦点上），全局绑定必须带修饰键——否则要么偷走输入、要么永远不触发（KEYBINDINGS.md:46-52）。
- 用户覆盖：`~/.kobe/settings/keybindings.yaml`，支持平台 overlay（darwin/linux/windows）、null 解绑、多 chord 列表、位置组（`sidebar.nav: [w, s]` slot dispatch）、`tmux.*` id 直通 tmux 层（覆盖默认时安装方自动 `unbind-key` 旧键）；校验拒绝会偷输入的裸字母、终端表达不了的 `shift+字母`、到不了 tmux 的 `cmd+`（KEYBINDINGS.md:124-233、`src/tmux/keybindings.ts:101-167`）。
- 键位选型的决策记录极有价值：为什么 `ctrl+hjkl` 而不是 `ctrl+1..4`（CSI-u/iTerm quirk）或 `alt+数字`（被 Raycast 吃掉）——**ctrl+字母是唯一零协商、零配置可靠的 chord**（KEYBINDINGS.md:412-453）；嵌入终端把除保留集外的一切键**最大化透传**给 engine（`RESERVED_GLOBAL_CHORDS`，KEYBINDINGS.md:455-479）。
- **Terminal Identity Boundary**：所有 PTY spawn 统一 `TERM=xterm-256color`+`COLORTERM=truecolor` 且剥掉 `TERM_PROGRAM`（外层 iTerm 身份泄漏曾导致 Neovim 颜色错乱）——嵌入终端方案的必修课（`CONTEXT.md:93-99`）。

---

## 8. 配置体系与默认值汇总

| 配置 | 位置 | 默认值 | 出处 |
|---|---|---|---|
| 引擎启动命令 | state.json `engineCommand.<vendor>` | registry defaultCommand | interactive-command.ts:100-111 |
| 引擎显示名 | state.json `engineName.<vendor>` | registry displayName | interactive-command.ts:57-71 |
| 默认 vendor | Task 缺省 | `claude` | task.ts:35 |
| 首选 vendor 解析 | per-repo last-active → 全局默认 → claude | | core.ts:249-252 |
| worktree 根 | Settings → General "Worktree location" | `~/.kobe/worktrees` | paths.ts:56-69 |
| Tasks rail 宽 | tmux server 选项 `@kobe_tasks_width` | 32 cells（16–120 clamp） | session-layout.ts:22-84 |
| engine pane 宽 | — | 60% | session-layout.ts:87-91 |
| repo init | `<repo>/.kobe/init.sh` + `.kobe/init-prompt.md` > `kobe repo set` 覆盖 | 无；watchdog 120s（5–3600） | repo-init.ts:1-110、launch-line.ts:117-143 |
| PR prompt 模板 | `<worktree>/.kobe/pr-instructions.md` 覆盖 | 内置模板 | ops/pr-prompt.ts:15-33、ARCHITECTURE.md:437 |
| 键位 | `~/.kobe/settings/keybindings.yaml` | KobeKeymap/TMUX_*_DEFAULTS | tmux/keybindings.ts:42-99 |
| Settings 页 | General/Engines/Accounts/Keybindings/Feedback/Dev | | settings-dialog/model.ts:28-36 |
| General 内容 | theme、language(i18n)、透明背景、focus accent、reduced motion、split style、toast、sound、zen 保留 Tasks、settings surface(chattab/taskpanel)、编辑器(kind/custom)、worktree base、scrollback rows | | model.ts:47-68 |
| 实验开关 | `experimental.autoStatus` / `.dispatcher` / `.archivedHistoryPreview` / `.remoteProjects` | 全默认关 | state/auto-status.ts:19、dispatcher.ts:19、archived-history.ts:20、repos.ts:360 |
| 环境变量 | `KOBE_DEV`、`KOBE_TUI`、`KOBE_HOME_DIR`、`KOBE_TMUX_SOCKET`、`KOBE_REPO_INIT_TIMEOUT_SECONDS`、`KOBE_DAEMON_SOCKET_PATH` | | env.ts 全文、direct.ts:120 |
| fan-out 上限 | — | 10 | cli/api/flags.ts:15 |

---

## 9. kobe 完整功能清单（Coolie 对标 checklist）

### 9.1 CLI 命令（用户可见）

| 命令 | 行为 | 出处 |
|---|---|---|
| `kobe` | 启动 TUI：默认 attach 进 tmux workspace；`KOBE_TUI=1` 启 Workspace Host | cli/index.ts:486-489, env.ts:43-51 |
| `kobe web [--port N]` | 浏览器 dashboard（同 daemon，任务双向同步） | usage.ts:21, README.md:104-113 |
| `kobe add [path]` / `kobe add --remote --host --user --path [--port] [--key\|--password]` | 保存 repo 进 picker（校验是 git repo）+ 建 main task + 自动收养已有 worktrees；--remote 注册 SSH 项目 | cli/index.ts:50-96 |
| `kobe remove [path]` | 忘记 saved project（非破坏，容错匹配：原文/toplevel/绝对路径） | cli/index.ts:119-186 |
| `kobe adopt [glob] [--repo] [--vendor] [--yes]` | 扫描/导入已有 git worktree 为任务；无 glob 是 dry-run | cli/index.ts:269-354 |
| `kobe export [--csv\|--json]` | 打印任务列表（无 daemon 依赖） | usage.ts:26 |
| `kobe repo <show\|set\|unset>` | 管理 per-repo init 脚本/首 prompt 覆盖 | usage.ts:27 |
| `kobe api <verb>` | 脚本化 RPC 面（见 9.2） | cli/api/verbs.ts |
| `kobe daemon <start\|stop\|status\|restart>` | daemon 管理 | cli/index.ts:421-425 |
| `kobe theme <list\|add\|remove>` | 用户主题管理 | usage.ts:30 |
| `kobe skill <install\|status\|command>` | 安装 kobe agent skill（教 Claude Code 用 kobe api） | usage.ts:31, README.md:124-128 |
| `kobe completions <bash\|zsh\|fish>` | shell 补全脚本 | cli/index.ts:382-386 |
| `kobe feedback` | 发 GitHub Discussions 反馈 | usage.ts:32 |
| `kobe update [target]` | 自更新 | usage.ts:33 |
| `kobe doctor` | 只读诊断 daemon/tmux/state | maintenance.ts:141-145 |
| `kobe reset [--hard] [--yes]` | 停 daemon+pty host+杀 tmux 会话；--hard 再删索引/UI 状态；永不删 worktree | maintenance.ts:314-411 |
| `kobe reload` | 原地重启所有会话的 Tasks/Ops pane（engine 不动，升级后用） | maintenance.ts:430-479 |
| `kobe kill-sessions` | 拆掉 kobe tmux server（dev 复位） | commands-tui.ts:163-181 |
| `kobe -v/--version`、`-h/--help` | 版本/帮助；未知命令报错退出（不落 TUI） | cli/index.ts:364-372,479-484 |
| 内部命令（tmux 绑定/hook 触发） | `new-chattab`、`engine-tab-exit`、`quick-create`、`focus-tasks`、`heal-layout`、`resync-window`、`capture-layout`、`layout --action <9种>`、`tasks`、`ops [--preview]`、`new-task`、`quick-task`、`settings`、`worktrees`、`help-page`、`update-page`、`history [--live]`、`hook`、`pty-host` | commands-tui.ts:104-451, cli/index.ts:426-470 |

### 9.2 `kobe api` verbs（agent 可脚本化面，`cli/api/verbs.ts:117-434`）

- 发现：`schema`（分级：默认紧凑索引 / `--verb` / `--group` / `--all`）
- 读：`list`、`get-task`（含 `.running`=tmux 存活）、`collect`（多任务对比快照：branch/running/未提交变更数）、`pty-list`
- 建：`add`（别名 `spawn-task`；带 `--prompt` 则物化 worktree+启 engine+投递）、`fan-out`（一个 prompt 并行 N 个任务，`--agents claude:2,codex:1`，上限 10）
- 驱动：`send`（tmux 粘贴一整轮 prompt）、`dispatch`（经 daemon `session.deliver` 通道投递，不碰 tmux）、`note`（上报 field note 给 dispatcher）、`set-active`
- 编辑：`rename`、`set-branch`、`set-vendor`、`set-status`
- 生命周期：`archive`、`pin`、`delete [--force]`
- worktree：`ensure-worktree`、`adopt`、`discover-adoptable`
- issues：`issue-list/create/set-status/update`；另有 `feedback`

### 9.3 tmux Handover 快捷键（默认 attach 模式；`docs/KEYBINDINGS.md:97-122`、`src/tmux/keybindings.ts:42-99`）

| 键 | 行为 |
|---|---|
| `ctrl+h/j/k/l` | 四方向 pane 焦点移动；边缘按下 no-op（不 wrap）；左边缘特例=恢复/聚焦 Tasks rail；zoom 时放行 |
| `ctrl+q` | 两段式：先聚焦 Tasks pane，再按一次 detach；surface 页 no-op |
| `ctrl+t` | 同引擎新 ChatTab |
| `ctrl+shift+t` / `prefix T` | 先选引擎再开 ChatTab（后者是不支持扩展键终端的兜底） |
| `ctrl+[` / `ctrl+]` | 上/下一个 ChatTab |
| `ctrl+w` | 关当前 ChatTab（最后一个受保护） |
| `F2` | 重命名 ChatTab |
| `prefix s / x / r` | 工作区临时 shell split（中列最多 4 pane）/ 关 split / 重置全部 split |
| `prefix a / o / z` | 隐藏恢复 Tasks rail / Ops pane / 终端 pane（进程保留） |
| `prefix space` | Zen：全部 ChatTab 折叠到 engine pane，会话级持久 |
| `prefix f` | prompt-only 快速建任务页（repo/引擎/base 从当前任务继承） |

### 9.4 Tasks pane 内（pane-local 字母键；`docs/KEYBINDINGS.md:120`、`src/tui/context/keybindings-sidebar.ts`）

`n` 新任务、`s` Settings、`x` worktree 管理页（跨项目审计+删除）、`u` 更新页（有新版时）、`o` 在编辑器打开 worktree、`t` 排序切换（default↔recent）、`a` 归档/取消、`d` 删除（脏树二次确认）、`r` 改标题、`b` 改 branch、`v` 换引擎、`?` 折叠键位图例、`[`/`]` Working↔Archives 视图、`/` 搜索（搜索时字母键自动降级为输入）、`ctrl+p` 项目过滤循环（经 `ui-prefs` 通道全会话同步）、`Right` 聚焦 engine pane、`Shift+M`+j/k 手动排序、`Shift+P` 置顶、`i` 只读实时预览（beta）、`g/G` 列表首尾、`j/k` 上下。归档/删除同时清理任务的 tmux session。

### 9.5 Workspace Host（`KOBE_TUI=1`）快捷键（`docs/KEYBINDINGS.md:14-33,455-479`、`CONTEXT.md:63-111`）

- 焦点：`ctrl+h/j/k/l` 直达（sidebar/workspace/files/workspace）、`F4` 前向循环、`ctrl+q` 回 sidebar（第二次退出）
- Terminal Tabs：`ctrl+t` 新 tab、`ctrl+e` 选引擎开 tab（shell 是一等 tab 类型）、`ctrl+w` 关 tab/split leaf（上下文相关；最后 tab 拒关）、`F2` 重命名 tab/leaf、`ctrl+]`/`ctrl+[` 循环
- Split：`ctrl+\` 右分、`ctrl+=` 下分（新 leaf 跑 shell）、`F3` leaf 焦点循环；leaf 退出 tmux 式塌缩
- `F5` 终端重置（确认门）、`F6` Zen（藏 Files 列）、`ctrl+pgup/pgdn` 本地回滚滚动、`F1` 帮助
- 其余一切（`shift+tab` plan-mode、`ctrl+r` 等）透传给 engine
- Tab 生命周期：engine 退出 → tab 原地降级为 shell（会话可 resume）；TUI 退出不杀会话（detachAll）；重启后死 engine tab 用 `--resume <sessionId>` 拉回（一次）

### 9.6 Settings（`settings-dialog/model.ts:28-68`）

六节：**General**（主题/语言 i18n/透明背景/焦点强调色/减少动效/split 样式/toast/声音/zen 保留 Tasks/settings 呈现面/编辑器选择+自定义命令/worktree 位置/scrollback 行数）、**Engines**（每引擎启动命令+显示名覆盖、添加 custom engine、codex effort）、**Accounts**（三家 binary+登录探测）、**Keybindings**（只读展示配置路径/已应用覆盖/加载警告）、**Feedback**（站内发反馈）、**Dev**（重置状态、重启 daemon）。

### 9.7 Ops pane（`CONTEXT.md:43-45`、`commands-tui.ts:425-450`、`src/tui/ops/`）

- FileTree 浏览 worktree + 精简文件/diff 查看器；Enter 把 `@<path>` 注入 engine pane（tmux send-keys）；`kobe ops --preview <rel>` 开全宽语法高亮预览窗
- 活动徽标（转录 mtime 轮询）
- **Create PR**（files pane `files.createPR`，keybindings-files.ts:93）：向 engine 注入结构化 PR prompt 模板（含 branch/target/dirty 数、`gh pr create --base` 步骤；模板可被 `<worktree>/.kobe/pr-instructions.md` 覆盖）（`src/tui/ops/pr-prompt.ts:15-33`）
- files pane 键：`j/k` 导航、`h/l` 折叠展开、`Enter` 打开、`[`/`]` 切 tab、刷新、外部打开、`@` mention（keybindings-files.ts）

### 9.8 后台自动化 / daemon 功能

- 自动标题（转录首条 user 消息，TUI 退出时 + daemon 轮询双路径）
- PR 状态收集器（Task.prStatus 徽标）、worktree 未提交变更计数、转录活动 → 各自通道推送
- 版本更新 chip（npm 检查，`src/version.ts`；不自动安装）
- engine-state 活动徽标（hook 事件驱动 + 轮询兜底）
- dispatcher/field-notes 知识路由（实验）、agent 状态自报 in_review（实验）
- repo init 脚本 + init prompt（launch 织入）
- 远程项目（实验 `experimental.remoteProjects`）：SSH ControlMaster 复用，worktree 建在远端 `<basePath>/.kobe/worktrees`，engine 经 ssh 包装启动（paths.ts:199-225、tmux-session-create.ts:81-96）
- 主题化 tmux chrome（状态栏/边框跟随 kobe 主题）、i18n（含中文，`src/tui/i18n/`）

---

## 10. 对 Coolie 的可借鉴点（按优先级）

1. **observe → decide → apply 三段式**（session-decision/session-layout 纯函数 + tmux.ts 应用者）：所有和真实 tmux/git 交互的策略都提炼成纯函数单测。Coolie 的 server 层直接复刻这个模式。
2. **懒 worktree + 自清理回滚 + slug 分配器**：`createTask` 只记意图、首次进入才落盘、slug commit 晚于 store 写、失败全回滚。这一整套是"绝不留孤儿目录"的完整答案（worktree-coordinator.ts）。
3. **单写者 daemon + 通道快照 + role 化 refcount**：Coolie 的 CS 架构里 server 就是这个 daemon；`role:"gui"` 持有生命周期 / `role:"pane"` 不持有的设计直接解决"CLI/面板连接不该阻止 server 退出"。
4. **engine 进程与 daemon 分离**（PTY Host 独立进程）：server 重启不杀 agent 会话是硬需求；kobe 用 ring buffer 重放 + OSC title 跟踪 + idle 自退，方案完整。
5. **Engine Registry 契约**：identity/capabilities/history/hooks/turn-detector/terminal-title 六件套 + custom engine 的"documented empty entry"。Coolie 对多 engine 的抽象可以照抄这份接口再加 opencode 的 DI。
6. **keymap 单表 + LIFO binding stack + modal barrier + YAML 覆盖**：满足 Coolie"丰富快捷键"需求的成熟结构；附带整套踩坑记录（ctrl+字母 > ctrl+数字/alt+数字、shift+字母不可表达、嵌入终端最大化透传+最小保留集）。
7. **prompt 投递细节**：bracketed paste + 150ms 延迟 Enter + 画面稳定检测；`send-keys -l --`；这类 tty 坑一次抄齐。
8. **Terminal Identity Boundary**：嵌入终端必须剥 `TERM_PROGRAM`。Coolie 走 Tauri 内嵌终端时同样适用。
9. **attach 前 fit + heal 防 reflow 闪烁**、布局 hook 自愈/捕获/防抖三件套：做 tmux 集成绕不开。
10. **`kobe api` 分级 schema + fan-out**：让 coding agent 自己驱动 orchestrator（配套 skill 分发），Coolie 的 CLI 面可对标。
11. **工程纪律**：500 行文件 cap、bug fix 必带回归测试、CONTEXT.md 严格词汇表（带 banned synonyms）、docs 即 source of truth——个人项目长期可维护性的低成本手段。
12. **repo init 契约**（`.kobe/init.sh` + `init-prompt.md` + watchdog + once-per-worktree 标记）：Coolie "干净开发环境脚手架"定位的核心机制，可直接采纳同名约定（换目录名）。

## 11. 风险与注意事项

- **tmux 是硬依赖**（默认路径），且深度绑定其语义（window/pane 选项、hook、format 展开）；kobe 为此付出了大量 heal/resync/capture 补丁代码。Coolie 若以 GUI(Tauri) 为主面、tmux 仅作持久层，可考虑直接走 kobe 的 PTY Host 路线（issue #16 的方向），tmux 层按需可选。
- **双栈并存的成本真实存在**：tmux Handover 和 Workspace Host 两套 tab/split/zen/键位语义要维持词汇与行为 parity（CONTEXT.md 里大量 "avoid" 条目就是管理这种混乱的代价）。Coolie 一开始就定 client=Tauri 可避开。
- **Bun + opentui 锁定**：`node-pty` 不能跑在 Bun 下（web sidecar 被迫用 Node），opentui 0.4.x 仍较年轻。Coolie server 用 TS 时注意运行时选型。
- **claude `--session-id`/`--append-system-prompt`/hooks 是 kobe 大量功能的挂载点**（窗口↔转录映射、auto-title、协议注入、活动徽标）；codex/copilot 没有等价物时功能自动降级（copilot 无 hooks、无 turn marker）。Coolie 做引擎抽象时要把"能力缺失时的降级路径"设计成一等公民（kobe 的 Noop/Unknown/EMPTY 模式）。
- **文档滞后点**：README 的引擎列表含 gemini（代码已删）；`<repo>/.claude/worktrees` 是 legacy 路径（README:85-89 仍写它）。以代码为准。
- **性能细节有讲究**：焦点切换不做全量 fsync（`touchRecency` 懒刷盘，core.ts:150-159）、observe 单次 tmux spawn、hook 计时器泄漏修复（hook-cmd.ts:36-47）——高频路径的 IO 成本在这种"每个键都可能 spawn 进程"的架构里会被放大。
- 未验证项：`kobe export`/`kobe theme`/`kobe skill`/completions 的具体实现细节（仅读了 usage 与入口分发）；web dashboard 的完整页面清单（仅读设计文档）；`docs/design/tasks.md`、`daemon.md` 全文未读。

## 12. 来源清单

- 本地代码库：`/Users/outman/workspace/ai/personal_ai/Coolie/refs/kobe`（upstream https://github.com/Sma1lboy/kobe ，npm `@sma1lboy/kobe@0.7.94`）
- 文档：`README.md`、`CONTEXT.md`（词汇表）、`CLAUDE.md`（操作手册/硬规则）、`docs/ARCHITECTURE.md`、`docs/KEYBINDINGS.md`、`docs/design/web-dashboard.md`
- 关键源码（均已通读）：
  - 任务域：`packages/kobe/src/types/task.ts`、`types/vendor.ts`、`orchestrator/core.ts`、`orchestrator/worktree-coordinator.ts`、`orchestrator/worktree/{manager,paths,slug-allocator}.ts`、`orchestrator/title.ts`
  - tmux：`src/tmux/{client,session-layout,session-decision,launch-line,keybindings,prompt-delivery}.ts`、`src/tui/panes/terminal/{tmux,tmux-session,tmux-session-create,chattab}.ts`、`src/tui/direct.ts`
  - engine：`src/engine/{registry,interactive-command}.ts`、`src/cli/hook-cmd.ts`（部分）
  - CLI：`src/cli/{index,usage,commands-tui,maintenance(部分)}.ts`、`src/cli/api/verbs.ts`
  - 状态/配置：`src/env.ts`、`src/state/repo-init.ts`、`src/state/repos.ts`（签名扫描）、settings-dialog model
  - daemon：`packages/kobe-daemon/src/daemon/{handlers-task,handlers-worktree,channels,paths}.ts`（grep 级扫描）

## 补充研究：诊断日志、导出与只读诊断（2026-07-11，为 Coolie 可观测性设计取证）

此前 §11 标注 `kobe export` 实现细节未验证，本节补齐（全部通读源码）：

### export（daemon-free 数据导出）
- `kobe export [--json|--csv|--format <json|csv|table>]`（`packages/kobe/src/cli/export-cmd.ts:1-70`）：**只读且不依赖 daemon**——进程内直接经 TaskIndexStore 读 `~/.kobe/tasks.json`（不重复解析，仍走 canonical owner），打印后退出。与 `kobe api list`（JSON-only、需 daemon 活着）互补，daemon 挂了也能导出。
- 输出契约：`--json`（默认，jq 可解析的数组）/ `--csv`（RFC-4180 风格带表头）/ `--format table`（对齐人读表）；**COLUMNS 常量是所有格式共用的单一字段真源**（id/title/status/archived/vendor/branch/repo/worktreePath，export-cmd.ts:42-58）；坏 flag → exit 2。
- 聚合的活状态导出走 `kobe api collect`（`src/cli/api/handlers-fanout.ts:54-95`）：按 `--task-ids` 或 `--repo` 收集每个任务的 `{status, running, changes:{added,deleted}}`——静态清单（export）与动态聚合（collect）刻意分开。

### 诊断日志（daemon.log / client.log）
- **两个 append-only 日志**：daemon detached spawn 时 stdout/stderr 重定向进 `~/.kobe/daemon.log`；TUI pane 进程（tasks/ops/gui…）写 `~/.kobe/client.log`（`packages/kobe-daemon/src/client/client-log.ts:1-50`）——pane 跑在 alternate-screen 里，stderr 会被 TUI 盖掉，不落盘就永远看不见（Tasks-pane 同步漂移事故正是这么漏掉的）。
- **大小上限轮转**（`packages/kobe-daemon/src/daemon/log-rotate.ts:1-46`）：默认 10MB，超限 boot 时 rename 成 `<path>.old` 只保一代；判定函数 `shouldRotateLog(sizeBytes, cap)` 抽成纯函数可单测。动机是真实事故 issue #26：无上限时孤儿 pane 重连刷屏把 client.log 写到 736MB、daemon.log 345MB。轮转失败吞掉不阻断启动。
- **写日志纪律**：fire-and-forget 异步 `appendFile`（O_APPEND 保证多进程并发写行原子），**绝不 `appendFileSync`**（call site 在 socket data handler 与重连退避环上，同步写会卡事件循环）；所有错误路径吞掉——日志失败绝不允许打死 pane。每行带 process role context + pid（`setClientLogContext`，多 pane 共写一文件仍可归因）。
- **crash net**（`packages/kobe-daemon/src/daemon/crash-log.ts:1-40`）：daemon 注册 `unhandledRejection`/`uncaughtException` handler——记录 ISO 时间戳 + kind + 完整 stack 到 daemon.log 后**继续服务**而非退程；理由：长命 RPC server 的每个请求相互独立，被一个野 promise 打死整个 daemon（且 stdio:ignore 时零痕迹"凭空消失"）是曾经的真实故障模式。

### doctor（只读诊断）
- `kobe doctor`（`src/cli/maintenance.ts:141-145`）：只读检查 daemon/tmux/state 三域健康，**绝不杀进程、绝不删文件**；与 `kobe reset`（修复性，但永不碰 worktree）职责分离。

### 对 Coolie 的直接启示
1. Coolie 的 events 表（SQLite）天生比 kobe 的内存通道快照更强（durable、seq 游标）——kobe 的 engine 事件只折叠进 last-value 通道不落盘，排查历史靠 daemon.log 文本。Coolie 应两者都要：结构化 events 表 + 文本诊断日志。
2. `coolie export` 应 daemon-free 直读 SQLite（readonly 打开），与需要 server 的 `GET /events` 互补——对应 kobe 的 export vs api list/collect 分工。
3. 日志三纪律照抄：10MB 轮转保一代、fire-and-forget append、crash net 记录不退程。
