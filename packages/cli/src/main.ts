#!/usr/bin/env node
import { Command } from "commander"
import { ROUTES, decodeProject, decodeWorkspace, decodeCoolieEvent, tmuxSessionName } from "@coolie/protocol"
import { readServerInfo, probeAlive } from "@coolie/server"
import * as path from "node:path"
import * as fs from "node:fs"
import { spawnSync } from "node:child_process"
import Database from "better-sqlite3"
import { api, home } from "./client.js"
import { toCsv, toTable } from "./export-format.js"

const program = new Command("coolie").showHelpAfterError()
const fail = (e: unknown): never => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1) }

const project = program.command("project")
project.command("add <path>").action(async (p) => {
  // Resolve client-side, against the CLI invocation's own cwd — never send a
  // relative path to the daemon, whose cwd is wherever it was first
  // auto-spawned from (not necessarily where `coolie project add .` was run).
  try { const proj = await api("POST", "/projects", { repoRoot: path.resolve(p) }); console.log(`added ${proj.name} (${proj.id})`) }
  catch (e) { fail(e) }
})
project.command("list").action(async () => {
  try { for (const p of ((await api("GET", "/projects")) as unknown[]).map((x) => decodeProject(x))) console.log(`${p.id}\t${p.name}\t${p.repoRoot}`) }
  catch (e) { fail(e) }
})
project.command("remove <id>").action(async (id) => {
  try { await api("DELETE", `/projects/${id}`); console.log(`removed ${id}`) } catch (e) { fail(e) }
})

// ---------- workspace lifecycle（Plan 2） ----------
program.command("create")
  .argument("<projectIdOrPath>", "项目 id，或 git 仓库路径（未注册时自动注册）")
  .option("--slug <slug>", "branch 语义名（branch = coolie/<slug>；缺省用目录名）")
  .option("--name <name>", "指定目录名（缺省从 national-parks 名池取）")
  .option("--prompt <text>", "workspace 就绪后投递给 engine 的首条 prompt")
  .action(async (arg: string, opts: { slug?: string; name?: string; prompt?: string }) => {
    try {
      let projectId = arg
      if (fs.existsSync(arg)) {
        const abs = path.resolve(arg)
        const projects: any[] = await api("GET", "/projects")
        let p = projects.find((x) => x.repoRoot === abs)
        if (!p) p = await api("POST", "/projects", { repoRoot: abs })
        projectId = p.id
      }
      const ws = decodeWorkspace(await api("POST", "/workspaces", {
        projectId,
        ...(opts.slug ? { branchSlug: opts.slug } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.prompt ? { initialPrompt: opts.prompt } : {}),
      }))
      console.log(`created ${ws.name} (${ws.id}) branch=${ws.branch} path=${ws.path}`)
    } catch (e) { fail(e) }
  })

program.command("list").action(async () => {
  try {
    for (const w of ((await api("GET", "/workspaces")) as unknown[]).map((x) => decodeWorkspace(x)))
      console.log(`${w.id}\t${w.name}\t${w.status}\t${w.branch}\t${w.path}`)
  } catch (e) { fail(e) }
})

program.command("archive <wsId>")
  .option("--force", "脏树也归档（丢弃未提交改动）")
  .action(async (id: string, opts: { force?: boolean }) => {
    try { await api("POST", `/workspaces/${id}/archive`, { force: !!opts.force }); console.log(`archived ${id}`) }
    catch (e) { fail(e) }
  })

program.command("unarchive <wsId>").action(async (id: string) => {
  try { await api("POST", `/workspaces/${id}/unarchive`, {}); console.log(`unarchived ${id}`) }
  catch (e) { fail(e) }
})

program.command("delete <wsId>")
  .option("--force", "脏树也删（丢弃未提交改动）")
  .action(async (id: string, opts: { force?: boolean }) => {
    try { await api("DELETE", `/workspaces/${id}${opts.force ? "?force=1" : ""}`); console.log(`deleted ${id}`) }
    catch (e) { fail(e) }
  })

const tmuxSocketName = () => process.env.COOLIE_TMUX_SOCKET ?? "coolie"

program.command("enter <wsId>")
  .description("attach 进 workspace 的 tmux session（Ctrl-b d 返回）")
  .action((id: string) => {
    const sock = tmuxSocketName()
    const session = tmuxSessionName(id)
    const has = spawnSync("tmux", ["-L", sock, "has-session", "-t", `=${session}`], { stdio: "ignore" })
    if (has.status !== 0)
      fail(`tmux session ${session} 不存在（workspace 可能已归档/尚未创建，或 session 被外力清理；M1 不自动重建——Plan 4 ensure-or-heal）`)
    const r = spawnSync("tmux", ["-L", sock, "attach", "-t", `=${session}`], { stdio: "inherit" })
    process.exit(r.status ?? 0)
  })

program.command("open <wsId>")
  .description("打印 iTerm2 逃生舱命令（GUI 的 Open in iTerm2 按钮复用此命令）")
  .action((id: string) => {
    console.log(`tmux -L ${tmuxSocketName()} attach -t ${tmuxSessionName(id)}`)
  })

