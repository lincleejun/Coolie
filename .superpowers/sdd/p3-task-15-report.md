# Task 15 报告：README + 全量回归 + 手工 claude 冒烟

## 状态：DONE_WITH_CONCERNS

回归 100% 绿（232/232），README 已提交。手工冒烟中除 **`--prompt` 自动投递在 claude 首次冷启动时被静默吞掉**（复现 2/2 次）外，其余全部环节（tmux session、事件流、hooks 回调、tabs 状态机、WS 终端通道、`open`/`archive`/`unarchive`/`delete`、engine 归 tmux、清场）均通过。判定详情见下方 Step 2。

---

## Step 1：README

在 `README.md` 末尾（`## 排查与导出` 之后）追加 `## tmux 链路与 engine（M1 Plan 3）` 小节，内容与 brief 一致（能力要点 + 环境变量表）。

Commit：
```
e6adb1b docs: README Plan 3 (tmux/engine/WS/unix socket) + manual claude smoke results
 1 file changed, 18 insertions(+)
```

## Step 2：全量回归

```
$ bun install
Checked 110 installs across 157 packages (no changes)

$ bun run typecheck
$ tsc -b packages/protocol packages/server packages/cli
（无输出，退出码 0）

$ bun run test
 Test Files  32 passed (32)
      Tests  232 passed (232)
   Duration  7.35s
```
全绿，232/232，0 fail 0 skip。（注：`log.test.ts` 里一条 `uncaughtException boom` 是该用例主动抛错自测，非失败。）

零泄漏核查：
```
$ tmux -L coolie list-sessions 2>&1 | head -1
no server running on /private/tmp/tmux-501/coolie

$ ps aux | grep -E "tmux -L coolie-test|tmux attach" | grep -v grep
（空）
```

## Step 3：手工 claude 冒烟（真引擎）

隔离环境：
```
COOLIE_HOME=<scratch>/p3-smoke-home
COOLIE_WORKSPACES_ROOT=<scratch>/p3-smoke-ws
COOLIE_TMUX_SOCKET=coolie-smoke-90142
```
scratch repo：`<scratch>/p3-smoke-repo`（`git init` + 一个 init 提交）。

### 1. doctor
```
$ coolie server stop; coolie doctor
stopped
ok   home  <scratch>/p3-smoke-home
warn db    尚无数据库
warn server stopped
ok   log   尚无日志
ok   git   /usr/bin/git
ok   tmux  /opt/homebrew/bin/tmux
ok   claude /Users/outman/.local/bin/claude
```
git/tmux/claude 三行 ok（db/server 的 warn 是首次运行前的预期状态）。

### 2. create --prompt（**⚠ 发现问题**）

第一次：
```
$ coolie create <scratch>/p3-smoke-repo --slug smoke --prompt "say hi and stop"
created chile-torres (01KX9S26WVNS8BPZPFCEH21DZY) branch=coolie/smoke path=...
```
命令报告成功（未报「画面未稳定」错误）。`events tail` 显示 `engine.started`（23:44:06.665）→ `prompt.delivered`（23:44:07.388，chars=15，仅 **723ms** 后）。但 `tmux capture-pane` 持续观察 60 秒，claude TUI 一直停在初始欢迎屏，输入框 `❯ ` 全程为空——prompt 从未真正进入 claude。

按 brief 指引重试一次：`delete --force` → 重新 `create --slug smoke2 --prompt "say hi and stop"`。
```
created argentina-iguazu (01KX9S6ACG70M484322A1PCT7Z) branch=coolie/smoke2 ...
```
`engine.started`（23:46:21.296）→ `prompt.delivered`（23:46:21.715，仅 **419ms** 后）。同样地，`capture-pane` 显示欢迎屏，输入框依旧为空——**复现，2/2**。

**根因判断**：`waitStable` 在 claude 首启的过渡帧（如启动画面渲染前的短暂空白/间歇稳定态）上误判"已稳定"，过早（< 1s）执行 paste+Enter；此时 claude 的交互式 UI 尚未真正接管 stdin，按键被悄悄丢弃，但投递管线本身（sanitize→paste buffer→Enter）执行无异常，所以事件总线记了 `prompt.delivered` 成功——这是一个**误报**，程序判断与终端实况不一致。

