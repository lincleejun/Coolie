import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { runtimeTmuxKillSessions } from "./helpers/runtime-env.js"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
const TMUX_SOCK = process.env.COOLIE_TMUX_SOCKET!
let home: string, wsRoot: string, repo: string
let wsId: string, wsPath: string

const coolie = (...args: string[]) =>
  execFileSync(TSX, [CLI, ...args], {
    env: {
      ...process.env, COOLIE_HOME: home, COOLIE_WORKSPACES_ROOT: wsRoot,
      COOLIE_TMUX_SOCKET: TMUX_SOCK, COOLIE_CLAUDE_CMD: "cat", COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_HOME: path.join(home, "claude-home"),
      COOLIE_CLAUDE_CONFIG: path.join(home, "claude.json"), // trust 种子绝不能写真实 ~/.claude.json
    },
    encoding: "utf8",
  })
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-we2e-home-")))
  wsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-we2e-ws-")))
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-we2e-repo-")))
  sh(repo, "init", "-b", "main")
  sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t")
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n")
  sh(repo, "add", "-A"); sh(repo, "commit", "-m", "init")
})
afterAll(() => {
  try { coolie("server", "stop") } catch {}
  runtimeTmuxKillSessions()
})

describe("coolie workspace commands e2e", () => {
  it("create by repo path auto-registers the project and prints the workspace line", () => {
    const out = coolie("create", repo, "--slug", "cli-e2e")
    const m = out.match(/^created (\S+) \((\S+)\) branch=coolie\/cli-e2e path=(.+)$/m)
    expect(m).not.toBeNull()
    wsId = m![2]!
    wsPath = m![3]!
    expect(fs.existsSync(path.join(wsPath, "README.md"))).toBe(true)
    expect(coolie("list")).toContain(`${wsId}\t`)
    expect(coolie("list")).toContain("active")
    // 守卫：folder-trust 种子必须落在 COOLIE_CLAUDE_CONFIG 指向的临时文件（而非真实 ~/.claude.json）。
    const trustCfg = JSON.parse(fs.readFileSync(path.join(home, "claude.json"), "utf8"))
    expect(trustCfg.projects?.[fs.realpathSync(wsPath)]?.hasTrustDialogAccepted).toBe(true)
  }, 60_000)
  it("archive removes the worktree dir, keeps the branch", () => {
    expect(coolie("archive", wsId)).toContain(`archived ${wsId}`)
    expect(fs.existsSync(wsPath)).toBe(false)
    expect(coolie("list")).toContain("archived")
    expect(sh(repo, "rev-parse", "--verify", "refs/heads/coolie/cli-e2e").trim()).toMatch(/^[0-9a-f]{40}$/)
  }, 30_000)
  it("unarchive rebuilds the worktree", () => {
    expect(coolie("unarchive", wsId)).toContain(`unarchived ${wsId}`)
    expect(fs.existsSync(path.join(wsPath, "README.md"))).toBe(true)
    expect(coolie("list")).toContain("active")
  }, 30_000)
  it("delete refuses a dirty tree without --force, succeeds with it; branch survives", () => {
    fs.writeFileSync(path.join(wsPath, "junk.txt"), "x") // untracked → 脏
    expect(() => coolie("delete", wsId)).toThrow() // exit 1（409 Conflict）
    expect(coolie("delete", wsId, "--force")).toContain(`deleted ${wsId}`)
    expect(coolie("list")).not.toContain(wsId)
    expect(sh(repo, "rev-parse", "--verify", "refs/heads/coolie/cli-e2e").trim()).toMatch(/^[0-9a-f]{40}$/)
  }, 30_000)

  it("open prints the attach command for the test socket", () => {
    const out = coolie("open", "someid")
    expect(out.trim()).toBe(`tmux -L ${TMUX_SOCK} attach -t coolie-someid`)
  })

  it("enter exits non-zero with guidance when the workspace is missing", () => {
    // Plan 4: enter 丢失 session → 走 ensure-or-heal（POST /ensure）；不存在的 workspace
    // 由 server 报 NotFound「workspace 不存在」，CLI fail() 打到 stderr 并 exit 1。
    let failed = false
    try { coolie("enter", "no-such-ws") } catch (e: any) {
      failed = true
      expect(String(e.stderr)).toContain("不存在")
    }
    expect(failed).toBe(true)
  })

  it("create --prompt delivers the first prompt into the engine window", () => {
    const out = coolie("create", repo, "--name", "prompted-ws", "--slug", "prompted", "--prompt", "hello-e2e-prompt")
    const id = out.match(/created \S+ \(([^)]+)\)/)![1]!
    // create 是同步流水线：返回时 prompt 已投递（cat 引擎回显）
    const cap = execFileSync("tmux", ["-L", TMUX_SOCK, "capture-pane", "-p", "-t", `=coolie-${id}:0`], { encoding: "utf8" })
    expect(cap).toContain("hello-e2e-prompt")
    coolie("delete", id, "--force") // 清理：session + worktree + 记录
  }, 30_000)
})
