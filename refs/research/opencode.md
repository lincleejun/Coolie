# opencode 源码研究（面向 Coolie 的 server 架构与引擎抽象）

> 研究对象：本地 clone `/Users/outman/workspace/ai/personal_ai/Coolie/refs/opencode`
> HEAD：`9976269ab1accfc9f9dc98a4a688c516934de422`（2026-07-10，v1.17.18）。**shallow clone（depth=1，`git log` 只有 1 条），无法追溯历史版本代码**。
> 注意：repo 的 `package.json` 里 repository 已指向 `github.com/anomalyco/opencode`（package.json 尾部 repository 字段），且代码库已全面迁移到 **Effect 4.0（beta）**。社区早期文章里描述的 `App.provide` / `Instance.state` 简单 DI 模式在这个版本里已被 Effect Layer 体系取代，但其原语（AsyncLocalStorage context、lazy）仍在仓库中残留并可引用。本文两代模式都讲，并明确告诉 Coolie 该抄哪个。

---

## 1. 概述：它是什么、怎么拆的

opencode 是一个 AI coding agent，但架构上是严格的 **CS 结构**：

- **server**：`opencode serve` 启动 headless HTTP server（`packages/opencode/src/cli/cmd/serve.ts:6-24`），一个 server 进程可同时服务**多个项目目录**——每个请求通过 `directory` query 参数或 `x-opencode-directory` header 指定目标项目（`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:87`；serve.ts:10-11 的注释直说："Server loads instances per-request via x-opencode-directory header"）。
- **client**：TUI（TypeScript + solid-js 渲染到终端，基于 `@opentui/solid`，见根 `package.json` catalog 中 `@opentui/core@0.4.3` 等）、Electron desktop（`packages/desktop/package.json:15` 用 electron-vite）、web、plugin、slack bot——全部通过生成的 SDK 消费同一套 HTTP API + SSE 事件流。
- 设计词汇表：根目录 `CONTEXT.md` 是一份极其详尽的架构决策文档（"Embedded OpenCode"、"SDK Contract IR"、双事件流语义等都有明文定义），本文多处引用。

对 Coolie 的意义：这正是 Coolie 想要的形态（TS server + 多形态 client + CLI），且它的"一个 server、按 directory 路由到多个项目实例"模式与 coolie = repo + branch 的定位直接对应。

---

## 2. Monorepo 结构：packages 划分与职责

Bun workspaces（根 `package.json` `workspaces.packages: ["packages/*", "packages/console/*", ...]`），turbo 跑 typecheck。与 Coolie 相关的核心包：

| 包 | 职责 | 证据 |
|---|---|---|
| `packages/opencode`（名 `opencode`） | 主 CLI 入口 + server + 大部分业务 service（session/provider/tool/mcp/lsp/permission/worktree…） | `packages/opencode/src/index.ts:1-33`（yargs 注册所有子命令） |
| `packages/core`（`@opencode-ai/core`） | 正在下沉的领域核心：SQLite database、event sourcing、session projector、models-dev catalog、pty、workspace、effect DI 基础设施 | 目录 `packages/core/src/`（database/、event/、session/、effect/…） |
| `packages/schema`（`@opencode-ai/schema`） | 纯 Effect Schema 定义（event、location、models-dev…），最底层 | `packages/schema/package.json`（只依赖 effect） |
| `packages/protocol`（`@opencode-ai/protocol`） | **HTTP API contract**：用 `HttpApi`/`HttpApiGroup` 声明全部端点，不含实现 | `packages/protocol/src/api.ts:37-64` |
| `packages/server`（`@opencode-ai/server`） | server 侧共享定义（cors、api 组装辅助） | `packages/server/package.json` |
| `packages/client`（`@opencode-ai/client`） | 由 protocol contract **生成**的网络 SDK，双输出：Promise 版 + Effect 版 | `packages/client/script/build.ts:7-30` |
| `packages/sdk/js`（`@opencode-ai/sdk`） | 旧一代 SDK：由 OpenAPI json 经 `@hey-api/openapi-ts` 生成；附 `createOpencodeServer()`（spawn `opencode serve` 子进程） | `packages/sdk/js/script/build.ts:10-15`、`packages/sdk/js/src/server.ts:22-40` |
| `packages/sdk-next`（`@opencode-ai/sdk-next`） | "Embedded OpenCode"：在内存中直接执行 server 的 HttpRouter，不开端口 | `CONTEXT.md`（"SDK executes Server's assembled HttpRouter in memory. It opens no listener…"） |
| `packages/httpapi-codegen` | 自研 SDK 生成器：HttpApi contract → "SDK Contract IR" → 多个 emitter | `packages/client/script/build.ts:2`（import `compile/emitPromise/emitEffectImported`） |
| `packages/tui` | TUI client（solid-js + @opentui 终端渲染） | `packages/tui/src/context/sdk.tsx:1`（用 `@opencode-ai/sdk/v2`） |
| `packages/app` / `packages/ui` / `packages/session-ui` / `packages/storybook` | solid-js Web UI 及组件库（desktop 与 web 共用） | `packages/app/package.json` |
| `packages/desktop` | Electron 壳（**不是 Tauri**） | `packages/desktop/package.json:15-22` |
| `packages/plugin`（`@opencode-ai/plugin`） | 插件 API 类型面（plugin 通过 SDK client 回连 server） | `packages/plugin/src/index.ts:57`（`client: ReturnType<typeof createOpencodeClient>`） |
| `packages/effect-drizzle-sqlite` / `effect-sqlite-node` | SQLite + drizzle 的 Effect 封装 | 各自 package.json |
| 其余（console/enterprise/function/identity/slack/stats/web/llm/codemode/http-recorder…） | SaaS/企业/文档站/实验设施，与 Coolie 无关 | — |

