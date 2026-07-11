#!/usr/bin/env node
import { Command } from "commander"
import { ROUTES } from "@coolie/protocol"
import { readServerInfo, probeAlive } from "@coolie/server"
import * as os from "node:os"; import * as path from "node:path"
import { api, home } from "./client.js"

const program = new Command("coolie").showHelpAfterError()
const fail = (e: unknown): never => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1) }

const project = program.command("project")
project.command("add <path>").action(async (p) => {
  try { const proj = await api("POST", "/projects", { repoRoot: p }); console.log(`added ${proj.name} (${proj.id})`) }
  catch (e) { fail(e) }
})
project.command("list").action(async () => {
  try { for (const p of await api("GET", "/projects")) console.log(`${p.id}\t${p.name}\t${p.repoRoot}`) }
  catch (e) { fail(e) }
})
project.command("remove <id>").action(async (id) => {
  try { await api("DELETE", `/projects/${id}`); console.log(`removed ${id}`) } catch (e) { fail(e) }
})

const server = program.command("server")
server.command("status").action(async () => {
  const info = readServerInfo(path.join(process.env.COOLIE_HOME ?? path.join(os.homedir(), ".coolie"), "server.json"))
  if (info && (await probeAlive(info))) { console.log(`running pid=${info.pid} port=${info.port}`) }
  else { console.log("stopped"); process.exit(1) }
})
server.command("stop").action(async () => {
  // Deliberately NOT api("POST", "/shutdown") — that goes through ensureServer(),
  // which auto-spawns a server just to shut it down when none is running. Talk
  // to the daemon directly instead (same readServerInfo + probeAlive + fetch
  // /shutdown logic as @coolie/server's own cmdStop); behavior contract
  // ("stopped", exit 0) is unchanged, but a not-running server is left alone.
  const info = readServerInfo(path.join(home(), "server.json"))
  if (!info || !(await probeAlive(info))) { console.log("stopped"); return }
  try {
    await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}` },
    })
  } catch {} // server 可能应答后立刻退出/中途消失——目标（停止）已经达成
  console.log("stopped")
})

program.command("api").command("schema").action(() => {
  // "METHOD PATH" must appear as a literal single-space substring (tests assert
  // toContain("GET /health") etc.) — pad the combined head, not method/path
  // separately, or the column padding inserts extra spaces between them.
  for (const r of ROUTES) {
    const head = `${r.method} ${r.path}`
    console.log(`${head.padEnd(28)} ${r.description}`)
  }
})

program.parseAsync().catch(fail)
