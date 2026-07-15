import { describe, it, expect, afterAll } from "vitest"
import { Effect, Exit } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { sanitizePromptForPty } from "../src/tmux/sanitize.js"
import { waitStable, deliverPrompt } from "../src/tmux/delivery.js"
import { makeTmuxService } from "../src/tmux/service.js"
import { runtimeTmuxKillSessions } from "./helpers/runtime-env.js"

const SOCK = process.env.COOLIE_TMUX_SOCKET!
const svc = makeTmuxService(SOCK)
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-dlv-"))
afterAll(() => { runtimeTmuxKillSessions() })

describe("sanitizePromptForPty（纯函数，Superset 语义）", () => {
  it("normalizes CRLF and bare CR to LF", () => {
    expect(sanitizePromptForPty("a\r\nb\rc")).toBe("a\nb\nc")
  })
  it("strips CSI sequences", () => {
    expect(sanitizePromptForPty("red" + String.fromCharCode(0x1b) + "[31mtext" + String.fromCharCode(0x1b) + "[0m!")).toBe("redtext!")
  })
  it("strips OSC sequences (BEL and ST terminated)", () => {
    expect(sanitizePromptForPty("t" + String.fromCharCode(0x1b) + "]0;title" + String.fromCharCode(0x07) + "x")).toBe("tx")
    expect(sanitizePromptForPty("t" + String.fromCharCode(0x1b) + "]0;title" + String.fromCharCode(0x1b) + "\\x")).toBe("tx")
  })
  it("strips stray ESC and control chars but keeps newline", () => {
    expect(sanitizePromptForPty("a" + String.fromCharCode(0x1b) + "Z" + String.fromCharCode(0x00) + String.fromCharCode(0x07) + "b\nc")).toBe("ab\nc")
  })
  it("expands tabs to two spaces (completion trigger)", () => {
    expect(sanitizePromptForPty("a\tb")).toBe("a  b")
  })
  it("passes CJK through untouched", () => {
    expect(sanitizePromptForPty("修复登录 bug")).toBe("修复登录 bug")
  })
})

describe("waitStable + deliverPrompt against a real cat pane", () => {
  // 下面几条用 cat（瞬间就绪）演练 waitStable/deliverPrompt 的基本契约，与 Plan3 Task15 强化的
  // 冷启动兜底（minElapsedMs/stableFrames 默认值）无关——显式传 opts 恢复旧版秒回行为，保持测试快。
  const FAST = { minElapsedMs: 0, stableFrames: 2 }

  it("waitStable settles on an idle pane", async () => {
    await Effect.runPromise(svc.newSession({ name: "coolie-d1", cwd, windowName: "engine", command: ["cat"] }))
    const frame = await Effect.runPromise(waitStable(svc, "coolie-d1:0", { intervalMs: 100, ...FAST }))
    expect(typeof frame).toBe("string")
  })

  it("waitStable fails on a永不稳定的画面", async () => {
    await Effect.runPromise(svc.newSession({
      name: "coolie-d2", cwd, windowName: "engine",
      command: ["/bin/sh", "-c", "while true; do date +%s%N; sleep 0.05; done"],
    }))
    const exit = await Effect.runPromiseExit(waitStable(svc, "coolie-d2:0", { intervalMs: 100, attempts: 4, ...FAST }))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("deliverPrompt: sanitize → paste → 150ms → Enter（cat 收到完整多行）", async () => {
    await Effect.runPromise(deliverPrompt(svc, "coolie-d1:0", "line-one\r\nline" + String.fromCharCode(0x1b) + "[31m-two\ttail", FAST))
    const deadline = Date.now() + 5000
    let cap = ""
    while (Date.now() < deadline) {
      cap = await Effect.runPromise(svc.capturePane("coolie-d1:0"))
      if (cap.includes("line-one") && cap.includes("line-two  tail")) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(cap).toContain("line-one")
    expect(cap).toContain("line-two  tail") // CSI 剥掉、tab 变两空格、CRLF 归一为换行
  })

  it("empty-after-sanitize prompt is a no-op", async () => {
    await Effect.runPromise(deliverPrompt(svc, "coolie-d1:0", "\x1b[31m\x07", FAST))
    // 不抛即可；无新增内容断言由上一用例的画面对照隐含
  })
})

// Plan3 Task15 回归证据：pane 用 `read -t N -r d; exec cat` 模拟 engine 冷启动——
// 早于「真正的 app」attach stdin 之前到达的输入，会被这个「过渡期读者」读走并丢弃（真实 bug 的机制：
// claude 冷启动阶段 tty 仍是默认 cooked 模式，键入内容会被回显一次，但在 TUI 把 stdin 接管前
// 到达的内容永远进不了 claude 自己的输入循环）；一旦过渡期结束（exec 成 cat），投递的内容才会
// 被「app」真正读到并回显第二次（cat 把 stdin 写回 stdout）。用这个双重回显次数区分「送达」和「丢失」。
describe("waitStable 强化兜底：冷启动瞬时稳定窗口不再被误判（Plan3 Task15）", () => {
  const swallowScript = (discardSeconds: number) => ["/bin/bash", "-c", `read -t ${discardSeconds} -r d; exec cat`]
  const echoCount = (text: string, needle: string) => (text.match(new RegExp(needle, "g")) ?? []).length

  it("旧版语义（minElapsedMs:0/stableFrames:2）在冷启动窗口内投递 → 文本被过渡期读者吞掉（回归证据）", async () => {
    await Effect.runPromise(svc.newSession({ name: "coolie-d5", cwd, windowName: "engine", command: swallowScript(3) }))
    await Effect.runPromise(deliverPrompt(svc, "coolie-d5:0", "swallowed-prompt", { minElapsedMs: 0, stableFrames: 2 }))
    await new Promise((r) => setTimeout(r, 3500)) // 等过渡期彻底结束、cat 稳定接管
    const cap = await Effect.runPromise(svc.capturePane("coolie-d5:0"))
    expect(echoCount(cap, "swallowed-prompt")).toBe(1) // 只有 tty 的一次回显：从未被「app」读到
  })

  it("新版默认（minElapsedMs=1500/stableFrames=3）撑过冷启动窗口 → 文本被 app 真正收到（tty 回显 + app 回显）", async () => {
    await Effect.runPromise(svc.newSession({ name: "coolie-d6", cwd, windowName: "engine", command: swallowScript(1) }))
    await Effect.runPromise(deliverPrompt(svc, "coolie-d6:0", "delivered-prompt")) // 用生产默认 opts
    const deadline = Date.now() + 6000
    let cap = ""
    while (Date.now() < deadline) {
      cap = await Effect.runPromise(svc.capturePane("coolie-d6:0"))
      if (echoCount(cap, "delivered-prompt") >= 2) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(echoCount(cap, "delivered-prompt")).toBeGreaterThanOrEqual(2) // app 收到并回显：修复生效
  })
})