**隔离验证**（证明 claude 引擎与 tmux session 本身完全正常，问题只在自动投递时机）：
```
$ tmux -L coolie-smoke-90142 send-keys -t coolie-01KX9S6ACG70M484322A1PCT7Z:0 "manual test after retry"
$ tmux -L coolie-smoke-90142 send-keys -t coolie-01KX9S6ACG70M484322A1PCT7Z:0 Enter
```
→ 文本立刻出现在输入框，claude 显示 "✳ Whisking…"，~9s 后完整回复：
```
⏺ 收到，会话正常工作。这是一个冒烟测试仓库（分支 coolie/smoke2，工作区干净，只有一个 init 提交），我这边工具和环境都已就绪。
  如果这只是重试后的连通性测试，那么测试通过 ✅。有具体任务的话，直接告诉我即可。
✻ Sautéed for 9s
```
后续所有步骤均基于这个手动送达的会话继续验证管线其余部分（tmux/事件/hooks/tabs/WS 全部为真实端到端）。

按任务指引：重试不超过两次、已达上限，不再循环，如实记录为 **DONE_WITH_CONCERNS**。这是 Step 5（waitStable 投递流水线）时机窗口在真实 claude 首启延迟下的一个真实时序缺陷，建议后续任务修复 `waitStable`/投递时机判定（例如要求稳定窗口内至少出现一次已知的"ready"锚点文本，而不仅是像素级不变）。

### 3. tmux sessions
```
$ tmux -L coolie-smoke-90142 list-sessions
coolie-01KX9S6ACG70M484322A1PCT7Z: 1 windows
coolie-ctl: 1 windows (attached)
```
`coolie-<wsId>` 与 `coolie-ctl`（惰性 spawn，因 step 2 的 --prompt 已触发过 sendKey）均存在，符合预期。

### 4. enter / TUI
`capture-pane` 已在上文验证：真 claude TUI 完整渲染（logo/tips/what's new/claude-mem SessionStart 注入等），手动送入消息后完整问答往返可见。

### 5. events tail
```
workspace.creating → workspace.tmux.created{sessionName} → tab.created{engine,claude} →
engine.started{sessionId,command} → prompt.delivered{chars:15} → workspace.created →
tab.status.changed{working,hook} → engine.turn.started →
tab.status.changed{awaiting-input,hook} → engine.turn.finished →
tab.title.changed{"manual test after retry"}
```
全部依次出现，**hooks 回环成功**（`engine.turn.started/finished` 由 claude POST 到 `/hooks/claude` 触发）。

### 6. tabs 状态 curl
```
$ curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/workspaces/<id>/tabs
[{"id":"...","status":"awaiting-input","title":"manual test after retry","lastHookAt":...}]
```
答毕后 `status=awaiting-input`，`title` 非空且为转录派生。（对话过程中的 `working` 态也已在 events 中确认过。）

### 7. WS 终端通道
```
$ bun -e '... new WebSocket(".../ws/terminal?workspace=<id>&window=0...")...'
WS OPEN
bytes received: 6457
```
3 秒内收到 6457 字节二进制 PTY 帧，通道工作正常。

### 8. server 归属 tmux
```
$ coolie server stop
stopped
$ tmux -L coolie-smoke-90142 has-session -t "=coolie-<id>"; echo $?
0
```
server 死后 session 仍在。随后 `coolie list`（触发自动重连 server）成功返回，`capture-pane` 确认画面无损。

### 9. archive / unarchive / delete
```
$ coolie archive <id> --force   → archived <id>
$ tmux has-session -t "=coolie-<id>"  → can't find session（已消失，分支保留）
$ coolie unarchive <id>         → unarchived <id>
$ coolie enter <id>
tmux session coolie-<id> 不存在（workspace 可能已归档/尚未创建，或 session 被外力清理；M1 不自动重建——Plan 4 ensure-or-heal）
$ coolie delete <id> --force     → deleted <id>
```
与 brief 预期完全一致（M1 不自动重建，Plan 4 才做 heal）。

### 10. 清场验证
```
$ coolie server stop  → stopped
$ grep -i error <home>/logs/server.log   → 空
$ tmux -L coolie-smoke-90142 ls
coolie-ctl: 1 windows   ← 惰性 hub 仍在（预期，不随 workspace 生命周期回收）
```
按任务要求显式 `kill-server` 兜底：
```
$ tmux -L coolie-smoke-90142 kill-server
$ tmux -L coolie-smoke-90142 ls
no server running on /private/tmp/tmux-501/coolie-smoke-90142
```
`kill-server` 后 socket 文件仍残留一个 0 字节 inode（tmux 已知行为，非 coolie 泄漏），手动 `rm` 清除，确认后 `ls`/`find` 均为空。

