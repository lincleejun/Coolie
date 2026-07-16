#!/usr/bin/env node
import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { Context, Effect, Layer, Exit, Option, Scope } from "effect"
import { tmuxSessionName } from "@coolie/protocol"
import { CoolieConfig, CoolieConfigLive } from "./config.js"
import { Db, DbLive } from "./db/sqlite.js"
import { cleanupRemovedRunTabs } from "./db/cleanup.js"
import { ProjectsRepoLive } from "./repo/projects.js"
import { EventsRepo, EventsRepoLive } from "./repo/events.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "./repo/workspaces.js"
import { TabsRepo, TabsRepoLive } from "./repo/tabs.js"
import { QueueRepo, QueueRepoLive } from "./repo/queue.js"
import { StateRepoLive } from "./repo/state.js"
import { InputReceiptsRepoLive } from "./repo/input-receipts.js"
import { EventsBus, EventsBusLive } from "./events/bus.js"
import { WorkspaceLifecycle, WorkspaceLifecycleLive } from "./workspace/lifecycle.js"
import { GitServiceLive } from "./git/service.js"
import { realGitRead } from "./git/inspect.js"
import { makeSetupRunnerLive } from "./workspace/setup.js"
import { TmuxService, TmuxServiceLive } from "./tmux/service.js"
import { makeComposerOps } from "./tmux/ops.js"
import { makeTmuxLayout } from "./tmux/layout.js"
import { EngineRegistry, EngineRegistryLive, engineHome } from "./engine/registry.js"
import { CustomEngineStoreLive } from "./engine/custom-store.js"
import { EngineBootstrapHookLive } from "./engine/bootstrap.js"
import { SessionReadiness, makeSessionReadiness } from "./engine/readiness.js"
import { SessionEnsurerLive } from "./workspace/heal.js"
import { WorkspaceAdopterLive } from "./workspace/adopt.js"
import { FinishOpsLive, WorkspaceFinisherLive } from "./workspace/finish.js"
import { WorkspaceCheckpointsLive } from "./workspace/checkpoint.js"
import { WorktreeEnvironmentLive } from "./workspace/worktree-environment.js"
import { ensureHookScript } from "./engine/claude/hooks.js"
import { startTranscriptPoller } from "./engine/monitor.js"
import { createWorkspaceSerial, resumeQueuedWorkspaces, startQueueDrainer, type DrainDeps } from "./engine/queue-drain.js"
import { attachTerminalWs } from "./http/ws.js"
import { createApp, newToken } from "./http/app.js"
import type { AppServices } from "./http/app.js"
import { readServerInfo, claimServerInfo, probeAlive } from "./daemon/info.js"
import { assertSockPathFits } from "./daemon/socket.js"
import { makeClientRegistry } from "./daemon/clients.js"
import { rotateLogIfNeeded } from "./log/rotate.js"
import { createLogger, installCrashNet } from "./log/logger.js"
import { BackgroundCollector, collectPullRequest } from "./collector/background.js"

const cfg = Effect.runSync(CoolieConfig.pipe(Effect.provide(CoolieConfigLive)))

const cmdStatus = async (): Promise<never> => {
  const info = readServerInfo(cfg.serverInfoPath)
  if (info && (await probeAlive(info))) { console.log(`running pid=${info.pid} port=${info.port}`); process.exit(0) }
  console.log("stopped"); process.exit(1)
}

const cmdStop = async (): Promise<never> => {
  const info = readServerInfo(cfg.serverInfoPath)
  if (!info || !(await probeAlive(info))) { console.log("stopped"); process.exit(0) }
  await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
    method: "POST", headers: { Authorization: `Bearer ${info.token}` },
  })
  console.log("stopping"); process.exit(0)
}