**依赖方向铁律**（根 `AGENTS.md:3`）："Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server."——这条分层纪律值得 Coolie 原样采用（schema → core/protocol → server；client 只碰 schema+protocol）。

---

## 3. client/server 分离：HTTP API、事件流、SDK 生成

### 3.1 API contract 与 server 组装

- contract 声明在 protocol 包：`HttpApi.make("server")` 逐个 `.add()` 挂 group——health、location、agent、session、message、model、provider、integration、credential、permission、fs、command、skill、event、pty、question、reference、projectCopy（`packages/protocol/src/api.ts:37-64`）。
- protocol 只放 contract，middleware 的**具体实现 key 由 server 注入**："Protocol owns middleware placement, while Server injects concrete keys so Core service identities stay downstream"（`packages/protocol/src/api.ts:25`）。client 侧则用空壳 middleware 占位来实例化同一 contract（`packages/client/src/contract.ts:5-17`）。
- server 启动：`Server.listen()` 用 Node `createServer` + effect `HttpRouter.serve`，端口默认策略"显式 0 时先试 4096 再随机"（`packages/opencode/src/server/server.ts:117-122`），支持 mDNS 发布（server.ts:155-170）。同文件还有 `Server.Default`：把 handler 包成 `{fetch, request}` 的内存 app，供进程内直接调用（server.ts:56-65）。
- 路由/handler 编写规范见 `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md`：`HttpApiBuilder.group()` 写普通端点，SSE 返回 `HttpServerResponse.stream(...)`，WebSocket 用 `handleRaw`；"stable service 在 layer 构建时 yield 一次，闭包进 handler，绝不在请求内 `Effect.provide` 重建"。

### 3.2 多项目路由（Coolie 最该抄的一块）

请求 → 项目实例的解析链：

1. `WorkspaceRoutingMiddleware` 从 `?directory=` 或 `x-opencode-directory` header 取目录，缺省 `process.cwd()`（workspace-routing.ts:87），产出 `RequestPlan.Local { directory, workspaceID }` 或 `Remote`（代理到远程 workspace，workspace-routing.ts:31-44）。
2. `InstanceContextMiddleware` 拿 directory 调 `InstanceStore.load({directory})`，把得到的 `InstanceContext` 通过 `Effect.provideService(InstanceRef, ctx)` 注入本次请求的 effect 环境（`packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts:23-43`）。
3. 下游所有 service 通过 `InstanceState.context`（读 `InstanceRef`，`packages/opencode/src/effect/instance-state.ts:14-18`）拿到当前项目的 `{directory, worktree, project}`。

`InstanceContext` 本体极小：`{ directory, worktree, project }`（`packages/opencode/src/project/instance-context.ts:5-9`）。

### 3.3 事件流：两条通道，语义分明

**通道 A：instance 级 live SSE** `GET /api/event`：

- contract：`HttpApiEndpoint.get("event.subscribe", "/api/event", { success: HttpApiSchema.StreamSse({ data: EventSchema }) })`（`packages/protocol/src/groups/event.ts:33-46`）。
- handler（`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:25-99`）要点：
  - 先 `Queue.unbounded` + 立即注册 listener，保证 body fiber 启动期间事件不丢（event.ts:29-33 注释）；
  - 按 `event.location.directory === instance.directory` 过滤，只推本项目事件（event.ts:35-39）；
  - 首条固定 `server.connected`，每 10s 心跳 `server.heartbeat`，收到 `server.instance.disposed` 就终止流（event.ts:59-71）。
