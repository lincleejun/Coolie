# Coolie M2 Roadmap（codex 引擎接入 + 多引擎/注意力/写回闭环）

> **For agentic workers:** 本文件是 M2 的规划总纲（scope + carry-over 分诊 + plan 拆分 + 波次并行 + 完成标志），不含逐步实现代码。各 plan 的可执行细节见对应 `2026-07-12-coolie-m2-planN-*.md`，用 superpowers:writing-plans 格式逐任务落地。
>
> 依据：设计文档 `docs/superpowers/specs/2026-07-11-coolie-design.md` §十三（里程碑）、§六（Engine 抽象）、§7.1/7.2（右栏 diff 评论 / composer 队列）、§八（CLI fan-out / deep links）；codex 调研 `refs/research/codex.md`；M1 账本 `.superpowers/sdd/progress.md`。M1（Plan 1–5）已全部合入 main：monorepo + protocol + server 三通道 + tmux 链路 + claude adapter + client + lifecycle 四项 + CLI 基础集 + 可观测性三件套。

## 一、M2 Scope（spec §十三 逐字）

设计文档第 209 行原文：

> **M2**：codex adapter、fan-out、diff 行评论写回 PTY、deep links、通知与注意力管理、外部终端模式（per task）、主题/i18n、web client。

第 210 行「刻意不做」（M2 边界，防 scope 蔓延）：

> **刻意不做**：自渲染对话流（除非 M3+ 做 headless 兜底三档）、双 UI 栈、云端执行、SSH 远程（CS 架构下近乎免费，后置）。

**关键 scope 裁定（承 M1 账本，控制器已批）**：
- 「非 nativeQueue 的 server 端 prompt 队列」虽未在第 209 行字面出现，但 spec §7.2 明写「无原生队列的 engine 走 server 端 queue（turn detector 触发投递）」——codex `nativeQueue=false`（codex.md §9 能力矩阵：codex 无 headless 常驻双向流、无 mid-turn 原生队列），故该队列是 codex 接入的**直接派生需求**，归入 M2 Plan 2。
- 「用户键位覆盖（JSON）+ `⌘K` 命令面板 + footer cheatsheet」是 M1 明确削减、控制器批准的 M2 项（账本第 112 行「用户键位覆盖+⌘K+footer = M2 削减获批」），归入 Plan 4。
- 「附件/图片」（composer 图片存临时目录插路径，spec §7.2）M1 未做，归入 Plan 4（web client 与 composer 完成度一并）。
- **codex 驱动路径裁定（不可 violated 的 M1 原则延续）**：codex 与 claude 一样**跑原生 TUI 于 tmux window 0**，语义走 hooks + rollout mtime + notify 三路旁路（codex.md §1 路径三、kobe 三件套）。**不用 app-server、不用 `exec --json`**——那两条是「无头自渲染」，属 spec 明列的 M3+ 兜底，M2 不碰（spec §一原则 2、§十三刻意不做）。这条裁定是 Plan 1 的架构地基。

## 二、M1 Carry-over 分诊表

M1 五个 plan 合入 main 时留下的 deferred/carry-over（源：`.superpowers/sdd/progress.md` 终审段 + task brief）。每项在此分诊到 M2 具体 plan 或明确判为「不做/已闭」。

