# Coolie M1 Plan 5：Client GUI（Tauri 2 + React + xterm.js）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `packages/client`——Coolie 的 Tauri 2 桌面 GUI：左栏 project→workspace 列表、中央 xterm.js 终端 tabs（WS 二进制通道）、常驻 Composer（三档发送+打断）、右栏 Changes/Files、HOTKEYS_REGISTRY 三层键位仲裁、SSE 游标重连与 server 崩溃重拉起，完成 M1 全链路（spec §七 全部 + §五/§2.3/§十/§十二 的 client 侧）。

**Architecture:** GUI 是纯 protocol 消费者（spec §2.2）：控制面走 REST、终端字节走 WS 二进制帧、事件走 durable SSE（三通道不混用，§2.3）。PTY 全在 server 侧（tauri-terminal-poc 结论 b），Tauri 壳只做渲染 + 三个极小 Rust command（读 server.json / detached spawn / PATH 探测）。本计划含 **两个前置 server 任务**（Task 2/3）：client 消费所需但 server 尚缺的只读 git 端点与 composer 投递端点——这是"client 不许碰 git/PTY"原则下的唯一干净路径。

**Tech Stack:** Tauri 2（rustc 1.96 / cargo，macOS，`macOSPrivateApi` + window-vibrancy）；React 18 + TypeScript strict + Vite 6；zustand 5（opcode 验证过的轻状态方案）；`@xterm/xterm` 6 + addon-fit + addon-webgl（WebGL→canvas/DOM fallback）；bun 管包；vitest（纯逻辑单测 + 对真 server 的集成测试）。

## Global Constraints

（逐条抄自 spec，全部任务隐式遵守）

- **engine 进程只属于 tmux**：GUI 死不影响 engine；重连即恢复（§一.1）。client 绝不 spawn engine/PTY。
- **绝不自渲染 engine 对话流**（§一.2）；**绝不 scrape 终端画面**（§一.3）——GUI 状态只来自 tabs/events API。
- **三通道不混用**（§2.3）：REST 控制面 / WS 二进制帧（绝不塞 JSON 信封；控制帧除 resize/exit 外无他）/ SSE 事件。
- **UI 禁止硬编码 vendor 字符串**（§六）：engine 名称/能力/模型列表全部来自 server（`GET /config`），能力位缺失 = 控件 Noop 降级。
- **窗口质感**：`decorations:false + transparent + macOSPrivateApi + vibrancy` 自绘 titlebar；**Edit 菜单必须保留系统角色项**（否则 Cmd+C/V/A 全废，§7.1 + Tauri #2397 族）。
- **快捷键**：单一 `HOTKEYS_REGISTRY`；全局键约束在 Cmd 空间；终端焦点三层仲裁（Superset 原样）；其余按键全部透传（§7.3）。
- **server 运行时 Node**（§2.2）；client 包 TS strict（`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`，对齐 tsconfig.base）。
- macOS 打包（DMG/notarization/关 Sandbox）是 M2 事项；M1 交付 `tauri dev` 可跑的开发形态 + `cargo build` 通过。
- 提交纪律：每 task 尾 commit；消息用 conventional commits。

## 前置条件与并行约定（执行者必读）

1. **本计划在 `feat/m1-plan3-tmux-engine` 合并后执行**。SERVER API 真源 = `packages/protocol/src/routes.ts` + `domain.ts`；执行前先重读，确认与本文引用一致。
2. **Plan 4（daemon 强化）与本计划并行编写**。Plan 4 将新增：role 化 client lease（gui 持有 server 生命周期）、ensure-or-heal、engine keep-alive + resume API。本计划把这些消费点做成**容错 stub**并标注 `[Plan 4 contract — verify at execution]`：端点 404 时优雅降级，Plan 4 合并后按其实际 API 替换。全文共 3 处：Task 4 lease、Task 10 attach 失败 ensure、Task 11 Resume 按钮。
3. Task 2/3 改 `packages/server`/`packages/protocol`。若执行时发现 app.ts 行号漂移（Plan 3 收尾修复所致），以文中给出的**锚点代码**定位，不按行号。

## File Structure（新增/修改总览）

```
packages/protocol/src/routes.ts                 [修改] +8 路由（Task 2/3）
packages/server/src/git/inspect.ts              [新建] diffstat/changes/files（Promise 版只读 git）
packages/server/src/engine/claude/commands.ts   [新建] slash command 目录扫描
packages/server/src/engine/claude/adapter.ts    [修改] export claudeModels
packages/server/src/tmux/service.ts             [修改] +killWindow
packages/server/src/tmux/ops.ts                 [新建] ComposerOps（input 四模式/新窗/杀窗）
packages/server/src/repo/tabs.ts                [修改] +remove(id)
packages/server/src/http/app.ts                 [修改] CORS + 8 条新路由
packages/server/src/main.ts                     [修改] 注入 gitRead/composerOps/config
packages/client/                                [全新] 第 5 个 workspace 包
  package.json / tsconfig.json / vite.config.ts / index.html
  src-tauri/{Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, src/main.rs}
  src/main.tsx / App.tsx / styles.css / env.d.ts
  src/api/{client.ts, sse.ts, discovery.ts, lease.ts}
  src/stores/{types.ts, data.ts, ui.ts}
  src/hotkeys/{registry.ts, dispatch.ts, useGlobalHotkeys.ts}
  src/terminal/{arbitrate.ts, session.ts, Terminal.tsx, TabsBar.tsx}
  src/composer/{send.ts, drafts.ts, fuzzy.ts, Composer.tsx, Picker.tsx, Dispatch.tsx}
  src/sidebar/Sidebar.tsx
  src/rightpanel/RightPanel.tsx
  src/chrome/{Titlebar.tsx, TmuxGuide.tsx, Cheatsheet.tsx}
  test/*.test.ts（纯逻辑单测 + api 集成测试）
package.json（根）                               [修改] typecheck 追加 client
README.md                                       [修改] Task 16
```

每个文件一个职责：`arbitrate.ts`/`send.ts`/`fuzzy.ts`/`sse.ts`（解析器与退避）是**纯函数模块**——vitest 直接测；React 组件只做接线，不进单测（GUI 用 Task 16 人工冒烟覆盖，M1 不做 WebDriver）。

---

### Task 1: Tauri 2 scaffold + cargo build 去险

`packages/client` 骨架：Vite + React + TS strict 前端，src-tauri 壳（自绘窗口所需全部配置 + 3 个 Rust command + Edit 菜单系统角色）。本任务结束时 `cargo build` 与 `bun run typecheck`、`vite build` 全绿——Rust 工具链风险第一时间出清。

**Files:**
- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`
- Create: `packages/client/vite.config.ts`
- Create: `packages/client/index.html`
- Create: `packages/client/src/env.d.ts`
- Create: `packages/client/src/main.tsx`
- Create: `packages/client/src/App.tsx`（占位，Task 8 重写）
- Create: `packages/client/src/styles.css`（基础层，后续任务追加）
- Create: `packages/client/src-tauri/Cargo.toml`
- Create: `packages/client/src-tauri/build.rs`
- Create: `packages/client/src-tauri/tauri.conf.json`
- Create: `packages/client/src-tauri/capabilities/default.json`
- Create: `packages/client/src-tauri/src/main.rs`
- Create: `packages/client/src-tauri/.gitignore`
- Modify: 根 `package.json`（typecheck 脚本）

**Interfaces:**
- Produces（Rust commands，后续任务经 `invoke` 调用）：
  - `read_server_info() -> Option<String>`（`$COOLIE_HOME|~/.coolie/server.json` 原文，不存在返回 null）
  - `spawn_detached(program: String, args: Vec<String>) -> Result<(), String>`（新进程组 detached spawn）
  - `binary_on_path(name: String) -> bool`（GUI 极简 PATH + homebrew 常见目录探测）
- Produces（构建期常量）：`__COOLIE_SERVER_CMD__: string`（NUL 分隔的 daemon 启动命令，vite define 注入）

- [ ] **Step 1: 写 client 包清单与 TS 配置**

`packages/client/package.json`：

```json
{
  "name": "@coolie/client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tauri dev",
    "dev:vite": "vite",
    "build:vite": "vite build",
    "tauri": "tauri"
  },
  "dependencies": {
    "@coolie/protocol": "workspace:*",
    "@tauri-apps/api": "^2.9.0",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-webgl": "^0.20.0",
    "@xterm/xterm": "^6.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.9.0",
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

（若 `bun install` 对某个版本报 no matching version，用 `bun add <pkg>` 让 bun 解析与 xterm 6 兼容的最新版，**不要**降 xterm 到 5.x。）

`packages/client/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "node"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`verbatimModuleSyntax` 是刻意的：强制 `import type`，保证 `@coolie/protocol`（依赖 effect）只以类型形态进 client，**零运行时 effect 字节进 bundle**。

`types: ["vite/client", "node"]` 必须含 `node`：`vite.config.ts` 用 `node:path`/`node:url`/`import.meta.url`，test 文件用 `process.env`/`__dirname` 等 node 全局——只留 `vite/client` 会让 `tsc --noEmit -p packages/client`（Step 6 及后续每个"typecheck 绿"关卡）报 `Cannot find name '__dirname'/'process'`。对应 devDependencies 加 `@types/node`（node 全局类型）与 `vitest`（test 文件 `describe/it/expect` 导入源）。

- [ ] **Step 2: vite.config.ts（含 daemon 启动命令的构建期注入）**

`packages/client/vite.config.ts`：

```ts
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../..")
// GUI 拉起 daemon 的默认命令（开发形态）：与 CLI ensureServer 同一目标（tsx + server main.ts start）。
// 空格分隔（discovery.ts split(" ") 对应）；依赖 checkout 路径无空格——有空格时两侧同步换分隔符。
// 打包形态（M2）改为随 app 分发的 coolie-server 入口。
const serverCmd = [
  path.join(repoRoot, "node_modules/.bin/tsx"),
  path.join(repoRoot, "packages/server/src/main.ts"),
  "start",
].join(" ")

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", target: "es2022" },
  define: { __COOLIE_SERVER_CMD__: JSON.stringify(serverCmd) },
})
```

`packages/client/src/env.d.ts`：

```ts
/// <reference types="vite/client" />
declare const __COOLIE_SERVER_CMD__: string
```

- [ ] **Step 3: 前端入口三件套**

`packages/client/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Coolie</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/client/src/main.tsx`：

```tsx
import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

`packages/client/src/App.tsx`（Task 8 重写，此处仅证明链路通）：

```tsx
export const App = () => <div className="app-boot">Coolie client scaffold OK</div>
```

`packages/client/src/styles.css`（基础层；后续任务在文件尾**追加**各自区块，不改本段）：

```css
/* === base (Task 1) === */
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: rgba(30, 30, 34, 0.72);
  --panel: rgba(255, 255, 255, 0.04);
  --border: rgba(255, 255, 255, 0.09);
  --fg: #e6e6e9;
  --fg-dim: #9a9aa3;
  --accent: #7aa2f7;
  --danger: #f7768e;
  --ok: #9ece6a;
  --warn: #e0af68;
  --titlebar-h: 38px;
}
html, body, #root { height: 100%; }
body {
  font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 13px;
  color: var(--fg);
  background: transparent; /* vibrancy 透出 */
  overflow: hidden;
  user-select: none;
  cursor: default;
}
input, textarea { user-select: text; cursor: text; }
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
.app-boot { padding: 40px; }
```

- [ ] **Step 4: src-tauri 壳**

`packages/client/src-tauri/Cargo.toml`：

```toml
[package]
name = "coolie-client"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
window-vibrancy = "0.6"

[profile.dev]
incremental = true
```

`packages/client/src-tauri/build.rs`：

```rust
fn main() {
    tauri_build::build()
}
```

`packages/client/src-tauri/tauri.conf.json`：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Coolie",
  "version": "0.1.0",
  "identifier": "app.coolie.client",
  "build": {
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "bun run dev:vite",
    "frontendDist": "../dist",
    "beforeBuildCommand": "bun run build:vite"
  },
  "app": {
    "macOSPrivateApi": true,
    "windows": [
      {
        "label": "main",
        "title": "Coolie",
        "width": 1440,
        "height": 900,
        "minWidth": 980,
        "minHeight": 600,
        "decorations": false,
        "transparent": true
      }
    ],
    "security": { "csp": null }
  },
  "bundle": { "active": false }
}
```

（CSP null：client 要连动态端口的 `http://127.0.0.1:*` 与 `ws://127.0.0.1:*`，M1 本地个人工具接受；打包版收紧是 M2 事项。`bundle.active:false`：M1 不出包。）

`packages/client/src-tauri/capabilities/default.json`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-start-dragging"
  ]
}
```

`packages/client/src-tauri/.gitignore`：

```
target/
gen/schemas/
```

`packages/client/src-tauri/src/main.rs`：

```rust
// Coolie client 壳：刻意最小化——PTY/git/引擎全在 coolie-server（spec §2.1、tauri-terminal-poc 结论 b）。
// Rust 只承担 webview 做不到的三件事：读 server.json、detached spawn daemon、PATH 探测 tmux。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::Manager;

fn coolie_home() -> PathBuf {
    match std::env::var("COOLIE_HOME") {
        Ok(h) if !h.is_empty() => PathBuf::from(h),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".coolie"),
    }
}

#[tauri::command]
fn read_server_info() -> Option<String> {
    std::fs::read_to_string(coolie_home().join("server.json")).ok()
}

#[tauri::command]
fn spawn_detached(program: String, args: Vec<String>) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // 新进程组：GUI 退出不连坐 daemon（kobe 所有权分离）
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("spawn {program} failed: {e}"))
}

#[tauri::command]
fn binary_on_path(name: String) -> bool {
    // GUI 进程 PATH 极简（opcode claude_binary.rs 教训）：先查常见安装目录，再扫 PATH
    let candidates = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    if candidates.iter().any(|d| std::path::Path::new(d).join(&name).exists()) {
        return true;
    }
    std::env::var("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(&name).exists()))
        .unwrap_or(false)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_server_info, spawn_detached, binary_on_path])
        .setup(|app| {
            let win = app.get_webview_window("main").expect("main window");
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let _ = apply_vibrancy(&win, NSVisualEffectMaterial::Sidebar, None, None);
            }
            // Edit 菜单保留系统角色项：否则 WKWebView 里 Cmd+C/V/X/A 全废（Tauri #2397/#11422 族，spec §7.1）
            let app_menu = Submenu::with_items(
                app,
                "Coolie",
                true,
                &[
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&app_menu, &edit_menu])?)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running coolie client");
}
```

（注意：**不注册 Cmd+W/Cmd+N 等菜单 accelerator**——全局键统一走 JS 侧 HOTKEYS_REGISTRY（Task 7），菜单只保留系统角色，避免菜单/JS 双份真源。）

- [ ] **Step 5: 根 typecheck 接入 client**

修改根 `package.json` 的 scripts（只改这一行）：

```json
"typecheck": "tsc -b packages/protocol packages/server packages/cli && tsc --noEmit -p packages/client"
```

- [ ] **Step 6: 安装依赖并验证三条构建链**

```bash
cd /path/to/Coolie && bun install
bun run typecheck
cd packages/client && bunx vite build
cd src-tauri && cargo build
```

Expected：四条命令全部 exit 0。`cargo build` 首次约 2-5 分钟（tauri 全量编译）。若 `window-vibrancy 0.6` 与 tauri 2 版本冲突，`cargo add window-vibrancy` 取最新兼容版。

- [ ] **Step 7: 冒烟 tauri dev（可选但推荐）**

```bash
cd packages/client && bunx tauri dev
```

Expected：出现无系统 titlebar 的毛玻璃窗口，显示 "Coolie client scaffold OK"。验证 Cmd+Q 可退出。关闭。

- [ ] **Step 8: Commit**

```bash
git add packages/client package.json bun.lock
git commit -m "feat(client): Tauri 2 + Vite + React scaffold（自绘窗口/vibrancy/Edit 系统角色/3 个 Rust command）"
```

---

### Task 2: Server 只读端点（config / diffstat / changes / files / commands）+ CORS

**Client-only 范围的两个 justified exception 之一**（file-scoped、test-first）。GUI 需要而 server 缺失的只读面：左栏 `+N−M`（`git diff --shortstat`——已核实 server 无此端点）、右栏四分区、@文件列表、/命令扫描、tmux socket 名（Open in iTerm2 拼命令用）。同时补 **CORS**：webview/vite-dev 是跨源 origin，不加 CORS 三通道里 REST 与 SSE 全部被浏览器拦死（token 仍是唯一安全边界，CORS 只是放行浏览器）。

**Files:**
- Create: `packages/server/src/git/inspect.ts`
- Create: `packages/server/src/engine/claude/commands.ts`
- Modify: `packages/server/src/engine/claude/adapter.ts`（尾部 + export claudeModels）
- Modify: `packages/protocol/src/routes.ts`（+5 路由）
- Modify: `packages/server/src/http/app.ts`（CORS + 5 路由 + AppDeps 扩展）
- Modify: `packages/server/src/main.ts`（注入 gitRead/config）
- Test: `packages/server/test/git-inspect.test.ts`
- Test: `packages/server/test/http-gitread.test.ts`

**Interfaces:**
- Produces（HTTP，client Task 4+ 消费）：
  - `GET /config` → `{ tmuxSocket: string, engines: Array<{ id, displayName, capabilities: EngineCapabilities, models: string[] }> }`
  - `GET /workspaces/:id/git/diffstat` → `{ filesChanged: number, insertions: number, deletions: number }`（vs baseRef，含未提交）
  - `GET /workspaces/:id/git/changes` → `{ againstBase: FileChange[], committed: FileChange[], staged: FileChange[], unstaged: FileChange[], untracked: string[] }`，`FileChange = { path, insertions, deletions }`
  - `GET /workspaces/:id/files` → `{ files: string[] }`（tracked + untracked 非 ignored，路径相对 worktree）
  - `GET /workspaces/:id/commands` → `{ commands: Array<{ name: string, source: "repo" | "user" }> }`
  - 非 active workspace 一律 409 Conflict；OPTIONS 预检 → 204 + CORS 头；所有响应带 `Access-Control-Allow-Origin: *`
- Produces（代码，Task 3 复用模式）：`AppDeps.gitRead?: GitReadOps`、`AppDeps.config?: { tmuxSocket: string }`

- [ ] **Step 1: 写 inspect 纯解析器的失败测试**

`packages/server/test/git-inspect.test.ts`：

```ts
import { describe, it, expect, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { parseShortstat, parseNumstat, diffShortstat, collectChanges, listFiles } from "../src/git/inspect.js"

describe("parsers", () => {
  it("parseShortstat: 完整行", () => {
    expect(parseShortstat(" 3 files changed, 42 insertions(+), 7 deletions(-)\n"))
      .toEqual({ filesChanged: 3, insertions: 42, deletions: 7 })
  })
  it("parseShortstat: 只有 insertions / 空输出", () => {
    expect(parseShortstat(" 1 file changed, 2 insertions(+)\n"))
      .toEqual({ filesChanged: 1, insertions: 2, deletions: 0 })
    expect(parseShortstat("")).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
  })
  it("parseNumstat: 普通/二进制（- → 0）", () => {
    expect(parseNumstat("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n")).toEqual([
      { path: "src/a.ts", insertions: 12, deletions: 3 },
      { path: "logo.png", insertions: 0, deletions: 0 },
    ])
  })
})

describe("against real repo", () => {
  let repo: string, base: string
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-inspect-"))
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" })
    git("init", "-b", "main")
    git("config", "user.email", "t@t"); git("config", "user.name", "t")
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n")
    git("add", "."); git("commit", "-m", "base")
    base = git("rev-parse", "HEAD").trim()
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n")       // unstaged 改动
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n")            // untracked
  })
  it("diffShortstat 统计 vs base（含未提交）", async () => {
    const s = await diffShortstat(repo, base)
    expect(s.filesChanged).toBe(1)
    expect(s.insertions).toBe(1)
  })
  it("collectChanges 四分区 + untracked", async () => {
    const c = await collectChanges(repo, base)
    expect(c.unstaged.map((f) => f.path)).toContain("a.txt")
    expect(c.untracked).toContain("b.txt")
    expect(c.staged).toEqual([])
    expect(c.committed).toEqual([])
  })
  it("listFiles: tracked + untracked、不含 ignored", async () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n")
    fs.writeFileSync(path.join(repo, "ignored.txt"), "x\n")
    const files = await listFiles(repo)
    expect(files).toContain("a.txt")
    expect(files).toContain("b.txt")
    expect(files).not.toContain("ignored.txt")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run packages/server/test/git-inspect.test.ts`
Expected: FAIL（`Cannot find module '../src/git/inspect.js'`）

- [ ] **Step 3: 实现 inspect.ts**

`packages/server/src/git/inspect.ts`：

```ts
/**
 * 只读 git 观察面（GUI 左栏 diff 计数 / 右栏 Changes / @文件列表）。
 * Promise 版而非 Effect：这些端点无写操作、无回滚语义，http 路由直接 await + try/catch 映射 GitError 即可，
 * 不值得为其扩 AppServices union（避免波及全部既有 http 测试的 runtime 类型）。
 */
import { execFile } from "node:child_process"

export interface DiffStat { filesChanged: number; insertions: number; deletions: number }
export interface FileChange { path: string; insertions: number; deletions: number }
export interface ChangesReport {
  againstBase: FileChange[]; committed: FileChange[]
  staged: FileChange[]; unstaged: FileChange[]; untracked: string[]
}

const run = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} 失败：${String(stderr || error.message).trim()}`))
      else resolve(stdout)
    })
  })

export const parseShortstat = (out: string): DiffStat => ({
  filesChanged: Number(out.match(/(\d+) files? changed/)?.[1] ?? 0),
  insertions: Number(out.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
  deletions: Number(out.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
})

/** numstat 行：`ins\tdel\tpath`；二进制为 `-\t-\tpath` → 0/0（M1 不标 binary 位） */
export const parseNumstat = (out: string): FileChange[] =>
  out.split("\n").filter((l) => l !== "").map((l) => {
    const [ins, del, ...rest] = l.split("\t")
    return {
      path: rest.join("\t"),
      insertions: ins === "-" ? 0 : Number(ins),
      deletions: del === "-" ? 0 : Number(del),
    }
  })

export const diffShortstat = (worktree: string, baseRef: string): Promise<DiffStat> =>
  run(worktree, ["diff", "--shortstat", baseRef]).then(parseShortstat)

export const collectChanges = async (worktree: string, baseRef: string): Promise<ChangesReport> => {
  const [againstBase, committed, staged, unstaged, untrackedRaw] = await Promise.all([
    run(worktree, ["diff", "--numstat", baseRef]),          // base vs 工作树（总账）
    run(worktree, ["diff", "--numstat", baseRef, "HEAD"]),  // base 之后已提交的
    run(worktree, ["diff", "--numstat", "--cached"]),       // 已暂存
    run(worktree, ["diff", "--numstat"]),                   // 未暂存
    run(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ])
  return {
    againstBase: parseNumstat(againstBase),
    committed: parseNumstat(committed),
    staged: parseNumstat(staged),
    unstaged: parseNumstat(unstaged),
    untracked: untrackedRaw.split("\0").filter((s) => s !== ""),
  }
}

export const listFiles = (worktree: string): Promise<string[]> =>
  run(worktree, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .then((out) => out.split("\0").filter((s) => s !== ""))

export interface GitReadOps {
  diffstat(worktree: string, baseRef: string): Promise<DiffStat>
  changes(worktree: string, baseRef: string): Promise<ChangesReport>
  files(worktree: string): Promise<string[]>
}
export const realGitRead: GitReadOps = { diffstat: diffShortstat, changes: collectChanges, files: listFiles }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bunx vitest run packages/server/test/git-inspect.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: slash command 扫描 + claudeModels 导出**

`packages/server/src/engine/claude/commands.ts`：

```ts
import * as fs from "node:fs"
import * as path from "node:path"

export interface SlashCommand { name: string; source: "repo" | "user" }

/** 扫描 .md 命令文件（含子目录，名字用 `dir:file` 形态与 claude 一致的扁平化：M1 用相对路径去掉 .md、/ 换 :） */
const scanDir = (dir: string, source: SlashCommand["source"]): SlashCommand[] => {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
  } catch { return [] } // 目录不存在 = 无命令
  return entries
    .filter((e) => e.endsWith(".md"))
    .map((e) => ({ name: e.slice(0, -3).split(path.sep).join(":"), source }))
}