- **明确不自动重连**：`CONTEXT.md`——"`events.subscribe()` does not automatically reconnect after transport loss… consumers refresh authoritative state before explicitly opening a new subscription"。

**通道 B：session 级 durable 事件** `sessions.events({ sessionID, after })`：可按 aggregate seq 游标 replay（`CONTEXT.md`："replays durable events after the optional aggregate sequence, continues with newly committed durable events"）。live 流和 durable 流被刻意设计成两个 API：schema、replay 保证、游标、生命周期都不同（`CONTEXT.md`："A Session ID is not an optional filter on events.subscribe()…"）。

进程内广播用一个极简单例 `GlobalBus`（Node `EventEmitter`，自动补 event id，`packages/opencode/src/bus/global.ts:11-22`）。

### 3.4 client 怎么连：三种 transport，一套 API

`opencode` TUI 命令（`packages/opencode/src/cli/cmd/tui.ts`）展示了很妙的设计：

- 默认模式：server 跑在**同进程 Worker 线程**里，TUI 通过自制 RPC 把 `fetch` 桥接过去，baseUrl 是假的 `"http://opencode.internal"`，**零 TCP 端口**（tui.ts:236-249：`external ? {url: real} : {url: "http://opencode.internal", fetch: createWorkerFetch(client), events: createEventSource(client)}`；createWorkerFetch 在 tui.ts:24-40）。
- `--port/--hostname` 时切换为真实 HTTP + `ServerAuth.headers()` 鉴权（tui.ts:236-240）。
- TUI 内部：`createOpencodeClient({baseUrl, fetch, ...})` 注入 solid context（`packages/tui/src/context/sdk.tsx:23-33`），SSE 事件做 batch 后统一触发渲染（sdk.tsx:53-60 注释）。
- 第三形态：`sdk-next` 的 Embedded OpenCode 直接在内存执行 HttpRouter——"Networked and Embedded OpenCode use the same OpenCode Client and preserve the full HTTP encoding, routing, middleware, and decoding boundary; only the HttpClient transport differs"（`CONTEXT.md`）。

**结论：API 边界永远是 HTTP contract，transport 可以是 TCP / worker RPC / 内存直调。** 这让"同进程内嵌"与"远程 attach"共用全部代码。

### 3.5 SDK 生成

两代并存：

1. **legacy**（`@opencode-ai/sdk`）：`bun dev generate > openapi.json` 导出 OpenAPI，再 `@hey-api/openapi-ts` 生成 TS client（`packages/sdk/js/script/build.ts:10-15`）。根 `AGENTS.md:1`："To regenerate the legacy JavaScript SDK, run ./packages/sdk/js/script/build.ts"。
2. **新一代**（`@opencode-ai/client`）：不经 OpenAPI，直接 `compile(ClientApi)` 把 HttpApi contract 编译成 "SDK Contract IR"，再由两个 emitter 分别产出 Promise 客户端（`src/generated`）和 Effect 客户端（`src/generated-effect`）（`packages/client/script/build.ts:7-30`）；生成物入库并用 CI diff 校验（`packages/client/package.json` 的 `check:generated` script）。设计动机在 `CONTEXT.md` 有整段论述（"SDK generation reflects the public HttpApi once into an SDK Contract IR…"）。

---

## 4. 依赖注入 / 上下文机制（重点，含可抄代码）

### 4.1 遗留简单模式：AsyncLocalStorage context + lazy

这是老 opencode `App.provide` 模式的两块原语，**至今仍在仓库里**：

```ts
// packages/opencode/src/util/local-context.ts:9-23（原文）
export function create<T>(name: string) {
  const storage = new AsyncLocalStorage<T>()
  return {
    use() {
      const result = storage.getStore()
      if (!result) throw new NotFound(name)
      return result
    },
    provide<R>(value: T, fn: () => R) {
      return storage.run(value, fn)
    },
  }
}
```

```ts
// packages/opencode/src/util/lazy.ts:1-20（原文，略缩）
export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false
  const result = (): T => { if (loaded) return value as T; value = fn(); loaded = true; return value as T }
  result.reset = () => { loaded = false; value = undefined }
  return result
}
```

用法示例：`packages/opencode/src/project/instance-context.ts:11` `export const context = LocalContext.create<InstanceContext>("instance")`；`packages/opencode/src/server/server.ts:56` `export const Default = lazy(() => {...})`。

