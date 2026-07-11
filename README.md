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
| `COOLIE_DISABLE_HOOKS` | `1` = 不注入 claude hooks | 注入 |
