import { describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { generateCompletion } from "../src/completions.js"
import { checkForUpdate } from "../src/update-check.js"
import { resetRuntime } from "../src/server-control.js"

describe("milestone 5 CLI support", () => {
  it("ships a concise discoverable canonical Cursor skill", () => {
    const skill = path.resolve(__dirname, "../../../.cursor/skills/coolie/SKILL.md")
    const content = fs.readFileSync(skill, "utf8")
    expect(content).toMatch(/^---\nname: coolie\ndescription: .+\n---/)
    expect(content.split("\n").length).toBeLessThan(500)
    expect(content).toContain("coolie api schema")
  })

  it("supports grouped, verb-filtered, detailed schema discovery", () => {
    const tsx = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
    const cli = path.resolve(__dirname, "../src/main.ts")
    const output = execFileSync(tsx, [cli, "api", "schema", "--group", "workspaces", "--verb", "GET", "--all"], { encoding: "utf8" })
    expect(output).toContain("GET /workspaces")
    expect(output).toContain("request:")
    expect(output).toContain("response:")
    expect(output).toContain("example:")
    expect(output).not.toContain("POST /projects")
  })

  it.each(["bash", "zsh", "fish"] as const)("generates %s completion without executing a shell", (shell) => {
    const output = generateCompletion(shell)
    expect(output).toContain("coolie")
    expect(output).toContain("collect")
    expect(output).toContain("ensure-worktree")
  })

  it("update check degrades offline and never invokes an installer", async () => {
    const result = await checkForUpdate({
      current: "1.0.0",
      home: fs.mkdtempSync(path.join(os.tmpdir(), "coolie-update-")),
      timeoutMs: 100,
      fetcher: vi.fn(async () => { throw new Error("offline") }),
    })
    expect(result.status).toBe("offline")
    expect(result.message).toContain("offline")
  })

  it("respects update disable configuration", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-update-disabled-"))
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ updateCheck: false }))
    const fetcher = vi.fn()
    expect((await checkForUpdate({ current: "1.0.0", home, fetcher })).status).toBe("disabled")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("reset removes runtime files and only targets Coolie's tmux socket", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-reset-"))
    fs.writeFileSync(path.join(home, "server.json"), "stale")
    fs.writeFileSync(path.join(home, "coolie.sock"), "stale")
    fs.writeFileSync(path.join(home, "coolie.db"), "preserve")
    const worktree = path.join(home, "worktree")
    fs.mkdirSync(worktree)
    const run = vi.fn(() => ({ status: 0 }) as any)

    const result = await resetRuntime(home, "coolie-test", run as any)
    expect(result.removed).toEqual(["server.json", "coolie.sock"])
    expect(run).toHaveBeenCalledWith("tmux", ["-L", "coolie-test", "kill-server"], { stdio: "ignore" })
    expect(fs.existsSync(path.join(home, "coolie.db"))).toBe(true)
    expect(fs.existsSync(worktree)).toBe(true)
  })

  it("aborts reset without cleanup when the daemon remains alive", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-reset-hung-"))
    const serverInfo = { port: 4321, token: "secret", pid: 1234 }
    fs.writeFileSync(path.join(home, "server.json"), JSON.stringify(serverInfo))
    fs.writeFileSync(path.join(home, "coolie.sock"), "live")
    const run = vi.fn(() => ({ status: 0 }) as any)
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }))
    const probe = vi.fn(async () => true)

    await expect(resetRuntime(home, "coolie-test", run as any, {
      fetcher, probe, timeoutMs: 0,
    })).rejects.toThrow(/still alive.*aborted without cleanup/)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(true)
    expect(fs.existsSync(path.join(home, "coolie.sock"))).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })
})