const server = program.command("server")
server.command("status").action(async () => {
  const info = readServerInfo(path.join(home(), "server.json"))
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

// ---------- export（daemon-free） ----------
const EXPORT_COLUMNS = {
  projects: ["id", "name", "repoRoot", "defaultBaseBranch", "createdAt"],
  workspaces: ["id", "projectId", "name", "branch", "status", "path"],
  events: ["seq", "ts", "workspaceId", "type", "payload"],
} as const
type ExportWhat = keyof typeof EXPORT_COLUMNS

const EXPORT_SQL: Record<ExportWhat, string> = {
  projects: "SELECT id, name, repo_root AS repoRoot, default_base_branch AS defaultBaseBranch, created_at AS createdAt FROM projects ORDER BY created_at",
  workspaces: "SELECT id, project_id AS projectId, name, branch, status, path FROM workspaces ORDER BY created_at",
  events: "SELECT seq, ts, workspace_id AS workspaceId, type, payload FROM events WHERE seq > ? ORDER BY seq",
}

const usageExit = (msg: string): never => { console.error(`coolie export: ${msg}`); process.exit(2) }

program
  .command("export")
  .argument("[what]", "projects|workspaces|events", "projects")
  .option("--json", "JSON 数组（默认）")
  .option("--csv", "RFC-4180 CSV 带表头")
  .option("--format <fmt>", "json|csv|table")
  .option("--after <seq>", "仅 events：只导出该 seq 之后", "0")
  .action((what: string, opts: { json?: boolean; csv?: boolean; format?: string; after: string }) => {
    if (!(what in EXPORT_COLUMNS)) usageExit(`未知对象：${what}（可用 projects|workspaces|events）`)
    const fmt = opts.format ?? (opts.csv ? "csv" : "json")
    if (!["json", "csv", "table"].includes(fmt)) usageExit(`未知格式：${fmt}`)
    const dbPath = path.join(home(), "coolie.db")
    let rows: Record<string, unknown>[] = []
    let db: InstanceType<typeof Database> | undefined
    try {
      if (fs.existsSync(dbPath)) {
        db = new Database(dbPath, { readonly: true })
        rows = what === "events"
          ? db.prepare(EXPORT_SQL.events).all(Number(opts.after)) as any[]
          : db.prepare(EXPORT_SQL[what as ExportWhat]).all() as any[]
      }
    } catch { rows = [] } // db 打开失败（损坏）或表还没建（新库）→ 空集
    finally { db?.close() }
    const columns = EXPORT_COLUMNS[what as ExportWhat]
    if (fmt === "json") process.stdout.write(JSON.stringify(rows, null, 2) + "\n")
    else if (fmt === "csv") process.stdout.write(toCsv(columns, rows))
    else process.stdout.write(toTable(columns, rows))
  })

// ---------- events tail（需要 server） ----------
const events = program.command("events")
events.command("tail")
  .option("--after <seq>", "起始游标", "0")
  .option("--follow", "持续轮询")
  .option("--interval <ms>", "轮询间隔", "1000")
  .action(async (opts: { after: string; follow?: boolean; interval: string }) => {
    let cursor = Number(opts.after)
    const printBatch = async (): Promise<void> => {
      const batch = ((await api("GET", `/events?after=${cursor}`)) as unknown[]).map((x) => decodeCoolieEvent(x))
      for (const e of batch) {
        console.log(`${e.seq}\t${new Date(e.ts).toISOString()}\t${e.type}\t${e.workspaceId ?? "-"}\t${JSON.stringify(e.payload)}`)
        cursor = Math.max(cursor, e.seq)
      }
    }
    try {
      await printBatch()
      while (opts.follow) {
        await new Promise((r) => setTimeout(r, Number(opts.interval)))
        await printBatch()
      }
    } catch (e) { fail(e) }
  })

// ---------- doctor（只读） ----------
program.command("doctor").action(async () => {
  type Level = "ok" | "warn" | "fail"
  const lines: Array<[Level, string, string]> = []
  const check = (level: Level, name: string, detail: string) => lines.push([level, name, detail])

  const h = home()
  check(fs.existsSync(h) ? "ok" : "warn", "home", fs.existsSync(h) ? h : `${h}（尚未创建，首次使用时自动建）`)

  const dbPath = path.join(h, "coolie.db")
  if (!fs.existsSync(dbPath)) check("warn", "db", "尚无数据库")
  else {
    try { new Database(dbPath, { readonly: true }).close(); check("ok", "db", dbPath) }
    catch (e) { check("fail", "db", `无法打开：${String(e)}`) }
  }

  const info = readServerInfo(path.join(h, "server.json"))
  if (!info) check("warn", "server", "stopped")
  else {
    const alive = await probeAlive(info)
    let pidAlive = false
    try { process.kill(info.pid, 0); pidAlive = true } catch { /* dead */ }
    if (alive) check("ok", "server", `running pid=${info.pid} port=${info.port}`)
    else check(pidAlive ? "fail" : "warn", "server", pidAlive ? "pid 活着但 /health 不通" : "server.json 陈旧（进程已死）")
  }

  const logPath = path.join(h, "logs", "server.log")
  check("ok", "log", fs.existsSync(logPath) ? `${logPath}（${fs.statSync(logPath).size} bytes）` : "尚无日志")

  for (const bin of ["git", "tmux", "claude"] as const) {
    const found = spawnSync("which", [bin], { encoding: "utf8" })
    if (found.status === 0) check("ok", bin, found.stdout.trim())
    else check(bin === "git" ? "fail" : "warn", bin, "不在 PATH（tmux/claude 为 Plan 3 依赖）")
  }

  for (const [level, name, detail] of lines) console.log(`${level}\t${name}\t${detail}`)
  process.exit(lines.some(([l]) => l === "fail") ? 1 : 0)
})

program.parseAsync().catch(fail)
