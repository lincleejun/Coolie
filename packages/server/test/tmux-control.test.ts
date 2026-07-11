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

  it("timeout-then-respawn race: new child's reply is not misattributed to stale pending, and no child leaks", async () => {
    // Real tmux answers control-mode commands in low single-digit ms, and SIGSTOP-freezing the child
    // proved unreliable in this sandbox (the "stopped" child's reply still arrived a few ms later
    // despite `ps` confirming T state throughout — verified via a standalone repro script). Neither
    // gives a deterministic hang. Instead we shim PATH with a tiny fake "tmux" control-mode stub whose
    // very first real command blocks forever (via a blocking `read`, no subprocess — nothing to leak)
    // until killed, so the 3s^H^H configured timeout fires 100% deterministically. This exercises the
    // exact bug: makeControlClient's own timeout/respawn/exit-handler logic, independent of real tmux's
    // actual response latency.
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-fake-tmux-"))
    const stubPath = path.join(stubDir, "tmux")
    const hangMarker = path.join(stubDir, "hung-once")
    fs.writeFileSync(
      stubPath,
      `#!/usr/bin/env bash
echo "%begin 1 1 0"
echo "%end 1 1 0"
n=1
while IFS= read -r line; do
  n=$((n+1))
  if [ ! -e "${hangMarker}" ]; then
    touch "${hangMarker}"
    read -r -t 999999 _unused_forever
    continue
  fi
  echo "%begin $n $n 0"
  echo "%end $n $n 0"
done
`,
    )
    fs.chmodSync(stubPath, 0o755)

    // timeoutMs only needs to be "not indefinite" — the stub's first command hangs forever (blocking
    // read, no clock race needed) so any finite value triggers the timeout deterministically. Kept at a
    // generous 1000ms so the *second/third* commands (real bash-script cold-start latency under load)
    // have ample headroom to resolve normally without tripping their own timeout.
    const ctl2 = makeControlClient(`fake-${path.basename(stubDir)}`, { timeoutMs: 1000 })
    // Spawn (synchronously, inside ctl2.exec) with PATH shimmed so "tmux" resolves to our stub; restore
    // PATH immediately after the synchronous portion of exec() runs (spawn's env is captured at call
    // time) so the mutation window never spans an `await` — safe even if other test files share this
    // worker's process.env.
    const execViaStub = (command: string): Promise<void> => {
      const origPath = process.env.PATH
      process.env.PATH = `${stubDir}:${origPath}`
      try {
        return ctl2.exec(command)
      } finally {
        process.env.PATH = origPath
      }
    }
    try {
      const timedOut = execViaStub("first-command-hangs")
      const pid1 = ctl2.childPid()
      expect(pid1).not.toBeNull()
      await expect(timedOut).rejects.toThrow(/timeout/)

      // Fire the next command immediately — before the old, killed child's belated 'exit' event lands —
      // to force an auto-respawn while the stale timed-out entry (buggy code) is still in `pending`.
      await execViaStub("second-command-ok")
      // Give the old child's belated 'exit' handler time to (mis)fire before issuing a third command:
      // buggy code's unconditional `child = null` would clobber the live respawned child's reference,
      // silently forcing yet another (leaked) respawn on this next call.
      await new Promise((r) => setTimeout(r, 500))
      await execViaStub("third-command-ok")

      const psOut = execFileSync("pgrep", ["-f", stubPath], { encoding: "utf8" }).trim()
      const survivors = psOut.split("\n").filter((l) => l.length > 0)
      expect(survivors.length).toBe(1)
    } finally {
      ctl2.dispose()
      try {
        const leftover = execFileSync("pgrep", ["-f", stubPath], { encoding: "utf8" }).trim()
        for (const pidStr of leftover.split("\n").filter((l) => l.length > 0)) {
          try { process.kill(Number(pidStr), "SIGKILL") } catch { /* ignore */ }
        }
      } catch { /* none left, pgrep exits 1 */ }
      fs.rmSync(stubDir, { recursive: true, force: true })
    }
  })
})