/** repo（worktree/.claude/commands）优先，user（~/.claude/commands）随后；同名去重取 repo */
export const scanSlashCommands = (worktree: string, claudeHome: string): SlashCommand[] => {
  const repo = scanDir(path.join(worktree, ".claude", "commands"), "repo")
  const seen = new Set(repo.map((c) => c.name))
  const user = scanDir(path.join(claudeHome, "commands"), "user").filter((c) => !seen.has(c.name))
  return [...repo, ...user].sort((a, b) => a.name.localeCompare(b.name))
}
```

`packages/server/src/engine/claude/adapter.ts` 文件尾追加（不动既有代码）：

```ts
/** GUI 模型选择器选项（/model 别名；spec §六 UI 禁止硬编码 vendor 字符串——由 server 下发） */
export const claudeModels = ["default", "opus", "sonnet", "haiku"]
```

- [ ] **Step 6: protocol 路由表登记**

`packages/protocol/src/routes.ts` 在 `GET /ws/terminal` 条目**之前**插入：

```ts
  { method: "GET",  path: "/config",                        description: "client 引导信息：tmuxSocket + engines（能力位/模型列表）" },
  { method: "GET",  path: "/workspaces/:id/git/diffstat",   description: "vs baseRef 的 shortstat（左栏 +N−M 轮询）" },
  { method: "GET",  path: "/workspaces/:id/git/changes",    description: "四分区 numstat：against-base/committed/staged/unstaged + untracked" },
  { method: "GET",  path: "/workspaces/:id/files",          description: "worktree 文件列表（@文件选择器/Files 树）" },
  { method: "GET",  path: "/workspaces/:id/commands",       description: "slash 命令扫描：repo .claude/commands + ~/.claude/commands" },
```

- [ ] **Step 7: 写 http 路由的失败测试**

`packages/server/test/http-gitread.test.ts`（沿用既有 http 测试的组装方式——参考 `test/http-workspaces.test.ts` 顶部如何 build layer/runtime/token，保持一致；下面给出核心断言，组装段抄该文件）：

```ts
import { describe, it, expect } from "vitest"
// 组装：照 http-workspaces.test.ts 建 runtime + createApp + supertest 风格的 fetch helper。
// 关键差异：createApp 时传 gitRead 假实现 + config：
const fakeGitRead = {
  calls: [] as string[][],
  diffstat: async (wt: string, base: string) => {
    fakeGitRead.calls.push(["diffstat", wt, base])
    return { filesChanged: 2, insertions: 10, deletions: 3 }
  },
  changes: async () => ({ againstBase: [], committed: [], staged: [], unstaged: [], untracked: ["u.txt"] }),
  files: async () => ["a.ts", "b.ts"],
}
// createApp({ ..., gitRead: fakeGitRead, config: { tmuxSocket: "coolie-test" } })

describe("GET /config", () => {
  it("返回 tmuxSocket 与 engines（含能力位与模型列表）", async () => {
    const r = await get("/config")
    expect(r.status).toBe(200)
    expect(r.body.tmuxSocket).toBe("coolie-test")
    const claude = r.body.engines.find((e: any) => e.id === "claude")
    expect(claude.capabilities.nativeQueue).toBe(true)
    expect(claude.models).toContain("opus")
  })
})

describe("git read routes", () => {
  it("active workspace：diffstat 走 gitRead 并带 worktree 路径与 baseRef", async () => {
    const ws = await createActiveWorkspace() // helper：repo 里插入 active 的 workspace 行
    const r = await get(`/workspaces/${ws.id}/git/diffstat`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ filesChanged: 2, insertions: 10, deletions: 3 })
    expect(fakeGitRead.calls.at(-1)).toEqual(["diffstat", ws.path, ws.baseRef])
  })
  it("非 active → 409；未知 id → 404", async () => { /* archived 工作区 409、随机 id 404 */ })
  it("changes/files 路由 200", async () => { /* 同上形态 */ })
})

describe("CORS", () => {
  it("OPTIONS 预检 → 204 + allow 头；GET 响应带 ACAO", async () => {
    const pre = await rawFetch("/projects", { method: "OPTIONS" })
    expect(pre.status).toBe(204)
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/authorization/i)
    const r = await rawFetch("/health", { method: "GET" })
    expect(r.headers.get("access-control-allow-origin")).toBe("*")
  })
})
```

（`GET /workspaces/:id/commands` 用真临时目录测：建 `worktree/.claude/commands/review.md` + `claudeHome/commands/deploy.md`，断言两条、source 正确。）

- [ ] **Step 8: 跑测试确认失败**

Run: `bunx vitest run packages/server/test/http-gitread.test.ts`
Expected: FAIL（404 no route / createApp 不认识 gitRead）

- [ ] **Step 9: app.ts 实现 CORS + 5 条路由**

`packages/server/src/http/app.ts` 修改点（锚点定位，不按行号）：

(a) imports 区追加：

```ts
import { ConflictError } from "../repo/errors.js"
import type { GitReadOps } from "../git/inspect.js"
import { scanSlashCommands } from "../engine/claude/commands.js"
import { claudeModels } from "../engine/claude/adapter.js"
```

(b) `AppDeps` 接口追加两个可选成员：

```ts
  /** 只读 git 观察面（GUI）；未提供时相关路由 501 */
  readonly gitRead?: GitReadOps
  /** GET /config 下发的 client 引导信息 */
  readonly config?: { readonly tmuxSocket: string }
```

（`createApp` 的解构参数同步加 `gitRead, config`。）

(c) 在 `if (route === "GET /health")` **之前**加 CORS（预检免 token——浏览器预检不带 Authorization）：

> **F7（安全前提，勿删）：** `access-control-allow-origin: *` 之所以安全，**仅**因为两条前提同时成立：(1) server 绑定 `127.0.0.1`（非 `0.0.0.0`），跨机根本连不上；(2) 认证是 **Bearer token（非 cookie/session）**——`*` 通配下浏览器禁止携带凭据 cookie，且我们本就不用 cookie，token 由 JS 显式塞进 `Authorization` 头，CORS 通配不会让第三方站点拿到它。**一旦 bind 从 loopback 放宽（哪怕临时调试），这套 CORS 必须重新设计**（收窄 origin 白名单 + 复核 token 暴露面），否则任意网页都能打这个端口。

```ts
      // CORS：webview/vite-dev 是跨源 origin；token 是唯一安全边界，这里只放行浏览器（agent-deck 姿势）
      // 安全前提见上方 F7 note：* 只在 127.0.0.1 bind + 非 cookie 的 Bearer 认证下成立。
      res.setHeader("access-control-allow-origin", "*")
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
        }).end()
        return
      }
```

(d) 在 `return err(res, 404, ...)` **之前**加路由（active 守卫 helper + 4 条 ws 路由 + config）：

```ts
        if (route === "GET /config") {
          if (!config) return err(res, 500, "Internal", "config unavailable")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const registry = yield* EngineRegistry
              const claude = registry.get("claude")
              return {
                tmuxSocket: config.tmuxSocket,
                engines: claude
                  ? [{ id: claude.id, displayName: claude.displayName, capabilities: claude.capabilities, models: claudeModels }]
                  : [],
              }
            }),
            (body) => send(res, 200, body),
            onError,
          )
        }
        const gitRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/(git\/diffstat|git\/changes|files|commands)$/)
        if (req.method === "GET" && gitRoute) {
          const wsId = gitRoute[1]!
          const kind = gitRoute[2]!
          if (kind !== "commands" && !gitRead) return err(res, 501, "Internal", "gitRead unavailable")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(wsId)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              return ws
            }),
            async (ws) => {
              try {
                if (kind === "git/diffstat") return send(res, 200, await gitRead!.diffstat(ws.path, ws.baseRef))
                if (kind === "git/changes") return send(res, 200, await gitRead!.changes(ws.path, ws.baseRef))
                if (kind === "files") return send(res, 200, { files: await gitRead!.files(ws.path) })
                return send(res, 200, { commands: claudeHome !== undefined ? scanSlashCommands(ws.path, claudeHome) : scanSlashCommands(ws.path, "") })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "GitError", e?.message ?? String(e))
              }
            },
            onError,
          )
        }
```

(e) `packages/server/src/main.ts`：`createApp({...})` 调用追加两行参数：

```ts
    gitRead: realGitRead,
    config: { tmuxSocket: cfg.tmuxSocket },
```

（import：`import { realGitRead } from "./git/inspect.js"`。）

- [ ] **Step 10: 全量跑 server 测试**

Run: `bunx vitest run packages/server packages/protocol`
Expected: 全 PASS（既有测试不受影响——AppDeps 新成员是可选的）。再跑 `bun run typecheck`。

- [ ] **Step 11: Commit**

```bash
git add packages/server packages/protocol
git commit -m "feat(server): GUI 只读面（config/diffstat/changes/files/commands）+ CORS（Plan 5 前置）"
```

---

### Task 3: Server 动作端点（shell tab 创建/关闭 + composer 投递四模式）

**第二个 justified exception。** Composer 的投递管线（稳定检测→消毒→bracketed paste→150ms→Enter）与打断（Esc）已在 server 内实现（`tmux/delivery.ts`）但**无任何 HTTP 路由暴露**——已核实 routes.ts 无此端点；New Shell tab / 关 tab 同理（tabs 只有 GET）。tmux 归 server 管（持久 control-mode client），client 自己写 WS 字节做"投递"会绕过消毒与稳定检测，禁止。

**Files:**
- Modify: `packages/server/src/tmux/service.ts`（TmuxServiceShape + makeTmuxService：`killWindow`）
- Create: `packages/server/src/tmux/ops.ts`
- Modify: `packages/server/src/repo/tabs.ts`（+`remove`）
- Modify: `packages/protocol/src/routes.ts`（+3 路由）
- Modify: `packages/server/src/http/app.ts`（3 路由 + AppDeps.composerOps）
- Modify: `packages/server/src/main.ts`（注入 composerOps）
- Test: `packages/server/test/tmux-ops.test.ts`（真 tmux）
- Test: `packages/server/test/http-composer.test.ts`（fake ops）

**Interfaces:**
- Produces（HTTP）：
  - `POST /workspaces/:id/tabs` body `{ kind: "shell" }` → 201 `Tab`（tmux new-window + tabs 行；非 shell 400）
  - `DELETE /workspaces/:id/tabs/:tabId` → 204（仅 kind=shell 可关，否则 409；kill-window + 删行 + `tab.closed` 事件）
  - `POST /workspaces/:id/input` body `{ text: string, mode: "send"|"interrupt-send"|"insert"|"interrupt", skipStable?: boolean }` → 200 `{ ok: true }`
    - `send`：`skipStable=false` 走完整 deliverPrompt（稳定→消毒→paste→150ms→Enter）；`skipStable=true`（claude 忙时 nativeQueue 直投——**忙时画面永不稳定，必须跳过稳定检测**）直接消毒→paste→150ms→Enter
    - `interrupt-send`：sendKey Escape → deliverPrompt（Esc 后画面会稳定）
    - `insert`：（skipStable 同上规则的）稳定检测 → 消毒 → paste，**不回车**
    - `interrupt`：仅 sendKey Escape（text 允许空）
    - 目标 = engine tab 的 `coolie-<wsId>:<tmuxWindow>`；非 interrupt 模式空 text → 400；无 engine tab → 404
  - 每次成功投递 append 事件 `composer.delivered`（payload `{ mode, tabId, chars }`）
- Produces（代码）：`ComposerOps` 接口（`input/newShellWindow/killWindow`），`AppDeps.composerOps?: ComposerOps`

- [ ] **Step 1: 写 tmux ops 的失败测试（真 tmux，模式照 `test/delivery.test.ts` 的专用 socket 纪律）**

`packages/server/test/tmux-ops.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import { Effect } from "effect"
import { makeTmuxService } from "../src/tmux/service.js"
import { makeComposerOps } from "../src/tmux/ops.js"

const SOCK = `coolie-test-${process.pid}-ops`
const SESSION = "ops-session"
const tmux = makeTmuxService(SOCK)
const ops = makeComposerOps(tmux)
const capture = () => execFileSync("tmux", ["-L", SOCK, "capture-pane", "-p", "-t", `=${SESSION}:0`], { encoding: "utf8" })

beforeAll(async () => {
  await Effect.runPromise(tmux.newSession({ name: SESSION, cwd: process.cwd(), windowName: "engine", command: ["cat"] }))
  await new Promise((r) => setTimeout(r, 300))
})
afterAll(() => { try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch {} })

describe("makeComposerOps", () => {
  it("send（完整管线）把文本投进 pane 并回车", async () => {
    await ops.input(`${SESSION}:0`, { text: "hello-send", mode: "send", skipStable: false })
    await new Promise((r) => setTimeout(r, 300))
    expect(capture()).toContain("hello-send") // cat 回显 = Enter 已生效
  })
  it("insert 不回车（cat 无回显第二行）", async () => {
    await ops.input(`${SESSION}:0`, { text: "pending-insert", mode: "insert", skipStable: false })
    await new Promise((r) => setTimeout(r, 300))
    const frame = capture()
    // 输入行有文本、但 cat 未回显（回显会产生第二次出现）
    expect(frame.split("pending-insert").length - 1).toBe(1)
  })
  it("interrupt 发 Escape 不崩（cat 场景无可见效果，验证不抛错）", async () => {
    await ops.input(`${SESSION}:0`, { text: "", mode: "interrupt", skipStable: false })
  })
  it("newShellWindow / killWindow 往返", async () => {
    const idx = await ops.newShellWindow(SESSION, process.cwd())
    expect(idx).toBeGreaterThan(0)
    const wins = await Effect.runPromise(tmux.listWindows(SESSION))
    expect(wins.some((w) => w.index === idx)).toBe(true)
    await ops.killWindow(SESSION, idx)
    const after = await Effect.runPromise(tmux.listWindows(SESSION))
    expect(after.some((w) => w.index === idx)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run packages/server/test/tmux-ops.test.ts`
Expected: FAIL（`Cannot find module '../src/tmux/ops.js'`）

- [ ] **Step 3: 实现 killWindow + ops.ts**

`packages/server/src/tmux/service.ts`：`TmuxServiceShape` 里 `sendKey` 之后加一行：

```ts
  /** kill-window（shell tab 关闭）；window 不存在视为成功（幂等） */
  readonly killWindow: (session: string, index: number) => Effect.Effect<void, TmuxError>
```

`makeTmuxService` 返回对象里 `sendKey` 之后加实现：

```ts
  killWindow: (session, index) =>
    runTmux(socket, "kill-window", ["kill-window", "-t", `=${session}:${index}`]).pipe(
      Effect.asVoid,
      Effect.catchAll((e) => e.exitCode !== null ? Effect.void : Effect.fail(e)),
    ),
```

`packages/server/src/tmux/ops.ts`：

```ts
/**
 * ComposerOps：composer 投递/tab 动作的 Promise 门面（http 路由消费）。
 * 复用 Plan 3 的 deliverPrompt/waitStable/sanitize——绝不绕过消毒与稳定检测。
 * skipStable 的存在理由：engine working 时 TUI spinner 持续重画，waitStable 永远不满足；
 * claude nativeQueue=true 意味着忙时直接 paste 是安全的（TUI 原生排队），此时客户端传 skipStable=true。
 */
import { Effect } from "effect"
import type { TmuxServiceShape } from "./service.js"
import { deliverPrompt, waitStable } from "./delivery.js"
import { sanitizePromptForPty } from "./sanitize.js"

export type InputMode = "send" | "interrupt-send" | "insert" | "interrupt"

export interface ComposerOps {
  input(target: string, opts: { text: string; mode: InputMode; skipStable: boolean }): Promise<void>
  newShellWindow(session: string, cwd: string): Promise<number>
  killWindow(session: string, index: number): Promise<void>
}

const ENTER_DELAY_MS = 150 // kobe 实测：粘贴终止符与回车必须分开两次 tty read

export const makeComposerOps = (tmux: TmuxServiceShape): ComposerOps => {
  const pasteClean = (target: string, text: string, enter: boolean) =>
    Effect.gen(function* () {
      const clean = sanitizePromptForPty(text)
      if (clean === "") return
      yield* tmux.pasteText(target, clean)
      if (enter) {
        yield* Effect.sleep(ENTER_DELAY_MS)
        yield* tmux.sendKey(target, "Enter")
      }
    })
  return {
    input: (target, { text, mode, skipStable }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (mode === "interrupt") { yield* tmux.sendKey(target, "Escape"); return }
          if (mode === "interrupt-send") {
            yield* tmux.sendKey(target, "Escape")
            yield* deliverPrompt(tmux, target, text) // Esc 后画面会稳定 → 完整管线
            return
          }
          if (mode === "send") {
            if (skipStable) yield* pasteClean(target, text, true)
            else yield* deliverPrompt(tmux, target, text)
            return
          }
          // insert：paste 不回车
          if (!skipStable) yield* waitStable(tmux, target)
          yield* pasteClean(target, text, false)
        }),
      ),
    newShellWindow: (session, cwd) =>
      Effect.runPromise(tmux.newWindow({ session, name: "shell", cwd })),
    killWindow: (session, index) => Effect.runPromise(tmux.killWindow(session, index)),
  }
}
```

- [ ] **Step 4: 跑 tmux-ops 测试**

Run: `bunx vitest run packages/server/test/tmux-ops.test.ts packages/server/test/tmux-service.test.ts`
Expected: PASS（含既有 tmux-service 测试不回归）

- [ ] **Step 5: TabsRepo.remove**

`packages/server/src/repo/tabs.ts`：`TabsRepoShape` 里 `removeByWorkspace` 之前加：

```ts
  /** 删单个 tab 行 + tab.closed 事件（shell tab 关闭用） */
  readonly remove: (id: string) => Effect.Effect<void, NotFoundError>
```

实现（`removeByWorkspace` 之前，模式照 `setTitle`）：

```ts
      remove: (id) => Effect.gen(function* () {
        const r = yield* mustGetRow(id)
        let ev!: CoolieEvent
        db.transaction(() => {
          db.prepare("DELETE FROM tabs WHERE id = ?").run(id)
          ev = appendEventRow(db, { workspaceId: r.workspace_id, type: "tab.closed", payload: { tabId: id, kind: r.kind } })
        })()
        broadcast(ev)
      }),
```

（`packages/server/test/tabs-repo.test.ts` 加一条：insert → remove → listByWorkspace 不含该 tab、events 出现 `tab.closed`。照该文件既有测试形态写。）

- [ ] **Step 6: protocol 路由**

`packages/protocol/src/routes.ts`（紧接 Task 2 加的条目后）：

```ts
  { method: "POST",   path: "/workspaces/:id/tabs",        description: "新建 shell tab {kind:shell}（tmux new-window）" },
  { method: "DELETE", path: "/workspaces/:id/tabs/:tabId", description: "关 shell tab（kill-window；engine/setup/run 拒绝）" },
  { method: "POST",   path: "/workspaces/:id/input",       description: "composer 投递 {text, mode: send|interrupt-send|insert|interrupt, skipStable?}" },
```

- [ ] **Step 7: 写 http 路由失败测试**

`packages/server/test/http-composer.test.ts`（组装同 Task 2 Step 7；createApp 传 fake composerOps）：

```ts
const fakeOps = {
  calls: [] as any[],
  input: async (target: string, o: any) => { fakeOps.calls.push(["input", target, o]) },
  newShellWindow: async (session: string) => { fakeOps.calls.push(["newWindow", session]); return 3 },
  killWindow: async (session: string, idx: number) => { fakeOps.calls.push(["killWindow", session, idx]) },
}

describe("POST /workspaces/:id/input", () => {
  it("send：目标是 engine tab 的 session:window，透传 skipStable", async () => {
    const ws = await createActiveWorkspaceWithEngineTab({ tmuxWindow: 0 })
    const r = await post(`/workspaces/${ws.id}/input`, { text: "hi", mode: "send", skipStable: true })
    expect(r.status).toBe(200)
    expect(fakeOps.calls.at(-1)).toEqual(["input", `coolie-${ws.id}:0`, { text: "hi", mode: "send", skipStable: true }])
  })
  it("空 text + mode=send → 400；mode=interrupt 空 text OK", async () => { /* … */ })
  it("投递后 events 含 composer.delivered", async () => { /* GET /events 断言 type */ })
  it("非 active → 409", async () => { /* … */ })
})

describe("shell tabs", () => {
  it("POST {kind:shell} → 201 Tab（tmuxWindow=3 来自 ops）+ tabs 行落库", async () => { /* … */ })
  it("POST {kind:engine} → 400", async () => { /* … */ })
  it("DELETE shell tab → 204 + killWindow 被调 + 行已删；DELETE engine tab → 409", async () => { /* … */ })
})
```

（`/* … */` 处按上一条的形态写全——每条都要有真实断言，执行者不得留空。）

- [ ] **Step 8: 跑测试确认失败**

Run: `bunx vitest run packages/server/test/http-composer.test.ts`
Expected: FAIL（404 no route）

- [ ] **Step 9: app.ts 三条路由**

imports 追加：

```ts
import { tmuxSessionName } from "@coolie/protocol"
import type { ComposerOps, InputMode } from "../tmux/ops.js"
```

`AppDeps` 追加：

```ts
  /** composer 投递 / shell tab 动作（tmux 门面）；未提供时相关路由 501 */
  readonly composerOps?: ComposerOps
```

（`createApp` 的解构参数同步加 `composerOps`。）

在 Task 2 的 gitRoute 块之后、404 之前加：

```ts
        const tabsCreate = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs$/)
        if (req.method === "POST" && tabsCreate) {
          if (!composerOps) return err(res, 501, "Internal", "composerOps unavailable")
          const body = await readJson(req)
          if (body.kind !== "shell") return err(res, 400, "Validation", "只支持 kind=shell")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(tabsCreate[1]!)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              return ws
            }),
            async (ws) => {
              try {
                const idx = await composerOps.newShellWindow(tmuxSessionName(ws.id), ws.path)
                const exit = await runtime(Effect.gen(function* () {
                  return yield* (yield* TabsRepo).insert({ workspaceId: ws.id, kind: "shell", tmuxWindow: idx })
                }))
                Exit.match(exit, {
                  onSuccess: (tab) => send(res, 201, tab),
                  onFailure: (cause) => { const { status, body } = errorFromCause(cause, onError); send(res, status, body) },
                })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
            onError,
          )
        }
        const tabDel = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)$/)
        if (req.method === "DELETE" && tabDel) {
          if (!composerOps) return err(res, 501, "Internal", "composerOps unavailable")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const tab = yield* (yield* TabsRepo).get(tabDel[2]!)
              if (tab.workspaceId !== tabDel[1]!) return yield* new NotFoundError({ message: "tab 不属于该 workspace" })
              if (tab.kind !== "shell")
                return yield* new ConflictError({ message: `只能关 shell tab（当前 ${tab.kind}）` })
              return tab
            }),
            async (tab) => {
              try {
                if (tab.tmuxWindow !== null) await composerOps.killWindow(tmuxSessionName(tab.workspaceId), tab.tmuxWindow)
                await runtime(Effect.gen(function* () { yield* (yield* TabsRepo).remove(tab.id) }))
                send(res, 204)
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
            onError,
          )
        }
        const inputRoute = url.pathname.match(/^\/workspaces\/([^/]+)\/input$/)
        if (req.method === "POST" && inputRoute) {
          if (!composerOps) return err(res, 501, "Internal", "composerOps unavailable")
          const body = await readJson(req)
          const mode = body.mode as InputMode
          if (!["send", "interrupt-send", "insert", "interrupt"].includes(mode))
            return err(res, 400, "Validation", "mode 必须是 send|interrupt-send|insert|interrupt")
          if (typeof body.text !== "string") return err(res, 400, "Validation", "text 必须是 string")
          if (mode !== "interrupt" && body.text.trim() === "")
            return err(res, 400, "Validation", "非 interrupt 模式 text 不能为空")
          return await runRoute(
            res, runtime,
            Effect.gen(function* () {
              const ws = yield* (yield* WorkspacesRepo).get(inputRoute[1]!)
              if (ws.status !== "active")
                return yield* new ConflictError({ message: `workspace 非 active（当前 ${ws.status}）` })
              const tab = yield* (yield* TabsRepo).findEngineTab(ws.id)
              if (!tab) return yield* new NotFoundError({ message: "无 engine tab" })
              return { ws, tab }
            }),
            async ({ ws, tab }) => {
              try {
                const target = `${tmuxSessionName(ws.id)}:${tab.tmuxWindow ?? 0}`
                await composerOps.input(target, { text: body.text, mode, skipStable: body.skipStable === true })
                await runtime(Effect.gen(function* () {
                  yield* (yield* EventsRepo).append({
                    workspaceId: ws.id, type: "composer.delivered",
                    payload: { mode, tabId: tab.id, chars: body.text.length },
                  })
                }))
                send(res, 200, { ok: true })
              } catch (e: any) {
                if (!res.headersSent) err(res, 500, "TmuxError", e?.message ?? String(e))
              }
            },
            onError,
          )
        }
