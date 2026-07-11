#!/usr/bin/env node
import { Command } from "commander"
import { ROUTES } from "@coolie/protocol"
import { readServerInfo, probeAlive } from "@coolie/server"
import * as os from "node:os"; import * as path from "node:path"
import { api } from "./client.js"

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
  try { await api("POST", "/shutdown") } catch {} // server 可能没跑或应答后立刻退出
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