老版 opencode（v0.x）的完整模式是：`App.provide(ctx, fn)` 用 ALS 把 app 上下文注入调用链，每个 service 是一个 namespace，内部用 `App.state("name", init, dispose)` 在 ctx 上懒初始化并缓存自己的 state——**此描述基于训练知识，本 clone 无历史无法逐行验证（未验证）**。但本仓库的迁移注释可以旁证该模式存在过："Bridge for Promise/ALS callers that cannot yet yield InstanceStore.Service. Delete this module once those callers are migrated to Effect boundaries"（`packages/opencode/src/project/instance-runtime.ts:5-7`）。

**给 Coolie 的简版重写**（把老模式浓缩为 ~40 行，语义与 opencode 旧版等价）：

```ts
// coolie 版：ctx = 一个 task/workspace 实例
interface Ctx { directory: string; branch: string; services: Map<string, { state: any; dispose?: (s: any) => Promise<void> }> }
const ctx = LocalContext.create<Ctx>("app")   // 上面那个 ALS 原语

export const App = {
  provide: <T>(input: Omit<Ctx, "services">, fn: () => Promise<T>) =>
    ctx.provide({ ...input, services: new Map() }, fn),
  // lazy service：第一次 use 时 init，挂在当前 ctx 上，随 ctx 销毁
  state<S>(key: string, init: (c: Ctx) => S, dispose?: (s: S) => Promise<void>) {
    return () => {
      const c = ctx.use()
      if (!c.services.has(key)) c.services.set(key, { state: init(c), dispose })
      return c.services.get(key)!.state as S
    }
  },
  async dispose() {
    const c = ctx.use()
    for (const [, v] of c.services) await v.dispose?.(v.state)
  },
}

// 某个 service 模块（namespace 即模块，无 class、无容器注册）
export namespace Session {
  const state = App.state("session", (c) => new Map<string, Info>())
  export function get(id: string) { return state().get(id) }
}
```

要点：**"依赖注入"在 opencode 语境里从来不是 IoC 容器，而是"用 ALS 传 request/instance 级上下文 + 模块级懒单例"**。HTTP middleware 里 `App.provide(ctx, () => next())` 一包，全链路的 service 自动拿到正确的项目实例。这套东西对 Coolie 的体量完全够用。

### 4.2 新一代 Effect 模式（本 clone 的现状）

如果 Coolie 想上 Effect，这里是完整拆解；不想上，可跳到 4.3 看结论。

**(a) Service 声明与实现分离**。每个 service 一个模块，导出 `Interface`、`Service`（Context tag）、`use`（proxy 访问器）、`node`（依赖图节点）。最小完整样例是 Env：

```ts
// packages/opencode/src/env/index.ts:8-41（原文，略缩）
export interface Interface {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  readonly all: () => Effect.Effect<State>
  ...
}
export class Service extends Context.Service<Service, Interface>()("@opencode/Env") {}
export const use = serviceUse(Service)

const layer = Layer.effect(Service, Effect.gen(function* () {
  const state = yield* InstanceState.make<State>(() => Effect.succeed({ ...process.env }))
  const get = Effect.fn("Env.get")((key) => InstanceState.use(state, (env) => env[key]))
  ...
  return Service.of({ get, all, set, remove })
}))

export const node = LayerNode.make({ service: Service, layer, deps: [] })
```

`serviceUse` 是一个 Proxy 语法糖：`Env.use.get("PATH")` 等价于 `Service.use(s => s.get("PATH"))`，只暴露返回 Effect 的方法（`packages/core/src/effect/service-use.ts:17-43`）。

**(b) LayerNode：自研的显式依赖图**。Effect 的 Layer 组合是隐式的；opencode 在其上做了一层 `LayerNode`：每个 node 记 `{service, implementation(layer), dependencies, tag}`（`packages/core/src/effect/layer-node.ts:22-31`），`LayerNode.compile()` 递归把依赖 `Layer.provide` 进来并做 memo + **循环依赖检测**（layer-node.ts:189-194 抛 "Cycle detected in layer tree: A -> B -> A"）。node 有 `global`/`location` 两种 tag（`packages/core/src/effect/app-node.ts:3-12`），`hoist()` 可以把 location 级 node 从图里拎出来单独构建（layer-node.ts:211-248）——用于同一 service 在不同 location 有不同实例。

**(c) AppRuntime：全局单例运行时**。约 50 个 service node 组成一棵图，`AppNodeBuilderV1.build(LayerNode.group([...]))` 编译成一个 `AppLayer`，再 `ManagedRuntime.make(AppLayer, { memoMap })`（`packages/opencode/src/effect/app-runtime.ts:58-111`）。`memoMap` 是模块级 `Layer.makeMemoMapUnsafe()` 单例（`packages/core/src/effect/memo-map.ts:3`）——**多个 runtime（HTTP listener、CLI、后台任务）共享同一份 service 实例**，这是它替代"全局单例对象"的方法。

