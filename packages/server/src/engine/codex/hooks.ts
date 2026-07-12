import * as fs from "node:fs"
import * as path from "node:path"

/** codex 旁路观察事件（codex.md §6）：与 claude 旁路同集，映射 SessionStart→就绪、
 * UserPromptSubmit→turn-start、Stop→turn-complete。绝不含 PermissionRequest（决策 hook）。 */
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const

/** 幂等注入项目级 codex hooks（codex.md §6：<repo>/.codex/hooks.json，shape 同 claude settings.json）。
 * 先移除引用本脚本的旧条目再追加；用户自有 hooks 原样保留。 */
export const injectCodexHooks = (opts: {
  readonly worktreePath: string
  readonly workspaceId: string
  readonly scriptPath: string
}): void => {
  const dir = path.join(opts.worktreePath, ".codex")
  const file = path.join(dir, "hooks.json")
  fs.mkdirSync(dir, { recursive: true })
  let settings: any = {}
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")) } catch { /* 无文件/坏 JSON → 重建 */ }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) settings = {}
  if (typeof settings.hooks !== "object" || settings.hooks === null) settings.hooks = {}
  const command = `COOLIE_WORKSPACE=${opts.workspaceId} sh "${opts.scriptPath}"`
  for (const evt of CODEX_HOOK_EVENTS) {
    const entries: any[] = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : []
    const kept = entries.filter((e) => !JSON.stringify(e).includes(opts.scriptPath))
    kept.push({ hooks: [{ type: "command", command }] })
    settings.hooks[evt] = kept
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")
}