| # | Carry-over（M1 遗留） | 源 | 处置 | 落点 |
|---|---|---|---|---|
| C1 | `ws.ts:89` 终端输入 `data.toString("utf8")` 损坏非 UTF8 键序（应二进制透传） | P4 终审 M3 | **修**：`p.write(data)` 原样 Buffer 透传 | Plan 1 · Task 10 |
| C2 | `retry` 传 `{}` ctx → 预投递失败的 create 重试不补投 `--prompt`（也不带 engineId） | P4 终审 M4 | **修**：create 时持久化 initialPrompt+engineId，retry 从库回填 ctx | Plan 1 · Task 11 |
| C3 | `engine-exit` 两次写（setStatus + events.append）非单事务 | P4 终审 Minor | **修**：折进单 `db.transaction`（顺手，engine 运行时同域） | Plan 1 · Task 11 |
| C4 | hook 会话 id 回填仅在 `tab.engineSessionId !== null` 时触发 → 服务端造 id 的 codex 起始为 null 永不回填 | app.ts:232 现状 | **修**：stored 为 null 也回填（codex 先启动后回填 id 的核心接缝） | Plan 1 · Task 9 |
| C5 | `/hooks/claude` 路由 + `registry.get("claude")` 硬编码；`GET /config` 只下发 claude；`bootstrap.ts` 硬编码 `registry.get("claude")`；transcript home 硬编码 `cfg.claudeHome` | app.ts / bootstrap.ts 现状 | **改造为引擎无关**：generic `/hooks/:engine`、config 下发全部注册引擎、bootstrap 用 `ctx.engineId`、per-engine home | Plan 1 · Tasks 1–4 |
| C6 | 行级 diff（右栏 diff 行评论 → 消毒 → 写回 agent PTY，Superset 闭环） | spec §7.1「M2」 | **做**：M2 核心交互 | Plan 4 · 全程 |
| C7 | SSE-shutdown `closeAllConnections` 未被 `<1.5s` 断言钉死（2s 兜底遮蔽） | P4 Wave2 gate | **修**：加 `<1.5s` 断言真钉 closeAllConnections | Plan 2 · Task（daemon 生命周期同域） |
| C8 | `delivery.test.ts` 二进制不可 diff（改 `fromCharCode` 断言） | P3 Wave A Minor | **修**（cosmetic，顺手） | Plan 1 · Task 10（同碰 ws/二进制） |
| C9 | `bun install` 翻 `main.ts` mode 644→755 | P1 known nit | **判定不做**：已在 P3 Wave D 提交为 755（shebang+bin 目标），账本第 85 行「KEEP」；不回退 | 关闭 |
| C10 | runGit interrupt finalizer（仅当给 runGit 加 timeout 才需要）；query-param NaN 校验等 P1/P2 hygiene | P2/P3 账本 | **判定不做/已闭**：M1 未加 timeout，不触发；query 校验已在 P3 落地 | 关闭 |
| C11 | archive/delete 的 µs-window 409（status 读→改之间并发第二请求，TOCTOU 短窗回 409） | P4 终审 M1 | **explicit-defer**：µs 级窗、client 幂等重试即恢复、无数据损坏；观测到再收（若 Plan 2 daemon 生命周期加乐观锁则顺手闭） | 延后（Plan 2 若顺手则闭） |
| C12 | shell-tab create 的「tmux-op-then-DB」非原子（tmux 建窗成功但 DB 写失败 → 孤儿 tmux window） | P5 T3 评审 | **修**：与 C3 同法，tmux 副作用与 DB 写同一失败路径补偿（建窗失败回滚 DB / DB 失败 kill window）；shell-tab 与外部终端同域 | Plan 3（shell-tab / 外部终端域） |
| C13 | `claimServerInfo` 原子写 server.json 的 mid-write reader window（reader 读到半写/旧 token 短窗） | P4 终审 M2 | **修**：tmp+rename 已原子，补 reader 侧「读失败/字段缺 → 短退避重读」；与 daemon 生命周期同域 | Plan 2（daemon 生命周期域，同 C7） |
| P5-minors | P5 的 4 个 minor（账本 P5 终审列）：cosmetic 断言/日志措辞/注释 typo 类 | P5 终审 | **已闭**：已在 `@9219315` 提交修复，逐条 CLOSED，不带入 M2 | **关闭 @9219315** |
| N1 | 过长 `COOLIE_HOME` 致 unix socket 路径超限（`sun_path` ~104 字节静默截断/bind 失败） | M1 pre-acceptance 新发现 | **修**：启动时若 `<home>/coolie.sock` 路径超限 → **loud-fail**（明确报错含实际长度与上限）；`coolie doctor` 增一条 warn（路径接近上限提前告警） | Plan 2（doctor/可观测性同域；若 M1 pre-acceptance 前置验收需要则先落 loud-fail 单点） |
| N2 | 裸 Esc（bare-Esc）中断当前 turn 不触发 Stop hook → tab status 卡在 "working" 直到下一 turn | M1 pre-acceptance 新发现 | **修**：turn detector 侧兜底——rollout mtime 静默超 `IDLE_THRESHOLD` 已能把 working→awaiting-input（部分缓解）；根治需 codex 侧 interrupt 事件或 idle 收敛调参，与 turn detector / 注意力同域 | Plan 2（turn detector / 通知与注意力域） |