**(d) 三级作用域**，这是整套 DI 的核心分层：

```
进程级（global services，ManagedRuntime + memoMap 单例）
  └─ 项目实例级（per directory）
       InstanceStore: Map<directory, Deferred<InstanceContext>>，并发 load 去重、
       reload/dispose 全生命周期 + 发 server.instance.disposed 事件
       （packages/opencode/src/project/instance-store.ts:108-124 load、147-164 dispose、189-190 provide）
       InstanceState.make(init): 每个 service 内部的"按 directory 缓存的懒状态"
       —— 用 ScopedCache<directory, State> 实现，并 registerDisposer 挂钩全局
       dispose（packages/opencode/src/effect/instance-state.ts:26-45）
  └─ 请求级（per request）
       InstanceRef / WorkspaceRef：Context.Reference（默认 undefined），由 HTTP
       middleware Effect.provideService 注入（instance-ref.ts:5-11、
       middleware/instance-context.ts:30-33）
```

即：**global service 是单例，但它的"每个项目的状态"通过 `InstanceState`（keyed cache）+ `InstanceRef`（当前项目是谁）动态解析**。老模式里 `App.state` 一个原语干的事，被拆成了 Ref + ScopedCache + Store 三件套。22 个模块用 `InstanceState.make`（grep 统计，如 provider.ts:1330、config.ts:600、lsp.ts:145、mcp/index.ts:492…）。

**(e) 附属设施**：
- `State.create`（`packages/core/src/state.ts:61-128`）：可重放 transform 的 draft state，plugin/config 改配置时整体重建（`transform` 注册、scope 关闭时自动撤销并 reload）——热重载语义的通用解法。
- `EffectBridge`（`packages/opencode/src/effect/bridge.ts:54-82`）：Effect ↔ Promise 世界互操作时捕获/恢复 InstanceRef + workspace ALS。存在本身就说明**双范式并存的桥接成本很高**。

### 4.3 给 Coolie 的判断

- 抄 **4.1 简单模式**（ALS context + namespace service + lazy state + dispose 注册表），再叠加一个 opencode 新版才想清楚的点：**instance 加载要有并发去重与显式生命周期**——`InstanceStore` 的 `Map<directory, Deferred>`（并发 load 只 boot 一次）、`reload`（先 dispose 旧的再 boot）、`disposeAll` + 完成后发事件，这个状态机直接平移到"Coolie task = worktree + session"上。
- **不要抄** LayerNode/ManagedRuntime/EffectBridge 这一层。它们是 50+ service、双范式迁移期的产物；Coolie 初期 service 数量大概率 <15。

---

## 5. provider / 模型抽象（→ Coolie 的 coding engine 抽象）

opencode 统一多家 LLM 的结构是清晰的三层：

**第一层：catalog（模型元数据）= models.dev**
- `ModelsDev` service 从 `https://models.dev` 拉全量 provider/model JSON（可用 `OPENCODE_MODELS_URL` 覆盖），缓存到 `Global.Path.cache/models.json`，用跨进程文件锁 Flock 防多 CLI 竞写，`Effect.cachedInvalidateWithTTL` 内存缓存 + 每 60 分钟后台刷新（`packages/core/src/models-dev.ts:138-144, 201-238`）。
- Model schema 字段：cost（含 cache_read/write、分层定价 tiers）、limit（context/input/output）、attachment/reasoning/tool_call/temperature 能力位、modalities、status（alpha/beta/deprecated）、`provider.npm`（该模型该用哪个 npm SDK 包）（models-dev.ts:47-100）。

**第二层：合并（catalog → plugin → 用户 config → auth/env 探测）**
- Provider service 的 instance state 构建流程（`packages/opencode/src/provider/provider.ts:1330-1420`）：先取 models.dev catalog → 跑 plugin 的 provider hook（可动态改模型列表）→ 用户 `config.provider` 深合并（mergeDeep）→ `disabled_providers`/`enabled_providers` 过滤 → 结合 auth/env 判定每个 provider 是否可用。
- 凭证统一存 `~/.local/share/opencode/auth.json`（`packages/opencode/src/auth/index.ts:11`），三种类型 schema 化：`Oauth {refresh, access, expires}` / `Api {key}` / `WellKnown {key, token}`（auth/index.ts:15-36），支持 `OPENCODE_AUTH_CONTENT` 环境变量整体注入（auth/index.ts:59-61 附近）。

