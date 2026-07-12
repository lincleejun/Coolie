#!/usr/bin/env node
import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { Context, Effect, Layer, Exit, Scope } from "effect"
import { tmuxSessionName } from "@coolie/protocol"
import { CoolieConfig, CoolieConfigLive } from "./config.js"
import { DbLive } from "./db/sqlite.js"
import { ProjectsRepoLive } from "./repo/projects.js"
import { EventsRepo, EventsRepoLive } from "./repo/events.js"
import { WorkspacesRepo, WorkspacesRepoLive } from "./repo/workspaces.js"
import { TabsRepo, TabsRepoLive } from "./repo/tabs.js"
import { EventsBus, EventsBusLive } from "./events/bus.js"
import { WorkspaceLifecycleLive } from "./workspace/lifecycle.js"
import { GitServiceLive } from "./git/service.js"
import { realGitRead } from "./git/inspect.js"
import { makeSetupRunnerLive } from "./workspace/setup.js"
import { TmuxService, TmuxServiceLive } from "./tmux/service.js"
import { makeComposerOps } from "./tmux/ops.js"
import { EngineRegistry, EngineRegistryLive } from "./engine/registry.js"
import { EngineBootstrapHookLive } from "./engine/bootstrap.js"
import { SessionEnsurerLive } from "./workspace/heal.js"
import { ensureHookScript } from "./engine/claude/hooks.js"
import { startTranscriptPoller } from "./engine/monitor.js"
import { attachTerminalWs } from "./http/ws.js"
import { createApp, newToken } from "./http/app.js"
import type { AppServices } from "./http/app.js"
import { readServerInfo, claimServerInfo, probeAlive } from "./daemon/info.js"
import { makeClientRegistry } from "./daemon/clients.js"
import { rotateLogIfNeeded } from "./log/rotate.js"
import { createLogger, installCrashNet } from "./log/logger.js"

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
  const appLayer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(EngineBootstrapHookLive, SessionEnsurerLive)),
    Layer.provideMerge(Layer.mergeAll(
      GitServiceLive,
      makeSetupRunnerLive((chunk) => logger.info(`setup: ${chunk.trimEnd()}`)),
      TmuxServiceLive,
      EngineRegistryLive,
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive)),
    Layer.provideMerge(EventsBusLive), // Plan 2 的 dead export 转正：单一构造点
    Layer.provideMerge(DbLive),
    Layer.provideMerge(CoolieConfigLive),
  )
  const runtimeCtx = await Effect.runPromise(Layer.buildWithScope(appLayer, scope))
  const bus = Context.get(runtimeCtx, EventsBus)
  const runtime = <A, E>(eff: Effect.Effect<A, E, AppServices>) =>
    Effect.runPromiseExit(Effect.provide(eff, runtimeCtx) as Effect.Effect<A, E, never>)

  const token = newToken()
  ensureHookScript(cfg.home) // hook 转发脚本：每次启动重写（home/版本变更自动生效）

  // tmux 首启检测（设计文档 §十二）：不阻启动，warn 进日志；doctor 同口径
  const tmuxSvc = Context.get(runtimeCtx, TmuxService)
  void Effect.runPromise(tmuxSvc.version()).then(
    (v) => logger.info(`tmux ok: ${v}`),
    (e) => logger.warn(`tmux 不可用：${String(e)}（brew install tmux；coolie doctor 检查）`),
  )

  // turn detector 兜底：转录 mtime 轮询（hooks 沉默时接管）
  const registry = Context.get(runtimeCtx, EngineRegistry)
  const claude = registry.get("claude")
  const stopPoller = claude
    ? startTranscriptPoller({
        listEngineTabs: async () => {
          const exit = await runtime(Effect.gen(function* () { return yield* (yield* TabsRepo).listEngineTabs() }))
          return Exit.isSuccess(exit) ? exit.value : []
        },
        statMtimeMs: (p) => { try { return fs.statSync(p).mtimeMs } catch { return null } },
        setStatus: async (tabId, status) => {
          await runtime(Effect.gen(function* () { yield* (yield* TabsRepo).setStatus(tabId, status, "poller") }))
        },
        engine: claude,
        home: cfg.claudeHome,
      })
    : () => {}

  const sockPath = path.join(cfg.home, "coolie.sock")

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

  const app = createApp({
    runtime, token, bus, claudeHome: cfg.claudeHome, clients,
    gitRead: realGitRead,
    config: { tmuxSocket: cfg.tmuxSocket },
    composerOps: makeComposerOps(tmuxSvc),
    onShutdown: () => void shutdown(),
    onError: (e) => logger.error("http 500", e),
  })
  const server = http.createServer(app)

  // WS 终端通道（挂 TCP server；GUI/浏览器从 TCP 连）
  attachTerminalWs(server, {
    token, tmuxSocket: cfg.tmuxSocket, clients,
    resolveSession: async (wsId) => {
      const exit = await runtime(Effect.gen(function* () { return yield* (yield* WorkspacesRepo).get(wsId) }))
      return Exit.match(exit, {
        onSuccess: (ws) => (ws.status === "active" ? tmuxSessionName(ws.id) : null),
        onFailure: () => null,
      })
    },
    log: (m) => logger.warn(m),
  })

  // ---- Plan 4：先 TCP listen，claim 赢了才碰 unix socket ----
  // 旧顺序（先 rm sock 再 listen sock 再 TCP）下，两个竞态 start 会互删对方的 sock。
  fs.mkdirSync(cfg.home, { recursive: true })
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
