# Coolie

coding agent 的干净开发环境伴侣（= repo + branch）。设计文档：`docs/superpowers/specs/2026-07-11-coolie-design.md`。

## 开发快速开始

```bash
bun install
bun run test          # 全部测试
bun run typecheck
```

## 试用（Plan 1 阶段能力）

```bash
bun x tsx packages/cli/src/main.ts project add ~/some/git/repo
bun x tsx packages/cli/src/main.ts project list
bun x tsx packages/cli/src/main.ts server status && bun x tsx packages/cli/src/main.ts server stop
```

## Workspace 生命周期（Plan 2 阶段能力）

```bash
# 创建（repo 路径未注册时自动注册项目；--slug 决定 branch 名 coolie/<slug>）
bun x tsx packages/cli/src/main.ts create ~/some/git/repo --slug fix-login
bun x tsx packages/cli/src/main.ts list                 # id/name/status/branch/path
bun x tsx packages/cli/src/main.ts archive <wsId>       # 删 worktree、留 branch（脏树需 --force）
bun x tsx packages/cli/src/main.ts unarchive <wsId>     # 从保留的 branch 重建
bun x tsx packages/cli/src/main.ts delete <wsId> --force # 删 worktree+记录，branch 永远保留
```

- worktree 落在 `~/coolie/workspaces/<repo>/<园名>`（`COOLIE_WORKSPACES_ROOT` 可覆盖）；目录名取自 national-parks 名池，生成后不变。
- 每个 workspace 分配 10 个端口（`$COOLIE_PORT_0..9`，40000 起步），setup script 可直接使用。
- setup script 三层合并：repo `.coolie/setup.sh`（可提交）→ `~/.coolie/projects/<projectId>/setup.sh`（本机覆盖）→ repo `.coolie/setup.local.sh`（本地 overlay，不入库）。
- gitignored 文件按 repo 根 `.worktreeinclude`（gitignore 语法，缺省 `.env*`）带入新 worktree。
- 创建失败自动回滚（不留半成品 worktree），workspace 落 `error` 态，可 `POST /workspaces/:id/retry` 重试。

### 事件流（SSE）

```bash
INFO=~/.coolie/server.json
curl -N -H "Authorization: Bearer $(jq -r .token $INFO)" \
  "http://127.0.0.1:$(jq -r .port $INFO)/events/stream?after=0"
# durable 回放 + live 推送；?workspace=<id> 过滤；15s 心跳注释行
```

## 排查与导出

```bash
bun x tsx packages/cli/src/main.ts doctor                        # 只读体检（home/db/server/tmux/git/claude）
bun x tsx packages/cli/src/main.ts export projects --format table
bun x tsx packages/cli/src/main.ts export events --json --after 0   # daemon-free，server 挂了也能导
bun x tsx packages/cli/src/main.ts events tail --follow          # 实时看事件流
```

server 数据在 `~/.coolie/`（`COOLIE_HOME` 可覆盖）；诊断日志在 `~/.coolie/logs/server.log`（10MB 自动轮转，保一代 `.old`）。

## tmux 链路与 engine（M1 Plan 3）

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

## Engine 抽象与 codex 接入（M2 Plan 1）

engine 经能力位（`EngineCapabilities`）与注册表抽象，**UI/调用方禁止硬编码 vendor 字符串**——引擎清单、模型、effort 档位一律由 `GET /config` 的 `engines[]` 下发。M2 Plan 1 起注册表含 `claude` 与 `codex` 两引擎（`GET /config` 下发全部）。

### 创建 codex workspace

- **REST（当前唯一显式选引擎入口）**：`POST /workspaces {projectId, engineId:"codex", initialPrompt}`——`engineId` 贯通 create 流水线（bootstrap 读 `ctx.engineId`）。
  ```bash
  INFO=~/.coolie/server.json
  curl -sX POST -H "Authorization: Bearer $(jq -r .token $INFO)" -H 'content-type: application/json' \
    -d '{"projectId":"<pid>","engineId":"codex","initialPrompt":"回答 PONG 两个字"}' \
    "http://127.0.0.1:$(jq -r .port $INFO)/workspaces"
  ```
- **GUI 引擎选择器**落 Plan 4；在此之前 GUI 的 Dispatch 默认取 `/config` 的 `engines[0]`（注册序 `claude` 在前 → 默认 claude）。
- **CLI**：`coolie create` 暂无 `--engine` 旗标（默认 claude）；选 codex 走上面的 REST。
- **`COOLIE_CODEX_CMD`** 是启动命令整体覆写 seam（原样使用、绝不追加 flag）——测试/调试用 `cat` 之类顶替真 binary。

### codex 与 claude 行为差异

