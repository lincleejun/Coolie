import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { decodeCoolieStateSnapshot } from "@coolie/protocol"
import { runtimeTmuxKillSessions } from "./helpers/runtime-env.js"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
const TMUX_SOCK = process.env.COOLIE_TMUX_SOCKET!

let home: string
let repo: string

const coolie = (...args: string[]) =>
  execFileSync(TSX, [CLI, ...args], {
    env: {
      ...process.env,
      COOLIE_HOME: home,
      COOLIE_TMUX_SOCKET: TMUX_SOCK,
      COOLIE_CLAUDE_CMD: "cat",
      COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_HOME: path.join(home, "claude-home"),
      COOLIE_CLAUDE_CONFIG: path.join(home, "claude.json"),
      COOLIE_CODEX_CMD: "cat",
      COOLIE_CODEX_HOME: path.join(home, "codex-home"),
      COOLIE_CODEX_CONFIG: path.join(home, "codex-config.toml"),
    },
    encoding: "utf8",
  })

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-agent-api-"))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-agent-api-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repo })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
  coolie("project", "add", repo)
  coolie("create", repo, "--name", "agent-api-state", "--engine", "claude", "--prompt", "noop")
}, 60_000)

afterAll(() => {
  try { coolie("server", "stop") } catch {}
  runtimeTmuxKillSessions()
})

describe("agent-facing state API", () => {
  it("coolie state prints stable JSON snapshot", () => {
    const out = coolie("state")
    const snapshot = decodeCoolieStateSnapshot(JSON.parse(out))
    expect(Number.isInteger(snapshot.asOfSeq)).toBe(true)
    expect(snapshot.asOfSeq).toBeGreaterThanOrEqual(0)
    expect(snapshot.scope).toBeNull()
    expect(Array.isArray(snapshot.projects)).toBe(true)
    expect(Array.isArray(snapshot.workspaces)).toBe(true)
    expect(Array.isArray(snapshot.tabs)).toBe(true)
    expect(Array.isArray(snapshot.openAttention)).toBe(true)
    expect(Array.isArray(snapshot.queuedPrompts)).toBe(true)
    expect(Array.isArray(snapshot.activeRuns)).toBe(true)
    expect(snapshot.projects.some((project) => project.repoRoot === repo)).toBe(true)
  })

  it("coolie state <workspace> scopes to one workspace", () => {
    const db = new Database(path.join(home, "coolie.db"), { readonly: true })
    const workspaceId = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string } | undefined)?.id
    db.close()
    expect(workspaceId).toBeDefined()

    const out = coolie("state", workspaceId!)
    const snapshot = decodeCoolieStateSnapshot(JSON.parse(out))
    expect(snapshot.scope).toEqual({ workspaceId })
    expect(snapshot.workspaces).toHaveLength(1)
    expect(snapshot.workspaces[0]!.id).toBe(workspaceId)
  })

  it("documents snapshot then SSE after flow in api schema", () => {
    const schema = coolie("api", "schema", "--group", "system", "--all")
    expect(schema).toContain("GET /state")
    expect(schema).toContain("CoolieStateSnapshot")
    expect(schema).toContain("GET /state?workspace=WORKSPACE_ID")
    expect(schema).toContain("GET /state → asOfSeq=N")
    expect(schema).toContain("GET /events/stream?after=N")
  })
})