**第三层：runtime adapter = Vercel AI SDK 的 `LanguageModelV3`**
- 统一接口就是 ai-sdk：常见 provider 的 SDK 直接打包并**动态 import**（`BUNDLED_PROVIDERS` 表，`provider.ts:105-120`：`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@openrouter/ai-sdk-provider`…）；catalog 里声明了 npm 包但没打包的，运行时 `Npm.add(model.api.npm)` 现装再加载（provider.ts:1768）。
- provider 间的行为差异集中在 `ProviderTransform`（`packages/opencode/src/provider/transform.ts`，未细读）和一些 SSE 超时包装（provider.ts:37-84 `wrapSSE`）。

**映射到 Coolie 的 coding engine 抽象**：
- engine catalog（静态描述：名字、二进制、tux/headless 能力位、会话恢复方式）≈ models.dev catalog——建议同样做成"远端/内置 JSON + 本地缓存 + schema 校验"；
- 用户 config 深合并 + enable/disable 列表 ≈ 第二层；
- 每个 engine 一个 adapter（claude/codex 的 spawn 参数、tux attach 方式）≈ 第三层，且**懒加载**（用到才 import/探测二进制）。
- auth.json 的"按 provider 键控的 discriminated union 凭证文件"模式可直接抄来管各 engine 的凭证/quota 状态。

---

## 6. session/message 存储与事件流

### 6.1 存储：从 JSON 文件迁往 SQLite（event sourcing + projector）

**旧：flat-file JSON KV**。`Storage` service 是 `key: string[] → path.join(dir, ...key) + ".json"` 的读写列举接口（`packages/opencode/src/storage/storage.ts:53-65`），内含多个把旧目录布局搬新家的 `MIGRATIONS`（storage.ts:81+）。现在基本只剩迁移和零散用途（如 `session_diff`，`packages/opencode/src/session/revert.ts:76`）。

**新：单一 SQLite**。`Global.Path.data/opencode.db`（可被 `OPENCODE_DB` flag 覆盖；非稳定 channel 用 `opencode-<channel>.db` 隔离），bun/node 双驱动 + drizzle，启动时 `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000; foreign_keys=ON` + 迁移（`packages/core/src/database/database.ts` 的 layer 与 `path()`）。

**事件溯源结构**：
- `event` 表：`(id, aggregate_id, seq, type, data JSON)`，`(aggregate_id, seq)` 唯一索引；`event_sequence` 表维护每个 aggregate 的当前 seq（`packages/core/src/event/sql.ts:4-25`）。durable 事件带 `{aggregateID, seq, version}`，schema 由 manifest 注册并可校验解码（`packages/core/src/event.ts:42-61` InvalidDurableEventError / decodeSerializedEvent，`readAggregate` 按 seq 增量读）。
- `SessionProjector` 订阅这些事件，把它们**投影**成查询友好的表（`packages/core/src/session/projector.ts:1-30`，import 一排 Table + `SessionAlreadyProjected`）。
- 投影表设计（`packages/core/src/session/sql.ts`）：
  - `session`（:22-66）：把高频过滤/聚合字段提升为列（project_id、directory、title、cost、tokens_*、time_archived…），低频复杂结构放 JSON 列（revert、permission、model、summary_diffs）；
  - `message`（:68-81）/ `part`（:82-98）：`id + 外键 + 时间戳` 为列，**整个 body 是一个 JSON `data` 列**，配 `(session_id, time_created, id)` 索引；
  - `session_message`（:119-139）：新一代消息表，带 `(session_id, seq)` 唯一索引支持有序 replay；
  - `todo`（:100-117）：完全结构化。
- ID 方案：前缀 + 单调时间戳（ascending/descending 两种方向，descending 用于想让最新排最前的场景）（`packages/opencode/src/id/id.ts:22-62`）。

### 6.2 事件订阅链路

```
domain 代码 emit durable event ──> EventV2（写 SQLite event 表 + PubSub）
                                     │
GlobalBus（进程级 EventEmitter，bus/global.ts:22）←─ 生命周期类事件（instance disposed…）
                                     │
SSE handler（handlers/event.ts）：EventV2Bridge.listen → Queue → 按 directory 过滤 → SSE
client：EventSource/AsyncIterable 消费；断线 = 流 fail，刷新状态后重订阅（live 流）
或用 sessions.events({after: seq}) 从 SQLite replay（durable 流）
```