| 维度 | claude | codex |
|---|---|---|
| session id 生命周期 | 客户端造 id：`launchCommand` 传 `--session-id <uuid>` | **服务端造 id**（`serverGeneratedId:true`）：bootstrap 起始存 `engineSessionId=null`，首个 `SessionStart` hook 经 `POST /hooks/codex` 回填真 UUIDv7（C4） |
| hooks trust 门 | 无（`seedFolderTrust` 预置 `~/.claude.json` 跳过 trust dialog） | **有**——双保险：① 起 session 前 `seedCodexTrust` 原子 UPSERT `config.toml` 的 `[projects."<realpath>"] trust_level="trusted"`（merge-only、幂等，实测有效——TUI 首启不再弹目录 trust 对话框）；② `launchCommand` **无条件**追加 `--dangerously-bypass-hook-trust`。**⚠ bypass-flag 结论被真机冒烟修正**：0.139.0 实测该 flag 只抑制 hook review 对话框，**不会激活未信任的 hooks**（详见下方「已知缺陷」） |
| 转录位置 | `~/.claude/...`（`COOLIE_CLAUDE_HOME`） | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*-<sessionId>.jsonl`（文件名内嵌 UUIDv7，日期树 newest-first 反查；`COOLIE_CODEX_HOME`） |
| effort 档位 | 无（`effort:false`，Noop） | `effort:true`，档位 `low`/`medium`/`high`/`xhigh`（`-c model_reasoning_effort=<档>`；`COOLIE_CODEX_MODELS` 只覆写 models，effort 档固定） |
| nativeQueue | `true`——TUI 原生 mid-turn 排队，忙时直投 | **`false`**——忙时（tab `working`）`POST /input {mode:"send"}` 返回 **409 `EngineBusy`**（Plan 1 无 server 端队列；`interrupt`/`interrupt-send`/`insert` 仍放行）。守卫是 Plan-1-only，代码含 REMOVAL MARKER，Plan 2 队列落地时删除该 if 块换 enqueue |
| resume | `claude --resume <sessionId>` | `codex resume <sessionId>` |
| 模型选择 | `default`/`opus`/`sonnet`/`haiku` | `gpt-5-codex`/`gpt-5`（`COOLIE_CODEX_MODELS` 逗号分隔覆写） |
| OSC title | engine 自写 | engine-owned；由 `-c tui.terminal_title=["activity","thread-title"]` 注入 |

- **per-engine monitor**：mtime 兜底轮询按 `tab.engineId` 解析引擎（`resolveEngine`）与 per-engine 转录目录（`homeFor`→`engineHome`），各引擎读各自 home，替代 M1 硬编码 `claudeHome`。codex 服务端造 id 期（`engineSessionId=null`）rollout 文件尚不存在、mtime 兜底跳过——此期状态设计上由 hooks 独家负责（该假设在 0.139.0 上不成立，见下）。
- **注入产物进 info/exclude**：codex 的 `.codex/hooks.json`（去 `PermissionRequest` 决策 hook，只留 `SessionStart`/`UserPromptSubmit`/`Stop` 观察事件）写入后随即 `git update-index` 排除，避免 isDirty 守卫误伤 archive/delete。

### ⚠ 已知缺陷：codex hooks 链路在 codex-cli 0.139.0 上不通（真机冒烟结论，2026-07-12）

真机冒烟（Task 12）证实 **Task 8 F3 的 bypass-flag 假设不成立**，codex 的 hooks→id 回填→徽标链路在 0.139.0 上全断，四个独立原因：

1. **`[features] hooks` 在 0.139.0 默认关**——不开则 hooks 完全不加载（`/hooks` 面板全 0）。Coolie 未 seed 此键。
2. **项目级 `<worktree>/.codex/hooks.json` 不被 0.139.0 发现**——即使 `features.hooks=true` 且目录已 trusted，`/hooks` 面板仍 Installed=0；只有用户级 `~/.codex/hooks.json` 被发现（官方文档描述的项目级发现应属更新版本）。
3. **`--dangerously-bypass-hook-trust` 不激活未信任 hooks**——它只抑制启动时的「Review hooks / Trust all / Continue without trusting」对话框；未信任 hook 依旧不跑（banner 原文「*Enabled* hooks may run without review」，enabled = 已 trust）。真正的信任在 `config.toml [hooks.state."<file>:<event>:<i>:<j>"] trusted_hash = "sha256:…"`（哈希算法未公开，非平凡不可预 seed）。
4. **即便 hooks 已信任，SessionStart 也不在 TUI 启动时执行**——实测延迟到首个 turn 才与 UserPromptSubmit/Stop 一起触发，故「`engine.session.started` 先于 `prompt.delivered`」的就绪门控在 0.139.0 上结构性不可达，首条 prompt 恒走 90s 超时降级（`prompt.delivery.degraded`，投递本身仍成功——codex composer 不吞字）。

**后果**：真机 codex 的 `engineSessionId` 永不回填（null）、徽标不流转、标题不派生。服务端链路本身健全——手工以 codex 同款 payload POST `/hooks/codex` 后，回填/`engine.session.started`/working↔awaiting-input 流转/rollout 标题派生/409 EngineBusy 全部按设计工作。修复（feature seed、用户级 hooks 或 trusted_hash 预置、`notify=[]` 兜底、就绪门控放宽）划入 M2 Plan 2。

### codex 环境变量

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `COOLIE_CODEX_HOME` | codex 数据目录（rollout 转录所在） | `~/.codex` |
| `COOLIE_CODEX_CONFIG` | trust 预置写入的 `config.toml` 路径 | 缺省回落 `<COOLIE_CODEX_HOME>/config.toml` |
| `COOLIE_CODEX_CMD` | engine 启动命令整体覆写（原样使用，测试/调试用） | 无（发现真 binary） |
| `COOLIE_CODEX_BIN` | codex 二进制显式路径 | 多路径自动发现（`/opt/homebrew/bin/codex` 等） |
| `COOLIE_CODEX_MODELS` | GUI 模型选择器选项（逗号分隔覆写） | `gpt-5-codex,gpt-5` |

> **零泄漏纪律**：测试**必须**同设 `COOLIE_CODEX_HOME` **和** `COOLIE_CODEX_CONFIG` 指临时目录。否则 `seedCodexTrust` 会写进真实 `~/.codex/config.toml`、转录 reader 会读真实 `~/.codex/sessions/`。真机冒烟（用真 codex binary、不设这两变量、seeding 落真实 `config.toml`）须先快照 `~/.codex/config.toml`、事后逐段还原——清单见 `docs/superpowers/plans/2026-07-12-coolie-m2-plan1-codex-adapter.md`。

## daemon 生命周期与自愈（M1 Plan 4）

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

## Client GUI（M1 Plan 5）

Tauri 2 + React 18 + xterm.js 6 桌面壳，纯 protocol 消费者（REST + WS 二进制 + SSE 三通道，绝不自己碰 git/tmux）。

```bash
bun install
cd packages/client && bunx tauri dev   # 自动发现/拉起 coolie-server（读 ~/.coolie/server.json）
# 等价：cd packages/client && bun run dev（package.json 的 "dev": "tauri dev"）
# 纯前端热更（不起 Tauri 壳）：bun run dev:vite；打包前端产物：bun run build:vite
```

- 左栏：project → workspace 两层列表；状态徽标（●工作中 ✓等输入 !错误 ○空闲）+ `+N−M`（server `git/diffstat` 端点 5s 轮询，client 无 git 访问）；搜索、pin 排序、归档区。
- 中央：xterm.js 6（WebGL 渲染，context loss 时回落 DOM canvas）挂 tmux window；tabs = engine / setup / run / shell；`↗ Open in iTerm2`（osascript attach 同一 tmux session）同画面逃生舱。**惰性挂载**：只有被看过的 tab 才建会话/WS，未看过的后台 tab 是零连接占位符；切走保活（只摘 DOM，scrollback/连接不丢）；workspace 归档/删除时其全部 tab 连接一并回收。
- Composer 三档：Enter 发送/排队（engine 忙时 `skipStable` 直投 claude nativeQueue）、⌘Enter 打断并发送、⌥Enter 仅插入、⇧Enter 换行；⌘. 打断；@文件（模糊排序 Enter 插入）、/命令（内置 + repo `.claude/commands` 扫描）、每 workspace 草稿（持久化，重启仍在）、模型选择器（切模型后 `/model` 补投，midSessionModelSwitch）。
- 快捷键：⌘N 新建（composer 变首条 prompt）、⌘T/⌘W 开关 shell tab、⌘1..9 跳 workspace、⌘[/⌘] 上/下一个 workspace、⌘L 聚焦 composer、⌘/ 快捷键表（cheatsheet）；终端聚焦时 Cmd 系全局键不进 PTY，Ctrl 系全透传（三层仲裁 + LIFO 注册表）。
- server 崩溃：SSE fetch 流指数退避（500ms→8s 封顶）+ `getInfo()` 自动重新拉起 daemon；offline 横幅 → 恢复即消；终端画面因 tmux 无损。GUI 的 SSE 连接带 `role=gui`（持有 server 惰性退出生命周期）。
- 依赖：macOS + tmux（首启 Rust 侧 `binary_on_path` 检测缺失即出 TmuxGuide 引导，装回 Recheck 通过）+ rustc/cargo（开发构建）。

新增 server 端点（本计划）：`GET /config`、`GET /workspaces/:id/git/{diffstat,changes}`、`GET /workspaces/:id/{files,commands}`；`POST /workspaces/:id/{tabs,input}`、`DELETE /workspaces/:id/tabs/:tabId`。全部经 loopback + Bearer 鉴权，CORS 放行 webview/vite-dev 跨源（token 是唯一安全边界）。

> M1 已知裁剪（controller 批准，M2 补）：附件/图片注入、⌘K 命令面板、用户 JSON 键位覆盖、footer cheatsheet 常驻条、右栏行级 diff 评论写回。Plan 4 契约点（lease `POST /clients {role:"gui"}`、engine Resume）在 Plan 4 未合并时按 404/501 静默降级。

GUI 手工冒烟清单（spec §十一 扩展版）与执行结果见 `docs/superpowers/plans/2026-07-11-coolie-m1-plan5-client.md` 末尾「冒烟记录」一节。
