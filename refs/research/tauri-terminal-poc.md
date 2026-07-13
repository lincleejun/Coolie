# Tauri 2 + PTY + 终端仿真器渲染 claude/codex TUI：PoC 实测与可行性研究

> 调研日期：2026-07-10/11。方法：真实 PoC 实测（本机构建 Tauri 2 app 并跑 claude TUI）+ 三个关键仓库精读（tauri-plugin-pty、ghostty-web、CBannink/claude-terminal）+ issue 考古 + WebSearch。
>
> 说明：任务下达时预期本文件已存在并要求"末尾追加补充研究"，但 `refs/research/` 下并无此文件，故本文档为全新创建，内容即为该补充研究本身。

## TL;DR（结论速览）

**Tauri 2 + PTY + xterm.js 渲染 claude TUI 的路线：可行，已实测跑通全链路**（Tauri 2 窗口 → portable-pty → `tmux attach` → claude v2.1.207 交互式 TUI → xterm.js/ghostty-web 双渲染，输入输出双向验证）。但有三个必须处理的工程问题：

1. **tauri-plugin-pty 不能直接生产使用**：阻塞式读线程模型在多 PTY / webview reload 场景下会耗尽 tokio runtime，本次 PoC 实测复现了"新 PTY 拿不到数据、IPC 半死"的故障；且原始吞吐仅 ~0.7 MB/s。需要 fork 改造或自研（约 200 行 Rust）。
2. **ghostty-web 的 "drop-in 兼容" 宣称只对核心 API 成立**：渲染 claude TUI 像素级正确，Ctrl 键位编码正确，但 Cmd+A 会向 PTY 漏写字符 `a`、鼠标滚轮永远不带坐标（tmux 分 pane 场景必坏）、buffer 读取 API 丢空格、attach 后渲染停滞、韩文 IME 不工作、上游有未修的 WASM 内存损坏。**当前不建议做主渲染器，放观察名单**。
3. **WKWebView 键盘层有两个已知坑**：dead-key 布局输入损坏（xterm.js #5894，开放中，有宿主侧 addon workaround）；macOS Cmd 快捷键依赖原生 Edit 菜单存在与否（Tauri #2397/#8676 一族）。真实中文 IME 与真实 Ctrl+A/E 穿透因自动化权限限制未实测，留 5 分钟人工清单（见"风险"节）。

另一个重要旁证：**tmux 居中的架构天然绕开了 xterm.js 最著名的 "claude TUI scroll-jump" 问题域**（实测确认 tmux 只向客户端发增量重绘，未观测到任何视口跳动），这是对 Coolie "tux/tmux 优先" 路线的直接技术背书。

## PoC 环境与方法

| 项 | 值 |
|---|---|
| 机器/系统 | Apple Silicon 16 核，macOS 26.3.1（WKWebView = AppleWebKit/605.1.15） |
| 工具链 | Rust 1.96.0，Node 22.22.3，tmux 3.6a，Tauri 2（tauri-macros 2.6.3），claude CLI v2.1.207 |
| 前端 | `@xterm/xterm` 6.0.0 + addon-fit + addon-webgl；`ghostty-web` 0.4.0（npm 最新，2026-06-28 发布） |
| PTY | `tauri-plugin-pty`（GitHub main，commit dfbc2d1，2026-07-08；npm 包名 `tauri-pty` 0.3.1） |
| 拓扑 | 一个窗口双 pane：左 xterm.js、右 ghostty-web；各自 spawn 一个 PTY 跑 `tmux -L cooliepoc new-session -A -s poc-x/poc-g`，session 内跑 `claude` |
| 观测手段 | 前端把所有事件（keydown、composition、PTY 进出字节 hex、吞吐、resize、buffer 内容、canvas 截图）经 Rust command 落盘 `/tmp/coolie-poc.log`；外部经文件命令通道驱动测试（合成键盘/滚轮/IME 事件、窗口 resize、canvas toDataURL 存 PNG）；tmux `send-keys`/`capture-pane` 做旁路注入与地面真值 |

