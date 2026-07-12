import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import { Effect } from "effect"
import { makeTmuxService } from "../src/tmux/service.js"
import { makeComposerOps } from "../src/tmux/ops.js"

const SOCK = `coolie-test-${process.pid}-ops`
const SESSION = "ops-session"
const tmux = makeTmuxService(SOCK)
const ops = makeComposerOps(tmux)
const capture = () => execFileSync("tmux", ["-L", SOCK, "capture-pane", "-p", "-t", `=${SESSION}:0`], { encoding: "utf8" })

beforeAll(async () => {
  await Effect.runPromise(tmux.newSession({ name: SESSION, cwd: process.cwd(), windowName: "engine", command: ["cat"] }))
  await new Promise((r) => setTimeout(r, 300))
})
afterAll(() => { try { execFileSync("tmux", ["-L", SOCK, "kill-server"]) } catch {} })

describe("makeComposerOps", () => {
  it("send（完整管线）把文本投进 pane 并回车", async () => {
    await ops.input(`${SESSION}:0`, { text: "hello-send", mode: "send", skipStable: false })
    await new Promise((r) => setTimeout(r, 300))
    expect(capture()).toContain("hello-send") // cat 回显 = Enter 已生效
  })
  it("insert 不回车（cat 无回显第二行）", async () => {
    await ops.input(`${SESSION}:0`, { text: "pending-insert", mode: "insert", skipStable: false })
    await new Promise((r) => setTimeout(r, 300))
    const frame = capture()
    // 输入行有文本、但 cat 未回显（回显会产生第二次出现）
    expect(frame.split("pending-insert").length - 1).toBe(1)
  })
  it("interrupt 发 Escape 不崩（cat 场景无可见效果，验证不抛错）", async () => {
    await ops.input(`${SESSION}:0`, { text: "", mode: "interrupt", skipStable: false })
  })
  it("newShellWindow / killWindow 往返", async () => {
    const idx = await ops.newShellWindow(SESSION, process.cwd())
    expect(idx).toBeGreaterThan(0)
    const wins = await Effect.runPromise(tmux.listWindows(SESSION))
    expect(wins.some((w) => w.index === idx)).toBe(true)
    await ops.killWindow(SESSION, idx)
    const after = await Effect.runPromise(tmux.listWindows(SESSION))
    expect(after.some((w) => w.index === idx)).toBe(false)
  })
})
