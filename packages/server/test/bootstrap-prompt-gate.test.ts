import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Effect, Layer, Exit } from "effect"
import { EventEmitter } from "node:events"
import * as http from "node:http"
import Database from "better-sqlite3"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepo, ProjectsRepoLive } from "../src/repo/projects.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { GitServiceLive } from "../src/git/service.js"
import { SetupRunnerLive } from "../src/workspace/setup.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive } from "../src/workspace/lifecycle.js"
import { EngineRegistry, EngineRegistryLive } from "../src/engine/registry.js"
import type { Engine } from "../src/engine/types.js"
import { EngineBootstrapHookLive, sessionNameFor } from "../src/engine/bootstrap.js"
import { makeTmuxService, TmuxService } from "../src/tmux/service.js"
import { EventsBus } from "../src/events/bus.js"
import { createApp, newToken } from "../src/http/app.js"

/**
 * Plan3 Task15：首条 prompt 投递按 SessionStart hook 就绪信号门控（回归修复）。
 *
 * pane 命令 `bash -c "read -t N -r d; exec cat"` 模拟 engine 冷启动：
 * [0, N)s 内到达的输入被这个「过渡期读者」read 走并丢弃（真实 bug 的机制——claude 冷启动阶段
 * tty 仍是默认 cooked 模式，键入内容会回显一次，但在 TUI 接管 stdin 前到达的内容永远进不了
 * claude 自己的输入循环）；过渡期结束后 exec 成 cat，之后到达的输入才会被「app」真正读到并
 * 回显第二次。用回显次数区分「送达」和「丢失」。
 *
 * 注意：真实 claude 的 SessionStart 只会在 TUI 真正 attach stdin *之后* 才触发——hook 信号本身
 * 就是「过渡期已经结束」的证据。所以测试里必须等 read 的丢字窗口自然过期（cat 已经接管）之后
 * 才去发这条模拟信号，不能在窗口内提前发——提前发是在验证一个生产环境不会出现的错误前提
 * （「hook 已响但 reader 还没接管」），而不是在验证门控本身。
 */

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-hg`
const tmux = makeTmuxService(SOCK)
let home: string, wsRoot: string, repoRoot: string, db: Database.Database
const bus = new EventEmitter()
bus.setMaxListeners(0)

const gatedEngine = (discardSeconds: number): Engine => ({
  id: "claude", displayName: "Fake Claude (hooked)",
  capabilities: { nativeQueue: true, midSessionModelSwitch: true, resume: true, hooks: true, effort: false },
  terminalTitle: "none",
  newSessionId: () => `sess-${Math.random().toString(36).slice(2, 8)}`,
  launchCommand: () => ["/bin/bash", "-c", `read -t ${discardSeconds} -r d; exec cat`],
  statusFromHookEvent: () => null,
  transcriptPath: ({ home: h, cwd, sessionId }) => path.join(h, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`),
  deriveTitle: () => null,
  resumeArgs: (s) => ["--resume", s],
})

const buildLayer = (engine: Engine, promptReadyTimeoutMs: number) => {
  const cfgLayer = Layer.succeed(CoolieConfig, {
    home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
    workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"), codexHome: path.join(home, "codex-home"),
    promptReadyTimeoutMs,
  })
  return WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(EngineBootstrapHookLive),
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive, SetupRunnerLive,
      Layer.succeed(TmuxService, tmux),
      Layer.succeed(EngineRegistry, new Map([[engine.id, engine]])),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
    Layer.provideMerge(Layer.succeed(EventsBus, bus)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(cfgLayer),
  )
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hg-home-"))
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hg-ws-"))
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-hg-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repoRoot })
  db = new Database(":memory:"); runMigrations(db)
})
afterAll(() => { try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ } })

const cap = (target: string) => Effect.runPromise(tmux.capturePane(target))
const echoCount = (text: string, needle: string) => (text.match(new RegExp(needle, "g")) ?? []).length
const waitForValue = async <T,>(fn: () => T | undefined, ms = 8000): Promise<T> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = fn()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("waitForValue timeout")
}