```

（`NotFoundError` 需要 import：`import { ConflictError, NotFoundError } from "../repo/errors.js"`——Task 2 已引 ConflictError，这里补 NotFoundError。`errorFromCause`/`Exit` 已在文件内。**注意**：既有 `GET /workspaces/:id/tabs` 的 match 是 `tabsList`——POST 分支必须放在它之后或用 method 区分，上面代码已用 `req.method === "POST"` 区分，无冲突。）

`packages/server/src/main.ts`：createApp 参数追加：

```ts
    composerOps: makeComposerOps(tmuxSvc),
```

（import `makeComposerOps`；`tmuxSvc` 变量已存在于 main.ts。）

- [ ] **Step 10: 全量回归**

Run: `bunx vitest run packages/server packages/protocol && bun run typecheck`
Expected: 全 PASS

- [ ] **Step 11: Commit**

```bash
git add packages/server packages/protocol
git commit -m "feat(server): composer 投递四模式 + shell tab 创建/关闭端点（Plan 5 前置）"
```

---

### Task 4: Client API 模块 + server 发现/拉起 + gui lease stub（对真 server 集成测试）

传输层三分：`client.ts`（纯 fetch 封装，可注入 ServerInfo——node 测试直接用）、`discovery.ts`（Tauri 专用：invoke 读 server.json / detached spawn，**不被测试 import**）、`lease.ts`（Plan 4 touchpoint stub）。发现/拉起逻辑复制 CLI `ensureServer` 的语义：读 server.json → probe /health → 死则 spawn → 10s 轮询。

**Files:**
- Create: `packages/client/src/api/client.ts`
- Create: `packages/client/src/api/discovery.ts`
- Create: `packages/client/src/api/lease.ts`
- Test: `packages/client/test/api-client.test.ts`（spawn 真 daemon）

**Interfaces:**
- Consumes: Task 2/3 的全部端点；`@coolie/server` 的 server.json 格式 `{ port, token, pid, sock? }`
- Produces:
  - `interface ServerInfo { port: number; token: string; pid: number; sock?: string }`（与 daemon/info.ts 同形，client 侧独立声明——client 不 import server 包）
  - `makeApi(info: ServerInfo): Api`；`Api = { info; req(method, path, body?): Promise<any>; wsTerminalUrl(wsId, window, cols, rows): string }`（req 对非 2xx 抛 `ApiError{ code, message, status }`）
  - `probeHealth(info): Promise<boolean>`
  - `ensureServer(): Promise<ServerInfo>`（discovery.ts，Tauri only）、`tmuxOnPath(): Promise<boolean>`
  - `startGuiLease(api): () => void`（lease.ts；返回 stop）

- [ ] **Step 1: 写集成测试（真 daemon，模式抄 `packages/cli/test/cli-e2e.test.ts` 的环境隔离）**

`packages/client/test/api-client.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn, execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { makeApi, probeHealth, ApiError, type ServerInfo } from "../src/api/client.js"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const SERVER_MAIN = path.resolve(__dirname, "../../server/src/main.ts")
const TMUX_SOCK = `coolie-test-${process.pid}-client`
let home: string, repo: string, info: ServerInfo, child: ReturnType<typeof spawn>

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clientapi-"))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-clientapi-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repo })
  child = spawn(TSX, [SERVER_MAIN, "start"], {
    env: {
      ...process.env, COOLIE_HOME: home, COOLIE_TMUX_SOCKET: TMUX_SOCK,
      COOLIE_CLAUDE_CMD: "cat", COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_HOME: path.join(home, "claude-home"),
      COOLIE_WORKSPACES_ROOT: path.join(home, "ws"),
    },
    stdio: "ignore",
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      info = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"))
      if (await probeHealth(info)) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error("daemon 未在 10s 内就绪")
}, 20_000)

afterAll(() => {
  try { child.kill("SIGTERM") } catch { /* gone */ }
  try { execFileSync("tmux", ["-L", TMUX_SOCK, "kill-server"]) } catch { /* gone */ }
})

describe("makeApi against real daemon", () => {
  it("GET /config 带 token 成功，返回 engines", async () => {
    const api = makeApi(info)
    const cfg = await api.req("GET", "/config")
    expect(cfg.tmuxSocket).toBe(TMUX_SOCK)
    expect(cfg.engines[0].id).toBe("claude")
  })
  it("project add + workspace 全链路（create → tabs → diffstat → input → shell tab → archive）", async () => {
    const api = makeApi(info)
    const p = await api.req("POST", "/projects", { repoRoot: repo })
    const ws = await api.req("POST", "/workspaces", { projectId: p.id, initialPrompt: "hello from gui test" })
    expect(ws.status).toBe("active")
    const tabs = await api.req("GET", `/workspaces/${ws.id}/tabs`)
    expect(tabs.some((t: any) => t.kind === "engine")).toBe(true)
    const stat = await api.req("GET", `/workspaces/${ws.id}/git/diffstat`)
    expect(stat).toHaveProperty("filesChanged")
    await api.req("POST", `/workspaces/${ws.id}/input`, { text: "ping", mode: "send", skipStable: true })
    const shell = await api.req("POST", `/workspaces/${ws.id}/tabs`, { kind: "shell" })
    expect(shell.kind).toBe("shell")
    await api.req("DELETE", `/workspaces/${ws.id}/tabs/${shell.id}`)
    await api.req("POST", `/workspaces/${ws.id}/archive`, { force: true })
  }, 60_000)
  it("坏 token → ApiError（401）", async () => {
    const api = makeApi({ ...info, token: "bogus" })
    await expect(api.req("GET", "/projects")).rejects.toBeInstanceOf(ApiError)
  })
  it("wsTerminalUrl 拼出带 token 的 ws:// URL", () => {
    const api = makeApi(info)
    const u = api.wsTerminalUrl("W1", 0, 120, 32)
    expect(u).toBe(`ws://127.0.0.1:${info.port}/ws/terminal?workspace=W1&window=0&cols=120&rows=32&token=${encodeURIComponent(info.token)}`)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run packages/client/test/api-client.test.ts`
Expected: FAIL（`Cannot find module '../src/api/client.js'`）

- [ ] **Step 3: 实现 client.ts / discovery.ts / lease.ts**

`packages/client/src/api/client.ts`：

```ts
/** 纯 fetch API 封装：无 Tauri 依赖（node 集成测试直接用）。unix sock 是 CLI 的事，浏览器只有 TCP。 */
export interface ServerInfo { port: number; token: string; pid: number; sock?: string }

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = "ApiError"
  }
}

export interface Api {
  readonly info: ServerInfo
  req(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<any>
  wsTerminalUrl(workspaceId: string, window: number, cols: number, rows: number): string
}

export const probeHealth = async (info: ServerInfo): Promise<boolean> => {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(800) })
    return r.ok
  } catch { return false }
}

export const makeApi = (info: ServerInfo): Api => ({
  info,
  req: async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${info.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (r.status === 204) return undefined
    let json: any = {}
    try { json = await r.json() } catch { /* 非 JSON 保持 {} */ }
    if (!r.ok) throw new ApiError(json.code ?? String(r.status), json.message ?? "request failed", r.status)
    return json
  },
  wsTerminalUrl: (workspaceId, window, cols, rows) =>
    `ws://127.0.0.1:${info.port}/ws/terminal?workspace=${encodeURIComponent(workspaceId)}` +
    `&window=${window}&cols=${cols}&rows=${rows}&token=${encodeURIComponent(info.token)}`,
})
```

`packages/client/src/api/discovery.ts`：

```ts
/** server 发现/拉起（Tauri 专用；语义 = CLI ensureServer：读 server.json → probe → spawn → 10s 轮询）。 */
import { invoke } from "@tauri-apps/api/core"
import { probeHealth, type ServerInfo } from "./client"

const readInfo = async (): Promise<ServerInfo | null> => {
  const raw = await invoke<string | null>("read_server_info")
  if (!raw) return null
  try {
    const j = JSON.parse(raw)
    if (typeof j.port === "number" && typeof j.token === "string" && typeof j.pid === "number") return j
    return null
  } catch { return null }
}

export const spawnDaemon = async (): Promise<void> => {
  const [program, ...args] = __COOLIE_SERVER_CMD__.split(" ")
  await invoke("spawn_detached", { program, args })
}

export const ensureServer = async (): Promise<ServerInfo> => {
  const existing = await readInfo()
  if (existing && (await probeHealth(existing))) return existing
  await spawnDaemon()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const info = await readInfo()
    if (info && (await probeHealth(info))) return info
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error("无法启动 coolie-server（10s 超时）")
}

export const tmuxOnPath = (): Promise<boolean> => invoke<boolean>("binary_on_path", { name: "tmux" })
```

（注：`__COOLIE_SERVER_CMD__` 的空格切分依赖 repo 路径无空格；vite.config 注入的是本机绝对路径，执行时如 checkout 路径含空格需把分隔符改成不会出现在路径里的字符并两侧同步。）

`packages/client/src/api/lease.ts`：

```ts
/**
 * [Plan 4 contract — verify at execution]
 * gui role lease：GUI 持有 server 生命周期（spec §2.1 role 化 refcount）。Plan 4 落地端点后按其真实
 * API（预期 POST /clients {role:"gui"} + 心跳）替换路径与字段。Plan 4 未合并时（404/501）静默降级为
 * no-op——daemon 靠 M1 的常驻行为兜底，不影响其余功能。
 */
import type { Api } from "./client"
import { ApiError } from "./client"

export const startGuiLease = (api: Api): (() => void) => {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const loop = async (): Promise<void> => {
    if (stopped) return
    try {
      await api.req("POST", "/clients", { role: "gui" })
      timer = setTimeout(() => void loop(), 10_000)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return // Plan 4 未合并：降级
      timer = setTimeout(() => void loop(), 10_000) // 瞬时失败重试
    }
  }
  void loop()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
```

- [ ] **Step 4: 跑集成测试**

Run: `bunx vitest run packages/client/test/api-client.test.ts && bun run typecheck`
Expected: PASS（daemon 全链路 60s 内）

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): API 模块 + server 发现/拉起 + gui lease stub（真 daemon 集成测试）"
```

---

### Task 5: SSE durable 流客户端（游标重连 + 指数退避 + 崩溃重拉起钩子）

`EventSource` 无法带 `Authorization` 头（server 在路由分发前查 Bearer），所以用 **fetch + ReadableStream 手写 SSE**：增量解析器（纯函数，单测）+ 游标（`after=lastSeq`）+ 指数退避（500ms 起 ×2，8s 封顶）+ 断线时经注入的 `getInfo`（= `ensureServer`）**重新发现/拉起 daemon**（spec §十：客户端指数退避重连并重新拉起 daemon，SSE 从 events 游标 replay）。

**Files:**
- Create: `packages/client/src/api/sse.ts`
- Test: `packages/client/test/sse.test.ts`
- Modify: `packages/client/test/api-client.test.ts`（追加真 server 流测试）

**Interfaces:**
- Consumes: `GET /events/stream?after=`（`id: <seq>` + `data: <json>` 块、心跳 `:hb`、前导 `:ok`）；Task 4 `ServerInfo`
- Produces:
  - `class SseParser { feed(chunk: string): CoolieEventLike[] }`（跨 chunk 缓冲）
  - `backoffDelay(attempt: number): number`
  - `startEventStream(opts: { getInfo, after, onEvent, onStatus }): () => void`
  - `interface CoolieEventLike { seq; workspaceId; type; payload; ts }`

- [ ] **Step 1: 写解析器/退避的失败测试**

`packages/client/test/sse.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { SseParser, backoffDelay } from "../src/api/sse.js"

describe("SseParser", () => {
  it("解析完整事件", () => {
    const p = new SseParser()
    const evs = p.feed('id: 7\ndata: {"seq":7,"type":"tab.status.changed","workspaceId":"W","payload":{},"ts":1}\n\n')
    expect(evs).toHaveLength(1)
    expect(evs[0]!.seq).toBe(7)
    expect(evs[0]!.type).toBe("tab.status.changed")
  })
  it("跨 chunk 拼接：半个事件不吐、补齐后吐", () => {
    const p = new SseParser()
    expect(p.feed('id: 1\ndata: {"seq":1,')).toHaveLength(0)
    const evs = p.feed('"type":"x","workspaceId":null,"payload":{},"ts":0}\n\n')
    expect(evs).toHaveLength(1)
  })
  it("心跳/注释块（:hb、:ok）与坏 JSON 跳过不抛", () => {
    const p = new SseParser()
    expect(p.feed(":ok\n\n:hb\n\n")).toHaveLength(0)
    expect(p.feed("data: {broken\n\n")).toHaveLength(0)
  })
  it("一个 chunk 多事件", () => {
    const p = new SseParser()
    const two = 'data: {"seq":1,"type":"a","workspaceId":null,"payload":{},"ts":0}\n\n' +
      'data: {"seq":2,"type":"b","workspaceId":null,"payload":{},"ts":0}\n\n'
    expect(p.feed(two).map((e) => e.seq)).toEqual([1, 2])
  })
})

describe("backoffDelay", () => {
  it("500 → 1000 → 2000 → … 封顶 8000", () => {
    expect(backoffDelay(0)).toBe(500)
    expect(backoffDelay(1)).toBe(1000)
    expect(backoffDelay(4)).toBe(8000)
    expect(backoffDelay(10)).toBe(8000)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run packages/client/test/sse.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 sse.ts**

`packages/client/src/api/sse.ts`：

```ts
/**
 * durable SSE 消费（spec §2.3/§十）：fetch 流式读取（EventSource 带不了 Bearer 头）。
 * 断线：退避 → getInfo()（内部会重新拉起 daemon）→ 用 lastSeq 游标重连 → server 端 replay 补齐，不丢不重。
 */
export interface CoolieEventLike {
  seq: number; workspaceId: string | null; type: string; payload: unknown; ts: number
}

export class SseParser {
  private buf = ""
  feed(chunk: string): CoolieEventLike[] {
    this.buf += chunk
    const out: CoolieEventLike[] = []
    for (;;) {
      const cut = this.buf.indexOf("\n\n")
      if (cut === -1) break
      const block = this.buf.slice(0, cut)
      this.buf = this.buf.slice(cut + 2)
      const dataLines = block.split("\n").filter((l) => l.startsWith("data:"))
      if (dataLines.length === 0) continue // 注释/心跳块
      try {
        const e = JSON.parse(dataLines.map((l) => l.slice(5).trimStart()).join("\n"))
        if (typeof e?.seq === "number" && typeof e?.type === "string") out.push(e)
      } catch { /* 坏块跳过：durable 流靠游标补，不因单块中毒断流 */ }
    }
    return out
  }
}

export const backoffDelay = (attempt: number): number => Math.min(500 * 2 ** attempt, 8000)

export interface EventStreamOpts {
  getInfo: () => Promise<{ port: number; token: string }>
  after: number
  onEvent: (e: CoolieEventLike) => void
  onStatus: (s: "online" | "offline") => void
}

export const startEventStream = (opts: EventStreamOpts): (() => void) => {
  let stopped = false
  let lastSeq = opts.after
  let attempt = 0
  let abort: AbortController | null = null

  const connectLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const info = await opts.getInfo() // server 崩溃场景：这里会 spawn 新 daemon（spec §十）
        abort = new AbortController()
        const r = await fetch(`http://127.0.0.1:${info.port}/events/stream?after=${lastSeq}`, {
          headers: { Authorization: `Bearer ${info.token}` },
          signal: abort.signal,
        })
        if (!r.ok || !r.body) throw new Error(`sse http ${r.status}`)
        opts.onStatus("online")
        attempt = 0
        const parser = new SseParser()
        const reader = r.body.getReader()
        const dec = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          for (const e of parser.feed(dec.decode(value, { stream: true }))) {
            lastSeq = Math.max(lastSeq, e.seq)
            opts.onEvent(e)
          }
        }
        throw new Error("sse stream ended") // server 正常不主动断
      } catch {
        if (stopped) return
        opts.onStatus("offline")
        await new Promise((r) => setTimeout(r, backoffDelay(attempt++)))
      }
    }
  }
  void connectLoop()
  return () => { stopped = true; abort?.abort() }
}
```

- [ ] **Step 4: 跑单测 + 追加真 server 流测试**

在 `packages/client/test/api-client.test.ts` 尾部加一个 describe（复用已起的 daemon）：

```ts
describe("startEventStream against real daemon", () => {
  it("收到 project.added（live 或 replay 均可）", async () => {
    const { startEventStream } = await import("../src/api/sse.js")
    const events: any[] = []
    const stop = startEventStream({
      getInfo: async () => info, after: 0,
      onEvent: (e) => events.push(e), onStatus: () => {},
    })
    const api = makeApi(info)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-sse-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    await api.req("POST", "/projects", { repoRoot: dir })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !events.some((e) => e.type === "project.added"))
      await new Promise((r) => setTimeout(r, 100))
    stop()
    expect(events.some((e) => e.type === "project.added")).toBe(true)
  }, 15_000)
})
```

Run: `bunx vitest run packages/client/test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): fetch 版 durable SSE（游标重连/指数退避/daemon 重拉起钩子）"
```

---

### Task 6: zustand stores（data + ui）与事件应用策略

两个 store：`data`（server 状态镜像 + 刷新动作 + SSE 事件应用 + 投递记账）、`ui`（选中态/面板/模式）。事件应用策略**粗粒度但正确**：`workspace.*` → 重拉 workspaces；`tab.*`/`engine.*`/`composer.*` → 重拉该 workspace 的 tabs；`project.*` → 重拉 projects——事件量是人手操作频度，不做细粒度 patch（记录为决策）。

**Files:**
- Create: `packages/client/src/stores/types.ts`
- Create: `packages/client/src/stores/data.ts`
- Create: `packages/client/src/stores/ui.ts`
- Test: `packages/client/test/stores.test.ts`

**Interfaces:**
- Consumes: Task 4 `Api`、Task 5 `CoolieEventLike`、`@coolie/protocol` 类型（**仅 `import type`**——verbatimModuleSyntax 会强制）
- Produces（后续所有 UI 任务消费）：
  - `useData`：state `{ status, config, projects, workspaces, tabsByWs, diffstatByWs, changesByWs, pendingSends, warnings }`；actions `setApi/getApi/setStatus/setSessionDisposer(fn)/bootstrap/refreshProjects/refreshWorkspaces/refreshTabs(wsId)/refreshDiffstat(wsId)/refreshChanges(wsId)/applyEvent(e)/sendInput(wsId, req)/cancelSend(id)/pushWarning(code, msg)/dismissWarning(id)`
  - `useUi`：state `{ selectedWs, selectedTabByWs, rightPanel, dispatchMode, dispatchProjectId, cheatsheetOpen, searchQuery, composerFocusNonce }`；actions `selectWs/selectTab/setRightPanel/setDispatchMode/setCheatsheet/setSearch/focusComposer`
  - `stores/types.ts`：`DiffStat/FileChange/ChangesReport/SlashCommand`（与 Task 2 server 响应同形）

- [ ] **Step 1: 写事件应用策略的失败测试**

`packages/client/test/stores.test.ts`（data store 是纯 TS，node 环境可测；Api 注入 fake）：

```ts
import { describe, it, expect, beforeEach } from "vitest"
import { useData } from "../src/stores/data.js"

const fakeApi = () => {
  const calls: string[] = []
  return {
    calls,
    info: { port: 1, token: "t", pid: 1 },
    req: async (m: string, p: string) => {
      calls.push(`${m} ${p}`)
      if (p === "/workspaces" || p === "/projects" || p.endsWith("/tabs")) return []
      if (p.endsWith("/git/diffstat")) return { filesChanged: 0, insertions: 0, deletions: 0 }
      return {}
    },
    wsTerminalUrl: () => "",
  } as any
}