最终确认：
- `ps aux | grep coolie` → 空
- `tmux -L coolie-smoke-90142 ls` → no server running
- socket 文件已删除
- 真实 `~/.coolie` 全程未被创建
- 真实 `tmux -L coolie` 无 server（未被污染）
- 真实 `~/.claude/projects/` 下只多出该 smoke session 的转录目录（claude 自身认证/记录用途，只读，符合预期，未清理）

## Step 4：Commit

```
git commit -m "docs: README Plan 3 (tmux/engine/WS/unix socket) + manual claude smoke results"
```
（已在 Step 1 完成，见上方 commit hash。）

---

## 结论

- README、typecheck、测试全部 PASS。
- 手工冒烟发现一个真实、可复现（2/2）的时序缺陷：`--prompt` 自动投递在 claude 首次冷启动时可能被 `waitStable` 的过早稳定判定坑掉，导致内容对用户不可见（尽管事件总线记为成功）。这不是环境偶发抖动——是 waitStable/投递时机判定与 claude 真实首启行为不匹配的设计缺口，建议开一个后续任务修复（例如稳定窗口要求命中已知的 UI 锚点文本，而非仅像素不变）。
- 该缺陷不影响 tmux/事件/hooks/tabs/WS/生命周期/清场 等所有其余管线——这些环节在本次冒烟中均以真实 claude 端到端验证通过。

---

## 追加：冷启动吞字 bug 修复（fix commit `e1833d3`）

### 状态：FIXED（自动化回归绿；真实 claude 复测留待后续手工冒烟）

**Commit**：`e1833d3 fix(server): gate initial prompt on SessionStart hook readiness (cold-start swallow)`
（`packages/server/src/{config.ts,engine/bootstrap.ts,engine/claude/adapter.ts,engine/claude/hooks.ts,http/app.ts,tmux/delivery.ts}` +
`packages/server/test/{delivery.test.ts,bootstrap-prompt-gate.test.ts}`）

### 就绪门控如何工作

1. **SessionStart 进 hook 集合**：`engine/claude/hooks.ts` 的 `HOOK_EVENTS` 加入 `SessionStart`（claude TUI 真正 attach stdin 时触发）；`engine/claude/adapter.ts` 把它映射为 tab 状态 `awaiting-input`；`http/app.ts` 的 `/hooks/claude` 把它转成 `engine.session.started` 事件并落库+广播（EventsBus）。
2. **bootstrap 提前订阅、延后投递**：`engine/bootstrap.ts` 在起 tmux session **之前**（避免订阅延迟错过冷启动期打出的早期 hook）订阅 EventsBus，等一个属于本 workspace 的 hook 派生 `engine.*` 事件（排除 bootstrap 自己写的 `engine.started`）；投递前 `Effect.timeoutTo` 等到该信号或 `promptReadyTimeoutMs`（默认 20s，`CoolieConfig.promptReadyTimeoutMs` 可覆盖，测试用极小值练超时路径）超时。收到信号后用秒回参数投递（`minElapsedMs:0/stableFrames:2`）；超时或 hooks 不可用（假 engine/禁用 hooks）则落回 `deliverPrompt` 默认参数。监听器无论成功/失败/中断都经 `Effect.ensuring` 摘除，不留 EventsBus 泄漏。
3. **waitStable 强化兜底**：`tmux/delivery.ts` 的 `waitStable` 新增 `minElapsedMs`（默认 1500ms）、`stableFrames`（默认 3，下限钳 2）、且要求帧非空——单纯"两帧相等"在冷启动的瞬时空白稳定窗口会被误判，三者叠加后单看画面不再能在冷启动期间提前判定"稳定"。

### 测试