describe("bootstrap：首条 prompt 投递按 SessionStart hook 就绪信号门控（Plan3 Task15）", () => {
  it("hooks 能力开启：收到 engine.session.started 前不投递；信号在 reader 真正接管之后到达，投递安全送达", async () => {
    const DISCARD_SECONDS = 1 // 过渡期读者窗口：1s 内到达的输入被吞
    const engine = gatedEngine(DISCARD_SECONDS)
    const layer = buildLayer(engine, 4000) // 就绪超时给足余量，本用例走信号路径，不该撞超时
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const project = yield* projects.add(repoRoot)
      return yield* lc.create({ projectId: project.id, name: "hook-gated-1", initialPrompt: "gate-me" })
    })
    const createExit = Effect.runPromiseExit(Effect.provide(program, layer) as Effect.Effect<any, any, never>)

    const wsId = await waitForValue(() => (db.prepare("SELECT id FROM workspaces WHERE name = 'hook-gated-1'").get() as any)?.id)
    // 等 tab 落地：证明 bootstrap 已经订阅完 bus、起完 tmux session（订阅发生在起 session 之前）
    await waitForValue(() => (db.prepare("SELECT id FROM tabs WHERE workspace_id = ?").get(wsId) as any)?.id)

    const session = sessionNameFor(wsId)
    // 门控生效的证据之一：信号发出前（仍在过渡期读者窗口内），pane 里不该出现我们的 prompt 文本
    await new Promise((r) => setTimeout(r, 300))
    expect(await cap(`${session}:0`)).not.toContain("gate-me")

    // 真实 claude 只会在 TUI 真正 attach stdin 之后才打 SessionStart——等过渡期窗口自然过期
    // （reader 已经换成 cat）之后再模拟 hook 落地，这样信号才如实对应「reader 已就绪」。
    await new Promise((r) => setTimeout(r, (DISCARD_SECONDS + 0.5) * 1000))
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      yield* (yield* EventsRepo).append({ workspaceId: wsId, type: "engine.session.started", payload: {} })
    }), layer) as Effect.Effect<any, never, never>)

    const exit = await createExit
    expect(Exit.isSuccess(exit)).toBe(true)

    let text = ""
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      text = await cap(`${session}:0`)
      if (echoCount(text, "gate-me") >= 2) break
      await new Promise((r) => setTimeout(r, 100))
    }
    // ≥2 次回显（tty echo + cat 自己的回显）= 真正被「app」收到，而不是丢进了过渡期读者
    expect(echoCount(text, "gate-me")).toBeGreaterThanOrEqual(2)
  })

  it("SessionStart 信号一直不来：就绪超时后降级走强化 waitStable 兜底，仍然投递成功", async () => {
    const engine = gatedEngine(0) // 无丢字窗口：一起来就 exec cat，只用于验证 timeout 兜底路径能投递成功
    const layer = buildLayer(engine, 200) // 极短就绪超时，快速触发 fallback（不发任何信号）
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      // 第一个用例已经 add 过同一个 repoRoot：projects.add 对已存在 repoRoot 会报 ConflictError，
      // 复用已有项目行而非重新 add。
      const list = yield* projects.list()
      const project = list[0]!
      return yield* lc.create({ projectId: project.id, name: "hook-gated-2", initialPrompt: "fallback-me" })
    })
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer) as Effect.Effect<any, any, never>)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const session = sessionNameFor(exit.value.id)
      let text = ""
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        text = await cap(`${session}:0`)
        if (text.includes("fallback-me")) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(text).toContain("fallback-me")
    }
  })

  it("hooks 开启但信号永不到达：超时降级前先记 prompt.delivery.degraded（取证可见），且排在 prompt.delivered 之前", async () => {
    const engine = gatedEngine(0) // 无丢字窗口，只验证事件取证与排序
    const timeoutMs = 200
    const layer = buildLayer(engine, timeoutMs) // 极短就绪超时 + 不发任何信号 → 走 hooks+timeout 降级路径
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      const project = list[0]!
      return yield* lc.create({ projectId: project.id, name: "hook-gated-3", initialPrompt: "degrade-me" })
    })
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer) as Effect.Effect<any, any, never>)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const wsId = exit.value.id
      const rows = db
        .prepare("SELECT seq, type, payload FROM events WHERE workspace_id = ? ORDER BY seq")
        .all(wsId) as Array<{ seq: number; type: string; payload: string }>
      const degraded = rows.find((r) => r.type === "prompt.delivery.degraded")
      const delivered = rows.find((r) => r.type === "prompt.delivered")
      // 降级取证事件被写入
      expect(degraded).toBeDefined()
      // 载荷如实标注超时原因与阈值（供 kobe 取证）
      expect(JSON.parse(degraded!.payload)).toEqual({ reason: "session-start-timeout", timeoutMs })
      // 仍然投递（降级不阻断投递）
      expect(delivered).toBeDefined()
      // 取证事件排在投递之前
      expect(degraded!.seq).toBeLessThan(delivered!.seq)
    }
  })
})