describe("useData.applyEvent", () => {
  beforeEach(() => {
    useData.setState({ projects: [], workspaces: [], tabsByWs: {}, diffstatByWs: {}, pendingSends: [], warnings: [] } as any)
    useData.getState().setSessionDisposer(() => {}) // 复位注入的回收器，避免用例间串味
  })
  it("workspace.* 触发 workspaces 重拉", async () => {
    const api = fakeApi(); useData.getState().setApi(api)
    useData.getState().applyEvent({ seq: 1, workspaceId: "W", type: "workspace.created", payload: {}, ts: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(api.calls).toContain("GET /workspaces")
  })
  it("tab.* / composer.* 触发对应 ws 的 tabs 重拉", async () => {
    const api = fakeApi(); useData.getState().setApi(api)
    useData.getState().applyEvent({ seq: 2, workspaceId: "W", type: "tab.status.changed", payload: {}, ts: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(api.calls).toContain("GET /workspaces/W/tabs")
  })
  it("project.* 触发 projects 重拉", async () => {
    const api = fakeApi(); useData.getState().setApi(api)
    useData.getState().applyEvent({ seq: 3, workspaceId: null, type: "project.added", payload: {}, ts: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(api.calls).toContain("GET /projects")
  })
  it("workspace.archived → 调用注入的终端会话回收器（F2：防 N×tabs 活 WS 泄漏）", () => {
    const api = fakeApi(); useData.getState().setApi(api)
    const disposed: string[] = []
    useData.getState().setSessionDisposer((wsId) => disposed.push(wsId))
    useData.getState().applyEvent({ seq: 4, workspaceId: "W", type: "workspace.archived", payload: {}, ts: 0 })
    expect(disposed).toEqual(["W"])
    // 常规 workspace.* 不回收（只有 archived/deleted 才断连）
    useData.getState().applyEvent({ seq: 5, workspaceId: "W", type: "workspace.updated", payload: {}, ts: 0 })
    expect(disposed).toEqual(["W"])
  })
  it("prompt.delivery.degraded → 浮出 UI 警告并带 code（F5：不静默丢）", () => {
    useData.getState().applyEvent({
      seq: 6, workspaceId: "W", type: "prompt.delivery.degraded",
      payload: { code: "enter_not_confirmed", reason: "回车未确认" }, ts: 0,
    })
    const w = useData.getState().warnings
    expect(w).toHaveLength(1)
    expect(w[0]!.code).toBe("enter_not_confirmed")
  })
})

describe("useData.sendInput", () => {
  it("记账 pendingSends 并在失败后清除（fetch 打向死端口必然 reject）", async () => {
    const api = fakeApi(); useData.getState().setApi(api)
    const p = useData.getState().sendInput("W", { text: "hi", mode: "send", skipStable: false })
    expect(useData.getState().pendingSends.filter((x) => x.wsId === "W")).toHaveLength(1)
    await p.catch(() => {}) // port 1 不可达：reject 即可，账要清
    expect(useData.getState().pendingSends).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run packages/client/test/stores.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现三个文件**

`packages/client/src/stores/types.ts`：

```ts
/** server 只读端点的响应形状（与 packages/server/src/git/inspect.ts 同形；client 不 import server 包） */
export interface DiffStat { filesChanged: number; insertions: number; deletions: number }
export interface FileChange { path: string; insertions: number; deletions: number }
export interface ChangesReport {
  againstBase: FileChange[]; committed: FileChange[]
  staged: FileChange[]; unstaged: FileChange[]; untracked: string[]
}
export interface SlashCommand { name: string; source: "repo" | "user" }
export interface EngineInfo {
  id: string; displayName: string
  capabilities: { nativeQueue: boolean; midSessionModelSwitch: boolean; resume: boolean; hooks: boolean; effort: boolean }
  models: string[]
}
```

`packages/client/src/stores/data.ts`：

```ts
import { create } from "zustand"
import type { Api } from "../api/client"
import type { CoolieEventLike } from "../api/sse"
import type { Project, Workspace, Tab } from "@coolie/protocol"
import type { DiffStat, ChangesReport, EngineInfo } from "./types"

export interface PendingSend { id: number; wsId: string; text: string; mode: string; abort: AbortController }
/** UI 警告面（prompt.delivery.degraded 等 server 侧降级信号 → toast/badge） */
export interface Warning { id: number; code: string; message: string }

interface DataState {
  status: "connecting" | "online" | "offline"
  config: { tmuxSocket: string; engines: EngineInfo[] } | null
  projects: Project[]
  workspaces: Workspace[]
  tabsByWs: Record<string, Tab[]>
  diffstatByWs: Record<string, DiffStat>
  changesByWs: Record<string, ChangesReport>
  pendingSends: PendingSend[]
  warnings: Warning[]
  setApi(api: Api): void
  getApi(): Api | null
  setStatus(s: DataState["status"]): void
  /** 终端会话回收钩子（依赖注入）：App 侧接 terminal/session 的 disposeWorkspaceSessions；node 测试注入 spy。
   *  用注入而非直接 import：session.ts 顶层 import 了 @xterm + xterm.css，直接引会把 DOM/CSS 依赖拖进纯 node store 测试。 */
  setSessionDisposer(fn: (wsId: string) => void): void
  bootstrap(): Promise<void>
  refreshProjects(): Promise<void>
  refreshWorkspaces(): Promise<void>
  refreshTabs(wsId: string): Promise<void>
  refreshDiffstat(wsId: string): Promise<void>
  refreshChanges(wsId: string): Promise<void>
  applyEvent(e: CoolieEventLike): void
  sendInput(wsId: string, req: { text: string; mode: string; skipStable: boolean }): Promise<void>
  cancelSend(id: number): void
  pushWarning(code: string, message: string): void
  dismissWarning(id: number): void
}

let api: Api | null = null
let sendSeq = 0
let warnSeq = 0
let disposeWsSessions: (wsId: string) => void = () => {} // F2：默认 noop，Terminal 模块加载时注册真实回收器
const swallow = (p: Promise<unknown>): void => { void p.catch(() => {}) } // 刷新失败＝下次事件/轮询再试

export const useData = create<DataState>((set, get) => ({
  status: "connecting",
  config: null,
  projects: [], workspaces: [], tabsByWs: {}, diffstatByWs: {}, changesByWs: {},
  pendingSends: [],
  warnings: [],
  setApi: (a) => { api = a },
  getApi: () => api,
  setStatus: (status) => set({ status }),
  setSessionDisposer: (fn) => { disposeWsSessions = fn },
  bootstrap: async () => {
    if (!api) return
    const [config, projects, workspaces] = await Promise.all([
      api.req("GET", "/config"), api.req("GET", "/projects"), api.req("GET", "/workspaces"),
    ])
    set({ config, projects, workspaces })
    for (const w of workspaces as Workspace[])
      if (w.status === "active") { swallow(get().refreshTabs(w.id)); swallow(get().refreshDiffstat(w.id)) }
  },
  refreshProjects: async () => { if (api) set({ projects: await api.req("GET", "/projects") }) },
  refreshWorkspaces: async () => { if (api) set({ workspaces: await api.req("GET", "/workspaces") }) },
  refreshTabs: async (wsId) => {
    if (!api) return
    const tabs = await api.req("GET", `/workspaces/${wsId}/tabs`)
    set((s) => ({ tabsByWs: { ...s.tabsByWs, [wsId]: tabs } }))
  },
  refreshDiffstat: async (wsId) => {
    if (!api) return
    try {
      const d = await api.req("GET", `/workspaces/${wsId}/git/diffstat`)
      set((s) => ({ diffstatByWs: { ...s.diffstatByWs, [wsId]: d } }))
    } catch { /* 非 active（刚归档）等：保留旧值 */ }
  },
  refreshChanges: async (wsId) => {
    if (!api) return
    const c = await api.req("GET", `/workspaces/${wsId}/git/changes`)
    set((s) => ({ changesByWs: { ...s.changesByWs, [wsId]: c } }))
  },
  applyEvent: (e) => {
    const { refreshWorkspaces, refreshTabs, refreshProjects, refreshDiffstat, pushWarning } = get()
    if (e.type.startsWith("project.")) swallow(refreshProjects())
    else if (e.type.startsWith("workspace.")) {
      swallow(refreshWorkspaces())
      if (e.type === "workspace.archived" || e.type === "workspace.deleted") {
        // F2：归档/删除 = workspace 从列表移除 → 主动回收该 ws 全部终端会话（N×tabs 的 xterm+WS 否则永久泄漏）。
        // engine 本体归 tmux（archive 侧另行 kill-session），这里只断 GUI 侧的活连接。
        if (e.workspaceId) disposeWsSessions(e.workspaceId)
      } else if (e.workspaceId) swallow(refreshTabs(e.workspaceId))
    } else if (e.workspaceId && (e.type.startsWith("tab.") || e.type.startsWith("engine.") || e.type.startsWith("composer."))) {
      swallow(refreshTabs(e.workspaceId))
      if (e.type === "engine.turn.finished") swallow(refreshDiffstat(e.workspaceId)) // turn 结束大概率有新 diff
    } else if (e.type.startsWith("prompt.")) {
      // F5：prompt.* 家族（landed commit eb2932e）——至少把投递降级信号浮到 UI，别静默丢。
      if (e.type === "prompt.delivery.degraded") {
        const p = (e.payload ?? {}) as { code?: string; reason?: string }
        pushWarning(p.code ?? "prompt.delivery.degraded", p.reason ?? "投递降级：prompt 可能未完整送达 engine")
      }
    }
  },
  sendInput: async (wsId, req) => {
    if (!api) throw new Error("api 未就绪")
    const id = ++sendSeq
    const abort = new AbortController()
    set((s) => ({ pendingSends: [...s.pendingSends, { id, wsId, text: req.text, mode: req.mode, abort }] }))
    try {
      // 不走 api.req：要挂 AbortSignal 支持排队撤回（POST /input 在稳定检测期间可长达数秒）
      const r = await fetch(`http://127.0.0.1:${api.info.port}/workspaces/${wsId}/input`, {
        method: "POST", signal: abort.signal,
        headers: { Authorization: `Bearer ${api.info.token}`, "content-type": "application/json" },
        body: JSON.stringify(req),
      })
      if (!r.ok) {
        const j: any = await r.json().catch(() => ({}))
        throw new Error(j.message ?? `input failed ${r.status}`)
      }
    } finally {
      set((s) => ({ pendingSends: s.pendingSends.filter((p) => p.id !== id) }))
    }
  },
  cancelSend: (id) => {
    const p = get().pendingSends.find((x) => x.id === id)
    p?.abort.abort()
    set((s) => ({ pendingSends: s.pendingSends.filter((x) => x.id !== id) }))
  },
  pushWarning: (code, message) => {
    const id = ++warnSeq
    set((s) => ({ warnings: [...s.warnings, { id, code, message }] }))
    setTimeout(() => get().dismissWarning(id), 8000) // 自动淡出；用户也可手动 ×
  },
  dismissWarning: (id) => set((s) => ({ warnings: s.warnings.filter((w) => w.id !== id) })),
}))
```

`packages/client/src/stores/ui.ts`：

```ts
import { create } from "zustand"

interface UiState {
  selectedWs: string | null
  selectedTabByWs: Record<string, string>
  rightPanel: "collapsed" | "changes" | "files"
  dispatchMode: boolean            // Cmd+N：composer 变新 workspace 首条 prompt 输入
  dispatchProjectId: string | null
  cheatsheetOpen: boolean
  searchQuery: string
  composerFocusNonce: number       // 递增触发 composer focus（Cmd+L / 创建流）
  selectWs(id: string | null): void
  selectTab(wsId: string, tabId: string): void
  setRightPanel(p: UiState["rightPanel"]): void
  setDispatchMode(on: boolean, projectId?: string | null): void
  setCheatsheet(open: boolean): void
  setSearch(q: string): void
  focusComposer(): void
}

const LS_KEY = "coolie.selectedWs"
const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> =
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} } // node 测试环境兜底

export const useUi = create<UiState>((set) => ({
  selectedWs: storage.getItem(LS_KEY),
  selectedTabByWs: {},
  rightPanel: "collapsed",
  dispatchMode: false,
  dispatchProjectId: null,
  cheatsheetOpen: false,
  searchQuery: "",
  composerFocusNonce: 0,
  selectWs: (id) => {
    if (id) storage.setItem(LS_KEY, id); else storage.removeItem(LS_KEY)
    set({ selectedWs: id, dispatchMode: false })
  },
  selectTab: (wsId, tabId) => set((s) => ({ selectedTabByWs: { ...s.selectedTabByWs, [wsId]: tabId } })),
  setRightPanel: (rightPanel) => set({ rightPanel }),
  setDispatchMode: (on, projectId = null) =>
    set((s) => ({ dispatchMode: on, dispatchProjectId: projectId, composerFocusNonce: s.composerFocusNonce + 1 })),
  setCheatsheet: (cheatsheetOpen) => set({ cheatsheetOpen }),
  setSearch: (searchQuery) => set({ searchQuery }),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),
}))
```

- [ ] **Step 4: 跑测试**

Run: `bunx vitest run packages/client/test/stores.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): zustand data/ui stores + SSE 事件应用策略 + 投递记账"
```

---

### Task 7: HOTKEYS_REGISTRY + LIFO binding stack + 终端三层仲裁 + composer 键位规划（纯逻辑）

键盘体系的**全部决策逻辑**做成纯函数（Superset 结构原样、独立实现：注册表反向索引 → 行编辑翻译 → 其余 Cmd 一律不进 PTY；打印字符按 `event.code` 物理键匹配防键盘布局漂移）。React 侧只在 Task 8 接一个 document listener。

**Files:**
- Create: `packages/client/src/hotkeys/registry.ts`
- Create: `packages/client/src/hotkeys/dispatch.ts`
- Create: `packages/client/src/terminal/arbitrate.ts`
- Create: `packages/client/src/composer/send.ts`
- Test: `packages/client/test/hotkeys.test.ts`
- Test: `packages/client/test/arbitrate.test.ts`
- Test: `packages/client/test/composer-send.test.ts`

**Interfaces:**
- Produces:
  - `HOTKEYS_REGISTRY: readonly HotkeyDef[]`；`HotkeyDef = { id: HotkeyId; chord: string; label: string; category: string }`；`HotkeyId` 字面量联合（见实现）
  - `normalizeChord(e: KeyEventLike): string | null`、`resolveHotkey(e): HotkeyDef | null`
  - `pushHotkeyLayer(handlers: Partial<Record<HotkeyId, () => void>>): () => void`（返回 pop）、`dispatchHotkey(e): boolean`、`_resetLayers()`
  - `arbitrateTerminalKey(e: TermKeyEvent): KeyDecision`；`KeyDecision = { action: "bubble" } | { action: "write"; bytes: string } | { action: "pty" }`
  - `planComposerKey(e, ctx: { engineWorking: boolean }): ComposerAction`；`ComposerAction = { kind: "none" | "newline" | "blur" } | { kind: "send" | "insert"; skipStable: boolean } | { kind: "interrupt-send" }`

- [ ] **Step 1: 写三个测试文件（失败）**

`packages/client/test/hotkeys.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { HOTKEYS_REGISTRY, normalizeChord, resolveHotkey } from "../src/hotkeys/registry.js"
import { pushHotkeyLayer, dispatchHotkey, _resetLayers } from "../src/hotkeys/dispatch.js"

const ev = (o: Partial<{ metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; code: string; key: string }>) =>
  ({ metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, code: "", key: "", ...o })

describe("registry", () => {
  it("注册表无重复 chord/id", () => {
    const chords = HOTKEYS_REGISTRY.map((h) => h.chord)
    expect(new Set(chords).size).toBe(chords.length)
    const ids = HOTKEYS_REGISTRY.map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it("normalizeChord：物理键（code）匹配；Ctrl/无修饰返回 null", () => {
    expect(normalizeChord(ev({ metaKey: true, code: "KeyN" }))).toBe("meta+n")
    expect(normalizeChord(ev({ metaKey: true, code: "BracketRight" }))).toBe("meta+]")
    expect(normalizeChord(ev({ metaKey: true, code: "Period" }))).toBe("meta+.")
    expect(normalizeChord(ev({ metaKey: true, code: "Digit3" }))).toBe("meta+3")
    expect(normalizeChord(ev({ ctrlKey: true, code: "KeyA" }))).toBeNull() // Ctrl 系永远透传
    expect(normalizeChord(ev({ code: "KeyJ" }))).toBeNull()
  })
  it("resolveHotkey 命中 Cmd+1..9 / Cmd+L / Cmd+.", () => {
    expect(resolveHotkey(ev({ metaKey: true, code: "Digit1" }))?.id).toBe("workspace.jump.1")
    expect(resolveHotkey(ev({ metaKey: true, code: "KeyL" }))?.id).toBe("composer.focus")
    expect(resolveHotkey(ev({ metaKey: true, code: "Period" }))?.id).toBe("engine.interrupt")
  })
})

describe("LIFO binding stack", () => {
  it("顶层 layer 优先，pop 后回落", () => {
    _resetLayers()
    const hits: string[] = []
    pushHotkeyLayer({ "workspace.new": () => hits.push("base") })
    const pop = pushHotkeyLayer({ "workspace.new": () => hits.push("modal") })
    dispatchHotkey(ev({ metaKey: true, code: "KeyN" }))
    pop()
    dispatchHotkey(ev({ metaKey: true, code: "KeyN" }))
    expect(hits).toEqual(["modal", "base"])
  })
  it("未命中任何 layer → false", () => {
    _resetLayers()
    expect(dispatchHotkey(ev({ metaKey: true, code: "KeyN" }))).toBe(false)
  })
})
```

`packages/client/test/arbitrate.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { arbitrateTerminalKey } from "../src/terminal/arbitrate.js"

const ESC = String.fromCharCode(0x1b)
const CTRL_A = String.fromCharCode(0x01)
const CTRL_E = String.fromCharCode(0x05)
const CTRL_U = String.fromCharCode(0x15)

const ev = (o: any) => ({ metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, code: "", key: "", type: "keydown", ...o })

describe("终端三层仲裁（spec §7.3，Superset 原样）", () => {
  it("① 注册表命中的 Cmd chord → bubble", () => {
    expect(arbitrateTerminalKey(ev({ metaKey: true, code: "KeyT", key: "t" }))).toEqual({ action: "bubble" })
    expect(arbitrateTerminalKey(ev({ metaKey: true, code: "Digit5", key: "5" }))).toEqual({ action: "bubble" })
  })
  it("② 行编辑翻译", () => {
    expect(arbitrateTerminalKey(ev({ metaKey: true, key: "ArrowLeft" }))).toEqual({ action: "write", bytes: CTRL_A })
    expect(arbitrateTerminalKey(ev({ metaKey: true, key: "ArrowRight" }))).toEqual({ action: "write", bytes: CTRL_E })
    expect(arbitrateTerminalKey(ev({ metaKey: true, key: "Backspace" }))).toEqual({ action: "write", bytes: CTRL_U })
    expect(arbitrateTerminalKey(ev({ altKey: true, key: "ArrowLeft" }))).toEqual({ action: "write", bytes: ESC + "b" })
    expect(arbitrateTerminalKey(ev({ altKey: true, key: "ArrowRight" }))).toEqual({ action: "write", bytes: ESC + "f" })
    expect(arbitrateTerminalKey(ev({ shiftKey: true, key: "Enter" }))).toEqual({ action: "write", bytes: ESC + "\r" })
  })
  it("③ 其余 Cmd 组合一律不进 PTY（bubble）：Cmd+C/V/A/Q", () => {
    for (const code of ["KeyC", "KeyV", "KeyA", "KeyQ"])
      expect(arbitrateTerminalKey(ev({ metaKey: true, code, key: code.slice(3).toLowerCase() }))).toEqual({ action: "bubble" })
  })
  it("其它按键全部透传：Ctrl+A/E、Esc、普通字符", () => {
    expect(arbitrateTerminalKey(ev({ ctrlKey: true, key: "a", code: "KeyA" }))).toEqual({ action: "pty" })
    expect(arbitrateTerminalKey(ev({ ctrlKey: true, key: "e", code: "KeyE" }))).toEqual({ action: "pty" })
    expect(arbitrateTerminalKey(ev({ key: "Escape", code: "Escape" }))).toEqual({ action: "pty" }) // claude 双击 Esc rewind 不受影响
    expect(arbitrateTerminalKey(ev({ key: "x", code: "KeyX" }))).toEqual({ action: "pty" })
  })
  it("非 keydown 不拦截", () => {
    expect(arbitrateTerminalKey(ev({ type: "keyup", metaKey: true, code: "KeyT" }))).toEqual({ action: "pty" })
  })
})
```

`packages/client/test/composer-send.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { planComposerKey } from "../src/composer/send.js"

const ev = (o: any) => ({ metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, key: "", ...o })

describe("composer 三档发送 + 打断（spec §7.2 表格）", () => {
  it("Enter：空闲=完整管线发送；忙时=nativeQueue 直投（skipStable）", () => {
    expect(planComposerKey(ev({ key: "Enter" }), { engineWorking: false })).toEqual({ kind: "send", skipStable: false })
    expect(planComposerKey(ev({ key: "Enter" }), { engineWorking: true })).toEqual({ kind: "send", skipStable: true })
  })
  it("Cmd+Enter = 打断并发送", () => {
    expect(planComposerKey(ev({ key: "Enter", metaKey: true }), { engineWorking: true })).toEqual({ kind: "interrupt-send" })
  })
  it("Option+Enter = 仅插入不回车", () => {
    expect(planComposerKey(ev({ key: "Enter", altKey: true }), { engineWorking: false })).toEqual({ kind: "insert", skipStable: false })
    expect(planComposerKey(ev({ key: "Enter", altKey: true }), { engineWorking: true })).toEqual({ kind: "insert", skipStable: true })
  })
  it("Shift+Enter = composer 内换行", () => {
    expect(planComposerKey(ev({ key: "Enter", shiftKey: true }), { engineWorking: false })).toEqual({ kind: "newline" })
  })
  it("Esc = 失焦回终端；其它键不管", () => {
    expect(planComposerKey(ev({ key: "Escape" }), { engineWorking: false })).toEqual({ kind: "blur" })
    expect(planComposerKey(ev({ key: "a" }), { engineWorking: false })).toEqual({ kind: "none" })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run packages/client/test/hotkeys.test.ts packages/client/test/arbitrate.test.ts packages/client/test/composer-send.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现四个模块**

`packages/client/src/hotkeys/registry.ts`：

```ts
/**
 * 单一真源（spec §7.3）：绑定与 ⌘/ cheatsheet 同源渲染。
 * 全局键约束在 Cmd 空间——Ctrl 系天然透传给 shell/engine。
 * 打印字符按 event.code（物理键）匹配，防 Dvorak/QWERTZ 漂移（Superset CONTRACT 同款）。
 * 用户 JSON 键位覆盖 与 ⌘K 命令面板：M2（CONTROLLER-SANCTIONED cut——见 Self-Review 决策记录）。
 *   锁定的 M1 IN-scope 只含 HOTKEYS_REGISTRY + 三层仲裁 + Cmd 全局键，此三项均已在 Task 7-8 实装。
 */
export type HotkeyId =
  | "workspace.new" | "tab.newShell" | "tab.close"
  | "workspace.jump.1" | "workspace.jump.2" | "workspace.jump.3" | "workspace.jump.4" | "workspace.jump.5"
  | "workspace.jump.6" | "workspace.jump.7" | "workspace.jump.8" | "workspace.jump.9"
  | "workspace.prev" | "workspace.next"
  | "composer.focus" | "engine.interrupt" | "app.cheatsheet"

export interface HotkeyDef { id: HotkeyId; chord: string; label: string; category: string }

const jump = (n: number): HotkeyDef =>
  ({ id: `workspace.jump.${n}` as HotkeyId, chord: `meta+${n}`, label: `切到第 ${n} 个 workspace`, category: "Workspace" })

export const HOTKEYS_REGISTRY: readonly HotkeyDef[] = [
  { id: "workspace.new", chord: "meta+n", label: "新建 workspace（composer 变首条 prompt）", category: "Workspace" },
  { id: "workspace.prev", chord: "meta+[", label: "上一个 workspace", category: "Workspace" },
  { id: "workspace.next", chord: "meta+]", label: "下一个 workspace", category: "Workspace" },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(jump),
  { id: "tab.newShell", chord: "meta+t", label: "新 shell tab", category: "Tab" },
  { id: "tab.close", chord: "meta+w", label: "关当前 shell tab", category: "Tab" },
  { id: "composer.focus", chord: "meta+l", label: "聚焦 composer", category: "Composer" },
  { id: "engine.interrupt", chord: "meta+.", label: "打断 engine（Esc）", category: "Composer" },
  { id: "app.cheatsheet", chord: "meta+/", label: "快捷键一览", category: "App" },
]

export interface KeyEventLike {
  metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; code: string; key: string
}

const CODE_MAP: Record<string, string> = {
  BracketLeft: "[", BracketRight: "]", Period: ".", Slash: "/",
}

/** 只归一 meta 系 chord；alt/shift 参与拼串（精确匹配，不误伤 Cmd+Shift+X 之类未注册组合） */
export const normalizeChord = (e: KeyEventLike): string | null => {
  if (!e.metaKey || e.ctrlKey) return null
  let base: string | null = null
  if (/^Key[A-Z]$/.test(e.code)) base = e.code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(e.code)) base = e.code.slice(5)
  else if (CODE_MAP[e.code]) base = CODE_MAP[e.code]!
  if (base === null) return null
  return `meta+${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}${base}`
}

const byChord = new Map(HOTKEYS_REGISTRY.map((h) => [h.chord, h]))

export const resolveHotkey = (e: KeyEventLike): HotkeyDef | null => {
  const chord = normalizeChord(e)
  return chord ? byChord.get(chord) ?? null : null
}
```

`packages/client/src/hotkeys/dispatch.ts`：

```ts
/** LIFO binding stack：模态（picker/cheatsheet/引导）push 一层覆盖同 id 绑定，关掉 pop 回落。 */
import { resolveHotkey, type HotkeyId, type KeyEventLike } from "./registry"

type Layer = Partial<Record<HotkeyId, () => void>>
const layers: Layer[] = []

export const pushHotkeyLayer = (handlers: Layer): (() => void) => {
  layers.push(handlers)
  let popped = false
  return () => {
    if (popped) return
    popped = true
    const i = layers.indexOf(handlers)
    if (i >= 0) layers.splice(i, 1)
  }
}

export const dispatchHotkey = (e: KeyEventLike): boolean => {
  const def = resolveHotkey(e)
  if (!def) return false
  for (let i = layers.length - 1; i >= 0; i--) {
    const h = layers[i]![def.id]
    if (h) { h(); return true }
  }
  return false
}

/** 测试专用 */
export const _resetLayers = (): void => { layers.length = 0 }
```

`packages/client/src/terminal/arbitrate.ts`：

```ts
/**
 * 终端焦点三层仲裁（spec §7.3，Superset terminal-key-event-handler 结构原样、独立实现）：
 * ① 注册表命中的 Cmd chord → bubble 给 app（xterm 提前 bail，事件自然冒泡到 document 的全局 dispatcher）
 * ② 行编辑翻译：macOS 原生行编辑键 → readline/escape 序列直写 PTY
 * ③ 其余 Cmd 组合一律不进 PTY（Ghostty/VS Code/Superset 三家共识）
 * 其它按键全部透传（Ctrl+A/E 归 shell/engine；Esc 归 claude 自己的双击 rewind）。
 */
import { resolveHotkey } from "../hotkeys/registry"

export interface TermKeyEvent {
  type: string
  metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean
  code: string; key: string
}

export type KeyDecision = { action: "bubble" } | { action: "write"; bytes: string } | { action: "pty" }

const ESC = String.fromCharCode(0x1b)
const CTRL_A = String.fromCharCode(0x01)
const CTRL_E = String.fromCharCode(0x05)
const CTRL_U = String.fromCharCode(0x15)

export const arbitrateTerminalKey = (e: TermKeyEvent): KeyDecision => {
  if (e.type !== "keydown") return { action: "pty" }
  // ① app 快捷键
  if (resolveHotkey(e)) return { action: "bubble" }
  // ② 行编辑翻译（语义键用 e.key）
  if (e.metaKey && !e.altKey && !e.ctrlKey) {
    if (e.key === "ArrowLeft") return { action: "write", bytes: CTRL_A }   // 行首
    if (e.key === "ArrowRight") return { action: "write", bytes: CTRL_E }  // 行尾
    if (e.key === "Backspace") return { action: "write", bytes: CTRL_U }   // kill line
  }
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    if (e.key === "ArrowLeft") return { action: "write", bytes: ESC + "b" }  // 词左
    if (e.key === "ArrowRight") return { action: "write", bytes: ESC + "f" } // 词右
  }
  if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && e.key === "Enter")
    return { action: "write", bytes: ESC + "\r" } // ESC CR：claude /terminal-setup 的换行序列，不依赖 kitty 握手
  // ③ 其余 Cmd chord 一律不进 PTY
  if (e.metaKey) return { action: "bubble" }
  return { action: "pty" }
}
```

`packages/client/src/composer/send.ts`：

```ts
/** composer 键位 → 发送动作（spec §7.2 表格的纯函数化）。skipStable 语义见 server tmux/ops.ts 注释。 */
export type ComposerAction =
  | { kind: "none" } | { kind: "newline" } | { kind: "blur" }
  | { kind: "send"; skipStable: boolean }
  | { kind: "insert"; skipStable: boolean }
  | { kind: "interrupt-send" }

export interface ComposerKeyEvent {
  key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean
}

export const planComposerKey = (e: ComposerKeyEvent, ctx: { engineWorking: boolean }): ComposerAction => {
  if (e.key === "Escape") return { kind: "blur" }
  if (e.key !== "Enter") return { kind: "none" }
  if (e.metaKey) return { kind: "interrupt-send" }
  if (e.shiftKey) return { kind: "newline" }
  if (e.altKey) return { kind: "insert", skipStable: ctx.engineWorking }
  return { kind: "send", skipStable: ctx.engineWorking }
}
```

- [ ] **Step 4: 跑测试**

Run: `bunx vitest run packages/client/test && bun run typecheck`
Expected: 全 PASS（含前置任务测试不回归）

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): HOTKEYS_REGISTRY + LIFO 层栈 + 终端三层仲裁 + composer 键位规划（纯函数+单测）"
```

---

### Task 8: App 壳：三栏布局 + 自绘 titlebar + 全局键接线 + tmux 首启引导 + cheatsheet

把 Task 4-7 的模块接成可运行的 app：启动流程（ensureServer → bootstrap → SSE → lease）、三栏布局骨架、自绘 titlebar（drag region + 红绿灯 + 连接状态）、document 级全局键 dispatcher、tmux 缺失引导弹窗（spec §十二）、⌘/ cheatsheet（registry 同源渲染）。左/中/右栏内容是后续任务的占位。

**Files:**
- Modify: `packages/client/src/App.tsx`（重写）
- Create: `packages/client/src/hotkeys/useGlobalHotkeys.ts`
- Create: `packages/client/src/chrome/Titlebar.tsx`
- Create: `packages/client/src/chrome/TmuxGuide.tsx`
- Create: `packages/client/src/chrome/Cheatsheet.tsx`
- Create: `packages/client/src/chrome/Toasts.tsx`（F5：降级警告浮层）
- Modify: `packages/client/src/styles.css`（追加）

**Interfaces:**
- Consumes: `ensureServer/tmuxOnPath`（Task 4）、`startEventStream`（Task 5）、`useData/useUi`（Task 6）、`dispatchHotkey/pushHotkeyLayer/HOTKEYS_REGISTRY`（Task 7）、`startGuiLease`
- Produces: `<App/>` 三栏骨架；全局 hotkey base layer（`workspace.*`/`composer.focus`/`engine.interrupt`/`app.cheatsheet` 的默认动作；`tab.*` 由 Task 11 补充自己的 handler）

- [ ] **Step 1: useGlobalHotkeys（document listener + base layer）**

`packages/client/src/hotkeys/useGlobalHotkeys.ts`：

```ts
import { useEffect } from "react"
import { dispatchHotkey, pushHotkeyLayer } from "./dispatch"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"

/** 视觉顺序的 active workspace 列表（pinned 优先 → createdAt 倒序）——Cmd+1..9/[/] 的索引真源 */
export const orderedActiveWs = () => {
  const ws = useData.getState().workspaces.filter((w) => w.status === "active" || w.status === "creating" || w.status === "error")
  return [...ws].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || b.createdAt - a.createdAt)
}

const jumpTo = (i: number): void => {
  const list = orderedActiveWs()
  const w = list[i]
  if (w) useUi.getState().selectWs(w.id)
}

const jumpAdjacent = (delta: number): void => {
  const list = orderedActiveWs()
  if (list.length === 0) return
  const cur = list.findIndex((w) => w.id === useUi.getState().selectedWs)
  const next = ((cur < 0 ? 0 : cur) + delta + list.length) % list.length
  useUi.getState().selectWs(list[next]!.id)
}

export const useGlobalHotkeys = (): void => {
  useEffect(() => {
    const pop = pushHotkeyLayer({
      "workspace.new": () => useUi.getState().setDispatchMode(true, useData.getState().projects[0]?.id ?? null),
      "workspace.prev": () => jumpAdjacent(-1),
      "workspace.next": () => jumpAdjacent(+1),
      ...(Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`workspace.jump.${n}`, () => jumpTo(n - 1)]))),
      "composer.focus": () => useUi.getState().focusComposer(),
      "engine.interrupt": () => {
        const wsId = useUi.getState().selectedWs
        if (wsId) void useData.getState().sendInput(wsId, { text: "", mode: "interrupt", skipStable: true }).catch(() => {})
      },
      "app.cheatsheet": () => useUi.getState().setCheatsheet(!useUi.getState().cheatsheetOpen),
    })
    const onKey = (e: KeyboardEvent): void => {
      if (dispatchHotkey(e)) e.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("keydown", onKey); pop() }
  }, [])
}
```

- [ ] **Step 2: Titlebar / TmuxGuide / Cheatsheet**

`packages/client/src/chrome/Titlebar.tsx`：

```tsx
import { getCurrentWindow } from "@tauri-apps/api/window"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"

export const Titlebar = () => {
  const status = useData((s) => s.status)
  const selectedWs = useUi((s) => s.selectedWs)
  const ws = useData((s) => s.workspaces.find((w) => w.id === selectedWs))
  const win = getCurrentWindow()
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="traffic" data-tauri-drag-region>
        <button className="tl close" title="关闭" onClick={() => void win.close()} />
        <button className="tl min" title="最小化" onClick={() => void win.minimize()} />
        <button className="tl max" title="缩放" onClick={() => void win.toggleMaximize()} />
      </div>
      <div className="titlebar-center" data-tauri-drag-region>
        {ws ? <><strong>{ws.name}</strong><span className="branch">⑂ {ws.branch}</span></> : <strong>Coolie</strong>}
      </div>
      <div className={`conn conn-${status}`} title={`server: ${status}`}>
        {status === "online" ? "●" : status === "offline" ? "○ 重连中…" : "○ 连接中…"}
      </div>
    </div>
  )
}
```

`packages/client/src/chrome/TmuxGuide.tsx`（spec §十二：tmux 非自带依赖，首启检测 + 引导；引导态压一层 hotkey layer 吞掉全局键防误操作）：

```tsx
import { useEffect, useState } from "react"
import { tmuxOnPath } from "../api/discovery"
import { pushHotkeyLayer } from "../hotkeys/dispatch"

