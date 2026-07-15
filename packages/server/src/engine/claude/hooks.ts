import * as fs from "node:fs"
import * as path from "node:path"

// SessionStart：Plan3 Task15 修复——claude 会话就绪信号（TUI attach 前的冷启动窗口结束），
// 用于门控首条 prompt 投递（bootstrap 等它，而非只信一次画面稳定就投）。
export const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "Notification", "SessionEnd", "SessionStart"] as const

export const hookScriptPath = (home: string, engineId: string): string =>
  path.join(home, "hooks", `${engineId}-hook.sh`)

/** hook 转发脚本（kobe hook-cmd 三铁律：绝不拉起 server、失败静默、永远 exit 0）。
 * 按引擎生成：写 hooks/<engineId>-hook.sh、POST /hooks/<engineId>。每次启动重写：home 变化/脚本升级
 * 自动生效。token/port 运行时从 server.json 读，脚本本身不含密钥。 */
export const ensureHookScript = (home: string, engineId: string): string => {
  const p = hookScriptPath(home, engineId)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const script = `#!/bin/sh
# Coolie ${engineId} hook forwarder（自动生成，勿手改）。
INFO="${home}/server.json"
[ -f "$INFO" ] || exit 0
PORT=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$INFO")
TOKEN=$(sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' "$INFO")
[ -n "$PORT" ] && [ -n "$TOKEN" ] || exit 0
curl -s -m 2 -X POST "http://127.0.0.1:$PORT/hooks/${engineId}?workspace=$COOLIE_WORKSPACE&tabId=$COOLIE_TAB_ID&window=$COOLIE_TMUX_WINDOW" \\
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  --data-binary @- >/dev/null 2>&1
exit 0
`
  fs.writeFileSync(p, script, { mode: 0o755 })
  return p
}

export const hooksDisabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.COOLIE_DISABLE_HOOKS === "1"

/** 幂等注入 worktree 级 hooks（settings 层面）：
 * 先移除一切引用本脚本的旧条目再追加（wsId/脚本路径变更自动更新），用户自己的 hooks 原样保留。 */
export const injectClaudeHooks = (opts: {
  readonly worktreePath: string
  readonly workspaceId: string
  readonly scriptPath: string
}): void => {
  const dir = path.join(opts.worktreePath, ".claude")
  const file = path.join(dir, "settings.local.json")
  fs.mkdirSync(dir, { recursive: true })
  let settings: any = {}
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")) } catch { /* 无文件/坏 JSON → 重建 */ }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) settings = {}
  if (typeof settings.hooks !== "object" || settings.hooks === null) settings.hooks = {}
  const command = `COOLIE_WORKSPACE=${opts.workspaceId} sh "${opts.scriptPath}"`
  for (const evt of HOOK_EVENTS) {
    const entries: any[] = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : []
    const kept = entries.filter((e) => !JSON.stringify(e).includes(opts.scriptPath))
    kept.push({ hooks: [{ type: "command", command }] })
    settings.hooks[evt] = kept
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")
}
