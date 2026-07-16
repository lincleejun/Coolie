#!/usr/bin/env node
import { Command } from "commander"
import {
  ROUTES,
  routeExample,
  routeGroup,
  routeRequestShape,
  routeResponseShape,
  selectRoutes,
  buildCoolieUrl,
  decodeProject,
  decodeWorkspace,
  decodeCoolieEvent,
  decodeCoolieStateSnapshot,
  decodeHealOutcome,
  tmuxSessionName,
} from "@coolie/protocol"
import {
  SUN_PATH_MAX,
  probeAlive,
  readServerInfo,
  sockPathByteLength,
  sockPathWarning,
} from "@coolie/server"
import * as path from "node:path"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import Database from "better-sqlite3"
import { api, ensureServer, home } from "./client.js"
import { toCsv, toTable } from "./export-format.js"
import { expandAgents, parseAgentsSpec } from "./fanout.js"
import { generateCompletion, type CompletionShell } from "./completions.js"
import { checkForUpdate } from "./update-check.js"
import { resetRuntime, stopDaemon } from "./server-control.js"

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

const resolveProjectId = async (arg: string): Promise<string> => {
  if (!fs.existsSync(arg)) return arg
  const abs = path.resolve(arg)
  const projects: any[] = await api("GET", "/projects")
  let project = projects.find((candidate) => candidate.repoRoot === abs)
  if (!project) project = await api("POST", "/projects", { repoRoot: abs })
  return project.id
}

const engine = program.command("engine").description("管理 coding engines")
engine.command("list").action(async () => {
  try {
    const config: any = await api("GET", "/config")
    for (const item of config.engines)
      console.log(`${item.id}\t${item.enabled ? "enabled" : "disabled"}\t${item.custom ? "custom" : "built-in"}\t${item.displayName}`)
  } catch (error) { fail(error) }
})
engine.command("put <json>")
  .description("创建/更新 custom engine（JSON 或 @file）")
  .action(async (source: string) => {
    try {
      const text = source.startsWith("@") ? fs.readFileSync(path.resolve(source.slice(1)), "utf8") : source
      const definition: any = await api("POST", "/engines/custom", JSON.parse(text))
      console.log(`saved ${definition.id}`)
    } catch (error) { fail(error) }
  })
engine.command("delete <id>").action(async (id: string) => {
  try { await api("DELETE", `/engines/custom/${encodeURIComponent(id)}`); console.log(`deleted ${id}`) }
  catch (error) { fail(error) }
})
engine.command("detect <id>").action(async (id: string) => {
  try {
    const result: any = await api("POST", `/engines/custom/${encodeURIComponent(id)}/detect`, {})
    console.log(`${result.available ? "available" : "unavailable"}\t${result.accountHint ?? result.error ?? ""}`)
    if (!result.available) process.exitCode = 1
  } catch (error) { fail(error) }
})
engine.command("copilot").option("--id <id>", "custom engine id", "copilot").action(async (opts: { id: string }) => {
  try {
    const definition: any = await api("POST", "/engines/custom/presets/copilot", { id: opts.id })
    console.log(`saved ${definition.id}`)
  } catch (error) { fail(error) }
})
engine.command("switch <wsId> <engineId>")
  .option("--tab <tabId>", "要切换的 engine tab（缺省为兼容 primary）")
  .option("--model <model>")
  .option("--effort <effort>")
  .action(async (wsId: string, engineId: string, opts: { tab?: string; model?: string; effort?: string }) => {
    try {
      await api("POST", `/workspaces/${wsId}/engine`, {
        engineId, ...(opts.tab ? { tabId: opts.tab } : {}),
        ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}),
      })
      console.log(`switched ${wsId} to ${engineId}`)
    } catch (error) { fail(error) }
  })

const tab = program.command("tab").description("管理 workspace chat tabs")
tab.command("list <wsId>").action(async (wsId: string) => {
  try {
    const tabs: any[] = await api("GET", `/workspaces/${wsId}/tabs`)
    for (const item of tabs) console.log(`${item.id}\t${item.kind}\t${item.engineId ?? "-"}\t${item.status}\t${item.title ?? ""}`)
  } catch (error) { fail(error) }
})
tab.command("create <wsId>")
  .requiredOption("--engine <engineId>")
  .option("--model <model>")
  .option("--effort <effort>")
  .option("--title <title>")
  .action(async (wsId: string, opts: { engine: string; model?: string; effort?: string; title?: string }) => {
    try {
      const created: any = await api("POST", `/workspaces/${wsId}/tabs`, {
        kind: "engine", engineId: opts.engine,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      })
      console.log(created.id)
    } catch (error) { fail(error) }
  })
