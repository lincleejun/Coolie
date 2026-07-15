import * as fs from "node:fs"
import * as path from "node:path"

export const keepAliveScriptPath = (home: string): string => path.join(home, "hooks", "coolie-keepalive.sh")

/**
 * engine keep-alive 包装（设计文档 §十）：engine 退出后 pane 不塌——
 * 回报 server（best-effort，hook-cmd 三铁律：绝不拉起 server、失败静默、绝不带走 pane）→
 * 打印横幅 → exec 交互 shell（布局保留、pane pid 不变）。
 * 每次 server 启动重写（home/版本变更自动生效）；token/port 运行时从 server.json 读，脚本不含密钥。
 */
export const ensureKeepAliveScript = (home: string): string => {
  const p = keepAliveScriptPath(home)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const script = `#!/bin/sh
# Coolie engine keep-alive 包装（自动生成，勿手改）。
# 用法：coolie-keepalive.sh <workspaceId> <engine command...>
WS="$1"; shift
# Keep the wrapper alive when the foreground engine receives SIGINT. External
# commands reset caught traps to their default disposition on exec, so Ctrl-C
# still reaches the engine; Coolie's intentional interrupt API sends Escape.
trap ':' INT
"$@"
CODE=$?
trap - INT
INFO="${home}/server.json"
if [ -f "$INFO" ]; then
  PORT=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$INFO")
  TOKEN=$(sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' "$INFO")
  if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
    curl -s -m 2 -X POST "http://127.0.0.1:$PORT/hooks/engine-exit?workspace=$WS&tabId=$COOLIE_TAB_ID&window=$COOLIE_TMUX_WINDOW" \\
      -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
      --data "{\\"exitCode\\":$CODE}" >/dev/null 2>&1
  fi
fi
printf '\\n[coolie] engine exited (code %s) — GUI Resume 按钮或 coolie resume %s 重启\\n' "$CODE" "$WS"
exec "\${SHELL:-/bin/sh}"
`
  fs.writeFileSync(p, script, { mode: 0o755 })
  return p
}

/** engine 命令 → window 0 实际运行的包装命令。 */
export const wrapEngineCommand = (
  home: string,
  wsId: string,
  engineCmd: readonly string[],
  context?: { readonly tabId?: string; readonly tmuxWindow?: number },
): string[] => [
  "/usr/bin/env",
  `COOLIE_WORKSPACE=${wsId}`,
  ...(context?.tabId ? [`COOLIE_TAB_ID=${context.tabId}`] : []),
  ...(context?.tmuxWindow !== undefined ? [`COOLIE_TMUX_WINDOW=${context.tmuxWindow}`] : []),
  "/bin/sh", keepAliveScriptPath(home), wsId, ...engineCmd,
]