Session service 的公共接口面很全，可当 Coolie session 域建模清单：list/create/fork/touch/get/setTitle/setArchived/setMetadata/setAgentModel/setPermission/revert/summary/share/diff/messages/children…（`packages/opencode/src/session/session.ts:416-451`）。

---

## 7. 与 Coolie 相关的可借鉴点（按优先级）

1. **API-first 的 CS 分离**：protocol 包声明 contract → server 实现 → SDK 全部生成（起步用 openapi.json + `@hey-api/openapi-ts` 即可，成本最低，opencode legacy SDK 就是这条路，`packages/sdk/js/script/build.ts`）。Coolie 的 React client、CLI、未来 TUI 都吃同一 SDK。
2. **单 server 多项目实例 + directory 路由**：`?directory=` / header → `InstanceStore.load` → per-request 注入 context（第 3.2 节）。这个模式使"一个常驻 daemon 管 N 个 repo × branch worktree"天然成立——正是 Coolie 的核心场景。`InstanceStore` 的 `Deferred` 并发去重 + reload/dispose + disposed 事件是最值得逐行搬的 ~200 行（instance-store.ts）。
3. **DI 抄旧不抄新**：ALS `LocalContext` + namespace service + `lazy`/`App.state`（第 4.1 节给了可用简版）。Effect 全家桶对单人项目是负资产（见第 8 节）。
4. **双事件流语义**：live SSE（connected/heartbeat/disposed 生命周期、不承诺 replay、断线刷新重订）+ durable per-session 事件（seq 游标 replay）。Conductor 式 UI 的"重开窗口恢复现场"就靠 durable 流；不要试图用一条流同时满足两种语义（CONTEXT.md 对此有专门论证）。
5. **SQLite 单文件 + "索引列提升 + JSON data 列"折衷**：session/message 表设计（第 6.1 节）平衡了 schema 演进和查询性能；完整 event sourcing + projector 对 Coolie 可能过重，但"消息 body 存 JSON 列"这半步非常实用。
6. **Worktree service 接口**可直接当 Coolie 的核心域参考：`create/list/remove/reset`，porcelain 解析、branch -D 清理、fsmonitor 停止、非 git 项目报 NotGitError（`packages/opencode/src/worktree/index.ts:119-128` 接口，:190-460 实现细节）。
7. **transport 三态**（TCP / worker-RPC fetch 桥 / 内存直调）同一 API（第 3.4 节）。Coolie 的 Tauri client 可仿 `createOpencodeServer()`（spawn sidecar 子进程 + 健康等待，`packages/sdk/js/src/server.ts:22-40`），本地 CLI 则可走内嵌模式。
8. **engine 抽象三层**：catalog / config 合并 / lazy adapter + 统一凭证文件（第 5 节）。
9. **附带发现**：opencode 有 ACP（Agent Client Protocol）入口 `opencode acp`（`packages/opencode/src/cli/cmd/acp.ts`、`src/acp/`）——Coolie 做引擎集成时，除 tux 外可关注 ACP 作为 headless 集成的标准化通道（未深入研究，仅指出存在）。
10. **工程纪律**：根 AGENTS.md 的风格约定（避免 try/catch、避免解构、单次使用不提前抽 helper）、`CONTEXT.md` 用"定义术语 + 关系陈述"的方式沉淀架构决策——这种文档形态对单人 + agent 协作的项目极其有效，建议 Coolie 开局就建一份。

---

## 8. 风险与应避免的复杂度

- **Effect 4.0 beta 全家桶**：整库押注 beta 版 effect（catalog `"effect": "4.0.0-beta.83"`），甚至 patch 了 effect 本体（根 `package.json` `patchedDependencies` 含 `effect@4.0.0-beta.83`）。类型体操深（layer-node.ts 里 300+ 行泛型）、生态窄、招式与 Promise 世界互操作要专门写桥（EffectBridge）。Coolie 单人项目不要跟。
- **迁移期双轨并存的代价**：存储（JSON Storage vs SQLite）、事件（GlobalBus vs EventV2 + event-v2-bridge）、SDK（sdk vs client vs sdk-next）、DI（ALS vs Effect，instance-runtime.ts 这种"迁完就删"桥接模块）全都两代并存。这是大团队重构的中间态，不是目标形态；Coolie 从第一天就单源。
- **范围蔓延对照**：workspace control-plane（本地/远程路由代理）、share、enterprise、slack、console、codemode、http-recorder……opencode 已是商业公司产品。Coolie 保持"个人伴侣"定位，protocol 里 18 个 group 对 Coolie 而言砍到 6 个以内（session/message/event/worktree/engine/fs）足够。
- **desktop 技术栈差异**：opencode desktop 是 **Electron + solid-js**，不是 React + Tauri；其 UI 代码组织（app/ui/session-ui 三层复用 + storybook）可参考，但绑定 solid，组件不能直接搬。
- **shallow clone 限制**：想研究旧版 `App.provide/Instance.state` 原始实现需 `git fetch --unshallow` 或另拉历史 tag（本文相关描述已标注未验证）。

