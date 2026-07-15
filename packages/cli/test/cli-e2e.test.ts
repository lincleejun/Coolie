import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import Database from "better-sqlite3"

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
      COOLIE_CODEX_CMD: "cat",
      COOLIE_CODEX_HOME: path.join(home, "codex-home"),
      COOLIE_CODEX_CONFIG: path.join(home, "codex-config.toml"),
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
  it("lists and adopts an existing linked branch worktree", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-adopt-repo-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: source })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: source })
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-adopt-wt-"))
    fs.rmdirSync(linked)
    execFileSync("git", ["worktree", "add", "-b", "feature/adopt-e2e", linked, "main"], { cwd: source })
    coolie("project", "add", source)
    const listed = coolie("adopt", source, "--list")
    expect(listed).toContain("\tfeature/adopt-e2e")
    const exactListedPath = listed.trim().split("\t")[0]!
    const adopted = coolie("adopt", source, "--path", exactListedPath, "--name", "adopted-e2e")
    expect(adopted).toContain("adopted adopted-e2e")
    expect(adopted).toContain(`path=${exactListedPath}`)
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
  it("create accepts engine, model and effort flags", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-engine-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: dir })
    const created = coolie(
      "create", dir, "--name", "codex-options",
      "--engine", "codex", "--model", "gpt-5", "--effort", "high",
    )
    const id = /\(([^)]+)\)/.exec(created)![1]!
    const db = new Database(path.join(home, "coolie.db"), { readonly: true })
    const row = db.prepare("SELECT data FROM workspaces WHERE id = ?").get(id) as { data: string }
    expect(JSON.parse(row.data).createCtx).toEqual({
      engineId: "codex",
      model: "gpt-5",
      effort: "high",
    })
    db.close()
    coolie("delete", id, "--force")
  })
  it("pin and unpin persist workspace state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-pin-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: dir })
    const id = /\(([^)]+)\)/.exec(coolie("create", dir, "--name", "pin-me"))![1]!
    expect(coolie("pin", id)).toContain(`pinned ${id}`)
    let db = new Database(path.join(home, "coolie.db"), { readonly: true })
    expect((db.prepare("SELECT pinned FROM workspaces WHERE id = ?").get(id) as { pinned: number }).pinned).toBe(1)
    db.close()
    expect(coolie("unpin", id)).toContain(`unpinned ${id}`)
    db = new Database(path.join(home, "coolie.db"), { readonly: true })
    expect((db.prepare("SELECT pinned FROM workspaces WHERE id = ?").get(id) as { pinned: number }).pinned).toBe(0)
    db.close()
    coolie("delete", id, "--force")
  })
  it("creates, lists and deletes checkpoint refs through the CLI", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-checkpoint-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    fs.writeFileSync(path.join(dir, "tracked.txt"), "base\n")
    execFileSync("git", ["add", "."], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir })
    const id = /\(([^)]+)\)/.exec(coolie("create", dir, "--name", "checkpoint-cli"))![1]!
    const worktree = (coolie("list").split("\n").find((line) => line.startsWith(`${id}\t`)) ?? "").split("\t")[4]!
    fs.writeFileSync(path.join(worktree, "tracked.txt"), "checkpoint content\n")
    fs.writeFileSync(path.join(worktree, "new.txt"), "untracked\n")

    const created = coolie("checkpoint", "create", id, "--label", "CLI safe point")
    const [checkpointId, oid, ref] = created.trim().split("\t")
    expect(ref).toBe(`refs/coolie-checkpoints/${id}/${checkpointId}`)
    expect(execFileSync("git", ["show", `${oid}:new.txt`], { cwd: dir, encoding: "utf8" })).toBe("untracked\n")
    expect(coolie("checkpoint", "list", id)).toContain("CLI safe point")

    coolie("archive", id, "--force")
    expect(() => coolie("checkpoint", "create", id)).toThrow()
    expect(coolie("checkpoint", "list", id)).toContain(checkpointId)
    expect(coolie("checkpoint", "delete", id, checkpointId!)).toContain(`deleted checkpoint ${checkpointId}`)
    expect(coolie("checkpoint", "list", id)).not.toContain(checkpointId)
    const events = coolie("events", "tail", "--after", "0")
    expect(events).toContain("checkpoint.created")
    expect(events).toContain("checkpoint.deleted")
    coolie("delete", id, "--force")
  })
  it("create --agents creates each instance independently with unique slugs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-fanout-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: dir })
    const out = coolie(
      "create", dir, "--agents", "claude:2,codex:1",
      "--slug", "fan", "--name", "fan-name", "--prompt", "hi",
    )
    expect(out).toContain("3/3 成功")
    expect(out).toMatch(/claude\s+created/)
    expect(out).toMatch(/codex\s+created/)
    const db = new Database(path.join(home, "coolie.db"), { readonly: true })
    const rows = db.prepare("SELECT id, name, branch, data FROM workspaces WHERE kind = 'task' AND project_id = (SELECT id FROM projects WHERE repo_root = ?) ORDER BY created_at")
      .all(dir) as Array<{ id: string; name: string; branch: string; data: string }>
    expect(rows.map((row) => row.branch)).toEqual(["coolie/fan-1", "coolie/fan-2", "coolie/fan-3"])
    expect(rows.map((row) => row.name)).toEqual(["fan-name-1", "fan-name-2", "fan-name-3"])
    expect(new Set(rows.map((row) => JSON.parse(row.data).createCtx.fanoutGroup)).size).toBe(1)
    db.close()
    for (const row of rows) coolie("delete", row.id, "--force")
  })
  it("create --agents rejects unknown engines before creating anything", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-unknown-engine-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    expect(() => coolie("create", dir, "--agents", "bogus:1")).toThrow(/未知引擎|Command failed/)
    const db = new Database(path.join(home, "coolie.db"), { readonly: true })
    const count = db.prepare("SELECT count(*) AS n FROM workspaces WHERE kind = 'task' AND project_id = (SELECT id FROM projects WHERE repo_root = ?)")
      .get(dir) as { n: number }
    expect(count.n).toBe(0)
    db.close()
  })
  it("create makes --agents and --engine mutually exclusive", () => {
    expect(() => coolie("create", repo, "--agents", "claude:1", "--engine", "claude")).toThrow()
  })
  it("create --agents reports partial failure and keeps successful workspaces", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-partial-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: dir })
    execFileSync("git", ["checkout", "-b", "coolie/partial-2"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "independent"], { cwd: dir })
    execFileSync("git", ["checkout", "main"], { cwd: dir })
    let output = ""
    try {
      coolie("create", dir, "--agents", "claude:2", "--name", "same-name", "--slug", "partial")
    } catch (error: any) {
      output = String(error.stdout ?? "") + String(error.stderr ?? "")
    }
    expect(output).toContain("1/2 成功")
    expect(output).toContain("failed:")
    const db = new Database(path.join(home, "coolie.db"), { readonly: true })
    const rows = db.prepare("SELECT id, status FROM workspaces WHERE kind = 'task' AND project_id = (SELECT id FROM projects WHERE repo_root = ?)")
      .all(dir) as Array<{ id: string; status: string }>
    expect(rows.map((row) => row.status).sort()).toEqual(["active", "error"])
    db.close()
    for (const row of rows) coolie("delete", row.id, "--force")
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