export const TmuxGuide = () => {
  const [missing, setMissing] = useState(false)
  const [checking, setChecking] = useState(false)
  useEffect(() => { void tmuxOnPath().then((ok) => setMissing(!ok)) }, [])
  useEffect(() => {
    if (!missing) return
    return pushHotkeyLayer({ "workspace.new": () => {}, "tab.newShell": () => {}, "tab.close": () => {} })
  }, [missing])
  if (!missing) return null
  const recheck = async () => {
    setChecking(true)
    setMissing(!(await tmuxOnPath()))
    setChecking(false)
  }
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>需要安装 tmux</h2>
        <p>Coolie 用 tmux 承载 engine 会话（GUI 崩了 engine 也不死）。tmux 不是 macOS 自带工具：</p>
        <pre>brew install tmux</pre>
        <p className="dim">安装后点击重新检测。（也可用 <code>coolie doctor</code> 复核环境。）</p>
        <button className="btn" onClick={() => void recheck()} disabled={checking}>
          {checking ? "检测中…" : "重新检测"}
        </button>
      </div>
    </div>
  )
}
```

`packages/client/src/chrome/Cheatsheet.tsx`（⌘/，registry 单一真源的第二处渲染）：

```tsx
import { HOTKEYS_REGISTRY } from "../hotkeys/registry"
import { useUi } from "../stores/ui"

export const Cheatsheet = () => {
  const open = useUi((s) => s.cheatsheetOpen)
  if (!open) return null
  const cats = [...new Set(HOTKEYS_REGISTRY.map((h) => h.category))]
  const pretty = (chord: string) => chord.replace("meta+", "⌘").replace("alt+", "⌥").replace("shift+", "⇧").toUpperCase()
  return (
    <div className="modal-backdrop" onClick={() => useUi.getState().setCheatsheet(false)}>
      <div className="modal cheatsheet" onClick={(e) => e.stopPropagation()}>
        <h2>快捷键</h2>
        {cats.map((c) => (
          <section key={c}>
            <h3>{c}</h3>
            {HOTKEYS_REGISTRY.filter((h) => h.category === c).map((h) => (
              <div className="hk-row" key={h.id}><kbd>{pretty(h.chord)}</kbd><span>{h.label}</span></div>
            ))}
          </section>
        ))}
        <p className="dim">终端内：Cmd+←/→ 行首尾、Cmd+⌫ 清行、Option+←/→ 词间跳、Shift+Enter 换行；其余按键直达 engine。</p>
      </div>
    </div>
  )
}
```

`packages/client/src/chrome/Toasts.tsx`（F5：prompt.delivery.degraded 等 server 降级信号的浮层——store.warnings 的唯一渲染处）：

```tsx
import { useData } from "../stores/data"

export const WarningToasts = () => {
  const warnings = useData((s) => s.warnings)
  if (warnings.length === 0) return null
  return (
    <div className="toasts">
      {warnings.map((w) => (
        <div className="toast toast-warn" key={w.id} role="alert">
          <span className="toast-code">{w.code}</span>
          <span className="toast-msg">{w.message}</span>
          <button className="toast-x" title="关闭" onClick={() => useData.getState().dismissWarning(w.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: App.tsx 重写（启动流程 + 三栏）**

`packages/client/src/App.tsx`：

```tsx
import { useEffect, useRef, useState } from "react"
import { ensureServer } from "./api/discovery"
import { makeApi } from "./api/client"
import { startEventStream } from "./api/sse"
import { startGuiLease } from "./api/lease"
import { useData } from "./stores/data"
import { useUi } from "./stores/ui"
import { useGlobalHotkeys } from "./hotkeys/useGlobalHotkeys"
import { Titlebar } from "./chrome/Titlebar"
import { TmuxGuide } from "./chrome/TmuxGuide"
import { Cheatsheet } from "./chrome/Cheatsheet"
import { WarningToasts } from "./chrome/Toasts"

export const App = () => {
  const [bootErr, setBootErr] = useState<string | null>(null)
  const started = useRef(false)
  useGlobalHotkeys()

  useEffect(() => {
    if (started.current) return // StrictMode 双跑防抖
    started.current = true
    let stopSse: (() => void) | null = null
    let stopLease: (() => void) | null = null
    void (async () => {
      try {
        const info = await ensureServer()
        const api = makeApi(info)
        useData.getState().setApi(api)
        await useData.getState().bootstrap()
        useData.getState().setStatus("online")
        stopLease = startGuiLease(api) // [Plan 4 contract — verify at execution]
        stopSse = startEventStream({
          after: 0, // 首连从 0 replay 没意义且量大：用 bootstrap 后的最新态即可 → 实际用当前最大 seq；M1 简化为 0 + 幂等刷新，事件量小可接受
          getInfo: async () => {
            const fresh = await ensureServer() // server 崩溃：重发现/重拉起（spec §十）
            const freshApi = makeApi(fresh)
            useData.getState().setApi(freshApi)
            void useData.getState().bootstrap()
            return fresh
          },
          onEvent: (e) => useData.getState().applyEvent(e),
          onStatus: (s) => useData.getState().setStatus(s),
        })
      } catch (e: any) {
        setBootErr(e?.message ?? String(e))
      }
    })()
    return () => { stopSse?.(); stopLease?.() }
  }, [])

  const rightPanel = useUi((s) => s.rightPanel)
  if (bootErr)
    return (
      <div className="app-frame">
        <Titlebar />
        <div className="boot-error">
          <h2>无法连接 coolie-server</h2>
          <pre>{bootErr}</pre>
          <button className="btn" onClick={() => location.reload()}>重试</button>
        </div>
      </div>
    )
  return (
    <div className="app-frame">
      <Titlebar />
      <div className="columns">
        <aside className="col-left">{/* Task 9: <Sidebar/> */}</aside>
        <main className="col-center">{/* Task 10/11/12: 终端 tabs + composer */}</main>
        <aside className={`col-right ${rightPanel === "collapsed" ? "collapsed" : ""}`}>{/* Task 14: <RightPanel/> */}</aside>
      </div>
      <TmuxGuide />
      <Cheatsheet />
      <WarningToasts />
    </div>
  )
}
```

- [ ] **Step 4: styles.css 追加布局/组件样式**

在 `packages/client/src/styles.css` 尾部追加：

```css
/* === app shell (Task 8) === */
.app-frame { display: flex; flex-direction: column; height: 100%; background: var(--bg); }
.titlebar {
  height: var(--titlebar-h); flex: none; display: flex; align-items: center;
  border-bottom: 1px solid var(--border); padding: 0 12px; gap: 12px;
}
.traffic { display: flex; gap: 8px; }
.tl { width: 12px; height: 12px; border-radius: 50%; padding: 0; }
.tl.close { background: #ff5f57; } .tl.min { background: #febc2e; } .tl.max { background: #28c840; }
.titlebar-center { flex: 1; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.titlebar-center .branch { margin-left: 8px; color: var(--fg-dim); font-size: 12px; }
.conn { font-size: 11px; } .conn-online { color: var(--ok); } .conn-offline { color: var(--warn); } .conn-connecting { color: var(--fg-dim); }
.columns { flex: 1; display: flex; min-height: 0; }
.col-left { width: 260px; flex: none; border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
.col-center { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.col-right { width: 320px; flex: none; border-left: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
.col-right.collapsed { width: 44px; }
.boot-error { padding: 48px; } .boot-error pre { color: var(--danger); margin: 12px 0; white-space: pre-wrap; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: #26262b; border: 1px solid var(--border); border-radius: 10px; padding: 24px; max-width: 480px; max-height: 70vh; overflow-y: auto; }
.modal h2 { font-size: 15px; margin-bottom: 10px; } .modal p { margin: 8px 0; line-height: 1.5; }
.modal pre { background: #1a1a1e; padding: 8px 12px; border-radius: 6px; margin: 10px 0; user-select: text; }
.btn { background: var(--accent); color: #14141a; border-radius: 6px; padding: 6px 14px; font-weight: 600; }
.btn:disabled { opacity: 0.5; }
.dim { color: var(--fg-dim); font-size: 12px; }
.cheatsheet section { margin-top: 12px; } .cheatsheet h3 { font-size: 12px; color: var(--fg-dim); margin-bottom: 6px; }
.hk-row { display: flex; gap: 12px; padding: 3px 0; }
.hk-row kbd { min-width: 64px; background: #1a1a1e; border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; text-align: center; font-size: 11px; }
/* F5：降级警告 toast */
.toasts { position: fixed; right: 16px; bottom: 16px; z-index: 200; display: flex; flex-direction: column; gap: 8px; max-width: 380px; }
.toast { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; font-size: 12px; }
.toast-warn { background: rgba(224,175,104,0.15); border: 1px solid var(--warn); color: var(--fg); }
.toast-code { font-family: Menlo, monospace; font-size: 11px; color: var(--warn); flex: none; }
.toast-msg { flex: 1; }
.toast-x { color: var(--fg-dim); flex: none; padding: 0 4px; }
.toast-x:hover { color: var(--fg); }
```

- [ ] **Step 5: 验证**

```bash
bun run typecheck && cd packages/client && bunx vite build
bunx tauri dev
```

Expected：typecheck/build 绿；`tauri dev` 起窗口——titlebar 可拖动、红绿灯可用、右上连接状态先"连接中"后"●"（daemon 被自动拉起）、⌘/ 弹 cheatsheet、无 tmux 的机器弹引导。三栏骨架可见。关闭。

- [ ] **Step 6: Commit**

```bash
git add packages/client
git commit -m "feat(client): app 壳——启动流程/三栏骨架/自绘 titlebar/全局键 dispatcher/tmux 引导/⌘/ cheatsheet"
```

---

### Task 9: 左栏 Sidebar（Cursor 三段式：动作区 / projects→workspaces / 底部设置）

Cursor 左栏信息架构（cursor.md §信息架构）：固定动作区（New/Search）→ 两层列表（project → workspace，**不引入中间层**）→ 底部设置。每行：状态徽标 + 名称 + `⑂branch` + `+N−M` diff 计数（`git diff --shortstat` 5s 轮询，引擎无关的最有信息量状态位）+ pin。归档区折叠收纳。

**Files:**
- Create: `packages/client/src/sidebar/Sidebar.tsx`
- Modify: `packages/client/src/App.tsx`（挂 `<Sidebar/>`）
- Modify: `packages/client/src/styles.css`（追加）

**Interfaces:**
- Consumes: `useData`（workspaces/projects/tabsByWs/diffstatByWs/refreshDiffstat/getApi）、`useUi`（selectWs/searchQuery/setDispatchMode）、`orderedActiveWs`（Task 8——**排序真源共用**，保证 Cmd+1..9 与视觉一致）
- Produces: `<Sidebar/>`；徽标规则函数 `wsBadge(ws, tabs)`（Task 11 的 tab 徽标同规则）

- [ ] **Step 1: 实现 Sidebar**

`packages/client/src/sidebar/Sidebar.tsx`：

```tsx
import { useEffect } from "react"
import type { Workspace, Tab } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { orderedActiveWs } from "../hotkeys/useGlobalHotkeys"

/** 状态徽标（spec §六）：workspace 状态优先，active 时取 engine tab 状态 */
export const wsBadge = (ws: Workspace, tabs: Tab[] | undefined): { glyph: string; cls: string; title: string } => {
  if (ws.status === "creating") return { glyph: "◌", cls: "b-creating", title: "创建中" }
  if (ws.status === "error") return { glyph: "!", cls: "b-error", title: "创建失败（可重试）" }
  if (ws.status === "archived") return { glyph: "▪", cls: "b-archived", title: "已归档" }
  const engine = tabs?.find((t) => t.kind === "engine")
  switch (engine?.status) {
    case "working": return { glyph: "●", cls: "b-working", title: "工作中" }
    case "awaiting-input": return { glyph: "✓", cls: "b-await", title: "等输入" }
    case "error": return { glyph: "!", cls: "b-error", title: "错误" }
    default: return { glyph: "○", cls: "b-idle", title: "空闲" }
  }
}

const DiffCount = ({ wsId }: { wsId: string }) => {
  const d = useData((s) => s.diffstatByWs[wsId])
  if (!d || (d.insertions === 0 && d.deletions === 0)) return null
  return <span className="diffcount"><em className="plus">+{d.insertions}</em><em className="minus">−{d.deletions}</em></span>
}

const WsRow = ({ ws }: { ws: Workspace }) => {
  const selected = useUi((s) => s.selectedWs === ws.id)
  const tabs = useData((s) => s.tabsByWs[ws.id])
  const badge = wsBadge(ws, tabs)
  return (
    <div className={`ws-row ${selected ? "selected" : ""}`} onClick={() => useUi.getState().selectWs(ws.id)}>
      <span className={`badge ${badge.cls}`} title={badge.title}>{badge.glyph}</span>
      <span className="ws-name">{ws.pinned ? "📌 " : ""}{ws.name}</span>
      <span className="ws-branch" title={ws.branch}>⑂{ws.branch.replace(/^coolie\//, "")}</span>
      {ws.status === "active" && <DiffCount wsId={ws.id} />}
    </div>
  )
}

export const Sidebar = () => {
  const projects = useData((s) => s.projects)
  const workspaces = useData((s) => s.workspaces)
  const query = useUi((s) => s.searchQuery)

  // diff 计数轮询（spec §7.1：git diff --shortstat 轮询）：5s、窗口聚焦时才打
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hasFocus()) return
      for (const w of useData.getState().workspaces)
        if (w.status === "active") void useData.getState().refreshDiffstat(w.id)
    }, 5000)
    return () => clearInterval(t)
  }, [])

  const match = (w: Workspace) =>
    query === "" || w.name.includes(query) || w.branch.includes(query)
  const ordered = orderedActiveWs().filter(match)
  const archived = workspaces.filter((w) => w.status === "archived" && match(w))

  return (
    <div className="sidebar">
      <div className="side-actions">
        <button className="side-new" onClick={() => useUi.getState().setDispatchMode(true, projects[0]?.id ?? null)}>
          ＋ New Workspace <kbd>⌘N</kbd>
        </button>
        <input
          className="side-search" placeholder="🔍 搜索 workspace…"
          value={query} onChange={(e) => useUi.getState().setSearch(e.target.value)}
        />
      </div>
      <div className="side-list">
        {projects.map((p) => {
          const rows = ordered.filter((w) => w.projectId === p.id)
          if (rows.length === 0 && query !== "") return null
          return (
            <section key={p.id}>
              <h3 className="proj-h">▾ {p.name}</h3>
              {rows.map((w) => <WsRow key={w.id} ws={w} />)}
              {rows.length === 0 && <div className="dim empty-hint">⌘N 创建第一个 workspace</div>}
            </section>
          )
        })}
        {archived.length > 0 && (
          <section>
            <h3 className="proj-h">▸ 已归档（{archived.length}）</h3>
            {archived.map((w) => <WsRow key={w.id} ws={w} />)}
          </section>
        )}
        {projects.length === 0 && <AddProject />}
      </div>
      <div className="side-footer">
        <button className="dim" onClick={() => useUi.getState().setCheatsheet(true)}>⚙ 设置 / ⌘/ 快捷键</button>
      </div>
    </div>
  )
}

const AddProject = () => (
  <div className="add-project">
    <p className="dim">还没有项目。输入 repo 绝对路径：</p>
    <input
      className="side-search" placeholder="/path/to/repo（回车添加）"
      onKeyDown={(e) => {
        if (e.key !== "Enter") return
        const v = (e.target as HTMLInputElement).value.trim()
        if (v === "") return
        void useData.getState().getApi()?.req("POST", "/projects", { repoRoot: v })
          .then(() => useData.getState().refreshProjects())
          .catch((err) => alert(`添加失败：${err.message}`))
      }}
    />
  </div>
)
```

（M1 设置页只放 cheatsheet 入口——name pool/主题等 spec 标注"优先级低/M2"。项目添加用路径输入而非系统文件对话框：省 dialog 插件依赖，M2 换。）

- [ ] **Step 2: App.tsx 挂载**

`App.tsx` 中 `<aside className="col-left">{/* Task 9: <Sidebar/> */}</aside>` 改为：

```tsx
<aside className="col-left"><Sidebar /></aside>
```

（顶部 `import { Sidebar } from "./sidebar/Sidebar"`。）

- [ ] **Step 3: styles.css 追加**

```css
/* === sidebar (Task 9) === */
.sidebar { display: flex; flex-direction: column; height: 100%; }
.side-actions { padding: 10px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--border); }
.side-new { text-align: left; padding: 6px 10px; border-radius: 6px; background: var(--panel); }
.side-new:hover { background: rgba(255,255,255,0.08); }
.side-new kbd { float: right; color: var(--fg-dim); font-size: 11px; }
.side-search { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; color: var(--fg); outline: none; }
.side-list { flex: 1; overflow-y: auto; padding: 8px 6px; }
.proj-h { font-size: 11px; color: var(--fg-dim); padding: 8px 6px 4px; text-transform: none; }
.ws-row { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 6px; overflow: hidden; }
.ws-row:hover { background: var(--panel); } .ws-row.selected { background: rgba(122,162,247,0.18); }
.ws-name { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-branch { flex: 1; color: var(--fg-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { flex: none; width: 14px; text-align: center; }
.b-working { color: var(--accent); } .b-await { color: var(--ok); } .b-error { color: var(--danger); }
.b-idle, .b-archived { color: var(--fg-dim); } .b-creating { color: var(--warn); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
.diffcount { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; }
.diffcount .plus { color: var(--ok); font-style: normal; margin-right: 4px; }
.diffcount .minus { color: var(--danger); font-style: normal; }
.side-footer { border-top: 1px solid var(--border); padding: 8px 10px; }
.empty-hint { padding: 4px 8px; font-size: 12px; }
.add-project { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
```

- [ ] **Step 4: 验证**

```bash
bun run typecheck && cd packages/client && bunx tauri dev
```

手工核对：添加本 repo 为项目 → 出现在左栏；`coolie create`（另开终端，同 COOLIE_HOME）创建一个 workspace → SSE 推动左栏出现 creating（◌ 闪烁）→ active；在 worktree 里改个文件 → 5s 内出现 `+N−M`；搜索框过滤生效；Cmd+1 选中第一个。

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): 左栏 Sidebar——三段式/两层列表/状态徽标/+N−M 轮询/搜索/归档区"
```

---

### Task 10: 终端会话（xterm.js 6 + WS 二进制 + fit/heal + WebGL fallback + 三层仲裁接线）

终端核心：`session.ts` 管理 xterm 实例与 WS 生命周期（**tab 切换不销毁**——DOM 迁移 + visibility 隐藏，保持 scrollback 与连接；但**惰性挂载**：只有被看过的 tab 才建会话，未看过的后台 tab 零 WS——见 Task 11 F3），`Terminal.tsx` 只做挂载点。接线要点（tauri-terminal-poc / superset 实测结论）：fit **先于** connect（首帧尺寸即正确，attach 时 tmux 自动全量重绘）、fonts.ready 后再 refit（字体度量 settle 前 WebGL atlas 会用错度量）、WebGL context loss → dispose → DOM 渲染兜底、resize 客户端 150ms 防抖（server 侧另有 50ms trailing）。

**Files:**
- Create: `packages/client/src/terminal/session.ts`
- Create: `packages/client/src/terminal/Terminal.tsx`
- Modify: `packages/client/src/styles.css`（追加）

**Interfaces:**
- Consumes: `Api.wsTerminalUrl`（Task 4）、`arbitrateTerminalKey`（Task 7）、`@xterm/xterm` + fit + webgl
- Produces:
  - `getOrCreateSession(key: string, make: () => TermSession): TermSession`、`disposeSession(key)`、`disposeWorkspaceSessions(wsId)`（key 约定 `${wsId}:${window}`）
  - `interface TermSession { el; term; mount(container): void; unmount(): void; focus(): void; dispose(): void; readonly state: "connecting"|"open"|"exited"|"dead"; onStateChange?: (s) => void; exitCode: number | null }`
  - `<TerminalView sessionKey wsId window/>` React 组件（含退出横幅 + Reconnect）

- [ ] **Step 1: 实现 session.ts**

`packages/client/src/terminal/session.ts`：

```ts
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { arbitrateTerminalKey } from "./arbitrate"
import type { Api } from "../api/client"

export type TermState = "connecting" | "open" | "exited" | "dead"

export interface TermSession {
  readonly el: HTMLDivElement
  readonly term: Terminal
  state: TermState
  exitCode: number | null
  onStateChange?: (s: TermState) => void
  mount(container: HTMLElement): void
  unmount(): void
  focus(): void
  reconnect(): void
  dispose(): void
}

const enc = new TextEncoder()

export const createTermSession = (api: Api, workspaceId: string, windowIdx: number): TermSession => {
  const el = document.createElement("div")
  el.className = "term-host"
  const term = new Terminal({
    fontFamily: "Menlo, Monaco, 'SF Mono', monospace",
    fontSize: 13,
    scrollback: 10_000,
    allowProposedApi: true,
    theme: { background: "#00000000" }, // vibrancy 透出；xterm 6 支持 alpha 背景
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  let ws: WebSocket | null = null
  let opened = false
  let disposed = false
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let ro: ResizeObserver | null = null

  const session: TermSession = {
    el, term, state: "connecting", exitCode: null,
    mount(container) {
      container.appendChild(el)
      if (!opened) {
        opened = true
        term.open(el)
        void loadRenderer()
        safeFit()
        connect()
        // heal：字体度量 settle 后 refit（首帧 WebGL atlas 用错度量的经典坑，superset plans/20260425）
        void document.fonts.ready.then(() => { safeFit(); pushResize() })
        ro = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => { safeFit(); pushResize() }, 150)
        })
        ro.observe(el)
      } else {
        safeFit()
        pushResize()
      }
    },
    unmount() { el.parentElement?.removeChild(el) }, // xterm 实例保活：scrollback/连接不丢
    focus() { term.focus() },
    reconnect() {
      if (disposed) return
      setState("connecting")
      session.exitCode = null
      connect()
    },
    dispose() {
      disposed = true
      ro?.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      try { ws?.close() } catch { /* already */ }
      term.dispose()
      el.remove()
    },
  }

  const setState = (s: TermState): void => { session.state = s; session.onStateChange?.(s) }

  const safeFit = (): void => {
    // 容器无尺寸（display:none/未布局）时 fit 会抛：吞掉，等下一次
    try { if (el.clientWidth > 4 && el.clientHeight > 4) fit.fit() } catch { /* skip */ }
  }

  const pushResize = (): void => {
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
  }

  const loadRenderer = async (): Promise<void> => {
    // WebGL → DOM fallback（xterm #5816 macOS beta WebGL 损坏 + context loss；claude-terminal try/catch 模式）
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl")
      const gl = new WebglAddon()
      gl.onContextLoss(() => gl.dispose()) // dispose 后 xterm 自动回落 DOM 渲染
      term.loadAddon(gl)
    } catch { /* DOM 渲染兜底 */ }
  }

  const connect = (): void => {
    const sock = new WebSocket(api.wsTerminalUrl(workspaceId, windowIdx, term.cols, term.rows))
    sock.binaryType = "arraybuffer"
    ws = sock
    sock.onopen = () => { setState("open"); pushResize() } // tmux attach 自带全量重绘，无需额外 heal 帧
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data)
          if (msg?.type === "exit") { session.exitCode = msg.code ?? null; setState("exited") }
        } catch { /* 未知控制帧忽略 */ }
        return
      }
      term.write(new Uint8Array(ev.data as ArrayBuffer)) // 二进制帧 → 零解码直写（spec §2.3）
    }
    sock.onclose = () => { if (session.state === "open" || session.state === "connecting") setState("dead") } // server 崩/4404
  }

  // 输入：xterm onData（含粘贴/IME 提交）→ 二进制帧
  term.onData((d) => { if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d)) })

  // 三层键位仲裁（Task 7 纯函数）：bubble → xterm bail 且事件冒泡给 document；write → 直写 PTY
  term.attachCustomKeyEventHandler((e) => {
    const decision = arbitrateTerminalKey(e as unknown as Parameters<typeof arbitrateTerminalKey>[0])
    if (decision.action === "pty") return true
    if (decision.action === "write") {
      e.preventDefault()
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(decision.bytes))
      return false
    }
    return false // bubble：xterm 不处理，事件自然冒泡到全局 dispatcher
  })

  return session
}