PoC 代码在会话临时目录（scratchpad），不随 repo 保存。复现要点：拷贝 `tauri-plugin-pty/examples/vanilla` 为骨架，Cargo 侧 `tauri-plugin-pty` 用 path/crates 依赖 + `tokio` runtime 放大（见下文 workaround），前端按插件 README 的 xterm 接线（https://github.com/Tnze/tauri-plugin-pty README），ghostty-web 按其 README `await init()` 后同样接线。环境变量必须显式传 `TERM=xterm-256color, COLORTERM=truecolor`（插件忽略 `termName` 参数，见下文）。首次构建 26.75s（cargo 热缓存），增量 rebuild ~20s。

## 实测结果明细

### 1. 全链路可行性 ✓

- Tauri 2 窗口内 PTY 跑 `tmux attach`，claude TUI 在两个渲染器中都完整呈现（欢迎框、双栏布局、box-drawing、品牌 logo 像素画、tmux 状态栏）。
- 输入路径：渲染器 `term.onData` → `pty.write` → tmux → claude 输入框，实测 `ping-test-123` 在两侧 claude 输入框中回显（tmux `capture-pane` 地面真值确认）。
- xterm.js WebGL addon 在本机 WKWebView 上加载成功（日志 `XTERM renderer=webgl OK`）。注意 xterm.js #5816 报告过 macOS 26.5 beta 上 WebGL 渲染损坏（https://github.com/xtermjs/xterm.js/issues/5816），需保留 canvas/DOM fallback（claude-terminal 示例的 try/catch 模式，见下）。
- ghostty-web WASM 初始化 29–113ms，无感。

### 2. 真彩（truecolor）✓ 两者均通过

外部脚本打印 24-bit 渐变（71 格，逐格不同 RGB），经 tmux 转发后读取两侧 buffer 单元格前景色：

- xterm.js：`cell.isFgRGB()=true`，采样值 `#fc0381 #e41b89 #cc3391 #b44b99 #9c63a1 #847ba9 #6c93b1 #54abb9` —— 平滑渐变，24-bit 保真。
- ghostty-web：同一组值完全一致。
- 注意：tmux 内 `TERM=tmux-256color`（tmux 自设），`COLORTERM=truecolor` 透传；RGB 能力经 tmux 3.6a 对外层 `xterm-256color` 客户端自动协商成功。**结论：真彩无风险**。

### 3. CJK 宽度 ✓ / 复杂 grapheme ⚠ 分化

