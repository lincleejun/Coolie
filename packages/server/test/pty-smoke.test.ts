import { describe, it, expect } from "vitest"
import * as pty from "node-pty"

describe("node-pty smoke（原生构建验收）", () => {
  it("spawns a pty and captures output + exit code", async () => {
    const p = pty.spawn("/bin/sh", ["-c", "printf 'pty-ok-%s' 42"], {
      name: "xterm-256color", cols: 80, rows: 24,
      cwd: process.cwd(), env: process.env as Record<string, string>,
    })
    let out = ""
    p.onData((d) => { out += d })
    const code = await new Promise<number>((resolve) => p.onExit(({ exitCode }) => resolve(exitCode)))
    expect(code).toBe(0)
    expect(out).toContain("pty-ok-42")
  })

  it("resize does not throw and kill terminates", async () => {
    const p = pty.spawn("/bin/sh", [], {
      name: "xterm-256color", cols: 80, rows: 24,
      cwd: process.cwd(), env: process.env as Record<string, string>,
    })
    expect(() => p.resize(120, 40)).not.toThrow()
    const exited = new Promise<void>((resolve) => p.onExit(() => resolve()))
    p.kill()
    await exited // 泄漏守卫：kill 后必须真的退出
  })
})