describe("bootstrap：create 带 engineId 走对应引擎（M2 Task2 流水线贯通）", () => {
  it("create 带 engineId=codex → tab.engineId=codex、launch 用 codex 命令、.codex/hooks.json 进 info/exclude", async () => {
    const claude = gatedEngine(0)
    // fake codex：hooks 能力开着，用来验证 bootstrap 走 codex 注入分支（.codex/hooks.json + info/exclude），
    // 而非 M1 硬编码的 claude 分支。launchCommand 返回可辨识哨兵，供 tmux 命令断言。
    const fakeCodex: Engine = {
      id: "codex", displayName: "Fake Codex",
      capabilities: { nativeQueue: false, midSessionModelSwitch: true, resume: true, hooks: true, effort: true },
      terminalTitle: "engine-owned",
      newSessionId: () => `codex-${Math.random().toString(36).slice(2, 8)}`,
      launchCommand: () => ["codex-fake"],
      statusFromHookEvent: () => null,
      transcriptPath: ({ home: h, sessionId }) => path.join(h, `${sessionId}.jsonl`),
      deriveTitle: () => null,
      resumeArgs: (s) => ["resume", s],
    }
    let lastCommand: string[] | undefined
    const recordingTmux: TmuxService = { ...tmux, newSession: (opts) => { lastCommand = opts.command; return tmux.newSession(opts) } }
    const cfgLayer = Layer.succeed(CoolieConfig, {
      home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
      workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"), codexHome: path.join(home, "codex-home"),
      promptReadyTimeoutMs: 4000,
    })
    const layer = WorkspaceLifecycleLive.pipe(
      Layer.provideMerge(EngineBootstrapHookLive),
      Layer.provideMerge(Layer.mergeAll(
        GitServiceLive, SetupRunnerLive,
        Layer.succeed(TmuxService, recordingTmux),
        Layer.succeed(EngineRegistry, new Map([[claude.id, claude], [fakeCodex.id, fakeCodex]])),
      )),
      Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
      Layer.provideMerge(Layer.succeed(EventsBus, bus)),
      Layer.provideMerge(Layer.succeed(Db, db)),
      Layer.provideMerge(cfgLayer),
    )
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      const project = list.length > 0 ? list[0]! : yield* projects.add(repoRoot)
      return yield* lc.create({ projectId: project.id, name: "codex-ws-1", engineId: "codex", initialPrompt: "" })
    })
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer) as Effect.Effect<any, any, never>)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const ws = exit.value
      const tabRow = db.prepare("SELECT engine_id FROM tabs WHERE workspace_id = ? AND kind = 'engine'").get(ws.id) as any
      expect(tabRow?.engine_id).toBe("codex")
      expect((lastCommand ?? []).join(" ")).toContain("codex-fake")
      // 门 gate-review 绑定项：codex hooks 产物 .codex/hooks.json 必须写进 info/exclude（同 M1 claude 手法）
      const exclude = fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8")
      expect(exclude).toContain(".codex/hooks.json")
    }
  })
})

describe("bootstrap：起 session 前调用 engine.prepareWorkspace（预置文件夹信任，跳过 trust dialog 死锁）", () => {
  it("prepareWorkspace 以 worktree cwd 被调用，且严格早于 tmux session 创建", async () => {
    const order: string[] = []
    const recorded: Array<{ cwd: string; claudeConfigPath?: string; codexConfigPath?: string }> = []
    // 录音引擎：无 prompt（不触发投递门控），只观测 prepareWorkspace 的调用参数与时序。
    const engine: Engine = {
      ...gatedEngine(0),
      displayName: "Fake Claude (prepare-recording)",
      prepareWorkspace: (ctx) => { recorded.push(ctx); order.push("prepare") },
    }
    // 包裹真实 tmux service，在 newSession 落点记一笔时序标记。
    const recordingTmux: TmuxService = { ...tmux, newSession: (opts) => { order.push("newSession"); return tmux.newSession(opts) } }
    const cfgLayer = Layer.succeed(CoolieConfig, {
      home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
      workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"), codexHome: path.join(home, "codex-home"),
      claudeConfigPath: path.join(home, "trust-config.json"), codexConfigPath: path.join(home, "codex-config.toml"), promptReadyTimeoutMs: 4000,
    })
    const layer = WorkspaceLifecycleLive.pipe(
      Layer.provideMerge(EngineBootstrapHookLive),
      Layer.provideMerge(Layer.mergeAll(
        GitServiceLive, SetupRunnerLive,
        Layer.succeed(TmuxService, recordingTmux),
        Layer.succeed(EngineRegistry, new Map([[engine.id, engine]])),
      )),
      Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
      Layer.provideMerge(Layer.succeed(EventsBus, bus)),
      Layer.provideMerge(Layer.succeed(Db, db)),
      Layer.provideMerge(cfgLayer),
    )
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const project = (yield* projects.list())[0]!
      return yield* lc.create({ projectId: project.id, name: "prepare-order-1" }) // 无 initialPrompt
    })
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer) as Effect.Effect<any, any, never>)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      // 以 worktree cwd 调用一次
      expect(recorded).toHaveLength(1)
      expect(recorded[0]!.cwd).toBe(exit.value.path)
      // 配置路径如实透传（供真实 adapter 写入 ~/.claude.json 的可覆盖 seam）
      expect(recorded[0]!.claudeConfigPath).toBe(path.join(home, "trust-config.json"))
      // codexConfigPath 同样透传（codex adapter 的 config.toml trust seam；测试可覆写防污染真实 ~/.codex）
      expect(recorded[0]!.codexConfigPath).toBe(path.join(home, "codex-config.toml"))
      // 严格时序：预备在起 session 之前
      expect(order).toEqual(["prepare", "newSession"])
    }
  })
})

