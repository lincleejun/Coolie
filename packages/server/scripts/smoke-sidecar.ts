#!/usr/bin/env bun
/**
 * Clean-room smoke for the Wave 4.1 production sidecar.
 * Never touches real ~/.coolie, ~/.claude, or ~/.codex.
 */
import { execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const artifacts = resolve(process.argv[2] ?? join(root, "packages/server/dist/sidecar"))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const waitFor = async <T>(
  predicate: () => T | null | Promise<T | null>,
  timeoutMs: number,
  description: string,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(25)
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError}` : ""}`)
}

type ServerInfo = { port: number; token: string }

const request = async (info: ServerInfo, path: string, init: RequestInit = {}) => {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${info.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text}`)
  return text === "" ? null : JSON.parse(text)
}

const terminalAttach = (info: ServerInfo, workspaceId: string) =>
  new Promise<{ marker: string; receivedBytes: number }>((resolvePromise, reject) => {
    const marker = `sidecar-attach-${Date.now()}`
    const url = new URL(`ws://127.0.0.1:${info.port}/ws/terminal`)
    for (const [key, value] of Object.entries({
      token: info.token,
      workspace: workspaceId,
      window: "0",
      cols: "80",
      rows: "24",
    }))
      url.searchParams.set(key, value)
    const ws = new WebSocket(url)
    ws.binaryType = "arraybuffer"
    let output = ""
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`terminal attach marker missing; output=${JSON.stringify(output)}`))
    }, 10_000)
    ws.addEventListener("open", () => ws.send(Buffer.from(`printf '${marker}\\n'\n`)))
    ws.addEventListener("message", (event) => {
      output +=
        typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8")
      if (output.includes(marker)) {
        clearTimeout(timer)
        ws.close()
        resolvePromise({ marker, receivedBytes: Buffer.byteLength(output) })
      }
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("terminal WebSocket failed"))
    })
  })

const auditBundle = () => {
  const manifest = JSON.parse(readFileSync(join(artifacts, "manifest.json"), "utf8")) as {
    files: { path: string }[]
    node: string
    modulesAbi: string
  }
  const joined = manifest.files.map((f) => f.path).join("\n")
  if (joined.includes("tsx") || joined.includes("node_modules/tsx"))
    throw new Error("sidecar manifest unexpectedly references tsx")
  if (!existsSync(join(artifacts, "node")) || !existsSync(join(artifacts, "server.cjs")))
    throw new Error("missing node or server.cjs")
  if (manifest.node !== "v22.22.3" || manifest.modulesAbi !== "127")
    throw new Error(`unexpected runtime pin ${manifest.node} / ${manifest.modulesAbi}`)
  return manifest
}

const smoke = async () => {
  auditBundle()
  const clean = mkdtempSync(join(tmpdir(), "coolie-sidecar-prod-"))
  const home = join(clean, "home")
  const fakeBin = join(clean, "bin")
  const repo = join(clean, "repo")
  mkdirSync(home, { recursive: true })
  mkdirSync(fakeBin, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const fakeEngine = join(fakeBin, "claude")
  writeFileSync(fakeEngine, "#!/bin/sh\nexec /bin/sh\n")
  chmodSync(fakeEngine, 0o755)
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" })
  writeFileSync(join(repo, "README.md"), "sidecar smoke\n")
  execFileSync("git", ["add", "README.md"], { cwd: repo })
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Coolie Sidecar Smoke",
      "-c",
      "user.email=sidecar-smoke@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: repo, stdio: "ignore" },
  )

  const env = {
    ...process.env,
    HOME: clean,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    COOLIE_HOME: home,
    COOLIE_WORKSPACES_ROOT: join(clean, "workspaces"),
    COOLIE_REPOS_ROOT: join(clean, "repos"),
    COOLIE_TMUX_SOCKET: `coolie-sidecar-${process.pid}`,
    COOLIE_CLAUDE_HOME: join(clean, "claude"),
    COOLIE_CODEX_HOME: join(clean, "codex"),
    COOLIE_CLAUDE_CONFIG: join(clean, "claude.json"),
    COOLIE_CODEX_CONFIG: join(clean, "codex.toml"),
    COOLIE_DISABLE_HOOKS: "1",
    COOLIE_LINGER_MS: "300000",
  }

  // cwd outside checkout — proves no dependency on repo node_modules/tsx.
  if (clean.startsWith(root)) throw new Error("clean room unexpectedly inside checkout")

  const nodeBin = join(artifacts, "node")
  const serverCjs = join(artifacts, "server.cjs")
  const startedAt = performance.now()
  const child = spawn(nodeBin, [serverCjs, "start"], {
    cwd: clean,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += chunk
  })

  try {
    const infoPath = join(home, "server.json")
    const info = await waitFor(() => {
      if (!existsSync(infoPath)) return null
      return JSON.parse(readFileSync(infoPath, "utf8")) as ServerInfo
    }, 15_000, "server.json")
    const startupMs = Math.round(performance.now() - startedAt)
    const health = await request(info, "/health")
    const project = await request(info, "/projects", {
      method: "POST",
      body: JSON.stringify({ repoRoot: repo }),
    })
    const workspaces = (await request(info, `/workspaces?project=${encodeURIComponent(project.id)}`)) as Array<{
      id: string
      kind: string
    }>
    const main = workspaces.find((workspace) => workspace.kind === "main")
    if (!main) throw new Error("main workspace was not created")
    const terminal = await terminalAttach(info, main.id)
    const dbPath = join(home, "coolie.db")
    if (!existsSync(dbPath) || statSync(dbPath).size === 0)
      throw new Error("better-sqlite3 did not create a database")

    // Process-group separation: killing a synthetic "GUI" process group must not
    // take down the detached sidecar (already in its own group via detached:true).
    const gui = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" })
    if (gui.pid == null) throw new Error("failed to spawn synthetic GUI")
    process.kill(-gui.pid, "SIGTERM")
    await sleep(100)
    if (child.exitCode !== null) throw new Error("sidecar died when synthetic GUI process group was killed")

    await request(info, "/shutdown", { method: "POST" })
    await waitFor(() => child.exitCode !== null, 5_000, "shutdown")
    return {
      variant: "production",
      command: basename(nodeBin),
      cwdOutsideCheckout: true,
      startupMs,
      health,
      sqliteBytes: statSync(dbPath).size,
      terminal,
      processGroupSeparated: true,
    }
  } catch (error) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
    throw new Error(`production smoke failed: ${error}\nstderr=${stderr}`)
  } finally {
    try {
      execFileSync("tmux", ["-L", env.COOLIE_TMUX_SOCKET, "kill-server"], { stdio: "ignore" })
    } catch {
      /* ignore */
    }
    rmSync(clean, { recursive: true, force: true })
  }
}

const result = await smoke()
console.log(JSON.stringify(result, null, 2))
