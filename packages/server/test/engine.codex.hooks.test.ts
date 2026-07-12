import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { injectCodexHooks, CODEX_HOOK_EVENTS } from "../src/engine/codex/hooks.js"

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cxh-"))

describe("injectCodexHooks", () => {
  it("写 .codex/hooks.json，覆盖旁路事件、绝不挂 PermissionRequest", () => {
    const wt = mkTmp()
    injectCodexHooks({ worktreePath: wt, workspaceId: "ws1", scriptPath: "/s/codex-hook.sh" })
    const j = JSON.parse(fs.readFileSync(path.join(wt, ".codex", "hooks.json"), "utf8"))
    for (const e of CODEX_HOOK_EVENTS) expect(Array.isArray(j.hooks[e])).toBe(true)
    expect(j.hooks.PermissionRequest).toBeUndefined()
    expect(JSON.stringify(j)).toContain("/s/codex-hook.sh")
    expect(JSON.stringify(j)).toContain("COOLIE_WORKSPACE=ws1")
  })
  it("幂等：重跑不重复本脚本条目，保留用户 hooks", () => {
    const wt = mkTmp()
    const dir = path.join(wt, ".codex"); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user-own.sh" }] }] } }))
    injectCodexHooks({ worktreePath: wt, workspaceId: "ws1", scriptPath: "/s/codex-hook.sh" })
    injectCodexHooks({ worktreePath: wt, workspaceId: "ws1", scriptPath: "/s/codex-hook.sh" })
    const j = JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8"))
    const stopCmds = JSON.stringify(j.hooks.Stop)
    expect(stopCmds).toContain("user-own.sh")                 // 用户条目保留
    expect(stopCmds.split("/s/codex-hook.sh").length - 1).toBe(1) // 本脚本不重复
  })
})