## 三、Plan 拆分（4 个 plan，各自独立可发布，依赖有序）

```
        ┌─────────────────────────────────────────────┐
Wave 0  │ Plan 1: codex adapter + 引擎无关运行时接缝     │  ← 地基，先落
        └───────────────┬─────────────────────────────┘
                        │ (config engines / registry / ctx.engineId / per-engine home / 队列能力位)
        ┌───────────────┼───────────────┬──────────────┐
Wave 1  │ Plan 2:       │ Plan 3:       │ Plan 4:       │  ← 文件不相交，可并行
        │ server queue  │ fan-out +     │ diff 行评论   │
        │ + 通知/注意力  │ deep links +  │ 写回 + 键位/  │
        │               │ 外部终端      │ ⌘K/主题/i18n  │
        │               │               │ + web client  │
        └───────────────┴───────────────┴──────────────┘
```

**Plan 1 — codex 引擎 adapter + 引擎无关运行时接缝**（本 roadmap 附带完整实现计划 `…-m2-plan1-codex-adapter.md`）：把 M1 为 codex 预留的 Engine 抽象接缝真正接通——generic `/hooks/:engine`、`GET /config` 下发全部引擎、`bootstrap`/`create` 走 `ctx.engineId`、per-engine 数据目录（`~/.codex`）、codex adapter（TUI-in-tmux + rollout 转录 reader + trust 预置 + hooks 旁路 + 服务端造 id 先启动后回填 + effort 档位）。顺带清 M1 引擎运行时 carry-over（C1/C2/C3/C4/C8）。**不含 UI**：验收经 CLI + fake/real codex 冒烟。独立可发布：main 从此能创建 codex workspace 并跑通 create→active→archive。

**Plan 2 — server 端 prompt 队列 + 通知与注意力管理**：codex `nativeQueue=false` → 忙时 composer 投递进 server 端队列，turn detector（`engine.turn.finished`）触发按序投递；composer「⏳ N 条排队中」可撤回 UI（spec §7.2）。叠加「通知与注意力管理」：turn-complete → OS 通知（codex `notify` 兜底 + claude Stop hook）、注意力路由（哪个 workspace 需要你）、GUI 未聚焦时的角标/横幅。清 C7（SSE-shutdown 钉死，daemon 生命周期同域）。依赖 Plan 1 的能力位（`nativeQueue`）与 turn detector 事件。

**Plan 3 — fan-out + `coolie://` deep links + 外部终端模式**：CLI `coolie create --agents claude:2,codex:1`（一个任务扇出到多引擎/多实例，spec §八）；`coolie://` deep link 标准 URL 结构（打开/聚焦 workspace、深链到 tab）；外部终端模式 per task（iTerm2 之外，用户配置的终端 app 直连 `tmux -L coolie attach`）。依赖 Plan 1 的多引擎 registry 与 `engineId` 贯通（fan-out 要能对不同引擎起 session）。

**Plan 4 — diff 行评论写回 PTY + client 完成度 + web client**：右栏 diff 行评论 → 消毒 → 写回 agent PTY 闭环（C6，spec §7.1，`@pierre/diffs` 许可复核）；M1 削减的 client 项——用户键位 JSON 覆盖、`⌘K` 命令面板、footer cheatsheet（HOTKEYS_REGISTRY 三处同源已在 M1 建好接缝）、附件/图片、主题/i18n；web client 壳（复用 M1 的 SSE/WS/REST 三通道 client，去 Tauri 特有面）。仅依赖 Plan 1 的 `/config` 多引擎下发做引擎标签；diff 写回复用 M1 composer→PTY 管道，无 Plan 1 强依赖，可在 Plan 1 config 接缝落地后即启动。**web client 是 Plan 4 内最大风险/工作量**，若超载可拆末段为 M2.5 跟进。