/* ---- 会话注册表：tab 切换/组件卸载不销毁（终端保活归 GUI 生命周期，engine 保活归 tmux） ----
 * 生命周期上界（F2/F3）：会话只在 (a) workspace 归档/删除 → disposeWorkspaceSessions（data store applyEvent 调用），
 *   或 (b) 手动关 shell tab → disposeSession 时回收；从不在 tab 切换/卸载时断连。
 * 惰性挂载（F3）：只有被看过的 tab 才进注册表——CenterArea 只给 active/已看过的 tab 渲染 TerminalView，
 *   未看过的后台 tab 是占位符、零 WS。因此活会话数 ≤ 用户实际看过的 tab 数（人手频度，天然有界）。
 * LRU 上界（可选，cheap）：若某 workspace tab 极多，可在 getOrCreateSession 里对同 wsId 前缀的会话按最近 mount 时间
 *   淘汰到 N（如 8）个——M1 不实装（Map 迭代顺序即插入序，加一个 lastTouch 时间戳与阈值即可），记为已知延展点。 */
const sessions = new Map<string, TermSession>()

export const sessionKey = (wsId: string, windowIdx: number): string => `${wsId}:${windowIdx}`
export const getOrCreateSession = (key: string, make: () => TermSession): TermSession => {
  // dead/exited 会话刻意保留复用（Reconnect 走 session.reconnect()，xterm 画面不清空）
  let s = sessions.get(key)
  if (!s) { s = make(); sessions.set(key, s) }
  return s
}
export const disposeSession = (key: string): void => { sessions.get(key)?.dispose(); sessions.delete(key) }
export const disposeWorkspaceSessions = (wsId: string): void => {
  for (const [k, s] of sessions) if (k.startsWith(`${wsId}:`)) { s.dispose(); sessions.delete(k) }
}
```

- [ ] **Step 2: 实现 Terminal.tsx**

`packages/client/src/terminal/Terminal.tsx`：

```tsx
import { useEffect, useRef, useState } from "react"
import { useData } from "../stores/data"
import { createTermSession, getOrCreateSession, sessionKey, disposeWorkspaceSessions, type TermState } from "./session"

// F2：Terminal 模块一加载就把真实的会话回收器注入 data store。
// store 里默认是 noop（保持 store 纯 node 可测）；一旦终端进场，workspace.archived/deleted 即触发按 ws 断连。
useData.getState().setSessionDisposer(disposeWorkspaceSessions)

/**
 * 退出横幅的 Resume：[Plan 4 contract — verify at execution]
 * Plan 4 提供 engine keep-alive + resume API 后接真按钮（POST resume → session 复活）。
 * 未合并时降级提示走 Open in iTerm2 手动 `claude --resume`。
 */
