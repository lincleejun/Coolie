import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
const TMUX_SOCK = `coolie-test-${process.pid}-cli`
let home: string, repo: string

const coolie = (...args: string[]) =>
  execFileSync(TSX, [CLI, ...args], {
    env: {
      ...process.env, COOLIE_HOME: home,
      COOLIE_TMUX_SOCKET: TMUX_SOCK, COOLIE_CLAUDE_CMD: "cat", COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_HOME: path.join(home, "claude-home"),
      COOLIE_CLAUDE_CONFIG: path.join(home, "claude.json"), // trust 种子绝不能写真实 ~/.claude.json
    },
    encoding: "utf8",
  })

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-"))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repo })
})
afterAll(() => {
  try { coolie("server", "stop") } catch {}
  try { execFileSync("tmux", ["-L", TMUX_SOCK, "kill-server"]) } catch { /* gone */ }
})

describe("coolie CLI e2e", () => {
  it("auto-spawns server and manages projects", () => {
    const added = coolie("project", "add", repo)
    expect(added).toContain("added")
    expect(coolie("project", "list")).toContain(repo)
    expect(coolie("server", "status")).toContain("running")
  })
  it("project add with a relative path resolves against the CLI's cwd, not the daemon's", () => {
    // The daemon backing `home` is already running (spawned by the previous
    // test) with its own cwd — wherever it was first auto-spawned from (the
    // test runner's cwd, i.e. this repo's root), which is NOT `parent` below.
    // A relative `project add` path must resolve against the CLI invocation's
    // cwd, never the daemon's — otherwise `add .` silently registers the
    // wrong repository (finding: repoRoot resolved server-side).
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-relparent-"))
    const relRepo = fs.mkdtempSync(path.join(parent, "coolie-rel-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: relRepo })
    const base = path.basename(relRepo)
    execFileSync(TSX, [CLI, "project", "add", base], { cwd: parent, env: { ...process.env, COOLIE_HOME: home }, encoding: "utf8" })
    expect(coolie("project", "list")).toContain(relRepo)
  })
  it("api schema prints the route table", () => {
    const out = coolie("api", "schema")
    expect(out).toContain("GET /health")
    expect(out).toContain("POST /projects")
  })
  it("unknown command exits non-zero", () => {
    expect(() => coolie("frobnicate")).toThrow()
  })
  it("server stop without a running server does not spawn one", () => {
    const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-stop-"))
    const out = execFileSync(TSX, [CLI, "server", "stop"], { env: { ...process.env, COOLIE_HOME: freshHome }, encoding: "utf8" })
    expect(out).toContain("stopped")
    expect(fs.existsSync(path.join(freshHome, "server.json"))).toBe(false) // no server was spawned
    // server.json alone is an unreliable oracle: the daemon's own /shutdown handler
    // removes it synchronously before the CLI's fetch() resolves, so an auto-spawn
    // followed by an immediate self-shutdown also leaves no server.json behind.
    // coolie.db, however, is created on daemon startup and never removed by
    // shutdown — its absence is a true signal that no daemon process ever ran.
    expect(fs.existsSync(path.join(freshHome, "coolie.db"))).toBe(false)
  })
  it("events tail prints structured events (e2e, non-follow)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-tail-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    coolie("project", "add", dir)
    const out = coolie("events", "tail", "--after", "0")
    expect(out).toContain("project.added")
    expect(out).toMatch(/^\d+\t\d{4}-\d{2}-\d{2}T/m) // seq \t ISO 时间戳开头
  })
  it("resume：session 被外力清理 → 经 ensure 重建（enter 的 heal 同一条 server 路径）", () => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
    const created = coolie("create", repo, "--name", "heal-me")
    const id = /\(([^)]+)\)/.exec(created)![1]!
    execFileSync("tmux", ["-L", TMUX_SOCK, "kill-session", "-t", `=coolie-${id}`])
    const out = coolie("resume", id)
    expect(out).toContain("action=recreated")
    const has = spawnSync("tmux", ["-L", TMUX_SOCK, "has-session", "-t", `=coolie-${id}`])
    expect(has.status).toBe(0) // session 回来了
    coolie("delete", id, "--force") // 清场
  })
})