- 双宽处理两者一致正确：`宽(w2)·(w0)度(w2)…`（w2 主格 + w0 占位格）。
- 复杂 grapheme（经 tmux 转发后从 buffer API 读回）：xterm.js 保留 `👋🏽`（肤色修饰）与 `🇨🇳`（旗帜）；ghostty-web 读回 `👋`、`👨`、`🇳`（修饰符/ZWJ 序列/regional-indicator 对丢失）。渲染层面未逐像素比对（此差异至少污染"读屏做语义提取/预览"类用途）。
- 关联上游 bug：ghostty-web 处理过多码点 grapheme 后 `free()` 会损坏共享 WASM 内存，后续所有 Terminal 崩溃（[coder/ghostty-web#141](https://github.com/coder/ghostty-web/issues/141)，open）——对 Coolie 这种多标签多终端反复建销的应用是致命项。

### 4. 鼠标 ⚠ 关键分化点

- **xterm.js**：tmux `mouse on` 时，真实滚轮与点击都以 SGR 序列带坐标上报（实测 `\x1b[<65;88;53M` 滚动、`\x1b[<0;79;14M/m` 按下/释放）。tmux 能据此滚动正确的 pane、claude TUI 能收到滚动。**完整可用**。
- **ghostty-web**：Terminal 层以 capture 方式拦截 wheel，alt-screen 下一律转成 ↑/↓ 箭头（每次滚动最多 5 个），**从不发送带坐标的 SGR 滚轮序列**（源码 `lib/terminal.ts` handleWheel，anomalyco 镜像 clone 中为 1583–1610 行；上游确认并有未合并修复 [coder/ghostty-web#136](https://github.com/coder/ghostty-web/pull/136)、[#147](https://github.com/coder/ghostty-web/pull/147)）。后果：tmux 多 pane 时滚错 pane / claude 收到的是箭头键不是滚动。PoC 合成滚轮事件下 ghostty 甚至无任何输出（xterm 正常发出 SGR）。**对 "tmux attach + 引擎 TUI" 场景这是硬伤**。

### 5. 键盘（JS 层，合成事件实测）

| 键 | xterm.js | ghostty-web |
|---|---|---|
| Ctrl+A / Ctrl+E / Ctrl+K / Ctrl+C | `\x01 \x05 \x0b \x03` ✓ | `\x01 \x05 \x0b \x03` ✓ |
| Cmd+A | 不处理、交还系统（正确） | **向 PTY 写出字符 `a`（漏写 bug）** |
| Shift+Enter | `\x0d`（与 Enter 无差别） | `\x0d`（同；修复 PR [#159](https://github.com/coder/ghostty-web/pull/159) 未合并，将改为 fixterms `\x1b[27;2;13~`） |
| ← （zsh 下 DECCKM） | `\x1bOD` ✓ | `\x1bOD` ✓ |

- Shift+Enter 无差别意味着 claude TUI 的"Shift+Enter 换行"依赖终端配置注入（claude 自身 /terminal-setup 即为此而生），宿主可在 onData 前拦截 keydown 自行映射 —— xterm.js `attachCustomKeyEventHandler` 与 ghostty-web 同名 API 都存在，可统一处理。
- 方法学注意：xterm.js 键盘管线是 legacy `keyCode` 驱动，合成 KeyboardEvent 必须带 keyCode 才被处理（真实键盘无此问题）；ghostty-web 用 `event.key/code`。
- **真实键盘的 WKWebView 原生层穿透（Ctrl+A/E 是否被系统吃掉、Cmd 快捷键与菜单竞争）未能自动化验证**（osascript 键注入无辅助功能权限，错误码 1002），列入人工清单。JS 层证据 + 大量 Tauri 终端 app 存在的事实（claude-terminal、marc2332/tauri-terminal）表明 Ctrl 键穿透默认可用。

### 6. IME / 中文输入 ⚠（合成事件 + issue 考古，真实 IME 未测）

- 合成 composition 序列（compositionstart→update→end "你好"）：ghostty-web 正确提交 `你好` 到 PTY；xterm.js 的 CompositionHelper 对合成序列不提交（其内部对 keydown 229/textarea 状态时序有更严格假设），**不代表真实 IME 失败**——xterm.js 在 Safari/WebKit 下的中文输入是被广泛使用的路径。
- 已知开放问题（按对 Coolie 的杀伤力排序）：
  - WKWebView（Tauri 2）dead-key 布局输入损坏：死键重复+后继字符丢失，Chromium 宿主不受影响；开放中，报告者在自己的 Tauri 项目做了宿主侧 addon workaround（https://github.com/xtermjs/xterm.js/issues/5894，参考实现 https://github.com/sotasan/piyo）。主要影响西语系死键布局，中文拼音 IME 不走死键路径。
  - 某些"常驻 229"型 IME（豆包）在英文模式下丢第二字符（https://github.com/xtermjs/xterm.js/issues/5887）。
  - IME 候选窗位置在有 placeholder 时错位（https://github.com/xtermjs/xterm.js/issues/5734）。
  - 中文全角标点被 IME 直接 commit（无 composition 会话）时可能变半角 —— 同类 AI 终端产品实例（https://github.com/stablyai/orca/issues/6147）。
  - ghostty-web：中日 IME 基本支持已合入（[#88](https://github.com/coder/ghostty-web/issues/88)/[#90](https://github.com/coder/ghostty-web/pull/90)），但**韩文 IME 不工作**（[#119](https://github.com/coder/ghostty-web/issues/119)/[#120](https://github.com/coder/ghostty-web/issues/120) open）、CJK 候选窗定位问题（[#97](https://github.com/coder/ghostty-web/issues/97) open）。
- Coolie 的缓冲因素：主输入走自绘输入框（Context.MD 底部输入框 + macOS 原生键位），终端内 IME 只是次要路径，风险可接受。

### 7. resize ✓（无抖动、无错误）

窗口在 1500x950 ↔ 1100x700 ↔ 900x600 间循环，claude TUI 运行中：两侧 ResizeObserver→fit→PTY resize 全程单发不重入，窗口 resize 到 TERMRESIZE 日志间隔 ~10–30ms，无 JS 错误、无渲染崩溃、claude/tmux 正常 reflow。ghostty-web 曾有高输出下 resize 崩溃，已修（[#132](https://github.com/coder/ghostty-web/pull/132) closed）。**结论：resize 不是风险点**（注意多客户端同时 attach 同一 tmux session 时"以最小客户端为准"的经典 tmux 行为仍需 `window-size latest` 类配置，PoC 未覆盖）。

### 8. 吞吐与背压 ⚠（插件是瓶颈，tmux 是解药）

- 原始 PTY（无 tmux）`cat` 3MB：**~0.7 MB/s**，2930 个 chunk（平均 ~1KB/chunk，每 chunk 一次 invoke 往返 ~1.4ms）。渲染器不是瓶颈（none/xterm/ghostty 三种模式同速）。
- 经 tmux：同一 3MB `cat`，客户端实际只收到 ~145KB（tmux 只发屏幕增量、自动削流），burst 速率 0.9 MB/s。**tmux 路线下插件吞吐够用；raw 模式（比如内嵌普通 shell 面板跑构建日志）会明显卡**。
- 背压：插件的拉式读取天然有背压（前端不读，内核 buffer 满，子进程 write 阻塞），但 `handleFlowControl` 等参数是空壳（见下）。

### 9. 稳定性：tokio 阻塞读耗尽（实测复现 + workaround 验证）✓⚠

- 插件把阻塞的 `std::io::Read` 直接放在 async command 里执行（`tauri-plugin-pty/src/lib.rs` 的 `read()`，main@dfbc2d1 第 117–141 行），每个活跃 PTY 常驻占用一个 tokio worker 线程；`exitstatus` 的阻塞 `wait()` 再占一个（同文件 191–212 行）。
- 实测：2 个 tmux PTY + 3 个 rawcat PTY + 一次 webview reload（旧页面的 session 全部泄漏，Rust 侧阻塞读线程不释放）后，新页面 PTY 完全收不到数据、部分 IPC 停摆。**这正是上游 issue #2 的作者自认架构缺陷**（"the underlying PTY operations aren't true async operations. They block the working threads of tokio"，https://github.com/Tnze/tauri-plugin-pty/issues/2）。
- workaround 实测有效：`tauri::async_runtime::set` 换成 `worker_threads(64).max_blocking_threads(256)` 的自建 runtime 后，同样测试序列不再饿死（issue #2 中作者给出的方案）。
- 相关可靠性观察：`onExit` 在 rawcat 场景未触发（`cat` 退出后 exitstatus 未返回，疑似 portable-pty wait 与 reader 生命周期交互）；`dispose()` 直接 `throw`（`api/index.ts:292-294`）；kill 后读循环挂死的问题历史上修过一轮（[#5](https://github.com/Tnze/tauri-plugin-pty/issues/5)/[#6](https://github.com/Tnze/tauri-plugin-pty/pull/6)）。
- webview reload 泄漏的对策上游已给了一半：`attach(pid)` + `getAllPids()`（[#8](https://github.com/Tnze/tauri-plugin-pty/pull/8)，2026-06 合入）允许 reload 后重连既有 PTY 而不是再 spawn——但旧读循环的阻塞线程仍需插件侧修复。

### 10. ghostty-web 渲染真值（canvas 截图）✓⚠

- 通过 canvas `toDataURL` 导出 ghostty-web 渲染像素：claude TUI 渲染**正确且美观**（box-drawing 对齐、色彩正确、tmux 状态栏正常）——前述 buffer 读出的"丢空格/错位"只存在于 buffer 提取 API（对齐 [#139](https://github.com/coder/ghostty-web/issues/139)/[#177](https://github.com/coder/ghostty-web/pull/177) viewport 读取类 bug），不是渲染问题。
- 但发现真实问题：**重新 attach 后 ghostty-web 画面停滞为空白+左上角幽灵光标，直到下一次输出才醒来**（对齐 open issues [#154](https://github.com/coder/ghostty-web/issues/154) 空白引导态、[#122](https://github.com/coder/ghostty-web/issues/122) 幽灵光标）。xterm.js 无此问题。
- xterm.js WebGL canvas 无法 toDataURL（preserveDrawingBuffer=false，预期行为），其渲染质量以 buffer 对齐 + VS Code 同款为据，未做像素级验证。

## tauri-plugin-pty 精读结论

- **是什么**：237 行 Rust（portable-pty 0.9 封装，spawn/write/read/resize/kill/exitstatus/get_all_pids 七个 command）+ 368 行 TS（node-pty 接口仿制，npm 包名 `tauri-pty`）。MIT，作者 Tnze，21 star，仍活跃（2026-07-08 有提交）。
- **Tauri 2 兼容**：已支持（[#3](https://github.com/Tnze/tauri-plugin-pty/pull/3)/[#4](https://github.com/Tnze/tauri-plugin-pty/issues/4)），带 permissions/capabilities 定义；读路径 2026-06 起用 `tauri::ipc::Response` 返回 ArrayBuffer，无 base64/JSON 开销（[#7](https://github.com/Tnze/tauri-plugin-pty/pull/7)）。
- **数据通路**：前端 `for(;;) await invoke("read")` 拉取 ≤4KB/次 —— 每 chunk 一次 IPC 往返是吞吐瓶颈的直接原因。
- **空壳参数**：`termName/encoding/handleFlowControl/flowControlPause/resume` 全部 TODO 未实现（`src/lib.rs:51-56`）——所以必须用 `env` 显式传 `TERM`/`COLORTERM`（claude-terminal 也是这么做的，见其 `src/lib/constants.ts` 的 `CLAUDE_ENV`）。
- **生产化改造清单**（fork 或自研，工作量小）：
  1. 读循环移出 tokio worker：每 PTY 一个专用 OS 线程（或 `spawn_blocking`）+ Tauri Channel/event 推送，消灭 invoke 轮询与线程耗尽两个问题；
  2. 读侧合批（聚 8–64KB 再推），吞吐可上两个量级；
  3. session 生命周期与 webview 解耦 + reload 重连（`attach()` 已有，补服务端清理）；
  4. 实现 `dispose()`、修 `exitstatus` 挂死、桥接 flow control。
  - 参照物：kobe 的 web dashboard 走 "browser SPA + PTY sidecar (node-pty + WebSocket)"（`refs/kobe/CLAUDE.md` Orientation 节），Coolie 若 server 进程本来就常驻 TS，**PTY 放 server 侧走 WebSocket、Tauri 只当浏览器**是绕开整个 Rust 插件问题域的合法替代架构，且天然支持"CLI/浏览器/GUI 三端看同一 session"。

## ghostty-web "xterm.js drop-in 兼容" 宣称评估

**上游正主是 coder/ghostty-web**（README 徽章即指向 coder/*；为 Coder 的 Mux 而做；2605 star，49 open issues，最后推送 2026-07-02）。tux.md 里引用的 anomalyco/ghostty-web 是其 fork（GitHub API `fork:true, parent:coder/ghostty-web`）。npm 最新 0.4.0（2026-06-28），0.5.0 系列还压在仓库里（[#137](https://github.com/coder/ghostty-web/issues/137)、[#182](https://github.com/coder/ghostty-web/pull/182)）。

宣称成立的部分：
- 核心 Terminal API（open/write/onData/onResize/buffer/attachCustomKeyEventHandler/registerLinkProvider/scroll 系列）齐全，`write(string|Uint8Array)` 签名兼容；PoC 中同一段接线代码对两个库零改动跑通 —— **`@xterm/xterm` → `ghostty-web` 改 import 对"基础接线"确实成立**。
- VT 解析确实更强（XTPUSHSGR 等 xterm.js 不支持的序列；本 PoC 未独立验证此点，测试脚本序列写错作废）。

不成立/要小心的部分：
- 需要 `await init()` 加载 ~400KB WASM —— 严格说已不是纯 drop-in（0.4.0 的 `init()` 无参，WASM 路径靠 `import.meta.url` 自动解析，Vite 下需 `optimizeDeps.exclude`）。
- **addon 生态只有 FitAddon**（in-tree），无 search/serialize/unicode11/web-links（links 内置）/webgl —— claude-terminal 用到的 SerializeAddon（会话恢复）、SearchAddon（Ctrl+Shift+F）在 ghostty-web 下无等价物。
- 渲染是 Canvas 2D，WebGL renderer 还在愿望单（[#155](https://github.com/coder/ghostty-web/issues/155) open）。
- `theme` 在 open() 后不可改（[#125](https://github.com/coder/ghostty-web/issues/125)，源码有显式 warn）；`scrollback` 单位文档与实现打架（行 vs 字节，[#140](https://github.com/coder/ghostty-web/issues/140)）。
- 输入编码没有全部过 Ghostty encoder，fast-path 与 xterm.js 行为有系统性偏差（Home/End 忽略 DECCKM、Shift 修饰丢失、部分非 BMP 字符被丢，维护者自己的重构 PR [#159](https://github.com/coder/ghostty-web/pull/159) 未合并）。
- 本 PoC 实测新增：Cmd+A 漏写 `a`、滚轮无坐标、attach 后渲染停滞、buffer 提取丢空格（详见上文）。
- Codex CLI 下 Ctrl+V 贴图不可用（[#148](https://github.com/coder/ghostty-web/issues/148) open）——对 Coolie 的 codex 引擎直接相关。
- 独立第三方评估同样给出"暂缓"结论：2code 项目对 AI CLI 宿主终端选型的调研判定 ghostty-web "被内存损坏 bug 和维护停滞阻塞"，短期留在 xterm.js，长期观察 ghostty-web/libghostty（https://github.com/AkaraChen/2code/issues/145）。

## xterm.js 直跑 claude 的 scroll-jump 问题域（以及 tmux 为何绕开它）

不经 tmux、直接 PTY 跑 claude 时，xterm.js 宿主有一整族已知问题：Ink/React 型 TUI 高频"清屏→归位→整屏重画"导致视口跳顶/强制吸底、scrollback 复制错乱：

- claude-code 官方仓库多起：[#34845](https://github.com/anthropics/claude-code/issues/34845)（随机跳顶+自动吸底）、[#37627](https://github.com/anthropics/claude-code/issues/37627)（工作中强制吸底）、[#37389](https://github.com/anthropics/claude-code/issues/37389)（长会话跳顶）、[#51828](https://github.com/anthropics/claude-code/issues/51828)（resize 后 scrollback 重复，VS Code 终端）。
- 根因是 xterm.js 缺 DEC 2026 synchronized output 的原子刷新，修复（延迟视口 DOM 同步）压在 xterm.js 7.0 的 PR #5770（时间点约 2026-12；转述自 https://github.com/AkaraChen/2code/issues/145 与 https://github.com/wavetermdev/waveterm/issues/2787 ；PR 本体未逐行核读，标注二手）。
- **本 PoC 的 tmux 路线实测无此现象**：claude 的重画被 tmux 吸收，客户端只收增量（3MB cat 只透传 145KB 同理）；实测 xterm 侧 `buffer.type=normal` 且视口稳定、无跳动。tmux 把"疯狂重画的 TUI"翻译成了"温和的光标定位增量流"，这是 tmux 接管模型在渲染保真度上的额外红利（此前 tux.md 只论证了它的计费/会话红利）。

## WKWebView 键盘/快捷键专题

- **Cmd 系快捷键**：macOS 上 WebView 的 Cmd+C/V/X/A 依赖 App 有原生 Edit 菜单（key equivalent 先走菜单再到 WebKit）。Tauri 历史 bug 族：[#2397](https://github.com/tauri-apps/tauri/issues/2397)（v1 时代无默认菜单导致全废）→ 因此诞生默认菜单 [#2398](https://github.com/tauri-apps/tauri/issues/2398)；Tauri 2 有默认菜单但自定义菜单丢 Edit 角色会复发（[#11422](https://github.com/tauri-apps/tauri/issues/11422)、[#12458](https://github.com/tauri-apps/tauri/issues/12458)、[#8676](https://github.com/tauri-apps/tauri/issues/8676) 多 webview 场景）。**Coolie 规则：自定义菜单时必须保留 Edit 子菜单的系统角色项**。PoC 用默认菜单，未观测到 Cmd 异常（Cmd+A 到达 JS 层且 xterm 正确放行）。
- **Ctrl 系（emacs 键位）**：JS 层验证 Ctrl+A/E/K/C 在两个渲染器都正确产生控制字节；macOS 系统层面 Ctrl+A/E 无全局占用（Ctrl+方向键有，但 Mission Control 快捷键不与终端冲突）。真实按键端到端未自动化验证（无辅助功能权限），风险低，列人工清单。
- **dead-key 布局**（美式国际/西班牙语等）：WKWebView 事件序列与 Chromium 不同 → xterm.js 死键重复+丢字符（https://github.com/xtermjs/xterm.js/issues/5894，open，2026-05 报告）；宿主侧 addon 可修（参考 https://github.com/sotasan/piyo）。中文用户主路径不受影响。
- **窗口级快捷键竞争**：Cmd+W/Q/H 等由菜单/系统处理，不会进终端；Coolie 自定义全局快捷键应走 Tauri 菜单 accelerator 或 global-shortcut 插件，避免在 JS 抢。

## CBannink/claude-terminal 示例精读（可直接抄的部分）

Windows 优先的个人项目（0 star，2026-02 停更），但恰好是 "Tauri 2 + tauri-pty 0.2 + xterm 5.5 + claude" 的完整可跑组合，验证了本路线在他人机器上同样成立：

- **addon 全家桶组合**：fit + webgl(fallback canvas/DOM，onContextLoss dispose) + web-links + search + unicode11 + serialize（`src/lib/terminal-manager.ts`）—— Coolie 选 xterm.js 时照抄即可。
- **env 注入**：`CLAUDE_ENV = { COLORTERM: "truecolor", TERM: "xterm-256color" }`（`src/lib/constants.ts`）。
- **claude 二进制发现**：常见安装路径候选 + `which` 兜底（`src-tauri/src/commands/claude.rs`）；会话管理直接拼 `--continue/--resume/--model` CLI 参数（`src/lib/claude-cli.ts`）。
- **三个启动时序坑**（其 PR #3 修复记录，Coolie 必踩预警）：React 渲染早于 `window.__TAURI_INTERNALS__` 注入（需等待轮询）；容器未完成布局就 `fit()` 导致 xterm 零尺寸崩溃（推迟到 rAF；本 PoC 补充：rAF 在窗口被遮挡时可能不触发，建议 setTimeout 或 ResizeObserver 首帧）；Store `load()` 失败被缓存导致永不重试。

## 与 Coolie 相关的结论与建议

1. **渲染器选型：xterm.js 6（WebGL + fallback）为主，ghostty-web 进观察名单**。判据：鼠标坐标上报（tmux 分 pane 硬需求）、Cmd+A 漏写、WASM 内存损坏、addon 生态、attach 渲染停滞五项，当前全部倒向 xterm.js；ghostty-web 的强项（VT 保真、复杂文字渲染、解析性能）在 tmux 削流后的负载下不构成决定性优势。切换成本被"接线层 API 兼容"压得很低，未来（0.5+ 修掉 #136/#141/#148 后）可低成本重评。
2. **PTY 层：不要直接用 tauri-plugin-pty 上生产**。两条路二选一：(a) fork 改造（专用读线程 + Channel 推送 + 合批 + reload 重连，~200 行量级）；(b) **PTY 挪到 Coolie server（node-pty + WebSocket）**，Tauri 前端纯做渲染 —— 与 Coolie 既定的 CS 架构（TS server 常驻、多客户端）更同构，且 CLI/浏览器/GUI 共享同一份 PTY 服务，kobe web dashboard 已验证此形态。倾向 (b)。
3. **tmux 居中不仅是会话/计费策略，也是渲染保真度策略**：它把 claude TUI 的暴力重画降级为增量流，绕开 xterm.js scroll-jump 问题族，还把插件 0.7MB/s 的吞吐瓶颈变得无关紧要。坚持 "Coolie task = worktree + tmux session + branch" 路线。
4. **键盘策略**：终端 pane 内 Ctrl 系交给渲染器；Cmd 系留给原生菜单（保 Edit 角色）；Shift+Enter 用 `attachCustomKeyEventHandler` 统一映射成 claude 认的序列；dead-key addon 备好（抄 piyo）。Context.MD 要求的"输入框支持 macOS 原生键位"主要落在自绘输入框（NSTextView 语义由 WebKit textarea 天然提供），与终端 pane 解耦。
5. **多 PTY 规模化**：Coolie 的并行任务数 × (attach 预览 + shell pane) 很容易超过默认 worker 数——无论选哪条 PTY 路线，都要把"几十个并发 PTY + 反复 reload"写进验收测试（本 PoC 的故障剧本可直接复用）。

## 风险与注意事项（含 5 分钟人工清单）

- **未验证-需人工**（自动化权限不足，各 1 分钟）：
  1. 真实中文 IME 在 Tauri 窗口 xterm.js 内输入"你好世界"+全角标点（对照 issue #5887/#5734 症状）；
  2. 真实键盘 Ctrl+A/E 在 claude 输入框内行首/行尾跳转；
  3. Cmd+C/V 复制粘贴进出终端（默认菜单在场/不在场两种情况）；
  4. 死键布局（若作者用美式国际布局才需要）；
  5. 长会话（>1h）WebGL 上下文丢失恢复。
- **未验证-二手信息**：xterm.js PR #5770 的内容与 7.0 时间表（转述自 2code #145）；XTPUSHSGR 支持差异（README 宣称，PoC 测试脚本写错未能验证）。
- **ghostty-web 观察触发器**：#136（滚轮坐标）、#141（WASM 内存损坏）、#148（Codex Ctrl+V）、#119/#120（韩文 IME）、npm 0.5.0 发布 —— 全绿再重评。
- **样本局限**：单机（Apple Silicon + macOS 26.3.1）、tmux 3.6a、用户 tmux.conf `mouse on`；未测 Intel Mac / 旧 WebKit；合成事件测的是 JS 层，不覆盖 WKWebView 原生事件层差异（dead-key 一案证明该层确有独立 bug 面）。
- claude TUI 版本迭代快（v2.1.207 实测），其对 kitty keyboard protocol / synchronized output 的采用会改变本文的键盘与滚动结论权重，建议每季度重跑 PoC 剧本。

## 来源清单

本地代码（clone 位于会话临时目录，引用时以 upstream 坐标为准）：

- tauri-plugin-pty main@dfbc2d1：`src/lib.rs:51-56,117-141,191-212`；`api/index.ts:286-352`（读循环/构造）、`:292-294`（dispose throw）；`examples/vanilla/`（Tauri 2 骨架与 xterm 6 接线）
- ghostty-web（anomalyco fork @513463a，npm 0.4.0 对照）：`lib/terminal.ts:1583-1610`（wheel→箭头）、`:206`（theme warn）；`lib/input-handler.ts:344-556`（键盘管线、Cmd/Ctrl 分支、composition 监听）；`lib/index.ts`（导出面/init）；`lib/addons/fit.ts`
- claude-terminal @9a43cb0：`src/lib/terminal-manager.ts`、`src/hooks/usePty.ts`、`src/lib/constants.ts`、`src/lib/claude-cli.ts`、PR #3 描述
- `/Users/outman/workspace/ai/personal_ai/Coolie/refs/research/tux.md`、`landscape.md:172,182`（本研究要回答的问题定义）；`refs/kobe/CLAUDE.md`（PTY sidecar 参照）

PoC 实测证据（本机，2026-07-10/11）：`/tmp/coolie-poc.log`（全部事件流水）、`/tmp/poc-ghostty-0.png`（ghostty 渲染 claude TUI 截图）——临时文件，结论已全部内化进上文。

网页（均 2026-07-10/11 访问）：

- https://github.com/Tnze/tauri-plugin-pty （README、issues #1–#8；#2 线程耗尽与 workaround、#5/#6 EOF、#7 ArrayBuffer、#8 attach）
- https://github.com/coder/ghostty-web （README、issues/PRs：#88/#90/#97/#119/#120/#122/#125/#132/#136/#137/#139/#140/#141/#147/#148/#154/#155/#159/#177/#182）
- https://github.com/CBannink/claude-terminal
- https://github.com/xtermjs/xterm.js/issues/5894 、/issues/5887 、/issues/5734 、/issues/5816
- https://github.com/tauri-apps/tauri/issues/2397 、/issues/2398 、/issues/8676 、/issues/11422 、/issues/12458
- https://github.com/AkaraChen/2code/issues/145 （独立选型评估）、/issues/144
- https://github.com/anthropics/claude-code/issues/34845 、/issues/37627 、/issues/37389 、/issues/51828 （scroll-jump 问题族）
- https://github.com/wavetermdev/waveterm/issues/2787 （xterm.js 缺 sync output）
- https://github.com/sotasan/piyo （WKWebView dead-key 宿主侧 workaround 参考实现）
- https://github.com/stablyai/orca/issues/6147 （IME 全角标点案例）
- npm registry：`ghostty-web`（0.4.0，2026-06-28）、`tauri-pty`（0.3.1）、`@xterm/xterm`（6.0.0）
