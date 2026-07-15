import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { runtimePort, runtimeTmuxSocket } from "./helpers/runtime-env.js"

describe("runtime test environment", () => {
  it("injects isolated homes, ports, and engine config paths", () => {
    const home = process.env.COOLIE_HOME!
    const claudeHome = process.env.COOLIE_CLAUDE_HOME!
    const codexHome = process.env.COOLIE_CODEX_HOME!
    const runtimeRoot = home.replace(/\/home\/\.coolie$/, "")
    expect(runtimeRoot).toMatch(/\/coolie-rt-/)
    expect(home).toBe(path.join(runtimeRoot, "home", ".coolie"))
    expect(claudeHome).toBe(path.join(runtimeRoot, "home", ".claude"))
    expect(codexHome).toBe(path.join(runtimeRoot, "home", ".codex"))
    expect(process.env.COOLIE_WORKSPACES_ROOT).toBe(path.join(runtimeRoot, "workspaces"))
    expect(process.env.COOLIE_REPOS_ROOT).toBe(path.join(runtimeRoot, "repos"))
    expect(process.env.TMPDIR).toBe(path.join(runtimeRoot, "tmp"))
    expect(runtimeTmuxSocket()).toMatch(/^coolie-test-\d+-[a-zA-Z0-9]+$/)
    expect(runtimePort()).toBe(Number(process.env.COOLIE_PORT))
    expect(runtimePort(3)).toBe(runtimePort() + 3)
    expect(fs.existsSync(home)).toBe(false) // created on demand by daemon/tests
  })

  it("uses a dedicated tmux socket for the worker", () => {
    const probeSocket = `${runtimeTmuxSocket()}-probe`
    execFileSync("tmux", ["-L", probeSocket, "new-session", "-d", "-s", "runtime-env-probe"])
    expect(execFileSync("tmux", ["-L", probeSocket, "list-sessions"], { encoding: "utf8" })).toContain("runtime-env-probe")
    execFileSync("tmux", ["-L", probeSocket, "kill-server"])
    expect(() => execFileSync("tmux", ["-L", probeSocket, "list-sessions"], { stdio: "pipe" })).toThrow()
  })
})