---

## 9. 未解决的疑问

1. 旧版 `App.provide` / `Instance.state` 的原始实现无法在本 clone 验证（depth=1）；4.1 的"老模式完整语义"部分基于训练知识重构，标未验证。
2. `ProviderTransform`（各 LLM 兼容性 shim）与 `packages/llm`（协议适配层）未细读——Coolie 不做 LLM 直连，优先级低。
3. tux：opencode 仓库内未出现该词；Coolie 语境的 tux（终端 UI 复用 claude/codex 自身渲染）在 opencode 中没有对应物，opencode 走的是"自渲染 TUI + SDK"路线，两者是不同的集成策略。
4. `packages/cli`（bin 名 `lildax`）的用途未查明，与主 CLI `opencode` 的关系不明。

---

## 10. 来源清单

代码（均相对 `/Users/outman/workspace/ai/personal_ai/Coolie/refs/opencode`，commit 9976269）：

- 结构/纪律：`package.json`（workspaces、catalog、patchedDependencies）；`AGENTS.md:1-5`（SDK 再生成、依赖方向）；`CONTEXT.md`（架构决策全文）
- server：`packages/opencode/src/cli/cmd/serve.ts:6-24`；`packages/opencode/src/server/server.ts:56-138,155-224`；`packages/opencode/src/server/routes/instance/httpapi/AGENTS.md`
- contract/路由：`packages/protocol/src/api.ts:25-87`；`packages/protocol/src/groups/event.ts:29-57`；`.../httpapi/middleware/workspace-routing.ts:22-44,87,156,207-208`；`.../httpapi/middleware/instance-context.ts:8-43`
- SSE：`.../httpapi/handlers/event.ts:12-99`；`packages/opencode/src/bus/global.ts:4-22`
- DI：`packages/opencode/src/util/local-context.ts:9-25`；`util/lazy.ts:1-20`；`project/instance-context.ts:5-24`；`project/instance-runtime.ts:5-16`；`project/instance-store.ts:14-213`；`effect/instance-ref.ts:5-11`；`effect/instance-state.ts:7-69`；`effect/instance-registry.ts:1-12`；`effect/app-runtime.ts:58-135`；`effect/bridge.ts:27-84`；`packages/core/src/effect/layer-node.ts:22-127,189-272`；`core/src/effect/app-node.ts:3-14`；`core/src/effect/service-use.ts:17-43`；`core/src/effect/memo-map.ts:3`；`core/src/state.ts:29-128`；样例 service `packages/opencode/src/env/index.ts:1-41`
- provider：`packages/core/src/models-dev.ts:15-244`；`packages/opencode/src/provider/provider.ts:37-120,1290-1420,1768`；`packages/opencode/src/auth/index.ts:11-52`；`packages/opencode/src/provider/auth.ts:114`
- 存储/事件：`packages/opencode/src/storage/storage.ts:53-120`；`packages/core/src/database/database.ts`（layer、path()）；`core/src/event/sql.ts:4-25`；`core/src/event.ts:1-80`；`core/src/session/sql.ts:22-168`；`core/src/session/projector.ts:1-80`；`packages/opencode/src/session/session.ts:416-451`；`packages/opencode/src/id/id.ts:18-62`；`packages/core/src/global.ts:10-32`
- client/SDK：`packages/client/script/build.ts:1-31`；`packages/client/src/contract.ts:1-53`；`packages/sdk/js/script/build.ts:1-30`；`packages/sdk/js/src/server.ts:22-40`；`packages/sdk/js/src/v2/client.ts:50-62`；`packages/opencode/src/cli/cmd/tui.ts:24-46,210-260`；`packages/tui/src/context/sdk.tsx:1-60`
- 其他：`packages/opencode/src/worktree/index.ts:119-128`（接口）；`packages/core/src/location.ts:11-38`；`packages/plugin/src/index.ts:1-57`；`packages/desktop/package.json:15-31`；`packages/opencode/src/cli/cmd/acp.ts`（存在性）

外部：models.dev（`https://models.dev`，代码内引用 models-dev.ts:138）；opencode GitHub（任务给定 `https://github.com/sst/opencode`，clone 内已指向 `https://github.com/anomalyco/opencode`）。