export const TerminalView = ({ wsId, windowIdx, active }: { wsId: string; windowIdx: number; active: boolean }) => {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<TermState>("connecting")
  const api = useData((s) => s.getApi())

  useEffect(() => {
    if (!api || !host.current) return
    const key = sessionKey(wsId, windowIdx)
    const s = getOrCreateSession(key, () => createTermSession(api, wsId, windowIdx))
    s.onStateChange = setState
    setState(s.state)
    s.mount(host.current)
    if (active) s.focus()
    return () => { s.unmount() } // 保活：只摘 DOM
  }, [api, wsId, windowIdx])

  useEffect(() => {
    if (!active || !api) return
    getOrCreateSession(sessionKey(wsId, windowIdx), () => createTermSession(api, wsId, windowIdx)).focus()
  }, [active, api, wsId, windowIdx])

  const reconnect = (): void => {
    if (!api) return
    getOrCreateSession(sessionKey(wsId, windowIdx), () => createTermSession(api, wsId, windowIdx)).reconnect()
  }

  return (
    <div className="term-wrap" style={{ visibility: active ? "visible" : "hidden", zIndex: active ? 1 : 0 }}>
      <div className="term-container" ref={host} />
      {(state === "exited" || state === "dead") && (
        <div className="term-banner">
          <span>{state === "exited" ? "进程已退出" : "连接已断开（server 重启/会话丢失）"}</span>
          <button className="btn" onClick={reconnect}>重新连接</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: styles.css 追加**

```css
/* === terminal (Task 10) === */
.term-stack { position: relative; flex: 1; min-height: 0; }
.term-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; }
.term-container { flex: 1; min-height: 0; padding: 4px 0 0 8px; }
.term-host { width: 100%; height: 100%; }
.term-banner {
  position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 12px; align-items: center;
  justify-content: center; padding: 10px; background: rgba(247,118,142,0.15); border-top: 1px solid var(--danger);
}
.xterm .xterm-viewport { background: transparent !important; }
```

- [ ] **Step 4: 验证（typecheck + build）**

```bash
bun run typecheck && cd packages/client && bunx vite build
```

Expected: 绿。（运行验证并入 Task 11——需要 tabs 栏才能看到终端。）

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): xterm 终端会话——WS 二进制/fit+fonts-heal/WebGL fallback/仲裁接线/保活注册表"
```

---

### Task 11: 终端 TabsBar（engine/setup/run/shell + New Shell + 关 tab + Open in iTerm2）

中央区顶部 tabs 栏：tabs 来自 tabs API（GUI tab ↔ tmux window 映射），tab 徽标同 `wsBadge` 规则；`＋`/Cmd+T 新建 shell tab（POST）、Cmd+W 关当前 shell tab（DELETE，engine/setup/run 不可关）；**Open in iTerm2** 一等公民按钮（`tmux -L <socket> attach -t coolie-<wsId>`，spec §五：里外同一画面）。

**Files:**
- Create: `packages/client/src/terminal/TabsBar.tsx`
- Modify: `packages/client/src/App.tsx`（中央区挂 TabsBar + 终端栈）
- Modify: `packages/client/src/styles.css`（追加）

**Interfaces:**
- Consumes: `useData`（tabsByWs/config/getApi/refreshTabs）、`useUi`（selectedTabByWs/selectTab）、`TerminalView`（Task 10）、`spawnDetached` 复用（osascript）、`pushHotkeyLayer`（补 tab.* 的 handler）
- Produces: `<CenterArea/>`（TabsBar + 终端栈 + 后续 Composer 的挂点）；`openInIterm(tmuxSocket, wsId)`

- [ ] **Step 1: 实现 TabsBar + CenterArea**

`packages/client/src/terminal/TabsBar.tsx`：

```tsx
import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { Tab } from "@coolie/protocol"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { pushHotkeyLayer } from "../hotkeys/dispatch"
import { TerminalView } from "./Terminal"

/** Open in iTerm2（spec §五）：osascript 起新窗口 attach 同一 tmux session——里外同一画面 */
const SHELL_SAFE = /^[A-Za-z0-9._-]+$/ // F6：socket 名/wsId 拼进 AppleScript 前的白名单——挡引号/分号/换行注入
export const openInIterm = async (tmuxSocket: string, wsId: string): Promise<void> => {
  if (!SHELL_SAFE.test(tmuxSocket) || !SHELL_SAFE.test(wsId))
    throw new Error(`拒绝打开：非法 socket/wsId（仅允许字母数字 . _ -）：${tmuxSocket} / ${wsId}`)
  const cmd = `tmux -L ${tmuxSocket} attach -t coolie-${wsId}`
  const script = [
    'tell application "iTerm2"',
    "  activate",
    "  set w to (create window with default profile)",
    `  tell current session of w to write text "${cmd}"`,
    "end tell",
  ].join("\n")
  await invoke("spawn_detached", { program: "/usr/bin/osascript", args: ["-e", script] })
}

const tabLabel = (t: Tab): string => {
  if (t.kind === "engine") return t.title ?? "claude" // displayName 来自 server config；title 由 historyReader 派生
  return t.kind
}

export const CenterArea = ({ wsId }: { wsId: string }) => {
  const tabs = useData((s) => s.tabsByWs[wsId]) ?? []
  const config = useData((s) => s.config)
  const engines = config?.engines ?? []
  const selectedId = useUi((s) => s.selectedTabByWs[wsId]) ?? tabs[0]?.id
  const selected = tabs.find((t) => t.id === selectedId) ?? tabs[0]

  // F3 惰性挂载（spec §五："PTY per 在看的 tab"）：只有被看过的 tab 才挂活 TerminalView/WS；
  // 未看过的后台 tab 是零连接占位符。看过一次即进 viewed，之后切走仍保活（会话注册表语义 + F2 归档回收）。
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (!selected) return
    setViewed((v) => v.has(selected.id) ? v : new Set(v).add(selected.id))
  }, [selected?.id])

  const newShell = async (): Promise<void> => {
    const api = useData.getState().getApi()
    if (!api) return
    const tab = await api.req("POST", `/workspaces/${wsId}/tabs`, { kind: "shell" })
    useUi.getState().selectTab(wsId, tab.id)
  }
  const closeTab = async (t: Tab): Promise<void> => {
    if (t.kind !== "shell") return // engine/setup/run 不可关（tmux window 归 lifecycle 管）
    const api = useData.getState().getApi()
    if (!api) return
    await api.req("DELETE", `/workspaces/${wsId}/tabs/${t.id}`)
  }

  // tab.* 全局键：随 CenterArea 挂载压层（LIFO：晚于 App base layer，优先命中）
  useEffect(() => {
    return pushHotkeyLayer({
      "tab.newShell": () => void newShell().catch((e) => alert(e.message)),
      "tab.close": () => { if (selected) void closeTab(selected).catch((e) => alert(e.message)) },
    })
  }, [wsId, selected?.id])

  const engineName = (id: string | null) => engines.find((e) => e.id === id)?.displayName ?? id ?? "engine"

  return (
    <div className="center-area">
      <div className="tabsbar">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${t.id === selected?.id ? "active" : ""}`}
            title={t.kind === "engine" ? engineName(t.engineId) : t.kind}
            onClick={() => useUi.getState().selectTab(wsId, t.id)}
          >
            {t.kind === "engine" && <span className={`badge b-${t.status}`}>●</span>}
            <span>{tabLabel(t)}</span>
            {t.kind === "shell" && (
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(t) }}>×</span>
            )}
          </button>
        ))}
        <button className="tab tab-new" title="新 shell tab（⌘T）" onClick={() => void newShell()}>＋</button>
        <div className="tabsbar-spacer" />
        <button
          className="iterm-btn"
          title="在 iTerm2 中打开（同一 tmux 会话）"
          onClick={() => config && void openInIterm(config.tmuxSocket, wsId)}
        >↗ Open in iTerm2</button>
      </div>
      <div className="term-stack">
        {tabs.filter((t) => t.tmuxWindow !== null).map((t) =>
          // 惰性挂载（F3）：active 或已看过 → 活 TerminalView（active 条件保证首帧不闪占位）；否则零 WS 占位符。
          viewed.has(t.id) || t.id === selected?.id ? (
            <TerminalView key={t.id} wsId={wsId} windowIdx={t.tmuxWindow!} active={t.id === selected?.id} />
          ) : (
            <div key={t.id} className="term-wrap term-placeholder" style={{ visibility: "hidden" }} aria-hidden />
          ),
        )}
        {tabs.length === 0 && <div className="dim center-empty">无终端 tab（workspace 可能已归档）</div>}
      </div>
    </div>
  )
}
```

（徽标 class 直接用 `b-${t.status}`——`b-working/b-awaiting-input/b-error/b-idle`；styles 里补 `b-awaiting-input` 别名。）

- [ ] **Step 2: App.tsx 中央区挂载**

`<main className="col-center">…</main>` 改为：

```tsx
<main className="col-center">
  {selectedWs ? <CenterArea wsId={selectedWs} /> : <div className="dim center-empty">选择或创建一个 workspace（⌘N）</div>}
</main>
```

（`const selectedWs = useUi((s) => s.selectedWs)`；import CenterArea。）

- [ ] **Step 3: styles.css 追加**

```css
/* === tabsbar (Task 11) === */
.center-area { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tabsbar { flex: none; display: flex; align-items: center; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--border); }
.tab { display: flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 6px 6px 0 0; color: var(--fg-dim); }
.tab.active { background: var(--panel); color: var(--fg); }
.tab .badge { font-size: 9px; }
.b-awaiting-input { color: var(--ok); }
.tab-close { margin-left: 4px; padding: 0 2px; border-radius: 3px; }
.tab-close:hover { background: rgba(255,255,255,0.15); }
.tab-new { padding: 5px 8px; }
.tabsbar-spacer { flex: 1; }
.iterm-btn { font-size: 12px; color: var(--fg-dim); padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; }
.iterm-btn:hover { color: var(--fg); background: var(--panel); }
.center-empty { display: flex; align-items: center; justify-content: center; height: 100%; }
```

- [ ] **Step 4: 运行验证（第一次看到 claude TUI 的里程碑）**

```bash
bun run typecheck && cd packages/client && bunx tauri dev
```

手工核对（真 claude）：选中一个 active workspace → engine tab 显示 claude TUI（tmux 吸收重画，无 scroll-jump）；打字/回车正常；Cmd+T 开 shell tab（zsh 提示符）、Cmd+W 关掉；`↗ Open in iTerm2` 弹出 iTerm2 且画面与 GUI 完全同步；杀掉 daemon（`coolie server stop`）→ 横幅出现 →（SSE 自动拉起 daemon 后）点重新连接恢复画面（tmux 无损）。

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): 终端 TabsBar——tabs API 映射/New Shell/关 tab/Open in iTerm2/退出横幅"
```

---

### Task 12: Composer 核心（textarea + 三档发送/打断 + 草稿 + 排队指示 + 模型选择器）

常驻 Composer（spec §7.2）：绑定当前 workspace 的**写-only surface**——回答由 engine TUI 渲染，composer 只把话打好投出去。真 textarea（IME/Cmd+A/Option+←→ 由 WebKit 原生提供）；键位走 Task 7 `planComposerKey`；投递走 Task 3 `POST /input`；每 workspace 草稿 localStorage；⏳ 排队指示可撤回；模型选择器按能力位降级（claude：`midSessionModelSwitch=true` → `/model` 投递；`effort=false` → effort 控件隐藏）。

> **F4（空闲发送延迟，明确取舍）：** 空闲态 Enter → `skipStable=false` → server 走完整 `deliverPrompt`，其中 `waitStable` 带 `minElapsedMs=1500` 的稳定地板 → **每条空闲投递有约 1.5s 底延**。**本计划的选择：接受为 M1 行为，不做变更**——理由：(1) 1.5s 地板正是防"engine 正在重画时抢投导致 prompt 撕裂"的安全裕度，空闲判定（`engineWorking=false`）依赖的是 tab.status，而 status 有 SSE 传播延迟与 hook 抖动，贸然对"看起来空闲"就传缩短的稳定参数会把安全边界让给一个不完全可信的信号；(2) M1 唯一引擎 claude 的 `nativeQueue=true`——真急的连投场景用户可在 engine working 时直投（`skipStable=true`，零地板），空闲单条的 1.5s 是可接受的一次性成本。M2 若接入无 nativeQueue 的引擎、或让 server 暴露"暖空闲"（status ready + 近窗 hook 活动证据）的缩短档稳定参数，再回来收窄此延迟。乐观清空（`update("")`）已让这 1.5s 内用户可继续打下一条，主观延迟被吸收。

**Files:**
- Create: `packages/client/src/composer/drafts.ts`
- Create: `packages/client/src/composer/Composer.tsx`
- Modify: `packages/client/src/App.tsx`（中央区挂 Composer）
- Modify: `packages/client/src/styles.css`（追加）
- Test: `packages/client/test/drafts.test.ts`

**Interfaces:**
- Consumes: `planComposerKey`（Task 7）、`useData.sendInput/pendingSends/cancelSend`（Task 6）、`useUi.composerFocusNonce`、engine 能力位（`useData.config.engines`）
- Produces:
  - `makeDrafts(storage): { load(wsId): string; save(wsId, text): void; clear(wsId): void }`（storage 注入 → node 可测）
  - `<Composer wsId/>`（Task 15 的 dispatch 模式会复用同一组件——本任务预留 `onSubmitOverride` prop）
  - `deliverModelSwitch(wsId, model)`：`/model <m>` 经 input 端点投递

- [ ] **Step 1: drafts 失败测试**

`packages/client/test/drafts.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { makeDrafts } from "../src/composer/drafts.js"

const memStorage = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe("makeDrafts", () => {
  it("per-workspace 隔离存取", () => {
    const d = makeDrafts(memStorage())
    d.save("A", "draft-a"); d.save("B", "draft-b")
    expect(d.load("A")).toBe("draft-a")
    expect(d.load("B")).toBe("draft-b")
  })
  it("未存过 → 空串；clear 后 → 空串", () => {
    const d = makeDrafts(memStorage())
    expect(d.load("X")).toBe("")
    d.save("X", "temp"); d.clear("X")
    expect(d.load("X")).toBe("")
  })
})
```

Run: `bunx vitest run packages/client/test/drafts.test.ts` → Expected: FAIL

- [ ] **Step 2: 实现 drafts.ts**

`packages/client/src/composer/drafts.ts`：

```ts
/** 每 workspace 草稿持久化（spec §7.2）；storage 注入使 node 可测 */
export interface DraftStorage {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

export const makeDrafts = (storage: DraftStorage) => ({
  load: (wsId: string): string => storage.getItem(`coolie.draft.${wsId}`) ?? "",
  save: (wsId: string, text: string): void => {
    if (text === "") storage.removeItem(`coolie.draft.${wsId}`)
    else storage.setItem(`coolie.draft.${wsId}`, text)
  },
  clear: (wsId: string): void => storage.removeItem(`coolie.draft.${wsId}`),
})
```

Run: `bunx vitest run packages/client/test/drafts.test.ts` → Expected: PASS

- [ ] **Step 3: 实现 Composer.tsx**

`packages/client/src/composer/Composer.tsx`：

```tsx
import { useEffect, useRef, useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { planComposerKey } from "./send"
import { makeDrafts } from "./drafts"

const drafts = makeDrafts(localStorage)

/** /model 投递：会话中切模型 = 翻译成 slash 命令（capabilities.midSessionModelSwitch 控制可用性） */
export const deliverModelSwitch = (wsId: string, model: string, engineWorking: boolean): Promise<void> =>
  useData.getState().sendInput(wsId, { text: `/model ${model}`, mode: "send", skipStable: engineWorking })

const QueueIndicator = ({ wsId }: { wsId: string }) => {
  const pending = useData((s) => s.pendingSends.filter((p) => p.wsId === wsId))
  if (pending.length === 0) return null
  return (
    <div className="queue-ind">
      ⏳ {pending.length} 条投递中
      {pending.map((p) => (
        <button key={p.id} className="queue-cancel" title={`撤回：${p.text.slice(0, 40)}`}
          onClick={() => useData.getState().cancelSend(p.id)}>×</button>
      ))}
    </div>
  )
}

export interface ComposerProps {
  wsId: string
  /** dispatch 模式（Task 15）：接管 Enter 提交（创建 workspace），三档语义停用 */
  onSubmitOverride?: (text: string) => void
  placeholder?: string
}

export const Composer = ({ wsId, onSubmitOverride, placeholder }: ComposerProps) => {
  const ta = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(() => drafts.load(wsId))
  const focusNonce = useUi((s) => s.composerFocusNonce)
  const tabs = useData((s) => s.tabsByWs[wsId])
  const config = useData((s) => s.config)
  const engineTab = tabs?.find((t) => t.kind === "engine")
  const engineWorking = engineTab?.status === "working"
  const engine = config?.engines.find((e) => e.id === (engineTab?.engineId ?? "claude"))
  const [model, setModel] = useState("default")

  useEffect(() => { setText(drafts.load(wsId)) }, [wsId])
  useEffect(() => { ta.current?.focus() }, [focusNonce])

  const update = (v: string): void => { setText(v); drafts.save(wsId, v) }

  const deliver = async (mode: "send" | "interrupt-send" | "insert", skipStable: boolean): Promise<void> => {
    const body = text.trim()
    if (body === "") return
    update("") // 先清（乐观）：投递数秒内用户可继续打下一条；失败恢复草稿
    try {
      await useData.getState().sendInput(wsId, { text: body, mode, skipStable })
    } catch (e: any) {
      update(body)
      alert(`投递失败：${e?.message ?? e}`)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (onSubmitOverride) {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        const body = text.trim()
        if (body !== "") { onSubmitOverride(body); update("") }
      }
      if (e.key === "Escape") { e.preventDefault(); useUi.getState().setDispatchMode(false) }
      return
    }
    const action = planComposerKey(e, { engineWorking: engineWorking === true })
    switch (action.kind) {
      case "newline": return // textarea 默认行为
      case "none": return
      case "blur": e.preventDefault(); ta.current?.blur(); return // Esc 失焦回终端（双击 Esc 自然形成失焦→打断）
      case "send": e.preventDefault(); void deliver("send", action.skipStable); return
      case "insert": e.preventDefault(); void deliver("insert", action.skipStable); return
      case "interrupt-send": e.preventDefault(); void deliver("interrupt-send", false); return
    }
  }

  const interrupt = (): void => {
    void useData.getState().sendInput(wsId, { text: "", mode: "interrupt", skipStable: true }).catch(() => {})
  }

  const switchModel = (m: string): void => {
    setModel(m)
    if (m === "default") return
    if (engine?.capabilities.midSessionModelSwitch)
      void deliverModelSwitch(wsId, m, engineWorking === true).catch((e) => alert(`切换失败：${e.message}`))
  }

  return (
    <div className="composer">
      <QueueIndicator wsId={wsId} />
      <div className="composer-box">
        <textarea
          ref={ta}
          value={text}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          placeholder={placeholder ?? "给 engine 的话… Enter 发送 · ⌘Enter 打断并发送 · ⌥Enter 仅插入 · ⇧Enter 换行"}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-side">
          {engineWorking && (
            <button className="stop-btn" title="打断（⌘.）" onClick={interrupt}>■</button>
          )}
          {engine && engine.capabilities.midSessionModelSwitch && !onSubmitOverride && (
            <select className="model-sel" value={model} onChange={(e) => switchModel(e.target.value)} title="模型（投 /model）">
              {engine.models.map((m) => <option key={m} value={m}>{engine.displayName}·{m}</option>)}
            </select>
          )}
          {/* effort 选择器：engine.capabilities.effort=false（claude）→ 不渲染（Noop 降级，M2 codex 启用） */}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: App.tsx 挂 Composer + styles**

CenterArea 之下（`col-center` 内、终端栈之后）挂常驻 composer——修改 App.tsx 的中央区：

```tsx
<main className="col-center">
  {selectedWs ? (
    <>
      <CenterArea wsId={selectedWs} />
      <Composer wsId={selectedWs} />
    </>
  ) : <div className="dim center-empty">选择或创建一个 workspace（⌘N）</div>}
</main>
```

styles.css 追加：

```css
/* === composer (Task 12) === */
.composer { flex: none; border-top: 1px solid var(--border); padding: 10px 12px; }
.composer-box { display: flex; gap: 8px; align-items: flex-end; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; }
.composer-box:focus-within { border-color: var(--accent); }
.composer textarea {
  flex: 1; background: transparent; border: none; outline: none; resize: none;
  color: var(--fg); font: inherit; line-height: 1.5; max-height: 180px;
}
.composer-side { display: flex; gap: 6px; align-items: center; }
.model-sel { background: #1a1a1e; color: var(--fg-dim); border: 1px solid var(--border); border-radius: 6px; font-size: 11px; padding: 3px 4px; }
.stop-btn { color: var(--danger); font-size: 14px; padding: 2px 8px; border: 1px solid var(--danger); border-radius: 6px; }
.queue-ind { font-size: 11px; color: var(--warn); padding: 0 2px 6px; display: flex; gap: 6px; align-items: center; }
.queue-cancel { color: var(--fg-dim); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
```

- [ ] **Step 5: 运行验证（真 claude 三档走查）**

```bash
bun run typecheck && cd packages/client && bunx tauri dev
```

手工核对：Enter 空闲发送（claude 收到并渲染）；claude 工作中 Enter → 直投（claude TUI 显示排队，composer 短暂 ⏳）；Cmd+Enter → claude 停下当前 turn 后收到新话；Option+Enter → 文本出现在 claude 输入行**未提交**，去终端可继续编辑；Shift+Enter 换行；Cmd+. / ■ 打断；切 workspace 草稿各自保留；模型选择器切 opus → claude 内可见 /model 生效；Esc 失焦后焦点回终端。

- [ ] **Step 6: Commit**

```bash
git add packages/client
git commit -m "feat(client): 常驻 Composer——三档发送/打断/草稿/排队撤回/模型选择器（能力位降级）"
```

---

### Task 13: Composer pickers（@文件模糊选择 + /命令补全）

`@` 弹文件模糊选择器（`GET /files` + 客户端 subsequence 模糊匹配，选中插入 `@相对路径`）；行首 `/` 弹命令补全（内置命令 + `GET /commands` 扫描结果）。选择器打开时压一层 hotkey layer（吞掉 Cmd+N/T/W 防误触），↑↓/Enter/Tab 选择、Esc 关闭。

**Files:**
- Create: `packages/client/src/composer/fuzzy.ts`
- Create: `packages/client/src/composer/Picker.tsx`
- Modify: `packages/client/src/composer/Composer.tsx`（接入 token 检测与插入）
- Modify: `packages/client/src/styles.css`（追加）
- Test: `packages/client/test/fuzzy.test.ts`

**Interfaces:**
- Consumes: `GET /workspaces/:id/files`、`GET /workspaces/:id/commands`（Task 2）、`pushHotkeyLayer`
- Produces:
  - `fuzzyFilter(items: string[], query: string, limit?): string[]`（subsequence + 连续/词首加分）
  - `detectToken(text: string, caret: number): { kind: "file" | "command"; query: string; start: number } | null`
  - `<Picker items onPick onClose/>`；Composer 的 `insertAtToken(replacement)`

- [ ] **Step 1: fuzzy/detectToken 失败测试**

`packages/client/test/fuzzy.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { fuzzyFilter, detectToken } from "../src/composer/fuzzy.js"

describe("fuzzyFilter", () => {
  const files = ["src/api/client.ts", "src/api/sse.ts", "packages/server/src/main.ts", "README.md"]
  it("subsequence 命中 + 连续匹配靠前", () => {
    const r = fuzzyFilter(files, "apicli")
    expect(r[0]).toBe("src/api/client.ts")
  })
  it("空 query 返回前 limit 条；无命中返回空", () => {
    expect(fuzzyFilter(files, "", 2)).toHaveLength(2)
    expect(fuzzyFilter(files, "zzzz")).toEqual([])
  })
  it("大小写不敏感", () => {
    expect(fuzzyFilter(files, "readme")).toContain("README.md")
  })
})

describe("detectToken", () => {
  it("@ 触发 file token（词起始处）", () => {
    expect(detectToken("看下 @src/ap", 9)).toEqual({ kind: "file", query: "src/ap", start: 3 })
  })
  it("行首 / 触发 command token；非行首 / 不触发", () => {
    expect(detectToken("/mod", 4)).toEqual({ kind: "command", query: "mod", start: 0 })
    expect(detectToken("a /mod", 6)).toBeNull()
  })
  it("token 中断（空格后）→ null；email 里的 @ 不触发", () => {
    expect(detectToken("@src ok", 7)).toBeNull()
    expect(detectToken("a@b", 3)).toBeNull()
  })
})
```

Run: `bunx vitest run packages/client/test/fuzzy.test.ts` → Expected: FAIL

- [ ] **Step 2: 实现 fuzzy.ts**

`packages/client/src/composer/fuzzy.ts`：

```ts
/** subsequence 模糊匹配：连续命中 +3/字符、词首（/ . - _ 后）+2、其余 +1；未全命中 = 淘汰 */
const score = (item: string, query: string): number => {
  const s = item.toLowerCase()
  const q = query.toLowerCase()
  let si = 0, total = 0, streak = 0
  for (const ch of q) {
    const at = s.indexOf(ch, si)
    if (at === -1) return -1
    const wordStart = at === 0 || "/._-".includes(s[at - 1]!)
    streak = at === si ? streak + 1 : 1
    total += streak >= 2 ? 3 : wordStart ? 2 : 1
    si = at + 1
  }
  return total - item.length * 0.01 // 等分时短路径优先
}

export const fuzzyFilter = (items: readonly string[], query: string, limit = 12): string[] => {
  if (query === "") return items.slice(0, limit)
  return items
    .map((item) => ({ item, sc: score(item, query) }))
    .filter((x) => x.sc >= 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit)
    .map((x) => x.item)
}

export interface TokenHit { kind: "file" | "command"; query: string; start: number }

/** caret 前的当前 token：@… 任意词起始处 = file；/… 仅行首 = command */
export const detectToken = (text: string, caret: number): TokenHit | null => {
  const upto = text.slice(0, caret)
  const wordStart = Math.max(upto.lastIndexOf(" "), upto.lastIndexOf("\n")) + 1
  const token = upto.slice(wordStart)
  if (token.startsWith("@") && token.length >= 1)
    return { kind: "file", query: token.slice(1), start: wordStart }
  if (token.startsWith("/") && wordStart === 0)
    return { kind: "command", query: token.slice(1), start: 0 }
  return null
}
```

Run: `bunx vitest run packages/client/test/fuzzy.test.ts` → Expected: PASS

- [ ] **Step 3: Picker.tsx + Composer 接入**

`packages/client/src/composer/Picker.tsx`：

```tsx
import { useEffect, useState } from "react"
import { pushHotkeyLayer } from "../hotkeys/dispatch"

export const Picker = ({ items, onPick, onClose }: {
  items: string[]; onPick: (item: string) => void; onClose: () => void
}) => {
  const [idx, setIdx] = useState(0)
  useEffect(() => setIdx(0), [items.join("\n")])
  // 打开期间吞掉全局键（LIFO 层）
  useEffect(() => pushHotkeyLayer({ "workspace.new": () => {}, "tab.newShell": () => {}, "tab.close": () => {} }), [])
  if (items.length === 0) return null
  return (
    <div className="picker">
      {items.map((it, i) => (
        <div key={it} className={`picker-row ${i === idx ? "active" : ""}`}
          onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); onPick(it) }}>
          {it}
        </div>
      ))}
      <PickerKeys count={items.length} idx={idx} setIdx={setIdx} pick={() => items[idx] && onPick(items[idx]!)} close={onClose} />
    </div>
  )
}

/** 键盘处理挂 document capture：textarea 焦点不動，↑↓/Enter/Tab/Esc 被 picker 截获 */
const PickerKeys = ({ count, idx, setIdx, pick, close }: {
  count: number; idx: number; setIdx: (i: number) => void; pick: () => void; close: () => void
}) => {
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setIdx((idx + 1) % count) }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setIdx((idx - 1 + count) % count) }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); pick() }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close() }
    }
    document.addEventListener("keydown", h, true)
    return () => document.removeEventListener("keydown", h, true)
  }, [count, idx, pick, close])
  return null
}
```

Composer.tsx 修改（接入 token 检测；给出**完整替换段**——在 Composer 组件内新增状态与逻辑）：

(a) 顶部 import 追加：

```tsx
import { fuzzyFilter, detectToken, type TokenHit } from "./fuzzy"
import { Picker } from "./Picker"
import type { SlashCommand } from "../stores/types"
```

(b) 组件内（`const [model, setModel] = useState("default")` 之后）追加：

```tsx
  const [token, setToken] = useState<TokenHit | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [commands, setCommands] = useState<SlashCommand[]>([])

  // @ 首次触发时懒加载文件/命令列表（workspace 切换时失效）
  useEffect(() => { setFiles([]); setCommands([]); setToken(null) }, [wsId])
  const ensureLists = (kind: "file" | "command"): void => {
    const api = useData.getState().getApi()
    if (!api) return
    if (kind === "file" && files.length === 0)
      void api.req("GET", `/workspaces/${wsId}/files`).then((r) => setFiles(r.files)).catch(() => {})
    if (kind === "command" && commands.length === 0)
      void api.req("GET", `/workspaces/${wsId}/commands`).then((r) => setCommands(r.commands)).catch(() => setCommands([]))
  }

  const BUILTIN_COMMANDS = ["model", "clear", "compact", "resume", "help"] // claude 内置常用子集
  const pickerItems = token === null ? [] :
    token.kind === "file"
      ? fuzzyFilter(files, token.query)
      : fuzzyFilter([...new Set([...BUILTIN_COMMANDS, ...commands.map((c) => c.name)])], token.query)

  const refreshToken = (v: string, caret: number): void => {
    const t = detectToken(v, caret)
    setToken(t)
    if (t) ensureLists(t.kind)
  }

  const insertAtToken = (replacement: string): void => {
    if (!token || !ta.current) return
    const caret = ta.current.selectionStart
    const next = text.slice(0, token.start) + replacement + " " + text.slice(caret)
    update(next)
    setToken(null)
    requestAnimationFrame(() => {
      const pos = token.start + replacement.length + 1
      ta.current?.setSelectionRange(pos, pos)
      ta.current?.focus()
    })
  }
```

(c) textarea 的 `onChange` 改为同时刷新 token；`onKeyDown` 首行加 picker 让路：

```tsx
          onChange={(e) => { update(e.target.value); refreshToken(e.target.value, e.target.selectionStart) }}
          onKeyDown={(e) => {
            if (token && pickerItems.length > 0 && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key))
              return // PickerKeys 在 document capture 层接管
            onKeyDown(e)
          }}
```

(d) `<div className="composer-box">` 之前渲染 picker：

```tsx
      {token && pickerItems.length > 0 && (
        <Picker
          items={pickerItems}
          onClose={() => setToken(null)}
          onPick={(item) => insertAtToken(token.kind === "file" ? `@${item}` : `/${item}`)}
        />
      )}
```

- [ ] **Step 4: styles.css 追加**

```css
/* === picker (Task 13) === */
.composer { position: relative; }
.picker {
  position: absolute; bottom: calc(100% - 4px); left: 12px; right: 12px; max-height: 240px; overflow-y: auto;
  background: #26262b; border: 1px solid var(--border); border-radius: 8px; z-index: 50; padding: 4px;
}
.picker-row { padding: 5px 10px; border-radius: 5px; font-family: Menlo, monospace; font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker-row.active { background: rgba(122,162,247,0.22); }
```

- [ ] **Step 5: 验证**

```bash
bunx vitest run packages/client/test && bun run typecheck && cd packages/client && bunx tauri dev
```

手工核对：composer 打 `@cli` → 弹文件列表且模糊排序合理 → Enter 插入 `@src/api/client.ts `；行首 `/` → 内置 + repo `.claude/commands` 命令都出现；↑↓/Tab/Esc 正常；picker 打开时 Cmd+N 无效（层栈生效），关闭后恢复。

- [ ] **Step 6: Commit**

```bash
git add packages/client
git commit -m "feat(client): composer pickers——@文件模糊选择 + /命令补全（内置+repo 扫描）"
```

---

### Task 14: 右栏 Changes（四分区）+ Files 树（@注入）

Conductor 形态右栏：**默认收起为一列文字入口**（不抢终端宽度），点击展开。Changes：`+N−M vs base` 头部 + 四分区（against-base/committed/staged/unstaged）文件列表（每文件 +a −d）+ untracked——**M1 决策：做到文件列表级，行级 diff 视图后置 M2**（spec §7.1 右栏定位是"文字入口"，行级评论写回本来就是 M2 §十三；此裁剪已在 Self-Review 记录）。Files：目录树，点文件把 `@路径` 注入 composer（cursor.md 右栏四件套裁剪：Browser 砍、Terminal 即中央区）。

**Files:**
- Create: `packages/client/src/rightpanel/RightPanel.tsx`
- Modify: `packages/client/src/App.tsx`（挂 RightPanel）
- Modify: `packages/client/src/styles.css`（追加）
- Test: `packages/client/test/filetree.test.ts`

**Interfaces:**
- Consumes: `useData.changesByWs/refreshChanges/diffstatByWs`、`GET /files`、`useUi.rightPanel/setRightPanel/focusComposer`、composer 草稿（`makeDrafts` 追加 append）
- Produces: `<RightPanel wsId/>`；`buildTree(paths: string[]): TreeNode`（纯函数）；`appendToDraft(wsId, text)`（drafts.ts 追加）

- [ ] **Step 1: buildTree 失败测试**

`packages/client/test/filetree.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import { buildTree } from "../src/rightpanel/RightPanel.js"

describe("buildTree", () => {
  it("扁平路径 → 嵌套树（目录优先、字母序）", () => {
    const t = buildTree(["b.txt", "src/a.ts", "src/api/x.ts", "src/api/y.ts"])
    expect(t.children.map((c) => c.name)).toEqual(["src", "b.txt"])
    const src = t.children[0]!
    expect(src.children.map((c) => c.name)).toEqual(["api", "a.ts"])
    expect(src.children[0]!.children.map((c) => c.name)).toEqual(["x.ts", "y.ts"])
  })
  it("叶子带完整相对路径", () => {
    const t = buildTree(["src/api/x.ts"])
    expect(t.children[0]!.children[0]!.children[0]!.path).toBe("src/api/x.ts")
  })
})
```

Run: `bunx vitest run packages/client/test/filetree.test.ts` → Expected: FAIL

- [ ] **Step 2: drafts.ts 追加 append**

`packages/client/src/composer/drafts.ts` 的 `makeDrafts` 返回对象追加：

```ts
  append: (wsId: string, text: string): void => {
    const cur = storage.getItem(`coolie.draft.${wsId}`) ?? ""
    storage.setItem(`coolie.draft.${wsId}`, cur === "" ? text : `${cur} ${text}`)
  },
```

（Composer.tsx 里 `drafts` 已是模块级实例；RightPanel 注入 @路径后调 `useUi.getState().focusComposer()`，Composer 在 focusNonce effect 里**重读草稿**——把 Task 12 的 `useEffect(() => { ta.current?.focus() }, [focusNonce])` 改为：

```tsx
  useEffect(() => { setText(drafts.load(wsId)); ta.current?.focus() }, [focusNonce])
```
）

- [ ] **Step 3: 实现 RightPanel.tsx**

`packages/client/src/rightpanel/RightPanel.tsx`：

```tsx
import { useEffect, useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { makeDrafts } from "../composer/drafts"
import type { FileChange } from "../stores/types"

const drafts = makeDrafts(localStorage)

export interface TreeNode { name: string; path: string; children: TreeNode[] }

export const buildTree = (paths: readonly string[]): TreeNode => {
  const root: TreeNode = { name: "", path: "", children: [] }
  for (const p of paths) {
    let node = root
    const parts = p.split("/")
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/")
      let child = node.children.find((c) => c.name === part)
      if (!child) { child = { name: part, path, children: [] }; node.children.push(child) }
      node = child
    })
  }
  const sort = (n: TreeNode): void => {
    n.children.sort((a, b) =>
      (Number(b.children.length > 0) - Number(a.children.length > 0)) || a.name.localeCompare(b.name))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

const injectAt = (wsId: string, path: string): void => {
  drafts.append(wsId, `@${path}`)
  useUi.getState().focusComposer() // composer 在 focusNonce 时重读草稿
}

const Tree = ({ node, wsId, depth }: { node: TreeNode; wsId: string; depth: number }) => {
  const [open, setOpen] = useState(depth < 1)
  const isDir = node.children.length > 0
  return (
    <div>
      {node.name !== "" && (
        <div className="tree-row" style={{ paddingLeft: depth * 14 }}
          onClick={() => (isDir ? setOpen(!open) : injectAt(wsId, node.path))}
          title={isDir ? node.path : `@${node.path} 注入 composer`}>
          {isDir ? (open ? "▾ " : "▸ ") : "· "}{node.name}
        </div>
      )}
      {open && node.children.map((c) => <Tree key={c.path} node={c} wsId={wsId} depth={depth + 1} />)}
    </div>
  )
}

const ChangeSection = ({ title, list }: { title: string; list: FileChange[] }) => {
  const [open, setOpen] = useState(true)
  return (
    <section className="chg-section">
      <h4 onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {title}（{list.length}）</h4>
      {open && list.map((f) => (
        <div className="chg-row" key={f.path} title={f.path}>
          <span className="chg-path">{f.path}</span>
          <span className="diffcount"><em className="plus">+{f.insertions}</em><em className="minus">−{f.deletions}</em></span>
        </div>
      ))}
    </section>
  )
}

export const RightPanel = ({ wsId }: { wsId: string }) => {
  const panel = useUi((s) => s.rightPanel)
  const changes = useData((s) => s.changesByWs[wsId])
  const stat = useData((s) => s.diffstatByWs[wsId])
  const [files, setFiles] = useState<string[]>([])

  useEffect(() => {
    if (panel === "changes") void useData.getState().refreshChanges(wsId).catch(() => {})
    if (panel === "files")
      void useData.getState().getApi()?.req("GET", `/workspaces/${wsId}/files`)
        .then((r) => setFiles(r.files)).catch(() => {})
  }, [panel, wsId])

  // 展开时跟随 turn 结束刷新（changes 已由 data store 的 engine.turn.finished → refreshDiffstat 带动；这里补 changes）
  useEffect(() => {
    if (panel !== "changes") return
    const t = setInterval(() => { if (document.hasFocus()) void useData.getState().refreshChanges(wsId).catch(() => {}) }, 8000)
    return () => clearInterval(t)
  }, [panel, wsId])

  if (panel === "collapsed")
    return (
      <div className="right-collapsed">
        <button className="right-entry" onClick={() => useUi.getState().setRightPanel("changes")}>
          Changes{stat && (stat.insertions > 0 || stat.deletions > 0) ? ` +${stat.insertions}−${stat.deletions}` : ""}
        </button>
        <button className="right-entry" onClick={() => useUi.getState().setRightPanel("files")}>Files</button>
      </div>
    )

  return (
    <div className="right-open">
      <div className="right-head">
        <button className={panel === "changes" ? "active" : ""} onClick={() => useUi.getState().setRightPanel("changes")}>Changes</button>
        <button className={panel === "files" ? "active" : ""} onClick={() => useUi.getState().setRightPanel("files")}>Files</button>
        <span className="tabsbar-spacer" />
        <button onClick={() => useUi.getState().setRightPanel("collapsed")}>»</button>
      </div>
      <div className="right-body">
        {panel === "changes" && (
          changes ? (
            <>
              <div className="chg-total">vs base：{stat ? `+${stat.insertions} −${stat.deletions}（${stat.filesChanged} 文件）` : "…"}</div>
              <ChangeSection title="Against base" list={changes.againstBase} />
              <ChangeSection title="Committed" list={changes.committed} />
              <ChangeSection title="Staged" list={changes.staged} />
              <ChangeSection title="Unstaged" list={changes.unstaged} />
              {changes.untracked.length > 0 && (
                <section className="chg-section">
                  <h4>Untracked（{changes.untracked.length}）</h4>
                  {changes.untracked.map((p) => <div className="chg-row" key={p}><span className="chg-path">{p}</span></div>)}
                </section>
              )}
            </>
          ) : <div className="dim">加载中…</div>
        )}
        {panel === "files" && <Tree node={buildTree(files)} wsId={wsId} depth={0} />}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: App.tsx 挂载 + styles**

App.tsx 右栏改为：

```tsx
<aside className={`col-right ${rightPanel === "collapsed" ? "collapsed" : ""}`}>
  {selectedWs && <RightPanel wsId={selectedWs} />}
</aside>
```

styles.css 追加：

```css
/* === right panel (Task 14) === */
.right-collapsed { display: flex; flex-direction: column; gap: 8px; padding: 12px 6px; align-items: stretch; }
.right-entry { writing-mode: vertical-rl; color: var(--fg-dim); font-size: 12px; padding: 10px 4px; border-radius: 6px; }
.right-entry:hover { background: var(--panel); color: var(--fg); }
.right-open { display: flex; flex-direction: column; height: 100%; }
.right-head { display: flex; gap: 4px; padding: 8px; border-bottom: 1px solid var(--border); }
.right-head button { padding: 4px 10px; border-radius: 6px; color: var(--fg-dim); }
.right-head button.active { background: var(--panel); color: var(--fg); }
.right-body { flex: 1; overflow-y: auto; padding: 8px; }
.chg-total { font-size: 12px; color: var(--fg-dim); padding: 4px 2px 10px; }
.chg-section h4 { font-size: 11px; color: var(--fg-dim); padding: 6px 2px 4px; cursor: pointer; }
.chg-row { display: flex; gap: 8px; padding: 3px 2px; font-size: 12px; font-family: Menlo, monospace; }
.chg-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.tree-row { padding: 3px 2px; font-size: 12px; font-family: Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 4px; }
.tree-row:hover { background: var(--panel); }
```

- [ ] **Step 5: 验证**

```bash
bunx vitest run packages/client/test && bun run typecheck && cd packages/client && bunx tauri dev
```

手工核对：右栏默认收起且 Changes 入口带 `+N−M`；展开 Changes → 四分区与 git 实况一致（在 worktree 手动 `git add` 一个文件观察 staged/unstaged 移动）；Files 树可展开、点文件 → composer 草稿尾部出现 `@路径` 且聚焦。

- [ ] **Step 6: Commit**

```bash
git add packages/client
git commit -m "feat(client): 右栏——Changes 四分区文件列表 + Files 树 @注入（默认收起文字入口）"
```

---

### Task 15: 创建流（Cmd+N：composer 变首条 prompt 输入）+ 断线状态打磨

spec §7.2"与创建流的关系"：`Cmd+N` 后**同一 composer** 充当首条 prompt 输入（Cursor Dispatcher 形态），Enter → `POST /workspaces {projectId, initialPrompt}`（server 同步跑完整条创建流水线：worktree → setup 可见执行 → tmux → engine → 投递首条 prompt）。创建期间左栏经 SSE 显示 creating（◌）；完成自动选中。模型非 default 时创建后补投 `/model`（M1 决策：POST /workspaces 无 model 参数，用 midSessionModelSwitch 能力位补投——避免第三个 server 任务；nativeQueue 保证补投安全排队）。同时打磨 offline 状态：全局 offline 横幅 + 终端 dead 会话在 server 回归后一键重连。

**Files:**
- Create: `packages/client/src/composer/Dispatch.tsx`
- Modify: `packages/client/src/App.tsx`（dispatchMode 渲染 + offline 横幅）
- Modify: `packages/client/src/styles.css`（追加）

**Interfaces:**
- Consumes: `Composer`（`onSubmitOverride`，Task 12）、`useUi.dispatchMode/dispatchProjectId`、`useData`、`deliverModelSwitch`（Task 12）
- Produces: `<DispatchPanel/>`；错误路径（创建 500/setup 失败 → status=error 的 workspace 出现在左栏，`!` 徽标 + 点击后中央区给 Retry/Delete 动作条 `<ErrorActions/>`）

- [ ] **Step 1: 实现 Dispatch.tsx（含 error workspace 动作条）**

`packages/client/src/composer/Dispatch.tsx`：

```tsx
import { useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { Composer } from "./Composer"
import { deliverModelSwitch } from "./Composer"

export const DispatchPanel = () => {
  const projects = useData((s) => s.projects)
  const engines = useData((s) => s.config?.engines ?? [])
  const claude = engines[0]
  const projectId = useUi((s) => s.dispatchProjectId) ?? projects[0]?.id ?? null
  const [model, setModel] = useState("default")
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = (prompt: string): void => {
    const api = useData.getState().getApi()
    if (!api || !projectId || creating) return
    setCreating(true); setErr(null)
    void (async () => {
      try {
        // 同步流水线：fetch 会等到 active/error 才返回（server 行为，可长达数十秒）
        const ws = await api.req("POST", "/workspaces", { projectId, initialPrompt: prompt })
        useUi.getState().selectWs(ws.id)
        if (model !== "default" && claude?.capabilities.midSessionModelSwitch)
          void deliverModelSwitch(ws.id, model, true).catch(() => {})
      } catch (e: any) {
        setErr(e?.message ?? String(e)) // status=error 的半成品会出现在左栏（! 徽标）供 Retry
      } finally {
        setCreating(false)
      }
    })()
  }

  return (
    <div className="dispatch">
      <div className="dispatch-head">
        <h2>新 Workspace</h2>
        <button className="dim" onClick={() => useUi.getState().setDispatchMode(false)}>Esc 取消</button>
      </div>
      <div className="dispatch-row">
        <label>项目</label>
        <select value={projectId ?? ""} onChange={(e) => useUi.getState().setDispatchMode(true, e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {claude && (
          <>
            <label>模型</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {claude.models.map((m) => <option key={m} value={m}>{claude.displayName}·{m}</option>)}
            </select>
          </>
        )}
      </div>
      {err && <div className="dispatch-err">创建失败：{err}（左栏 error 项可 Retry）</div>}
      {creating
        ? <div className="dispatch-busy">◌ 创建中…（fetch worktree → setup → tmux → engine → 投递首条 prompt）</div>
        : <Composer wsId={`dispatch:${projectId ?? "none"}`} onSubmitOverride={submit}
            placeholder="描述任务… Enter 创建 workspace 并作为首条 prompt 投递" />}
    </div>
  )
}

/** error workspace 的动作条（spec §四：error 可重试；半成品已自动回滚） */
export const ErrorActions = ({ wsId }: { wsId: string }) => {
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<unknown>): void => {
    setBusy(true)
    void fn().catch((e: any) => alert(e?.message ?? e)).finally(() => setBusy(false))
  }
  const api = () => useData.getState().getApi()!
  return (
    <div className="error-actions">
      <span className="b-error">! 创建失败（半成品已回滚）</span>
      <button className="btn" disabled={busy} onClick={() => act(() => api().req("POST", `/workspaces/${wsId}/retry`, {}))}>重试</button>
      <button disabled={busy} onClick={() => act(() => api().req("DELETE", `/workspaces/${wsId}?force=1`))}>删除记录</button>
    </div>
  )
}
```

（dispatch 模式的草稿 key 用 `dispatch:<projectId>`——与会话草稿隔离，Composer 无需改动。）

- [ ] **Step 2: App.tsx 接入 dispatch/offline/error 三态**

App.tsx 中央区最终形态（替换 Task 12 的版本）：

```tsx
  const dispatchMode = useUi((s) => s.dispatchMode)
  const status = useData((s) => s.status)
  const selWs = useData((s) => s.workspaces.find((w) => w.id === selectedWs))
```

```tsx
      <div className="columns">
        <aside className="col-left"><Sidebar /></aside>
        <main className="col-center">
          {status === "offline" && <div className="offline-banner">server 重连中…（终端画面由 tmux 保管，不会丢）</div>}
          {dispatchMode ? (
            <DispatchPanel />
          ) : selectedWs && selWs ? (
            selWs.status === "error" ? (
              <ErrorActions wsId={selectedWs} />
            ) : (
              <>
                <CenterArea wsId={selectedWs} />
                <Composer wsId={selectedWs} />
              </>
            )
          ) : (
            <div className="dim center-empty">选择或创建一个 workspace（⌘N）</div>
          )}
        </main>
        <aside className={`col-right ${rightPanel === "collapsed" ? "collapsed" : ""}`}>
          {selectedWs && !dispatchMode && <RightPanel wsId={selectedWs} />}
        </aside>
      </div>
```

（import DispatchPanel/ErrorActions。archived workspace 选中时 CenterArea 自然显示"无终端 tab"空态 + 后续可加 unarchive 按钮：在 ErrorActions 同文件补一个 `ArchivedActions`——`POST /workspaces/:id/unarchive` 一键恢复，挂法同 error 分支：

```tsx
            selWs.status === "archived" ? (
              <div className="error-actions">
                <span className="dim">已归档（branch 保留）</span>
                <button className="btn" onClick={() => void useData.getState().getApi()?.req("POST", `/workspaces/${selectedWs}/unarchive`, {})}>恢复</button>
              </div>
            ) :
```
插在 error 分支之后。）

- [ ] **Step 3: styles.css 追加**

```css
/* === dispatch / states (Task 15) === */
.dispatch { display: flex; flex-direction: column; height: 100%; padding: 24px 32px; gap: 14px; }
.dispatch-head { display: flex; justify-content: space-between; align-items: center; }
.dispatch-head h2 { font-size: 16px; }
.dispatch-row { display: flex; gap: 10px; align-items: center; }
.dispatch-row label { color: var(--fg-dim); font-size: 12px; }
.dispatch-row select { background: #1a1a1e; color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
.dispatch-busy { color: var(--warn); padding: 20px 0; animation: pulse 1.2s infinite; }
.dispatch-err { color: var(--danger); font-size: 12px; }
.offline-banner { flex: none; text-align: center; font-size: 12px; padding: 5px; background: rgba(224,175,104,0.15); color: var(--warn); border-bottom: 1px solid var(--warn); }
.error-actions { display: flex; gap: 12px; align-items: center; justify-content: center; height: 100%; }
```

- [ ] **Step 4: 运行验证（创建流 + 崩溃恢复全链路）**

```bash
bun run typecheck && cd packages/client && bunx tauri dev
```

手工核对：
1. Cmd+N → dispatch 面板，composer 占位符变化；选项目/模型；输入 prompt → Enter → "创建中…"；左栏出现 ◌ 项（SSE）；完成后自动选中、claude TUI 已在处理首条 prompt。
2. 故意用坏 setup script（repo 放 `.coolie/setup.sh` 内容 `exit 1`）再创建 → 左栏 `!` 项 → 点击 → Retry/删除动作条 → 修好脚本 Retry 成功。
3. `kill -9 <daemon pid>` → 顶部 offline 横幅 → 数秒内 SSE 自动拉起新 daemon → 横幅消失 → 终端横幅点重连 → 画面恢复（tmux 无损，正是 spec §一.1）。

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): 创建流（Cmd+N composer 派发）+ error/archived 动作条 + offline 横幅"
```

---

### Task 16: README + 全量回归 + GUI 手工冒烟清单（spec §十一）

收尾：README 增补 client 使用说明；全仓测试/typecheck/构建回归；执行 spec §十一"终端 E2E 人工清单"扩展版（真 claude 完整走查）并把结果记录进本计划文件末尾。

**Files:**
- Modify: `README.md`（追加 client 一节）
- Modify: `docs/superpowers/plans/2026-07-11-coolie-m1-plan5-client.md`（冒烟结果记录）

- [ ] **Step 1: README 追加**

在 `README.md` 尾部追加：

```markdown
## Client GUI（M1 Plan 5）

Tauri 2 + React + xterm.js 桌面壳，纯 protocol 消费者（REST + WS 二进制 + SSE 三通道）。

    bun install
    cd packages/client && bunx tauri dev   # 自动发现/拉起 coolie-server（读 ~/.coolie/server.json）

- 左栏：project → workspace 两层列表；状态徽标（●工作中 ✓等输入 !错误 ○空闲）+ `+N−M`（git diff --shortstat 5s 轮询）
- 中央：xterm.js 6（WebGL→DOM fallback）挂 tmux window；tabs = engine/setup/run/shell；`↗ Open in iTerm2` 同画面逃生舱
- Composer 三档：Enter 发送/排队（claude nativeQueue 忙时直投）、⌘Enter 打断并发送、⌥Enter 仅插入、⇧Enter 换行；⌘. 打断；@文件、/命令、每 workspace 草稿、模型选择器（/model 投递）
- 快捷键：⌘N 新建、⌘T/⌘W shell tab、⌘1..9/⌘[/⌘] 切 workspace、⌘L 聚焦 composer、⌘/ 快捷键表；终端内 Cmd 系不进 PTY，Ctrl 系全透传
- server 崩溃：SSE 指数退避 + 自动重新拉起 daemon；终端画面因 tmux 无损
- 依赖：macOS + tmux（首启有引导）+ rustc/cargo（开发构建）

新增 server 端点（本计划）：GET /config、/workspaces/:id/git/{diffstat,changes}、/workspaces/:id/{files,commands}；POST /workspaces/:id/{tabs,input}、DELETE /workspaces/:id/tabs/:tabId。
```

- [ ] **Step 2: 全量回归**

```bash
bun run typecheck
bunx vitest run
cd packages/client && bunx vite build && cd src-tauri && cargo build
```

Expected：全绿（protocol/server/cli/client 全部测试；三条构建链）。任何失败先修再进冒烟。

- [ ] **Step 3: GUI 手工冒烟清单（真 claude；勾选并在计划末尾记录结果）**

启动 `bunx tauri dev`，逐项执行：

**终端 E2E（spec §十一 原清单）**
- [ ] claude TUI 渲染：欢迎框/双栏/box-drawing 正确，工作中无 scroll-jump（tmux 吸收重画）
- [ ] Ctrl+A / Ctrl+E 在 claude 输入行行首/行尾跳转（穿透）；Ctrl+C 打断 shell 命令
- [ ] Cmd 快捷键：⌘N/T/W/1..9/[/]/L/. 全部生效；终端聚焦时 Cmd 键**不**漏进 TUI（claude 输入行无脏字符）
- [ ] 中文 IME：终端内输入"你好世界"+全角标点；composer 内同样（WebKit textarea 原生路径）
- [ ] resize：拖窗大小连续变化，claude/tmux 正常 reflow、无错位；松手后 `tmux -L coolie list-clients` 尺寸与窗口一致
- [ ] WebGL context loss：`bunx tauri dev` 下用长会话（或多开 8 个终端 tab 反复切换——切到即惰性挂载，切走保活）观察无白屏；若能触发 context loss，确认自动回落 DOM 渲染不崩
- [ ] 惰性挂载（F3）：新建一个 shell tab 但先别点 → 该 tab 无 WS（`tmux -L coolie list-clients` 不多一个 client / 无新连接）；点进去后才挂活、切走仍保活；归档整个 workspace → 其所有 tab 的连接一并断开（无泄漏）

**Composer / 创建流（spec §7.2）**
- [ ] 三档发送：空闲 Enter、忙时 Enter（claude 原生排队）、⌘Enter 打断后投、⌥Enter 插入不回车、⇧Enter 换行
- [ ] ⌘. 与 ■ 按钮打断；⏳ 指示出现与消失；投递中 × 撤回（长 waitStable 场景：interrupt-send 期间）
- [ ] @文件选择器（模糊排序、Enter 插入）、/命令补全（内置 + repo `.claude/commands`）
- [ ] 草稿：两个 workspace 来回切，草稿各自保留；重启 app 后仍在
- [ ] 模型选择器：切 opus → claude 中 /model 生效
- [ ] ⌘N 创建流：prompt 落地为首条消息；error 重试路径（坏 setup script）

**布局 / 状态（spec §7.1 + §十/§十二）**
- [ ] 左栏徽标随 claude 工作/停下实时变化（hook 驱动）；+N−M 随文件改动 5s 内更新；搜索、pin 排序
- [ ] 右栏默认收起；Changes 四分区与 `git status` 实况一致；Files 树 @注入
- [ ] Open in iTerm2：里外同一画面、同输入
- [ ] server 崩溃（kill -9）：offline 横幅 → 自动重拉起 → SSE 恢复 → 终端重连画面无损
- [ ] tmux 引导：`PATH= bunx tauri dev`（或临时改名 tmux）出引导弹窗，装回后 Recheck 通过
- [ ] archive → 左栏归档区 → unarchive 恢复（branch 保留，claude --resume 由 Plan 4 接管的部分记录现状即可）

- [ ] **Step 4: 记录冒烟结果 + 提交**

把清单执行结果（含发现的问题与 workaround）追加到本计划文件末尾"冒烟记录"一节，然后：

```bash
git add README.md docs/superpowers/plans/2026-07-11-coolie-m1-plan5-client.md
git commit -m "docs(client): README client 一节 + Plan 5 冒烟记录（M1 GUI 收口）"
```

---

## Self-Review 记录（计划作者，2026-07-11）

按 writing-plans 的三项自检过了一遍，修正已内联，以下是检查痕迹与遗留决策：

**1. Spec 覆盖检查**
- §7.1 布局：左栏 Task 9 ✓ / 中央 tabs Task 10-11 ✓ / 右栏默认收起 Task 14 ✓ / 窗口质感（decorations:false+transparent+macOSPrivateApi+vibrancy+Edit 角色）Task 1+8 ✓。
- §7.2 Composer：三档+打断 Task 12 ✓（表格六行全部落到 planComposerKey/全局键）/ @文件 / 命令 Task 13 ✓ / 草稿 ✓ / 模型选择器 ✓（effort 按能力位隐藏）/ 创建流 Task 15 ✓。**附件（图片存临时目录插路径）未做**——任务下达的锁定 IN 清单未含附件，判定后置 M2，此处显式记录为已知裁剪。
- §7.3 快捷键：REGISTRY/LIFO/三层仲裁/Cmd 全局键 Task 7-8 ✓（这三项 = 本任务锁定的 M1 IN-scope，全部实装）；⌘/ cheatsheet 做了（registry 同源第二渲染处）。**以下三项为 CONTROLLER-SANCTIONED M2 cuts**（锁定 M1 范围未含，controller 批准后置）：① 用户 JSON 键位覆盖、② ⌘K 命令面板、③ footer cheatsheet 常驻条（M1 以 ⌘/ 弹层 + cheatsheet 内提示行替代，第三处同源渲染 M2 补）。
- §五 client 侧：xterm 6 WebGL+fallback ✓ / fit+heal（fonts.ready refit + attach 全量重绘）✓ / resize 防抖（客户端 150ms + server 50ms 双层）✓ / Open in iTerm2 ✓。
- §2.3 三通道：REST（Task 4）/ WS 二进制（Task 10，输出零解码直写、输入 TextEncoder 二进制帧）/ SSE 游标重连（Task 5）✓，未混用。
- §十：server 崩 → 指数退避 + 重新拉起（Task 5 getInfo=ensureServer）+ 终端 Reconnect（Task 10/15）✓；engine 退出横幅 ✓（Resume 按钮=Plan 4 契约，已降级标注）。
- §十二 tmux 首启检测引导：Task 8 TmuxGuide ✓（Rust binary_on_path，不依赖 server）。
- §十一 测试策略映射：单测（纯函数）/集成（真 daemon）/E2E 人工清单（Task 16 扩展版）✓，不做 WebDriver。
- Server 缺口盘点结论（执行前提）：diffstat/changes/files/commands/config **确认缺失** → Task 2；composer input/tabs create+delete **确认缺失**（routes.ts 只有 GET tabs；delivery.ts 无路由暴露）→ Task 3；CORS 缺失（浏览器源必需）→ 并入 Task 2。共 2 个 server 任务，符合"至多 2 个"的约束。

**2. Placeholder 扫描**
- Task 2 Step 7 / Task 3 Step 7 的 http 测试骨架里有 3 处 `/* … */`——均紧邻同形态完整样例并显式标注"按上一条的形态写全"，属于模式复制而非缺失定义；保留（完整展开会让两个 server 任务超篇幅，模式已在同文件给全）。
- 其余任务代码均为完整实现，无 TBD/TODO。
- Task 10 `getOrCreateSession` 初稿有一行永假条件的死代码，已内联修正为简版（dead 会话刻意保留复用，Reconnect 走 session.reconnect()）。
- 初稿 vite.config 曾用 NUL 分隔 serverCmd 且文件里混入了字面 NUL 字节——已统一改为空格分隔（与 discovery.ts split 对应）并清除该字节。

**3. 类型/签名一致性**
- `ComposerOps.input(target, {text, mode, skipStable})`：Task 3 定义 = Task 3 路由调用 = Task 6 `sendInput` 请求体（`{text, mode, skipStable}`）✓。
- `wsBadge(ws, tabs)` Task 9 定义、Task 11 tab 徽标改用 `b-${t.status}` class（两套刻意分开：workspace 徽标聚合、tab 徽标直接映射），CSS 中 `b-awaiting-input` 已补 ✓。
- `startEventStream` 的 `getInfo` 返回 `{port, token}` 子集，`ensureServer` 返回 `ServerInfo` 超集 ✓（结构兼容）。
- `makeDrafts` 在 Task 12 定义、Task 14 追加 `append`——追加后 Task 12 的调用不受影响 ✓；Composer focusNonce effect 在 Task 14 Step 2 明确给出修改后版本 ✓。
- protocol 路由新增 8 条与 server 路由实现一一对应 ✓；`claudeModels` 导出（adapter）与 `/config` 组装一致 ✓。

**关键决策记录（含任务书要求的判断项）**
1. **diffstat 走 server 端点**（非 client git）：client 无 git 访问是原则；两个 server 前置任务即为此开的 file-scoped 口子。
2. **右栏 Changes M1 裁到文件列表级**：spec §7.1 右栏定位"默认收起为文字入口"、行级评论写回明确是 M2（§十三）；行级 diff 渲染（@pierre/diffs 许可未复核）一并后置。四分区语义完整保留。
3. **composer 忙时投递**：waitStable 在 engine working 时必然超时（spinner 持续重画）→ 引入 `skipStable`，由 client 依 tab status + nativeQueue 能力位决定；这是对 spec"忙时排队——claude 原生 mid-turn 队列直接投"的机制化。
4. **创建时模型参数**：不给 POST /workspaces 加 model 字段（超出"至多 2 个小 server 任务"预算），用创建后 `/model` 补投替代（midSessionModelSwitch=true 且 nativeQueue 排队安全）。M2 若做 codex（无 midSessionModelSwitch 时）必须回到创建参数路线。
5. **状态管理选 zustand 5**：opcode 同栈验证；两 store（data/ui）+ 模块级非响应式 api 引用，避免 Context 层级与 redux 仪式。
6. **SSE 用 fetch 流而非 EventSource**：Bearer 头限制（server 在路由前验 token）；顺带获得 abort/退避/游标的完全控制。
7. **终端会话保活注册表 + 惰性挂载**：tab 切换只摘 DOM（visibility 栈叠加），xterm/WS 不销毁——scrollback 与连接跨切换保留；但**只有被看过的 tab 才建会话**（F3，spec §五"PTY per 在看的 tab"），未看过的后台 tab 是零 WS 占位符。断连时机收敛为两处：workspace 归档/删除（F2，data store applyEvent → disposeWorkspaceSessions）与手动关 shell tab；GUI 关闭是最外层兜底（engine 本体归 tmux，不受影响）。
8. **Plan 4 契约点**（3 处，全部容错降级）：lease（Task 4）、attach 失败 ensure-or-heal（未显式做——WS 4404 归入 dead 横幅，Plan 4 合并后在 reconnect 前插 ensure 调用，Task 10 注释已标）、engine Resume 按钮（Task 11 注释已标）。
9. **CORS 加在 server**：token 是唯一安全边界（loopback + Bearer），CORS 仅放行浏览器执行环境；与 agent-deck"非 loopback 无 token 拒启"原则不冲突。

**对抗性复审记录（adversarial round：7 findings applied，2026-07-11）**
READY-WITH-FIXES 复审的 7 条发现已全部内联落地：
- **F1（HIGH）** tsconfig `types` 补 `node`、devDeps 补 `@types/node` + `vitest`——否则 `vite.config.ts`/test 的 node 全局让 Task 1 Step 6 起每个"typecheck 绿"关卡红。（Task 1）
- **F2（MED）** workspace.archived/deleted → data store `applyEvent` 调 `disposeWorkspaceSessions`（依赖注入回收器，Terminal 模块加载时注册），补 pure 单测断言回收被触发；注册表加 LRU 上界注记。（Task 6 + Task 10）
- **F3（MED，spec 偏差纠正）** 中央区改惰性挂载：只 active/已看过的 tab 挂活 TerminalView/WS，后台未看 tab 是零连接占位符——对齐 spec §五"PTY per 在看的 tab"。（Task 11，Task 10/16 描述同步）
- **F4（LOW）** 空闲发送 1.5s 稳定地板——**明确选择：接受为 M1 行为**（安全裕度 > 收窄，claude nativeQueue 覆盖急投场景；乐观清空吸收主观延迟），M2 再引"暖空闲"缩短档。（Task 12 文字）
- **F5（LOW）** `applyEvent` 补 `prompt.*` 分支：`prompt.delivery.degraded`（landed eb2932e）→ store.warnings → `WarningToasts` 浮层带 code，不再静默丢；补单测。（Task 6 + Task 8）
- **F6（LOW）** `openInIterm` 拼 AppleScript 前用 `/^[A-Za-z0-9._-]+$/` 校验 tmuxSocket/wsId，挡注入。（Task 11）
- **F7（INFO）** CORS `*` 处加显式前提 note：仅在 127.0.0.1 bind + 非 cookie 的 Bearer 认证下安全，bind 放宽必须重设计。（Task 2）

**遗留风险（执行者注意）**
- xterm 6 的 addon 版本号（fit ^0.11 / webgl ^0.20）是猜测值，Task 1 Step 6 已给"让 bun 解析"的兜底指令。
- `theme.background` 带 alpha 的透明终端背景在 WebGL 渲染器下行为需冒烟确认，不行就退纯色 `#1e1e22`。
- Plan 3 收尾 bug-fixer 与本计划并行改 server：Task 2/3 动 app.ts 前先 `git pull` + 重读锚点。
- tauri dev 首启要 `bun run dev:vite` 已被 beforeDevCommand 接管；若 5173 被占用 strictPort 直接 fail-fast（刻意）。
