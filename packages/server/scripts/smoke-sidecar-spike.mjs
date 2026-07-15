#!/usr/bin/env node
/**
 * Clean-room smoke for Task 0.6 artifacts. It never reads or writes real
 * Coolie/engine homes. A fake engine keeps the tmux pane alive while the real
 * server WebSocket exercises node-pty -> tmux attach.
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

const artifacts = resolve(process.argv[2] ?? "packages/server/dist/sidecar-spike")

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const waitFor = async (predicate, timeoutMs, description) => {
  const deadline = Date.now() + timeoutMs
  let lastError
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

const request = async (info, path, init = {}) => {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${info.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text}`)
  return text === "" ? null : JSON.parse(text)
}

const terminalAttach = (info, workspaceId) => new Promise((resolvePromise, reject) => {
  const marker = `sidecar-attach-${Date.now()}`
  const url = new URL(`ws://127.0.0.1:${info.port}/ws/terminal`)
  for (const [key, value] of Object.entries({
    token: info.token,
    workspace: workspaceId,
    window: "0",
    cols: "80",
    rows: "24",
  })) url.searchParams.set(key, value)
  const ws = new WebSocket(url)
  ws.binaryType = "arraybuffer"
  let output = ""
  const timer = setTimeout(() => {
    ws.close()
    reject(new Error(`terminal attach marker missing; output=${JSON.stringify(output)}`))
  }, 10_000)
  ws.addEventListener("open", () => ws.send(Buffer.from(`printf '${marker}\\n'\n`)))
  ws.addEventListener("message", (event) => {
    output += typeof event.data === "string"
      ? event.data
      : Buffer.from(event.data).toString("utf8")
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

const smoke = async (variant, command, args) => {
  const clean = mkdtempSync(join(tmpdir(), `coolie-sidecar-${variant}-`))
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
  execFileSync("git", [
    "-c", "user.name=Coolie Sidecar Smoke",
    "-c", "user.email=sidecar-smoke@example.invalid",
    "commit", "-m", "fixture",
  ], { cwd: repo, stdio: "ignore" })

  const env = {
    ...process.env,
    HOME: clean,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    COOLIE_HOME: home,
    COOLIE_WORKSPACES_ROOT: join(clean, "workspaces"),
    COOLIE_REPOS_ROOT: join(clean, "repos"),
    COOLIE_TMUX_SOCKET: `coolie-sidecar-${process.pid}-${variant}`,
    COOLIE_CLAUDE_HOME: join(clean, "claude"),
    COOLIE_CODEX_HOME: join(clean, "codex"),
    COOLIE_CLAUDE_CONFIG: join(clean, "claude.json"),
    COOLIE_CODEX_CONFIG: join(clean, "codex.toml"),
    COOLIE_DISABLE_HOOKS: "1",
    COOLIE_LINGER_MS: "300000",
  }
  const startedAt = performance.now()
  const child = spawn(command, [...args, "start"], {
    cwd: clean,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk })

  try {
    const infoPath = join(home, "server.json")
    const info = await waitFor(() => {
      if (!existsSync(infoPath)) return null
      return JSON.parse(readFileSync(infoPath, "utf8"))
    }, 15_000, `${variant} server.json`)
    const startupMs = Math.round(performance.now() - startedAt)
    const health = await request(info, "/health")
    const project = await request(info, "/projects", {
      method: "POST",
      body: JSON.stringify({ repoRoot: repo }),
    })
    const workspaces = await request(info, `/workspaces?project=${encodeURIComponent(project.id)}`)
    const main = workspaces.find((workspace) => workspace.kind === "main")
    if (!main) throw new Error("main workspace was not created")
    const terminal = await terminalAttach(info, main.id)
    if (!existsSync(join(home, "coolie.db")) || statSync(join(home, "coolie.db")).size === 0)
      throw new Error("better-sqlite3 did not create a database")
    await request(info, "/shutdown", { method: "POST" })
    await waitFor(() => child.exitCode !== null, 5_000, `${variant} shutdown`)
    return {
      variant,
      command: basename(command),
      startupMs,
      health,
      sqliteBytes: statSync(join(home, "coolie.db")).size,
      terminal,
    }
  } catch (error) {
    child.kill("SIGTERM")
    throw new Error(`${variant} smoke failed: ${error}\nstderr=${stderr}`)
  } finally {
    try {
      execFileSync("tmux", ["-L", env.COOLIE_TMUX_SOCKET, "kill-server"], { stdio: "ignore" })
    } catch {}
    rmSync(clean, { recursive: true, force: true })
  }
}

const results = []
results.push(await smoke(
  "runtime",
  join(artifacts, "runtime", "node"),
  [join(artifacts, "runtime", "server.cjs")],
))
results.push(await smoke(
  "standalone",
  join(artifacts, "standalone", "coolie-server"),
  [],
))
console.log(JSON.stringify(results, null, 2))
