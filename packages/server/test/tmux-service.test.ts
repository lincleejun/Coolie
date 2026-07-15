import { describe, it, expect, afterAll } from "vitest"
import { Effect, Exit } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { makeTmuxService, TmuxError } from "../src/tmux/service.js"
import { sanitizedTmuxEnv, shellQuote } from "../src/tmux/env.js"

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const svc = makeTmuxService(SOCK)
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-tmux-"))

afterAll(() => { try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* 已无 server */ } })

const run = <A>(eff: Effect.Effect<A, TmuxError>) => Effect.runPromise(eff)
const waitFor = async (fn: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error("waitFor timeout")
}

describe("tmux env boundary（纯函数）", () => {
  it("strips TERM_PROGRAM* and pins TERM/COLORTERM", () => {
    const env = sanitizedTmuxEnv({
      TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3", TERM_SESSION_ID: "x",
      PATH: "/bin", TERM: "screen", LANG: "", LC_CTYPE: "C", LC_ALL: "C",
    })
    expect(env.TERM_PROGRAM).toBeUndefined()
    expect(env.TERM_PROGRAM_VERSION).toBeUndefined()
    expect(env.TERM_SESSION_ID).toBeUndefined()
    expect(env.TERM).toBe("xterm-256color")
    expect(env.COLORTERM).toBe("truecolor")
    expect(env.LANG).toMatch(/UTF-8$/)
    expect(env.LC_CTYPE).toBe(env.LANG)
    expect(env.LC_ALL).toBe(env.LANG)
    expect(env.PATH).toBe("/bin")
  })
  it("shellQuote survives single quotes and spaces", () => {
    expect(shellQuote(["echo", "it's a test"])).toBe(`'echo' 'it'\\''s a test'`)
  })
})

describe("TmuxService on dedicated test socket", () => {
  it("hasSession=false on fresh socket; listSessions=[]", async () => {
    expect(await run(svc.hasSession("coolie-none"))).toBe(false)
    expect(await run(svc.listSessions())).toEqual([])
  })

  it("newSession creates window 0 with given name and command", async () => {
    await run(svc.newSession({ name: "coolie-t1", cwd, windowName: "engine", command: ["cat"] }))
    expect(await run(svc.hasSession("coolie-t1"))).toBe(true)
    expect(await run(svc.listSessions())).toContain("coolie-t1")
    const wins = await run(svc.listWindows("coolie-t1"))
    expect(wins).toHaveLength(1)
    expect(wins[0]).toMatchObject({ index: 0, name: "engine", role: null, workspaceId: null, tabId: null })
  })

  it("pasteText + sendKey(Enter) reach the pane (cat echo)", async () => {
    await run(svc.pasteText("coolie-t1:0", "hello-tmux-service"))
    await run(svc.sendKey("coolie-t1:0", "Enter"))
    await waitFor(async () => (await run(svc.capturePane("coolie-t1:0"))).includes("hello-tmux-service"))
  })

  it("newWindow appends and returns its index", async () => {
    const idx = await run(svc.newWindow({ session: "coolie-t1", name: "shell", cwd }))
    expect(idx).toBe(1)
    const wins = await run(svc.listWindows("coolie-t1"))
    expect(wins.map((w) => w.name)).toEqual(["engine", "shell"])
  })

  it("sets role metadata on windows/panes and supports reverse lookup", async () => {
    await run(svc.setWindowOption("coolie-t1:0", "@role", "engine"))
    await run(svc.setWindowOption("coolie-t1:0", "@workspace_id", "w1"))
    await run(svc.setWindowOption("coolie-t1:0", "@tab_id", "t1"))
    const pane = (await run(svc.listPanes("coolie-t1"))).find((item) => item.window === 0)!
    await run(svc.setPaneOption(pane.id, "@role", "engine"))
    const windows = await run(svc.listWindows("coolie-t1"))
    expect(windows[0]).toMatchObject({ role: "engine", workspaceId: "w1", tabId: "t1" })
    expect(await run(svc.targetMetadata("coolie-t1:0"))).toEqual({
      role: "engine", workspaceId: "w1", tabId: "t1",
    })
    const afterDaemonRestart = makeTmuxService(SOCK)
    expect(await run(afterDaemonRestart.targetMetadata("coolie-t1:0"))).toEqual({
      role: "engine", workspaceId: "w1", tabId: "t1",
    })
  })

  it("resizes a window through argv-safe tmux operations", async () => {
    await run(svc.resizeWindow("coolie-t1:0", 100, 30))
    expect((await run(svc.listWindows("coolie-t1")))[0]).toMatchObject({ width: 100, height: 30 })
  })

  it("session env carries injected vars (COOLIE_PORT_0 visible in pane)", async () => {
    await run(svc.newSession({
      name: "coolie-t2", cwd, windowName: "engine",
      command: ["/bin/sh", "-c", "echo PORT0=$COOLIE_PORT_0; cat"],
      env: { COOLIE_PORT_0: "40000" },
    }))
    await waitFor(async () => (await run(svc.capturePane("coolie-t2:0"))).includes("PORT0=40000"))
  })

  it("killSession is idempotent", async () => {
    await run(svc.killSession("coolie-t2"))
    expect(await run(svc.hasSession("coolie-t2"))).toBe(false)
    await run(svc.killSession("coolie-t2")) // 第二次不抛
  })

  it("version() returns a tmux version string", async () => {
    expect(await run(svc.version())).toMatch(/tmux \d/)
  })

  it("respawnWindow -k 原地替换 window 进程（窗口数不变）", async () => {
    const S4 = "coolie-respawn-test"
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-respawn-"))
    await Effect.runPromise(svc.newSession({ name: S4, cwd, windowName: "w", command: ["sleep", "30"] }))
    await Effect.runPromise(svc.respawnWindow({ session: S4, window: 0, cwd, command: ["sh", "-c", "printf respawn-ok; sleep 30"] }))
    const deadline = Date.now() + 5000
    let seen = false
    while (Date.now() < deadline && !seen) {
      seen = (await Effect.runPromise(svc.capturePane(`${S4}:0`))).includes("respawn-ok")
      if (!seen) await new Promise((r) => setTimeout(r, 100))
    }
    expect(seen).toBe(true)
    expect(await Effect.runPromise(svc.listWindows(S4))).toHaveLength(1)
    await Effect.runPromise(svc.killSession(S4))
  })
})