- `delivery.test.ts` 新增一对回归用例：pane 跑 `bash -c "read -t N -r d; exec cat"` 模拟"过渡期读者会吞掉早到输入，直到它超时让位给真正的 app"——旧语义参数（`minElapsedMs:0/stableFrames:2`）在窗口内投递→只回显一次（被吞，回归证据）；新默认参数撑过窗口→回显两次（tty echo + app 收到后自己回显，证明修复生效）。
- 新增 `bootstrap-prompt-gate.test.ts`：① hooks 能力开启时，手动模拟 `/hooks/claude` 落地（直接 `EventsRepo.append({type:"engine.session.started"})`，信号在过渡期读者窗口自然过期、reader 已换成 cat 之后才发出，如实对应生产里 SessionStart 只在 TUI 真接管后才触发的时序）→ 断言信号前 pane 无投递内容、信号后文本被真正的 app 收到（≥2 次回显）；② 信号永不到达时，短 `promptReadyTimeoutMs` 触发超时降级，仍靠强化 waitStable 兜底成功投递。
- 全量：`bun run test` 236/236 绿（既有 232 + 新增 4）；`tsc -b packages/protocol packages/server packages/cli` typecheck 无输出、退出 0；`ps aux | grep tmux` 确认无遗留 tmux server 进程（disposable sockets，各测试文件独立 `-L` socket + `afterAll kill-server`）。
- 未做的验证：真实 claude 手工冒烟复测（brief 明确注明本次修复不要求，留给后续手工 smoke 重跑确认）。

---

## 追加：门控上限跑赢真实 SessionStart 延迟 + 降级取证事件（fix follow-up）

### 状态：FIXED（自动化回归绿 239/239 + typecheck 0）

**背景（验收 forensics）**：`e1833d3` 的 20s 门控在真实 claude 上被证伪——`claude-mem` 插件首会话播种记忆使 SessionStart 实测 ~22.3s，门控早约 2s 超时误降级；降级落回 `waitStable`，它看到一个稳定非空的 claude-mem banner（≥1500ms/≥3 帧）就投递进一个 stdin 尚未 attach 的 TUI → prompt 被吞 2/2、无 transcript；events 显示 `prompt.delivered(21.8s)` 早于 `engine.session.started(22.3s)`。

### 改动

1. **门控上限抬到 90s**：`config.ts` 缺省 `promptReadyTimeoutMs` `20000 → 90000`，`COOLIE_PROMPT_READY_TIMEOUT_MS` 仍可覆盖（沿用文件既有 `Number(env ?? default)` 风格）。`bootstrap.ts` 的兜底常量 `DEFAULT_PROMPT_READY_TIMEOUT_MS` 同步对齐 90s（仅在 cfg 未注入时用，避免误导）。留足余量跑赢真实首启延迟。
2. **降级取证事件**：`bootstrap.ts` 在 gate 武装过（hooks 能力 + 有 prompt）却超时未等到信号（`ready` 存在且 `hookReady===false`）的分支，降级投递**之前**经 `EventsRepo.append`（同一套事务性 append）写一条 `prompt.delivery.degraded`，payload `{reason:"session-start-timeout", timeoutMs}`。信号路径（`hookReady===true`）与 hooks-less 引擎（`ready===undefined`，从未武装 gate）都不写此事件。降级后照常投递，信号路径不变。

### 测试（RED→GREEN）

- `config.test.ts`：新增 default `promptReadyTimeoutMs===90000` 与 `COOLIE_PROMPT_READY_TIMEOUT_MS` 覆盖两条（先 RED：默认仍 20000）。
- `bootstrap-prompt-gate.test.ts`：新增第 3 例——hooks 开启 + 信号永不发送 + 极短超时 → 断言 `prompt.delivery.degraded` 被写、payload 等于 `{reason:"session-start-timeout", timeoutMs:200}`、且其 `seq` 早于 `prompt.delivered`（取证事件排在投递前）。既有 2 例保持绿。

### 残留风险（brief 3c，不可解竞态）

晚到信号：若信号在极短门控超时**之后**、但 pane 的丢字窗口**仍开**时到达——今天的行为仍会吞字。这是「门控已放弃 + reader 尚未接管」的窄竞态，不在代码层强行消解（任何固定上限都可能被更慢的首启击穿）。缓解手段是把上限抬到 90s 使其在真实环境几乎不触发，并用 `prompt.delivery.degraded` 事件为剩余个案提供取证可见性（kobe：见到该事件即命中降级路径，无需靠 delivered/session.started 时序反推）。

### 验证

- 聚焦：`vitest run config.test.ts bootstrap-prompt-gate.test.ts` → 10 passed。
- 全量：`bun run test` → **Test Files 33 passed (33) / Tests 239 passed (239)**（既有 236 + 新增 3），Duration 8.81s。
- `bun run typecheck`（`tsc -b packages/protocol packages/server packages/cli`）无输出、退出 0。
- 无进程泄漏：各测试文件独立 disposable `-L` socket + `afterAll kill-server`；`ps aux | grep '[t]mux.*coolie-test'` 无遗留。