tab.command("close <wsId> <tabId>").action(async (wsId: string, tabId: string) => {
  try { await api("DELETE", `/workspaces/${wsId}/tabs/${tabId}`); console.log(`closed ${tabId}`) }
  catch (error) { fail(error) }
})
tab.command("rename <wsId> <tabId> <title>").action(async (wsId: string, tabId: string, title: string) => {
  try { await api("POST", `/workspaces/${wsId}/tabs/${tabId}/rename`, { title }); console.log(`renamed ${tabId}`) }
  catch (error) { fail(error) }
})

interface ConfigEngine {
  id: string
  capabilities: { effort: boolean }
  models: string[]
  efforts?: readonly string[]
}
interface ConfigNamePool { id: string; displayName: string }

// ---------- workspace lifecycle（Plan 2） ----------
program.command("create")
  .argument("<projectIdOrPath>", "项目 id，或 git 仓库路径（未注册时自动注册）")
  .option("--slug <slug>", "branch 语义名（branch = coolie/<slug>；缺省用目录名）")
  .option("--name <name>", "指定目录名（缺省从 national-parks 名池取）")
  .option("--name-pool <id>", "自动命名池（由 server /config 提供）")
  .option("--custom-names <comma>", "逗号分隔的自定义命名池（隐含 --name-pool custom）")
  .option("--prompt <text>", "workspace 就绪后投递给 engine 的首条 prompt")
  .option("--engine <id>", "coding engine（如 claude/codex）；不可与 --agents 同用")
  .option("--agents <spec>", "fan-out 规格，如 claude:2,codex:1；不可与 --engine 同用")
  .option("--model <model>", "创建时使用的模型")
  .option("--effort <effort>", "reasoning effort（如 low/medium/high/xhigh）")
  .action(async (arg: string, opts: {
    slug?: string; name?: string; namePool?: string; customNames?: string
    prompt?: string; engine?: string; agents?: string; model?: string; effort?: string
  }) => {
    try {
      if (opts.agents !== undefined && opts.engine !== undefined)
        return fail("--agents 与 --engine 互斥：fan-out 的引擎请全部写在 --agents 中")

      const projectId = await resolveProjectId(arg)
      const config = await api("GET", "/config") as { engines: ConfigEngine[]; namePools: ConfigNamePool[] }
      const engines = new Map(config.engines.map((engine) => [engine.id, engine]))
      const namePool = opts.customNames !== undefined ? "custom" : opts.namePool
      const customNames = opts.customNames?.split(",")
      if (namePool !== undefined && !config.namePools.some((pool) => pool.id === namePool))
        return fail(`未知命名池 '${namePool}'，可用：${config.namePools.map((pool) => pool.id).join(", ")}`)
      if (opts.customNames !== undefined && opts.namePool !== undefined && opts.namePool !== "custom")
        return fail("--custom-names 只能与 --name-pool custom 一起使用")
      const naming = {
        ...(namePool !== undefined ? { namePool } : {}),
        ...(customNames !== undefined ? { customNames } : {}),
      }

      if (opts.agents === undefined) {
        const engineId = opts.engine ?? "claude"
        if (!engines.has(engineId))
          return fail(`未知引擎 '${engineId}'，可用：${[...engines.keys()].join(", ")}`)
        const ws = decodeWorkspace(await api("POST", "/workspaces", {
          projectId,
          ...(opts.slug ? { branchSlug: opts.slug } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...naming,
          ...(opts.prompt ? { initialPrompt: opts.prompt } : {}),
          engineId,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
        }))
        await api("POST", `/workspaces/${ws.id}/ensure`, {})
        console.log(`created ${ws.name} (${ws.id}) branch=${ws.branch} path=${ws.path}`)
        return
      }

      const instances = expandAgents(parseAgentsSpec(opts.agents))
      const unknown = [...new Set(instances.filter((engineId) => !engines.has(engineId)))]
      if (unknown.length > 0)
        return fail(`未知引擎 '${unknown.join(", ")}'，可用：${[...engines.keys()].join(", ")}`)

      const groupId = `fo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const rows: Array<{ n: number; engineId: string; status: string; id: string }> = []
      for (const [index, engineId] of instances.entries()) {
        const engine = engines.get(engineId)!
        try {
          const ws = decodeWorkspace(await api("POST", "/workspaces", {
            projectId,
            engineId,
            fanoutGroup: groupId,
            ...(opts.slug ? { branchSlug: instances.length > 1 ? `${opts.slug}-${index + 1}` : opts.slug } : {}),
            ...(opts.name ? { name: instances.length > 1 ? `${opts.name}-${index + 1}` : opts.name } : {}),
            ...naming,
            ...(opts.prompt ? { initialPrompt: opts.prompt } : {}),
            // --model/--effort 是单一选择，跨引擎时只向明确支持该值的引擎发送；其余使用引擎默认值。
            ...(opts.model && engine.models.includes(opts.model) ? { model: opts.model } : {}),
            ...(opts.effort && engine.capabilities.effort && engine.efforts?.includes(opts.effort)
              ? { effort: opts.effort }
              : {}),
          }))
          await api("POST", `/workspaces/${ws.id}/ensure`, {})
          rows.push({ n: index + 1, engineId, status: "created", id: ws.id })
        } catch (error) {
          rows.push({
            n: index + 1,
            engineId,
            status: `failed: ${error instanceof Error ? error.message : String(error)}`,
            id: "-",
          })
        }
      }
      const succeeded = rows.filter((row) => row.id !== "-").length
      console.log(`fan-out group ${groupId}（${succeeded}/${rows.length} 成功）`)
      for (const row of rows)
        console.log(`${String(row.n).padEnd(4)}${row.engineId.padEnd(12)}${row.status.padEnd(18)}${row.id}`)
      if (succeeded !== rows.length) process.exitCode = 1
    } catch (e) { fail(e) }
  })

program.command("list").action(async () => {
  try {
    for (const w of ((await api("GET", "/workspaces")) as unknown[]).map((x) => decodeWorkspace(x)))
      console.log(`${w.id}\t${w.name}\t${w.status}\t${w.branch}\t${w.path}\t${w.kind}\t${w.taskStatus}\t${w.materialized ? "materialized" : "intent"}\t${w.sortOrder}`)
  } catch (e) { fail(e) }
})

program.command("get <wsId>")
  .description("读取单个 task/workspace")
  .action(async (id: string) => {
    try { process.stdout.write(JSON.stringify(await api("GET", `/workspaces/${encodeURIComponent(id)}`), null, 2) + "\n") }
    catch (error) { fail(error) }
  })

program.command("state [wsId]")
  .description("读取 canonical current-state snapshot；可选 workspace scope")
  .option("--json", "输出 JSON（默认）")
  .action(async (id: string | undefined) => {
    try {
      const path = id ? `/state?workspace=${encodeURIComponent(id)}` : "/state"
      const snapshot = decodeCoolieStateSnapshot(await api("GET", path))
      process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n")
    } catch (error) { fail(error) }
  })

program.command("collect [wsId]")
  .description("刷新并返回 task/runtime/diff/PR/transcript 聚合")
  .option("--cached", "只读取后台快照，不触发刷新")
  .action(async (id: string | undefined, opts: { cached?: boolean }) => {
    try {
      const result = opts.cached
        ? await api("GET", `/collect${id ? `?workspace=${encodeURIComponent(id)}` : ""}`)
        : await api("POST", "/collect", id ? { workspaceId: id } : {})
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } catch (error) { fail(error) }
  })

const addDeliveryCommand = (name: "send" | "dispatch", description: string) =>
  program.command(`${name} <wsId> <text>`)
    .description(description)
    .option("--tab <tabId>", "目标 engine tab")
    .option("--interrupt", "中断当前 turn 后投递")
    .action(async (id: string, text: string, opts: { tab?: string; interrupt?: boolean }) => {
      try {
        const result: any = await api("POST", `/workspaces/${encodeURIComponent(id)}/input`, {
          text,
          mode: opts.interrupt ? "interrupt-send" : "send",
          ...(opts.tab ? { tabId: opts.tab } : {}),
        })
        if (result.queued) {
          const contract = typeof result.messageId === "string" && typeof result.deliveryGuarantee === "string"
            ? ` message=${result.messageId} delivery=${result.deliveryGuarantee}`
            : ""
          console.log(`queued ${result.id} position=${result.position}${contract}`)
        } else {
          console.log(`sent ${id}`)
        }
      } catch (error) { fail(error) }
    })

addDeliveryCommand("send", "向 task 投递 prompt；忙时 SQLite queue 为 at-least-once，receipt 前 crash 可能重投")
addDeliveryCommand("dispatch", "调度 prompt；忙时 SQLite queue 为 at-least-once，receipt 前 crash 可能重投")

program.command("adopt")
  .argument("<projectIdOrPath>", "项目 id 或已注册/待注册仓库路径")
  .option("--path <exact>", "git worktree list 返回的精确绝对路径")
  .option("--name <name>", "采用后的 workspace 名")
  .option("--list", "只列出可采用 worktree")
  .action(async (arg: string, opts: { path?: string; name?: string; list?: boolean }) => {
    try {
      const projectId = await resolveProjectId(arg)
      if (opts.list || opts.path === undefined) {
        const rows: any[] = await api("GET", `/projects/${projectId}/worktrees/adoptable`)
        for (const row of rows) console.log(`${row.path}\t${row.branch}\t${row.head}`)
        return
      }
      const ws = decodeWorkspace(await api("POST", `/projects/${projectId}/worktrees/adopt`, {
        path: opts.path, ...(opts.name !== undefined ? { name: opts.name } : {}),
      }))
      console.log(`adopted ${ws.name} (${ws.id}) branch=${ws.branch} path=${ws.path}`)
    } catch (e) { fail(e) }
  })

program.command("finish <wsId>")
  .option("--create-pr", "push branch 并用 gh 创建 PR")
  .option("--merge-back", "在 clean 主 checkout 上执行 git merge --no-ff")
  .option("--title <title>", "PR 标题")
  .option("--body <body>", "PR 正文（缺省读取 .coolie/pr-template.md）")
  .action(async (id: string, opts: { createPr?: boolean; mergeBack?: boolean; title?: string; body?: string }) => {
    try {
      const out: any = await api("POST", `/workspaces/${id}/finish`, {
        createPr: !!opts.createPr,
        mergeBack: !!opts.mergeBack,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      })
      if (out.prUrl) console.log(`PR ${out.prUrl}`)
      if (out.mergedBack) console.log(`merged ${id} back`)
      for (const warning of out.warnings ?? []) console.error(`warning: ${warning}`)
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

program.command("pin <wsId>").action(async (id: string) => {
  try { await api("POST", `/workspaces/${id}/pin`, { pinned: true }); console.log(`pinned ${id}`) }
  catch (e) { fail(e) }
})

program.command("unpin <wsId>").action(async (id: string) => {
  try { await api("POST", `/workspaces/${id}/pin`, { pinned: false }); console.log(`unpinned ${id}`) }
  catch (e) { fail(e) }
})

program.command("rename <wsId> <name>").action(async (id: string, name: string) => {
  try { await api("POST", `/workspaces/${id}/rename`, { name }); console.log(`renamed ${id}`) }
  catch (e) { fail(e) }
})

program.command("task-status <wsId> <status>").action(async (id: string, status: string) => {
  try { await api("POST", `/workspaces/${id}/task-status`, { status }); console.log(`${id}\t${status}`) }
  catch (e) { fail(e) }
})

program.command("set-status <wsId> <status>").action(async (id: string, status: string) => {
  try { await api("POST", `/workspaces/${id}/task-status`, { status }); console.log(`${id}\t${status}`) }
  catch (e) { fail(e) }
})

program.command("branch-rename <wsId> <branch>").action(async (id: string, branch: string) => {
  try { await api("POST", `/workspaces/${id}/branch`, { branch }); console.log(`${id}\t${branch}`) }
  catch (e) { fail(e) }
})

program.command("set-branch <wsId> <branch>").action(async (id: string, branch: string) => {
  try { await api("POST", `/workspaces/${id}/branch`, { branch }); console.log(`${id}\t${branch}`) }
  catch (e) { fail(e) }
})

program.command("ensure-worktree <wsId>").action(async (id: string) => {
  try {
    const result: any = await api("POST", `/workspaces/${id}/ensure`, {})
    console.log(`${id}\t${result.action}\t${result.sessionId}`)
  } catch (error) { fail(error) }
})

program.command("reorder <projectId> <workspaceIds...>").action(async (projectId: string, workspaceIds: string[]) => {
  try { await api("POST", "/workspaces/reorder", { projectId, workspaceIds }); console.log(`reordered ${projectId}`) }
  catch (e) { fail(e) }
})

program.command("delete <wsId>")
  .option("--force", "脏树也删（丢弃未提交改动）")
  .action(async (id: string, opts: { force?: boolean }) => {
    try { await api("DELETE", `/workspaces/${id}${opts.force ? "?force=1" : ""}`); console.log(`deleted ${id}`) }
    catch (e) { fail(e) }
  })

const checkpoint = program.command("checkpoint")
  .description("用私有 git ref 管理非破坏性 checkpoint（不提供 restore）")

checkpoint.command("create <wsId>")
  .option("--label <label>", "可选标签（仅写入 checkpoint commit message）")
  .action(async (wsId: string, opts: { label?: string }) => {
    try {
      const item: any = await api("POST", `/workspaces/${wsId}/checkpoints`, {
        ...(opts.label !== undefined ? { label: opts.label } : {}),
      })
      console.log(`${item.checkpointId}\t${item.oid}\t${item.ref}${item.label ? `\t${item.label}` : ""}`)
    } catch (e) { fail(e) }
  })

checkpoint.command("list <wsId>").action(async (wsId: string) => {
  try {
    const items: any[] = await api("GET", `/workspaces/${wsId}/checkpoints`)
    for (const item of items)
      console.log(`${item.checkpointId}\t${item.oid}\t${item.ref}${item.label ? `\t${item.label}` : ""}`)
  } catch (e) { fail(e) }
})

checkpoint.command("delete <wsId> <checkpointId>").action(async (wsId: string, checkpointId: string) => {
  try {
    await api("DELETE", `/workspaces/${wsId}/checkpoints/${checkpointId}`)
    console.log(`deleted checkpoint ${checkpointId} from ${wsId}`)
  } catch (e) { fail(e) }
})

const tmuxSocketName = () => process.env.COOLIE_TMUX_SOCKET ?? "coolie"

program.command("enter <wsId>")
  .description("attach 进 workspace 的 tmux session（丢失自动重建；Ctrl-b d 返回）")
  .action(async (id: string) => {
    const sock = tmuxSocketName()
    const session = tmuxSessionName(id)
    const has = spawnSync("tmux", ["-L", sock, "has-session", "-t", `=${session}`], { stdio: "ignore" })
    if (has.status !== 0) {
      // ensure-or-heal（设计文档 §十）：session 丢失 → 经 server 重建（--resume 复活），失败才报错
      try {
        const out = decodeHealOutcome(await api("POST", `/workspaces/${id}/ensure`, {}))
        console.error(`[coolie] session 已重建（resumed=${out.resumed}）`)
      } catch (e) { fail(e) }
    }
    const r = spawnSync("tmux", ["-L", sock, "attach", "-t", `=${session}`], { stdio: "inherit" })
    process.exit(r.status ?? 0)
  })

program.command("open <wsId>")
  .description("打印 iTerm2 逃生舱命令（GUI 的 Open in iTerm2 按钮复用此命令）")
  .action((id: string) => {
    console.log(`tmux -L ${tmuxSocketName()} attach -t ${tmuxSessionName(id)}`)
  })

program.command("link")
  .description("生成 workspace/tab 的 coolie:// deep link（无需 server）")
  .argument("<wsId>")
  .option("--tab <tabId>", "定位到 workspace 中的 tab")
  .option("--open", "通过 macOS open 交给已注册的 Coolie.app")
  .action((wsId: string, opts: { tab?: string; open?: boolean }) => {
    const url = buildCoolieUrl({
      kind: "workspace",
      workspaceId: wsId,
      ...(opts.tab !== undefined ? { tabId: opts.tab } : {}),
    })
    console.log(url)
    if (!opts.open) return
    if (process.platform !== "darwin")
      return fail("--open 当前仅支持 macOS")
    // argv-only invocation: never interpolate the URL into a shell command.
    const result = spawnSync("open", [url], { stdio: "inherit" })
    if (result.error || result.status !== 0)
      return fail("open 失败；请确认 Coolie.app 已安装且注册了 coolie:// scheme")
  })

program.command("resume <wsId>")
  .description("engine 退出后原地重启（--resume 续会话；GUI Resume 按钮同款 API）")
  .option("--tab <tabId>", "恢复指定 engine tab")
  .action(async (id: string, opts: { tab?: string }) => {
    try {
      const tabs: any[] = await api("GET", `/workspaces/${id}/tabs`)
      const engineTab = opts.tab
        ? tabs.find((t) => t.id === opts.tab && t.kind === "engine")
        : tabs.find((t) => t.kind === "engine")
      if (!engineTab) return fail(`workspace ${id} 没有 engine tab`)
      const out = decodeHealOutcome(await api("POST", `/workspaces/${id}/tabs/${engineTab.id}/resume`, {}))
      console.log(`resumed ${id} (action=${out.action} resumed=${out.resumed} session=${out.sessionId})`)
    } catch (e) { fail(e) }
  })

const server = program.command("server")
server.command("start").action(async () => {
  try {
    const info = await ensureServer()
    console.log(`running pid=${info.pid} port=${info.port}`)
  } catch (error) { fail(error) }
})
server.command("status").action(async () => {
  const info = readServerInfo(path.join(home(), "server.json"))
  if (info && (await probeAlive(info))) { console.log(`running pid=${info.pid} port=${info.port}`) }
  else { console.log("stopped"); process.exit(1) }
})
server.command("stop").action(async () => {
  await stopDaemon(home())
  console.log("stopped")
})
server.command("restart").action(async () => {
  try {
    await stopDaemon(home())
    const info = await ensureServer()
    console.log(`restarted pid=${info.pid} port=${info.port}`)
  } catch (error) { fail(error) }
})
server.command("reset")
  .description("重置 Coolie runtime；保留 DB、worktrees 与 branches")
  .action(async () => {
    try {
      const result = await resetRuntime(home(), tmuxSocketName())
      console.log(`reset daemon=${result.daemonStopped ? "stopped" : "absent"} tmux=${result.tmuxStopped ? "stopped" : "absent"} cleaned=${result.removed.join(",") || "none"}`)
    } catch (error) { fail(error) }
  })

program.command("api").command("schema")
  .option("--group <group>", "system|projects|events|workspaces|engines|hooks|terminal")
  .option("--verb <verb>", "GET|POST|DELETE")
  .option("--all", "显示 request/response shape 与 example")
  .action((opts: { group?: string; verb?: string; all?: boolean }) => {
  const validGroups = new Set(["system", "projects", "events", "workspaces", "engines", "hooks", "terminal"])
  if (opts.group && !validGroups.has(opts.group)) return fail(`unknown schema group: ${opts.group}`)
  if (opts.verb && !["GET", "POST", "DELETE"].includes(opts.verb.toUpperCase()))
    return fail(`unknown schema verb: ${opts.verb}`)
  // "METHOD PATH" must appear as a literal single-space substring (tests assert
  // toContain("GET /health") etc.) — pad the combined head, not method/path
  // separately, or the column padding inserts extra spaces between them.
  for (const r of selectRoutes({ ...(opts.group ? { group: opts.group } : {}), ...(opts.verb ? { verb: opts.verb } : {}) })) {
    const head = `${r.method} ${r.path}`
    console.log(`${head.padEnd(28)} ${r.description}`)
    if (opts.all) {
      console.log(`  group: ${routeGroup(r)}`)
      console.log(`  request: ${routeRequestShape(r)}`)
      console.log(`  response: ${routeResponseShape(r)}`)
      console.log(`  example: ${routeExample(r)}`)
    }
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

program.command("completion <shell>")
  .description("生成 zsh/bash/fish completion")
  .action((shell: string) => {
    if (!["zsh", "bash", "fish"].includes(shell)) return fail("shell must be zsh|bash|fish")
    process.stdout.write(generateCompletion(shell as CompletionShell))
  })

program.command("update")
  .description("只读检查 CLI 更新（从不自动安装）")
  .option("--timeout <ms>", "超时毫秒", "2000")
  .action(async (opts: { timeout: string }) => {
    const result = await checkForUpdate({
      current: process.env.COOLIE_VERSION ?? "0.0.0",
      home: home(),
      ...(process.env.COOLIE_UPDATE_URL ? { endpoint: process.env.COOLIE_UPDATE_URL } : {}),
      timeoutMs: Number(opts.timeout),
    })
    console.log(result.message)
  })

const skill = program.command("skill").description("导出项目 canonical Cursor Agent Skill")
skill.command("export [destination]")
  .option("--force", "覆盖已有文件")
  .action((destination: string | undefined, opts: { force?: boolean }) => {
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.cursor/skills/coolie/SKILL.md")
    if (!fs.existsSync(source)) return fail(`canonical skill not found: ${source}`)
    const content = fs.readFileSync(source, "utf8")
    if (!destination) { process.stdout.write(content); return }
    const target = path.resolve(destination)
    if (fs.existsSync(target) && !opts.force) return fail(`destination exists: ${target} (use --force)`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, { flag: "w", mode: 0o644 })
    console.log(target)
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
    try {
      const d = new Database(dbPath, { readonly: true })
      check("ok", "db", dbPath)
      // stuck-creating（ledger carry-over）：create 是同步流水线，creating + 无活 server = server 崩溃残留。
      // doctor 只读纪律：只报告，绝不改库、绝不杀进程。
      try {
        const STUCK_MS = 10 * 60_000
        const rows = d.prepare("SELECT id, created_at AS createdAt FROM workspaces WHERE status = 'creating'").all() as any[]
        const stuck = rows.filter((r) => Date.now() - r.createdAt > STUCK_MS)
        if (stuck.length > 0)
          check("warn", "workspaces", `${stuck.length} 个卡在 creating 超过 10 分钟（server 崩溃残留？）：${stuck.map((r) => r.id).join(",")}——用 coolie 的 retry 或 delete 处理`)
      } catch { /* workspaces 表还没建（新库）：跳过 */ }
      d.close()
    } catch (e) { check("fail", "db", `无法打开：${String(e)}`) }
  }

  const info = readServerInfo(path.join(h, "server.json"))
  if (!info) check("warn", "server", "stopped")
  else {
    const alive = await probeAlive(info)
    let pidAlive = false
    try { process.kill(info.pid, 0); pidAlive = true } catch { /* dead */ }
    if (alive) {
      check("ok", "server", `running pid=${info.pid} port=${info.port}`)
      try {
        const cs: any = await (await fetch(`http://127.0.0.1:${info.port}/clients`, {
          headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1000),
        })).json()
        check("ok", "clients", `gui=${cs.guiHolders} total=${cs.clients.length} linger=${cs.lingerMs}ms armed=${cs.idleExitArmed}`)
      } catch { check("warn", "clients", "无法读取 /clients") }
    }
    else check(pidAlive ? "fail" : "warn", "server", pidAlive ? "pid 活着但 /health 不通" : "server.json 陈旧（进程已死）")
  }

  const logPath = path.join(h, "logs", "server.log")
  check("ok", "log", fs.existsSync(logPath) ? `${logPath}（${fs.statSync(logPath).size} bytes）` : "尚无日志")

  const sockPath = path.join(h, "coolie.sock")
  const sockWarn = sockPathWarning(sockPath)
  if (sockWarn) check("warn", "socket", sockWarn)
  else if (Number.isFinite(SUN_PATH_MAX))
    check("ok", "socket", `${sockPathByteLength(sockPath)}/${SUN_PATH_MAX} 字节`)
  else check("ok", "socket", `${sockPathByteLength(sockPath)} 字节（当前平台不套用 Darwin/Linux 上限）`)

  for (const bin of ["git", "tmux", "claude"] as const) {
    const found = spawnSync("which", [bin], { encoding: "utf8" })
    if (found.status === 0) check("ok", bin, found.stdout.trim())
    else check(bin === "git" ? "fail" : "warn", bin, "不在 PATH（tmux/claude 为 Plan 3 依赖）")
  }

  for (const [level, name, detail] of lines) console.log(`${level}\t${name}\t${detail}`)
  process.exit(lines.some(([l]) => l === "fail") ? 1 : 0)
})

program.parseAsync().catch(fail)
