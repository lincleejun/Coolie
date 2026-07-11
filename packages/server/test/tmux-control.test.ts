import { describe, it, expect, afterAll } from "vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { makeControlClient } from "../src/tmux/control.js"
import { makeTmuxService } from "../src/tmux/service.js"

const SOCK = `coolie-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const ctl = makeControlClient(SOCK)
const svc = makeTmuxService(SOCK, ctl)
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ctl-"))

afterAll(() => {
  ctl.dispose()
  try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch { /* gone */ }
})

const waitFor = async (fn: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error("waitFor timeout")
}

describe("persistent control-mode client", () => {
  it("execs send-keys through one persistent child", async () => {
    await Effect.runPromise(svc.newSession({ name: "coolie-c1", cwd, windowName: "engine", command: ["cat"] }))
    await ctl.exec("send-keys -t =coolie-c1:0 -l -- ctl-hello")
    await ctl.exec("send-keys -t =coolie-c1:0 Enter")
    await waitFor(async () => (await Effect.runPromise(svc.capturePane("coolie-c1:0"))).includes("ctl-hello"))
    expect(ctl.isAlive()).toBe(true)
    const pid1 = ctl.childPid()
    await ctl.exec("send-keys -t =coolie-c1:0 Enter")
    expect(ctl.childPid()).toBe(pid1) // 复用同一个子进程，不是每次 fork
  })

  it("rejects on %error but stays usable", async () => {
    // 依赖 F1 守卫：若连接守卫块被误结算，这个 %error 会错位挂到下一条命令上（旧实现在此必挂）
    await expect(ctl.exec("definitely-not-a-tmux-command")).rejects.toThrow()
    await ctl.exec("send-keys -t =coolie-c1:0 Enter") // 错误后继续可用
  })

  it("reconnects after the control child dies", async () => {
    const pid = ctl.childPid()
    expect(pid).not.toBeNull()
    process.kill(pid!, "SIGKILL")
    await waitFor(async () => !ctl.isAlive())
    await ctl.exec("send-keys -t =coolie-c1:0 -l -- after-reconnect")
    await ctl.exec("send-keys -t =coolie-c1:0 Enter")
    await waitFor(async () => (await Effect.runPromise(svc.capturePane("coolie-c1:0"))).includes("after-reconnect"))
    expect(ctl.childPid()).not.toBe(pid)
  })

  it("sendKey via TmuxService routes through the control client", async () => {
    await Effect.runPromise(svc.pasteText("coolie-c1:0", "via-service"))
    await Effect.runPromise(svc.sendKey("coolie-c1:0", "Enter"))
    await waitFor(async () => (await Effect.runPromise(svc.capturePane("coolie-c1:0"))).includes("via-service"))
  })
})
