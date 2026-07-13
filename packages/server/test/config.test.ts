import { describe, it, expect, afterEach } from "vitest"
import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import { CoolieConfig, CoolieConfigLive } from "../src/config.js"

const load = () => Effect.runSync(CoolieConfig.pipe(Effect.provide(CoolieConfigLive)))

describe("CoolieConfig", () => {
  afterEach(() => {
    delete process.env.COOLIE_HOME
    delete process.env.COOLIE_WORKSPACES_ROOT
    delete process.env.COOLIE_TMUX_SOCKET
    delete process.env.COOLIE_CLAUDE_HOME
    delete process.env.COOLIE_CODEX_HOME
    delete process.env.COOLIE_PROMPT_READY_TIMEOUT_MS
  })
  it("respects COOLIE_HOME", () => {
    process.env.COOLIE_HOME = "/tmp/coolie-test-home"
    const c = load()
    expect(c.home).toBe("/tmp/coolie-test-home")
    expect(c.dbPath).toBe("/tmp/coolie-test-home/coolie.db")
    expect(c.serverInfoPath).toBe("/tmp/coolie-test-home/server.json")
    expect(c.sockPath).toBe("/tmp/coolie-test-home/coolie.sock")
  })
  it("defaults under homedir", () => {
    const c = load()
    expect(c.home.endsWith("/.coolie")).toBe(true)
    expect(c.workspacesRoot.endsWith("/coolie/workspaces")).toBe(true)
  })
  it("respects COOLIE_WORKSPACES_ROOT", () => {
    process.env.COOLIE_WORKSPACES_ROOT = "/tmp/coolie-test-ws"
    const c = load()
    expect(c.workspacesRoot).toBe("/tmp/coolie-test-ws")
  })
  it("respects COOLIE_TMUX_SOCKET and COOLIE_CLAUDE_HOME", () => {
    process.env.COOLIE_TMUX_SOCKET = "coolie-test-x"
    process.env.COOLIE_CLAUDE_HOME = "/tmp/fake-claude-home"
    const c = load()
    expect(c.tmuxSocket).toBe("coolie-test-x")
    expect(c.claudeHome).toBe("/tmp/fake-claude-home")
  })
  it("defaults tmuxSocket=coolie and claudeHome under homedir", () => {
    const c = load()
    expect(c.tmuxSocket).toBe("coolie")
    expect(c.claudeHome.endsWith("/.claude")).toBe(true)
  })
  it("codexHome 默认 ~/.codex，可经 COOLIE_CODEX_HOME 覆写", () => {
    const a = load()
    expect(a.codexHome).toBe(path.join(os.homedir(), ".codex"))
    process.env.COOLIE_CODEX_HOME = "/tmp/cx"
    const b = load()
    expect(b.codexHome).toBe("/tmp/cx")
  })
  it("defaults promptReadyTimeoutMs=90000 (outlasts real SessionStart latency)", () => {
    const c = load()
    expect(c.promptReadyTimeoutMs).toBe(90_000)
  })
  it("respects COOLIE_PROMPT_READY_TIMEOUT_MS override", () => {
    process.env.COOLIE_PROMPT_READY_TIMEOUT_MS = "1234"
    const c = load()
    expect(c.promptReadyTimeoutMs).toBe(1234)
  })
})
