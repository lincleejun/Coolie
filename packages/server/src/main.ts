#!/usr/bin/env node
import * as http from "node:http"
import * as fs from "node:fs"
import { Effect, Layer, Exit, Scope } from "effect"
import { CoolieConfig, CoolieConfigLive } from "./config.js"
import { DbLive } from "./db/sqlite.js"
import { ProjectsRepo, ProjectsRepoLive } from "./repo/projects.js"
import { createApp, newToken } from "./http/app.js"
import { readServerInfo, writeServerInfo, probeAlive } from "./daemon/info.js"

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
  const existing = readServerInfo(cfg.serverInfoPath)
  if (existing && (await probeAlive(existing))) {
    console.error(`already running pid=${existing.pid} port=${existing.port}`); process.exit(1)
  }
  if (existing) fs.rmSync(cfg.serverInfoPath, { force: true }) // 陈旧文件

  // 组装 Effect runtime（scope 手动管理，进程退出时 close）
  const scope = Effect.runSync(Scope.make())
  const appLayer = ProjectsRepoLive.pipe(Layer.provide(DbLive), Layer.provide(CoolieConfigLive))
  const runtimeCtx = await Effect.runPromise(Layer.buildWithScope(appLayer, scope))
  // AppDeps.runtime must return the Effect's Exit (never reject) — see http/app.ts's
  // Runtime type. Effect.runPromise's rejection is a FiberFailure wrapper that isn't
  // reliably unwrapped; runPromiseExit + Exit.match (as app.ts already does) is robust.
  const runtime = <A, E>(eff: Effect.Effect<A, E, ProjectsRepo>) =>
    Effect.runPromiseExit(Effect.provide(eff, runtimeCtx) as Effect.Effect<A, E, never>)

  const token = newToken()
  const shutdown = async () => {
    fs.rmSync(cfg.serverInfoPath, { force: true })
    server.close()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    process.exit(0)
  }
  const server = http.createServer(createApp({ runtime, token, onShutdown: () => void shutdown() }))
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port
    writeServerInfo(cfg.serverInfoPath, { port, token, pid: process.pid })
    console.log(`coolie-server listening on 127.0.0.1:${port}`)
  })
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

const cmd = process.argv[2]
if (cmd === "start") void cmdStart()
else if (cmd === "status") void cmdStatus()
else if (cmd === "stop") void cmdStop()
else { console.error(`unknown command: ${cmd ?? "(none)"}；可用：start|status|stop`); process.exit(1) }