## 四、波次并行说明（承 M1 做法）

- **Wave 0 串行先行**：Plan 1 是所有多引擎工作的主干（config 下发引擎、registry、`ctx.engineId`、per-engine home、`nativeQueue` 能力位全在此落地）。Plan 2/3/4 都消费这些接缝，故 Plan 1 必须先合入 main。
- **Wave 1 三 plan 并行**：Plan 2（server/queue + client/composer 通知）、Plan 3（cli + server/http 路由 + client deep-link handler）、Plan 4（client/rightpanel + client/hotkeys + 新 web 包）文件基本不相交——像 M1 的 P4/P5 并行一样，可同时派计划作者 + 同时执行，各自独立 gate + 终审 + 合并。冲突面仅 `packages/protocol`（各 plan 新增自己的路由/事件词表，追加不改行）与 `packages/client/src/App.tsx`（Plan 2 通知横幅 vs Plan 4 主题壳——用 M1 P5 的「共享 App.tsx 串行段」纪律，或约定 Plan 4 后合并吸收）。
- **计划作者阶段可立即三线并行**：本 roadmap 定稿即可同时派 Plan 2/3/4 三个计划作者（各读 spec 对应节 + Plan 1 定稿接缝），无需等 Plan 1 执行完——它们只依赖 Plan 1 的**接口契约**（本 roadmap 与 Plan 1 文档已固定：`GET /config` engines 数组含 `{id,displayName,capabilities,models,efforts?}`、`ctx.engineId` 贯通、`/hooks/:engine`、`engineHome(id,cfg)`）。

## 五、完成标志（M2 Definition of Done）

- **codex 一等引擎**：GUI/CLI 均可选 claude 或 codex 创建 workspace；codex workspace 跑通 create→active→archive→unarchive→delete 全生命周期；codex TUI 在 tmux window 0 原生渲染、Open in iTerm2 里外同画面；hooks 旁路驱动徽标（●工作中/✓等输入/!错误/○空闲）、rollout mtime 兜底、服务端造的 id 先启动后经首个 SessionStart hook 回填、`--resume` 复活死会话、effort 档位（none/low/medium/high/xhigh）可选。真实 codex-cli 冒烟 2/2（session.started 先于 delivered、无 degraded、首条 prompt 无吞字）。
- **fan-out**：`coolie create --agents claude:2,codex:1` 一次创建 3 个 workspace（跨引擎），各自独立生命周期；`coolie://` deep link 打开/聚焦；外部终端模式可配置直连。
- **server 队列**：codex 忙时 composer 投递进队列，turn-complete 后按序自动投递；「⏳ N 条排队中」可撤回；claude 仍走原生 mid-turn 队列（能力位分流验证）。
- **通知与注意力**：turn-complete OS 通知、未聚焦角标、注意力路由到「需要你」的 workspace。
- **diff 行评论写回**：右栏 diff 选行评论 → 消毒 → 写回 agent PTY 闭环可用。
- **主题/i18n + web client**：主题切换、i18n 文案外置、web client 壳复用三通道跑通只读+投递。
- **M1 carry-over 清账**：C1–C8 全部落地或明确关闭（见分诊表）；`~/.coolie`/`~/.claude`/`~/.codex` 生产数据零污染（测试全走 `COOLIE_*_HOME` 临时目录，套件后真实文件字节级 diff 为空）。
- **回归**：全量 vitest 绿 + 双 typecheck 清洁 + 发版前 5 分钟人工终端 E2E 清单（claude + codex 双引擎 TUI 渲染、Cmd 快捷键、中文 IME、resize、WebGL context loss）。

## 完成标志：Roadmap 交付物

- 本文件（scope 逐字 + carry-over 分诊表 + 4-plan 拆分 + 波次并行 + DoD）。
- `2026-07-12-coolie-m2-plan1-codex-adapter.md`（首个 plan，完整 writing-plans 格式）。
- Plan 2/3/4 的计划文档待本 roadmap 定稿后并行派作者产出。
</content>
</invoke>
