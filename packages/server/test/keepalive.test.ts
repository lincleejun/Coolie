import { describe, it, expect, beforeEach } from "vitest"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { ensureKeepAliveScript, keepAliveScriptPath, wrapEngineCommand } from "../src/engine/keepalive.js"

let home: string, stubDir: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka-home-"))
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ka-stub-"))
  // stub curl：把参数记到文件，永远成功——脚本行为可断言且不发真网络
  fs.writeFileSync(path.join(stubDir, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${stubDir}/curl-args"\nexit 0\n`, { mode: 0o755 })
})

const runScript = (args: string[], extraEnv: Record<string, string> = {}) =>
  spawnSync("/bin/sh", [keepAliveScriptPath(home), ...args], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      // exec 的兜底 shell 立即退出，测试不悬挂。用绝对路径指向真实存在的 true(1)——
      // 脚本本身用 ${SHELL:-/bin/sh}，此处仅为测试注入一个立即退出的 shell 占位；
      // darwin 无 /bin/true（在 /usr/bin/true），故按平台解析而非硬编码 /bin/true。
      SHELL: fs.existsSync("/bin/true") ? "/bin/true" : "/usr/bin/true",
      ...extraEnv,
    },
    encoding: "utf8",
  })

describe("keep-alive 包装脚本", () => {
  it("生成：可执行、含 engine-exit 回报与 exec shell、勿手改标注", () => {
    const p = ensureKeepAliveScript(home)
    expect(p).toBe(keepAliveScriptPath(home))
    expect(fs.statSync(p).mode & 0o111).not.toBe(0)
    const body = fs.readFileSync(p, "utf8")
    expect(body).toContain("/hooks/engine-exit?workspace=$WS")
    expect(body).toContain(`${home}/server.json`)
    expect(body).toContain('exec "${SHELL:-/bin/sh}"')
    expect(body).toContain("trap ':' INT")
    expect(body).toContain("trap - INT")
  })

  it("engine 非零退出：curl 回报 exitCode + 横幅打印 + 落回 shell", () => {
    fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ port: 45678, token: "tok-1", pid: 1 }))
    ensureKeepAliveScript(home)
    const r = runScript(["wsX", "sh", "-c", "exit 3"])
    expect(r.status).toBe(0) // exec /bin/true → 脚本进程以 shell 的退出码结束，绝不因 engine 死而带走 pane
    const args = fs.readFileSync(path.join(stubDir, "curl-args"), "utf8")
    expect(args).toContain("/hooks/engine-exit?workspace=wsX")
    expect(args).toContain('{"exitCode":3}')
    expect(args).toContain("Bearer tok-1")
    expect(r.stdout).toContain("engine exited (code 3)")
    expect(r.stdout).toContain("coolie resume wsX")
  })

  it("server.json 缺席：跳过回报、仍打横幅落回 shell（回报是 best-effort）", () => {
    ensureKeepAliveScript(home)
    const r = runScript(["wsY", "sh", "-c", "exit 0"])
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(stubDir, "curl-args"))).toBe(false)
    expect(r.stdout).toContain("engine exited (code 0)")
  })

  it("engine 参数原样传递（含空格参数不经二次分词）", () => {
    ensureKeepAliveScript(home)
    const r = runScript(["wsZ", "printf", "%s", "a b"])
    expect(r.stdout.startsWith("a b")).toBe(true)
  })

  it("wrapEngineCommand 形状", () => {
    expect(wrapEngineCommand(home, "w1", ["cat"], { tabId: "t1", tmuxWindow: 2 })).toEqual([
      "/usr/bin/env", "COOLIE_WORKSPACE=w1", "COOLIE_TAB_ID=t1", "COOLIE_TMUX_WINDOW=2",
      "/bin/sh", keepAliveScriptPath(home), "w1", "cat",
    ])
  })
})
