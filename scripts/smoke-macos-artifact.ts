#!/usr/bin/env bun
/**
 * Task 4.4 — clean-environment smoke of a built macOS .app (no checkout cwd).
 */
import { execFileSync, spawn } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  cpSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const appSrc = resolve(
  process.argv[2] ?? "packages/client/src-tauri/target/release/bundle/macos/Coolie.app",
)
if (!existsSync(appSrc)) {
  console.error(`artifact missing: ${appSrc}`)
  process.exit(1)
}

const listFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })

const clean = mkdtempSync(join(tmpdir(), "coolie-artifact-smoke-"))
const installDir = join(clean, "Applications")
const home = join(clean, "home")
const repo = join(clean, "repo")
const workspaces = join(clean, "workspaces")
mkdirSync(installDir, { recursive: true })
mkdirSync(home, { recursive: true })
mkdirSync(workspaces, { recursive: true })
mkdirSync(repo, { recursive: true })

const app = join(installDir, "Coolie.app")
cpSync(appSrc, app, { recursive: true })

execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" })
writeFileSync(join(repo, "README.md"), "artifact smoke\n")
writeFileSync(join(repo, ".env"), "SMOKE=1\n")
execFileSync("git", ["add", "README.md"], { cwd: repo })
execFileSync(
  "git",
  [
    "-c",
    "user.name=Coolie Artifact Smoke",
    "-c",
    "user.email=artifact-smoke@example.invalid",
    "commit",
    "-m",
    "fixture",
  ],
  { cwd: repo, stdio: "ignore" },
)

const binary = join(app, "Contents/MacOS/Coolie")
if (!existsSync(binary)) {
  console.error(`Coolie binary missing in app bundle: ${binary}`)
  process.exit(1)
}

const resourceFiles = listFiles(join(app, "Contents/Resources"))
const nodePath = resourceFiles.find((p) => p.endsWith("/sidecar/node"))
const serverPath = resourceFiles.find((p) => p.endsWith("/sidecar/server.cjs"))
if (!nodePath || !serverPath) {
  console.error("sidecar resources missing inside .app")
  process.exit(1)
}

const env = {
  ...process.env,
  HOME: clean,
  COOLIE_HOME: home,
  COOLIE_WORKSPACES_ROOT: workspaces,
  COOLIE_REPOS_ROOT: join(clean, "repos"),
  COOLIE_TMUX_SOCKET: `coolie-artifact-${process.pid}`,
  COOLIE_CLAUDE_HOME: join(clean, "claude"),
  COOLIE_CODEX_HOME: join(clean, "codex"),
  COOLIE_DISABLE_HOOKS: "1",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async <T>(fn: () => T | null | Promise<T | null>, ms: number, label: string) => {
  const deadline = Date.now() + ms
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(50)
  }
  throw new Error(`${label} timed out: ${last}`)
}

const child = spawn(nodePath, [serverPath, "start"], {
  cwd: clean,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
})
let stderr = ""
child.stderr?.on("data", (c) => {
  stderr += c
})

try {
  const info = await waitFor(() => {
    const p = join(home, "server.json")
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, "utf8")) as { port: number; token: string }
  }, 20000, "server.json")

  const health = await fetch(`http://127.0.0.1:${info.port}/health`, {
    headers: { Authorization: `Bearer ${info.token}` },
  })
  if (!health.ok) throw new Error(`health ${health.status}`)

  const projectRes = await fetch(`http://127.0.0.1:${info.port}/projects`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repoRoot: repo }),
  })
  if (!projectRes.ok) throw new Error(`project create ${projectRes.status}`)
  const project = (await projectRes.json()) as { id: string }

  const createRes = await fetch(`http://127.0.0.1:${info.port}/workspaces`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId: project.id,
      name: "artifact-ws",
      initialPrompt: "artifact smoke",
    }),
  })
  if (!createRes.ok) throw new Error(`workspace create ${await createRes.text()}`)
  const workspace = (await createRes.json()) as { id: string }

  const ensureRes = await fetch(`http://127.0.0.1:${info.port}/workspaces/${workspace.id}/ensure`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  })
  if (!ensureRes.ok) throw new Error(`ensure ${await ensureRes.text()}`)

  const branchBefore = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" })

  await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
    method: "POST",
    headers: { Authorization: `Bearer ${info.token}` },
  })
  await waitFor(() => (child.exitCode !== null ? true : null), 8000, "shutdown")

  const branchAfter = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" })
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  })

  console.log(
    JSON.stringify(
      {
        ok: true,
        installDir,
        cwdOutsideCheckout: true,
        pathHasNoNodeModules: !String(env.PATH).includes("node_modules"),
        projectId: project.id,
        workspaceId: workspace.id,
        branchesPreserved: branchAfter.includes("main") && branchAfter.length >= branchBefore.length - 2,
        worktreesAfterShutdown: worktrees.trim().split("\n").filter(Boolean).length,
      },
      null,
      2,
    ),
  )
} catch (error) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
  console.error(String(error))
  console.error(stderr)
  process.exit(1)
} finally {
  try {
    execFileSync("tmux", ["-L", env.COOLIE_TMUX_SOCKET, "kill-server"], { stdio: "ignore" })
  } catch {
    /* ignore */
  }
  rmSync(clean, { recursive: true, force: true })
}