describe("bootstrap：serverGeneratedId 引擎先启动后回填（服务端造 id，Task9）", () => {
  // fake codex：serverGeneratedId=true。newSessionId 返回哨兵——serverGeneratedId 分流后
  // bootstrap 绝不该调用它/把它塞进 launch 命令，泄漏即断言失败。
  const fakeServerIdEngine = (): Engine => ({
    id: "codex", displayName: "Fake Codex (serverGeneratedId)",
    capabilities: { nativeQueue: false, midSessionModelSwitch: true, resume: true, hooks: true, effort: true },
    terminalTitle: "engine-owned",
    serverGeneratedId: true,
    newSessionId: () => "codex-SHOULD-NOT-APPEAR",
    launchCommand: ({ sessionId }) => (sessionId ? ["codex-fake", "--session-id", sessionId] : ["codex-fake"]),
    statusFromHookEvent: () => null,
    transcriptPath: ({ home: h, sessionId }) => path.join(h, `${sessionId}.jsonl`),
    deriveTitle: () => null,
    resumeArgs: (s) => ["resume", s],
  })

  const buildCodexLayer = (recordingTmux: TmuxService) => {
    const claude = gatedEngine(0)
    const codex = fakeServerIdEngine()
    const cfgLayer = Layer.succeed(CoolieConfig, {
      home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
      workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"), codexHome: path.join(home, "codex-home"),
      promptReadyTimeoutMs: 4000,
    })
    return WorkspaceLifecycleLive.pipe(
      Layer.provideMerge(EngineBootstrapHookLive),
      Layer.provideMerge(Layer.mergeAll(
        GitServiceLive, SetupRunnerLive,
        Layer.succeed(TmuxService, recordingTmux),
        Layer.succeed(EngineRegistry, new Map([[claude.id, claude], [codex.id, codex]])),
      )),
      Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
      Layer.provideMerge(Layer.succeed(EventsBus, bus)),
      Layer.provideMerge(Layer.succeed(Db, db)),
      Layer.provideMerge(cfgLayer),
    )
  }

  const createCodexWs = async (name: string, recordingTmux: TmuxService) => {
    const layer = buildCodexLayer(recordingTmux)
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      const project = list.length > 0 ? list[0]! : yield* projects.add(repoRoot)
      return yield* lc.create({ projectId: project.id, name, engineId: "codex", initialPrompt: "" })
    })
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer) as Effect.Effect<any, any, never>)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) throw new Error("create failed")
    return exit.value
  }

  it("serverGeneratedId 引擎 create → tab.engineSessionId 起始 null，launch 不带 session id", async () => {
    let lastCommand: string[] | undefined
    const recordingTmux: TmuxService = { ...tmux, newSession: (opts) => { lastCommand = opts.command; return tmux.newSession(opts) } }
    const ws = await createCodexWs("codex-sgid-1", recordingTmux)
    const tabRow = db.prepare("SELECT engine_session_id FROM tabs WHERE workspace_id = ? AND kind = 'engine'").get(ws.id) as any
    // 服务端造 id：起始存 null，等首个 SessionStart hook 回填真 id
    expect(tabRow?.engine_session_id).toBeNull()
    // launch 命令绝不出现占位 id，也不带 --session-id（codex 不支持预指定 session id）
    expect((lastCommand ?? []).join(" ")).not.toContain("codex-SHOULD-NOT-APPEAR")
    expect((lastCommand ?? []).join(" ")).not.toContain("--session-id")
  })

  it("codex 首个 SessionStart hook 回填真 id（复用 /hooks/:engine C4 回填，真 HTTP roundtrip）", async () => {
    const ws = await createCodexWs("codex-sgid-2", tmux)
    // 起始 null（先启动）
    const before = db.prepare("SELECT engine_session_id FROM tabs WHERE workspace_id = ? AND kind = 'engine'").get(ws.id) as any
    expect(before?.engine_session_id).toBeNull()

    // 真 /hooks/codex roundtrip：用 EngineRegistryLive（真 codex 已注册）over 同一个 db，
    // POST 首个 SessionStart 带真 id → C4「stored 为 null 也回填」把真 id 写回 tab。
    const hookLayer = Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive, EngineRegistryLive)
      .pipe(Layer.provide(Layer.succeed(Db, db)))
    const runtime = (eff: any) => Effect.runPromiseExit(Effect.provide(eff, hookLayer) as Effect.Effect<any, never, never>)
    const token = newToken()
    const server = http.createServer(createApp({ runtime, token, onShutdown: () => {}, codexHome: path.join(home, "codex-home") }))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as { port: number }).port
    try {
      const r = await fetch(`http://127.0.0.1:${port}/hooks/codex?workspace=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "real-cx-id" }),
      })
      expect(r.status).toBe(200)
    } finally {
      server.close()
    }
    const after = db.prepare("SELECT engine_session_id FROM tabs WHERE workspace_id = ? AND kind = 'engine'").get(ws.id) as any
    expect(after?.engine_session_id).toBe("real-cx-id")
  })
})

describe("bootstrap：codex 无-hooks 通路——rollout 文件就绪门控 + id 回填（0.139 四断点修复）", () => {
  // fake codex：hooks 能力关（0.139 现实）+ serverGeneratedId。initialPrompt 有值 → 触发 gateOnRollout。
  // launchCommand = exec cat（pane 存活可收字，供投递验证）；newSessionId 返回哨兵——rollout 门控回填真 id，
  // 绝不该用 newSessionId 的值。
  const ROLLOUT_UUID = "019f5586-002d-73c1-98b9-ef17a05f06c9"
  const rolloutCodex: Engine = {
    id: "codex", displayName: "Fake Codex (rollout-gated)",
    capabilities: { nativeQueue: false, midSessionModelSwitch: true, resume: true, hooks: false, effort: true },
    terminalTitle: "engine-owned",
    serverGeneratedId: true,
    newSessionId: () => "codex-SHOULD-NOT-APPEAR",
    launchCommand: () => ["/bin/bash", "-c", "exec cat"],
    statusFromHookEvent: () => null,
    transcriptPath: ({ home: h, sessionId }) => path.join(h, `${sessionId}.jsonl`),
    deriveTitle: () => null,
    resumeArgs: (s) => ["resume", s],
  }

  it("rollout 文件出现 → 回填 engineSessionId(=文件名 UUID) + engine.session.started(早于 delivered)，无 90s 降级", async () => {
    const layer = buildLayer(rolloutCodex, 4000)
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const list = yield* projects.list()
      const project = list[0]!
      return yield* lc.create({ projectId: project.id, name: "codex-rollout-1", engineId: "codex", initialPrompt: "rollout-me" })
    })
    const createExit = Effect.runPromiseExit(Effect.provide(program, layer) as Effect.Effect<any, any, never>)

    // 等 ws 行（拿 path，rollout session_meta.cwd 必须精确等于 worktree path）+ tab 行（证明已起 session、门控开始轮询）
    const ws = await waitForValue(() => db.prepare("SELECT id, path FROM workspaces WHERE name = 'codex-rollout-1'").get() as { id: string; path: string } | undefined)
    await waitForValue(() => (db.prepare("SELECT id FROM tabs WHERE workspace_id = ?").get(ws.id) as any)?.id)

    // 起 session 之后落地 rollout 文件（codexHome/sessions 日期树；session_meta 首行带 id + 本 worktree 的 cwd）
    const codexHome = path.join(home, "codex-home")
    const rolloutPath = path.join(codexHome, "sessions", "2026", "07", "12", `rollout-2026-07-12T00-00-00-${ROLLOUT_UUID}.jsonl`)
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true })
    fs.writeFileSync(rolloutPath, JSON.stringify({ type: "session_meta", payload: { id: ROLLOUT_UUID, cwd: ws.path } }) + "\n")

    const exit = await createExit
    expect(Exit.isSuccess(exit)).toBe(true)

    // ① engineSessionId 回填成 rollout 文件名内嵌的真 UUID（不是哨兵）
    const tabRow = db.prepare("SELECT engine_session_id FROM tabs WHERE workspace_id = ? AND kind = 'engine'").get(ws.id) as any
    expect(tabRow?.engine_session_id).toBe(ROLLOUT_UUID)

    const rows = db.prepare("SELECT seq, type, payload FROM events WHERE workspace_id = ? ORDER BY seq").all(ws.id) as Array<{ seq: number; type: string; payload: string }>
    const started = rows.find((r) => r.type === "engine.session.started")
    const delivered = rows.find((r) => r.type === "prompt.delivered")
    const degraded = rows.find((r) => r.type === "prompt.delivery.degraded")
    const sessionChanged = rows.find((r) => r.type === "tab.session.changed")
    // ② engine.session.started 追加（同 hooks 词汇，下游统一），带真 id
    expect(started).toBeDefined()
    expect(JSON.parse(started!.payload).sessionId).toBe(ROLLOUT_UUID)
    // ③ 回填经 setEngineSessionId → tab.session.changed（resume/标题/mtime 状态自此解锁）
    expect(sessionChanged).toBeDefined()
    expect(JSON.parse(sessionChanged!.payload).sessionId).toBe(ROLLOUT_UUID)
    // ④ 就绪信号早于投递（≠ 缺陷时序：delivered 早于 started），且无结构性 90s 降级
    expect(delivered).toBeDefined()
    expect(started!.seq).toBeLessThan(delivered!.seq)
    expect(degraded).toBeUndefined()
  })

  it("rollout 文件始终不出现 → rollout-timeout 降级取证（排在 delivered 前），仍投递成功", async () => {
    // 极短 rollout 就绪超时快速练到降级路径（不落任何 rollout 文件）。
    const cfgLayer = Layer.succeed(CoolieConfig, {
      home, dbPath: ":memory:", serverInfoPath: path.join(home, "server.json"),
      workspacesRoot: wsRoot, tmuxSocket: SOCK, claudeHome: path.join(home, "claude-home"), codexHome: path.join(home, "codex-home"),
      promptReadyTimeoutMs: 4000, rolloutReadyTimeoutMs: 200,
    })
    const layer = WorkspaceLifecycleLive.pipe(
      Layer.provideMerge(EngineBootstrapHookLive),
      Layer.provideMerge(Layer.mergeAll(
        GitServiceLive, SetupRunnerLive,
        Layer.succeed(TmuxService, tmux),
        Layer.succeed(EngineRegistry, new Map([[rolloutCodex.id, rolloutCodex]])),
      )),
      Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
      Layer.provideMerge(Layer.succeed(EventsBus, bus)),
      Layer.provideMerge(Layer.succeed(Db, db)),
      Layer.provideMerge(cfgLayer),
    )
    const program = Effect.gen(function* () {
      const projects = yield* ProjectsRepo
      const lc = yield* WorkspaceLifecycle
      const project = (yield* projects.list())[0]!
      return yield* lc.create({ projectId: project.id, name: "codex-rollout-2", engineId: "codex", initialPrompt: "rollout-timeout-me" })
    })
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer) as Effect.Effect<any, any, never>)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const wsId = exit.value.id
      const rows = db.prepare("SELECT seq, type, payload FROM events WHERE workspace_id = ? ORDER BY seq").all(wsId) as Array<{ seq: number; type: string; payload: string }>
      const degraded = rows.find((r) => r.type === "prompt.delivery.degraded")
      const delivered = rows.find((r) => r.type === "prompt.delivered")
      expect(degraded).toBeDefined()
      expect(JSON.parse(degraded!.payload)).toEqual({ reason: "rollout-timeout", timeoutMs: 200 })
      expect(delivered).toBeDefined()
      expect(degraded!.seq).toBeLessThan(delivered!.seq)
      // id 未回填（rollout 从未出现）：保持 null
      const tabRow = db.prepare("SELECT engine_session_id FROM tabs WHERE workspace_id = ? AND kind = 'engine'").get(wsId) as any
      expect(tabRow?.engine_session_id).toBeNull()
    }
  })
})
