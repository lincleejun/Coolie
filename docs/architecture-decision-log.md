# Coolie Architecture Decision Log

> 本文件是 append-only 的架构决策索引。实施中如果改变产品面、进程 ownership、持久化语义、测试门禁或多 worktree 集成协议，必须先追加或 supersede 一条记录。  
> 详细产品范围见 [`superpowers/specs/2026-07-15-coolie-v0.1.0-prd.md`](superpowers/specs/2026-07-15-coolie-v0.1.0-prd.md)。

## 状态词表

- **Proposed**：已提出，尚未成为实现约束。
- **Accepted**：当前实现和路线图必须遵守。
- **Superseded**：被后续决策替代，保留历史。
- **Rejected**：评估后不采用。

---

## AD-001 — 0.1.0 只交付 macOS Tauri 产品面

- **日期**：2026-07-15
- **状态**：Accepted

### Context

Coolie 当前有可构建的 Web client，但 0.1.0 的目标用户、原生能力、发行 blocker 和北极星旅程都集中在 macOS Tauri。继续同时维护 Web UI gate 会引入第二套 capability、连接和视觉验收面，稀释 0.1.0 的发行目标。

### Decision

- 0.1.0 只把 macOS Tauri 视为产品 UI 和发布面。
- 不扩展、不发布 Web client。
- 删除 `Web UI gate` / `bun run test:ui`，不建立 Playwright Web UI 门禁。
- 现有 Web build 可继续留在代码库，但不作为 0.1.0 DoD、release artifact 或阻断检查。

### Consequences

- UI 自动化必须驱动真实 Tauri test app，而不能以浏览器通过作为桌面正确性的替代。
- Web-specific regression 在 0.1.0 不承诺修复，除非同时影响共享 protocol/server/client core。
- 未来恢复 Web 产品面必须新增决策，重新定义认证、capability、发行和测试矩阵。

---

## AD-002 — 桌面 UI 自动化使用 WebdriverIO Tauri embedded provider

- **日期**：2026-07-15
- **状态**：Accepted

### Context

0.1.0 仍要求自动化 UI 验收，但已排除 Web UI gate。官方 `tauri-driver` 在 macOS 无外部 WKWebView driver；WebdriverIO Tauri embedded provider 可在 test app 内提供 WebDriver，并驱动真实 Tauri/WKWebView。

### Decision

测试分三层：

1. Vitest：pure state、parser、repository、HTTP contract。
2. WebdriverIO Tauri + mock daemon：主力 UI、keyboard、focus、error/offline journey。
3. WebdriverIO Tauri + real isolated daemon/tmux：关键 create、terminal、recovery、archive 闭环。

约束：

- webdriver plugins/capabilities 只进入 test binary/config。
- release binary 不包含 embedded WebDriver server。
- blocking UI gate 使用 role/name、focus、layout 和关键文本断言。
- transparent/vibrancy screenshot 只作失败 artifact，不作为像素级 blocking baseline。

### Consequences

- UI jobs 需要 macOS runner，执行成本高于 Chromium。
- mock daemon 与 real daemon profile 复用同一 Tauri suite，减少产品面漂移。
- CI 必须限制 real daemon/tmux 并发并做严格 teardown。

---

## AD-003 — 0.1.0 使用多任务、多 worktree 实施，验收后串行合回当前 main

- **日期**：2026-07-15
- **状态**：Accepted

### Context

0.1.0 路线图包含 protocol、DB migration、server、client、Tauri 和测试基础设施。直接在 main 并发实现会造成工作区污染、contract 冲突和无法归因的测试结果；这也违背 Coolie 自身“workspace 是委派单元”的产品模型。

### Decision

- 开工前先提交 PRD、roadmap 和本 decision log，形成 clean main baseline。
- 每个 roadmap Task 使用独立 Coolie task/worktree/branch。
- 没有依赖且不修改同一 shared contract/migration 的 Task 可以并行。
- Worker 只在自己的 worktree 修改、测试和提交，不直接修改或合并 main。
- Worker 完成后执行 `coolie collect <taskId>`，提交 diff、测试、风险和剩余事项，状态设为 `in_review`。
- Controller 在 task worktree 完成 review 和 acceptance；失败返回原 task 修复。
- 只有唯一 integrator 可以在 clean 当前 main 上串行执行：

```bash
coolie finish <taskId> --merge-back
```

- 合并冲突时停止并保留现场；禁止自动 reset、强推或跳过验收。
- 每个 Task 合入后运行受影响 gate；每个 Wave Checkpoint 运行完整 wave gate，随后 archive 已合入 workspace。

### Consequences

- 并行度受 shared protocol/migration contract 的串行地基限制。
- main 始终只接收已通过 task acceptance 的完整切片。
- 未通过的 branch/worktree 保持隔离，不允许部分 cherry-pick 绕过验收。
- 当前 main 脏时不得开始 merge-back；必须先处理 baseline 或用户修改。

---

## AD-004 — 0.1.0 保留 tmux session backend

- **日期**：2026-07-15
- **状态**：Accepted

### Context

最新 Kobe 已切换到 Hosted PTY，但 Coolie 当前 tmux backend 已提供 engine ownership、外部终端 attach、daemon/App restart 生存和 session heal。0.1.0 的主要风险是发行、状态一致性和 UI 验收，不是已被证据证明必须替换的 session backend。

### Decision

- 0.1.0 保留 dedicated tmux socket 与 terminal WS attach。
- 不实现 Hosted PTY migration。
- 优先修复 reconnect、archive 半状态、测试隔离和 sidecar packaging。
- 只有性能、内存、replay fidelity 或用户故障数据证明 tmux 无法满足目标时，才另立迁移 ADR。

### Consequences

- 0.1.0 继续依赖用户机器安装 tmux。
- Tauri real-daemon suite 必须覆盖 session restart/reattach/resize。
- Structured transcript 是 tmux 旁路的只读能力，不改变 engine process ownership。