const cmdStart = async (): Promise<void> => {
  const logPath = path.join(cfg.home, "logs", "server.log")
  rotateLogIfNeeded(logPath)
  const logger = createLogger(logPath, "server")
  installCrashNet(logger)

  const existing = readServerInfo(cfg.serverInfoPath)
  if (existing && (await probeAlive(existing))) {
    console.error(`already running pid=${existing.pid} port=${existing.port}`); process.exit(1)
  }
  if (existing) fs.rmSync(cfg.serverInfoPath, { force: true }) // 陈旧文件

  const scope = Effect.runSync(Scope.make())
  const sessionReadiness = makeSessionReadiness()
  const appLayer = Layer.mergeAll(WorkspaceLifecycleLive, WorkspaceAdopterLive, WorkspaceFinisherLive, WorkspaceCheckpointsLive).pipe(
    Layer.provideMerge(Layer.mergeAll(
      EngineBootstrapHookLive.pipe(Layer.provide(Layer.succeed(SessionReadiness, sessionReadiness))),
      SessionEnsurerLive,
    )),
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive,
      FinishOpsLive,
      makeSetupRunnerLive((chunk) => logger.info(`setup: ${chunk.trimEnd()}`)),
      TmuxServiceLive,
      EngineRegistryLive.pipe(Layer.provide(CustomEngineStoreLive)),
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive, QueueRepoLive, StateRepoLive, InputReceiptsRepoLive, CustomEngineStoreLive, WorktreeEnvironmentLive)),
    Layer.provideMerge(EventsBusLive), // Plan 2 的 dead export 转正：单一构造点
    Layer.provideMerge(DbLive),
    Layer.provideMerge(CoolieConfigLive),
  )
  const runtimeCtx = await Effect.runPromise(Layer.buildWithScope(appLayer, scope))
  const bus = Context.get(runtimeCtx, EventsBus)
  const runtime = <A, E>(eff: Effect.Effect<A, E, AppServices>) =>
    Effect.runPromiseExit(Effect.provide(eff, runtimeCtx) as Effect.Effect<A, E, never>)

  // A crash can leave a durable archiving row after input freeze or session teardown.
  // Reconcile before accepting traffic: clean/removed managed worktrees finish archiving;
  // dirty worktrees compensate to active and heal their runtime.
  await runtime(Effect.gen(function* () {
    yield* (yield* WorkspaceLifecycle).reconcileArchives()
  }))

  const token = newToken()
  // hook 转发脚本：每次启动按引擎重写（home/版本变更自动生效）；bootstrap 建 workspace 时也会各自重写
  for (const engineId of ["claude", "codex"]) ensureHookScript(cfg.home, engineId)

  // tmux 首启检测（设计文档 §十二）：不阻启动，warn 进日志；doctor 同口径
  const tmuxSvc = Context.get(runtimeCtx, TmuxService)
  const removedRunTabs = await cleanupRemovedRunTabs(
    Context.get(runtimeCtx, Db),
    (session, window) => Effect.runPromise(tmuxSvc.killWindow(session, window)),
    (error) => logger.warn(`清理旧 run tab 的 tmux window 失败：${String(error)}`),
  )
  if (removedRunTabs > 0) logger.info(`已清理 ${removedRunTabs} 个旧 run tab`)
  const composerOps = makeComposerOps(tmuxSvc)
  const tmuxLayout = makeTmuxLayout(
    tmuxSvc,
    Context.get(runtimeCtx, WorkspacesRepo),
    Context.get(runtimeCtx, TabsRepo),
  )
  void Effect.runPromise(tmuxSvc.version()).then(
    (v) => logger.info(`tmux ok: ${v}`),
    (e) => logger.warn(`tmux 不可用：${String(e)}（brew install tmux；coolie doctor 检查）`),
  )

  // turn detector 兜底：转录 mtime 轮询（hooks 沉默时接管）——F1：per-engine 解析，非只 claude。
  const registry = Context.get(runtimeCtx, EngineRegistry)
  const stopPoller = startTranscriptPoller({
    listEngineTabs: async () => {
      const exit = await runtime(Effect.gen(function* () { return yield* (yield* TabsRepo).listEngineTabs() }))
      return Exit.isSuccess(exit) ? exit.value : []
    },
    statMtimeMs: (p) => { try { return fs.statSync(p).mtimeMs } catch { return null } },
    setStatus: async (tabId, status) => {
      await runtime(Effect.gen(function* () { yield* (yield* TabsRepo).setStatus(tabId, status, "poller") }))
    },
    resolveEngine: (engineId) => registry.get(engineId ?? "claude"),
    homeFor: (engineId) => engineHome(engineId, cfg),
  })
  const workspaceSerial = createWorkspaceSerial()
  const collector = new BackgroundCollector({
    listWorkspaces: async () => {
      const exit = await runtime(Effect.gen(function* () { return yield* (yield* WorkspacesRepo).list() }))
      return Exit.isSuccess(exit) ? exit.value : []
    },
    diffstat: (workspace) => realGitRead.diffstat(workspace.path, workspace.baseRef),
    pullRequest: (workspace) => collectPullRequest(workspace),
    transcript: async (workspace) => {
      const exit = await runtime(Effect.gen(function* () {
        return yield* (yield* TabsRepo).listEngineTabsByWorkspace(workspace.id)
      }))
      const tabs = Exit.isSuccess(exit) ? exit.value : []
      const updatedAt = tabs.reduce<number | null>((latest, tab) =>
        tab.lastHookAt !== null && (latest === null || tab.lastHookAt > latest) ? tab.lastHookAt : latest, null)
      const titled = tabs.find((tab) => tab.title !== null)
      return {
        active: tabs.some((tab) => tab.status === "working"),
        updatedAt,
        title: titled?.title ?? null,
      }
    },
    appendEvent: async (workspaceId, type, payload) => {
      await runtime(Effect.gen(function* () {
        yield* (yield* EventsRepo).append({ workspaceId, type, payload })
      }))
    },
    concurrency: 4,
  })
  let stopCollector = (): void => {}
  const drainDeps: DrainDeps = {
    resolveEngineTab: async (workspaceId, tabId) => {
      const exit = await runtime(Effect.gen(function* () {
        const workspace = yield* (yield* WorkspacesRepo).get(workspaceId).pipe(Effect.option)
        if (Option.isNone(workspace)) return null
        const tabs = yield* TabsRepo
        const exact = tabId === undefined
          ? yield* tabs.findEngineTab(workspaceId)
          : Option.getOrNull(yield* tabs.get(tabId).pipe(Effect.option))
        if (!exact || exact.workspaceId !== workspaceId || exact.kind !== "engine") return null
        const engine = (yield* EngineRegistry).get(exact.engineId ?? "claude")
        return {
          tab: exact,
          wsActive: workspace.value.status === "active",
          nativeQueue: engine?.capabilities.nativeQueue === true,
        }
      }))
      return Exit.isSuccess(exit) ? exit.value : null
    },
    claimNext: async (workspaceId, tabId) => {
      const exit = await runtime(Effect.gen(function* () {
        return yield* (yield* QueueRepo).claimNext(workspaceId, tabId)
      }))
      return Exit.isSuccess(exit) ? exit.value : null
    },
    release: async (queueId) => {
      await runtime(Effect.gen(function* () { yield* (yield* QueueRepo).release(queueId) }))
    },
    deliver: (target, text) => composerOps.input(target, { text, mode: "send", skipStable: false }),
    markWorking: async (tabId) => {
      await runtime(Effect.gen(function* () {
        yield* (yield* TabsRepo).setStatus(tabId, "working", "queue")
      }))
    },
    onDelivered: async (queueId) => {
      await runtime(Effect.gen(function* () { yield* (yield* QueueRepo).delivered(queueId) }))
    },
    onFailed: async (_workspaceId, queueId, error) => {
      await runtime(Effect.gen(function* () {
        yield* (yield* QueueRepo).release(queueId, error instanceof Error ? error.message : String(error))
      }))
    },
  }
  let stopDrainer = (): void => {}

  const sockPath = cfg.sockPath

  // ---- Plan 4：幂等 + awaited close 的 shutdown ----
  let shuttingDown = false
  const closeHttp = (s: http.Server): Promise<void> =>
    new Promise((resolve) => {
      s.close(() => resolve())            // 未 listen 的 server：回调带 err 也会触发 → 照样 resolve
      s.closeAllConnections()             // SSE/WS 长连接不断掉，close 永不完成（Node ≥18.2）
    })
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return              // POST /shutdown、SIGTERM、idle-exit 可能并发到达
    shuttingDown = true
    logger.info("shutdown")
    stopPoller()
    stopDrainer()
    stopCollector()
    clients.dispose()
    fs.rmSync(cfg.serverInfoPath, { force: true })
    await Promise.race([
      Promise.all([closeHttp(server), closeHttp(unixServer)]),
      new Promise((r) => setTimeout(r, 2000)), // 兜底：close 卡住也要退
    ])
    fs.rmSync(sockPath, { force: true })
    await Effect.runPromise(Scope.close(scope, Exit.void)) // control client dispose；tmux server/session 不动
    await Promise.race([logger.flush(), new Promise((r) => setTimeout(r, 2000))])
    process.exit(0)
  }

  // refcount 惰性退出（设计文档 §2.1）：COOLIE_LINGER_MS 只在此边缘读取——
  // 不进 CoolieConfig（5 个测试 fixture 注入完整 config shape，加必填字段会全体破坏）
  const lingerRaw = Number(process.env.COOLIE_LINGER_MS ?? "")
  const lingerMs = Number.isFinite(lingerRaw) && lingerRaw > 0 ? lingerRaw : 60_000
  const clients = makeClientRegistry({
    graceMs: lingerMs,
    onIdleExpired: () => {
      logger.info(`refcount 惰性退出：最后一个 gui 持有者断开已超 ${lingerMs}ms`)
      void (async () => {
        await runtime(Effect.gen(function* () {
          yield* (yield* EventsRepo).append({ workspaceId: null, type: "daemon.idle.exit", payload: { graceMs: lingerMs } })
        }))
        await shutdown() // 与 POST /shutdown 同一条路：engine 归 tmux，session 分毫不动
      })()
    },
  })

  // B2 onboarding：clone repository。execFile 数组参（无 shell 注入面）+ `--` 断 flag 解析。
  const reposRoot = process.env.COOLIE_REPOS_ROOT ?? path.join(cfg.home, "repos")
  const cloneRepo = (cloneUrl: string, dest: string): Promise<void> =>
    new Promise((resolve, reject) => {
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }) } catch { /* clone 自身会再报错 */ }
      execFile("git", ["clone", "--", cloneUrl, dest], { timeout: 300_000 }, (error, _out, stderr) => {
        error ? reject(new Error(String(stderr || error.message).trim())) : resolve()
      })
    })

  const app = createApp({
    runtime, token, bus, claudeHome: cfg.claudeHome, codexHome: cfg.codexHome, clients,
    gitRead: realGitRead,
    config: { tmuxSocket: cfg.tmuxSocket, reposRoot },
    attachmentsDir: path.join(cfg.home, "attachments"),
    composerOps,
    layoutOps: {
      reconcile: (workspaceId) => Effect.runPromise(tmuxLayout.reconcile(workspaceId)),
      setZen: (workspaceId, zen, focusedTabId) =>
        Effect.runPromise(tmuxLayout.setZen(workspaceId, zen, focusedTabId)),
    },
    workspaceSerial,
    sessionReadiness,
    collector,
    cloneRepo,
    onShutdown: () => void shutdown(),
    onError: (e) => logger.error("http 500", e),
  })
  const server = http.createServer(app)

  // WS 终端通道（挂 TCP server；GUI/浏览器从 TCP 连）
  attachTerminalWs(server, {
    token, tmuxSocket: cfg.tmuxSocket, clients,
    resolveSession: async (wsId, window) =>
      workspaceSerial.run(wsId, async () => {
        const exit = await runtime(Effect.gen(function* () {
          const workspaces = yield* WorkspacesRepo
          let ws = yield* workspaces.get(wsId)
          if (!ws.materialized) {
            yield* (yield* WorkspaceLifecycle).ensure(wsId)
            ws = yield* workspaces.get(wsId)
          }
          if (ws.status !== "active" && ws.status !== "creating") return null
          if (ws.status === "active") yield* (yield* WorkspaceLifecycle).ensure(wsId)
          const registered = (yield* (yield* TabsRepo).listByWorkspace(wsId))
            .some((tab) => tab.tmuxWindow === window)
          return registered ? tmuxSessionName(ws.id) : null
        }))
        return Exit.match(exit, {
          onSuccess: (session) => session,
          onFailure: () => null,
        })
      }),
    log: (m) => logger.warn(m),
  })

  // ---- Plan 4：先 TCP listen，claim 赢了才碰 unix socket ----
  // 旧顺序（先 rm sock 再 listen sock 再 TCP）下，两个竞态 start 会互删对方的 sock。
  fs.mkdirSync(cfg.home, { recursive: true })
  assertSockPathFits(sockPath)
  const unixServer = http.createServer(app)

  server.listen(0, "127.0.0.1", () => {
    void (async () => {
      const port = (server.address() as { port: number }).port
      const won = await claimServerInfo(cfg.serverInfoPath, { port, token, pid: process.pid, sock: sockPath })
      if (!won) {
        logger.warn("单实例竞态落败：另一个 coolie-server 已注册 server.json，本进程退出（不碰对方的 sock）")
        server.close(); server.closeAllConnections()
        await Promise.race([logger.flush(), new Promise((r) => setTimeout(r, 1000))])
        process.exit(1)
      }
      stopDrainer = startQueueDrainer(bus, drainDeps, workspaceSerial)
      stopCollector = collector.start(Number(process.env.COOLIE_COLLECT_INTERVAL_MS ?? 30_000))
      void resumeQueuedWorkspaces(workspaceSerial, drainDeps, {
        recoverInflight: async () => {
          const exit = await runtime(Effect.gen(function* () { return yield* (yield* QueueRepo).recoverInflight() }))
          return Exit.isSuccess(exit) ? exit.value : 0
        },
        listWorkspaceIds: async () => {
          const exit = await runtime(Effect.gen(function* () { return yield* (yield* QueueRepo).listWorkspaceIds() }))
          return Exit.isSuccess(exit) ? exit.value : []
        },
        listTargets: async () => {
          const exit = await runtime(Effect.gen(function* () { return yield* (yield* QueueRepo).listTargets() }))
          return Exit.isSuccess(exit) ? exit.value : []
        },
      })
      fs.rmSync(sockPath, { force: true }) // 赢家清陈旧 sock
      unixServer.listen(sockPath, () => logger.info(`listening on unix socket ${sockPath}`))
      logger.info(`coolie-server listening on 127.0.0.1:${port}`)
    })()
  })
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

const cmd = process.argv[2]
if (cmd === "start") void cmdStart()
else if (cmd === "status") void cmdStatus()
else if (cmd === "stop") void cmdStop()
else { console.error(`unknown command: ${cmd ?? "(none)"}；可用：start|status|stop`); process.exit(1) }
