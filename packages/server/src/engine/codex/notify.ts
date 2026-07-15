import * as fs from "node:fs"
import * as path from "node:path"

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** Codex notify 转发器：不拉起 server、失败静默、始终 exit 0。 */
export const ensureNotifyScript = (home: string, engineId: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(engineId)) throw new Error(`invalid engine id: ${engineId}`)
  const scriptPath = path.join(home, "hooks", `${engineId}-notify.sh`)
  const infoPath = shellSingleQuote(path.join(home, "server.json"))
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  const script = `#!/bin/sh
# Coolie ${engineId} notify forwarder (generated).
WS="$1"
if [ "$#" -ge 4 ]; then
  TAB="$2"; WINDOW="$3"; JSON="$4"
else
  TAB=""; WINDOW=""; JSON="$2"
fi
INFO=${infoPath}

# Workspace is interpolated into a URL, so only Coolie's identifier alphabet is accepted.
case "$WS" in ""|*[!A-Za-z0-9_-]*) exit 0 ;; esac
[ -f "$INFO" ] || exit 0

# Parse the payload rather than substring-matching: only Codex turn completion is forwarded.
node -e 'try { const e=JSON.parse(process.argv[1]); process.exit(e && e.type === "agent-turn-complete" ? 0 : 1) } catch { process.exit(1) }' "$JSON" >/dev/null 2>&1 || exit 0

PORT=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$INFO")
TOKEN=$(sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' "$INFO")
[ -n "$PORT" ] && [ -n "$TOKEN" ] || exit 0

curl -s -m 2 -X POST "http://127.0.0.1:$PORT/notify/${engineId}?workspace=$WS&tabId=$TAB&window=$WINDOW" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "content-type: application/json" \\
  --data-binary "$JSON" >/dev/null 2>&1
exit 0
`
  fs.writeFileSync(scriptPath, script, { mode: 0o755 })
  fs.chmodSync(scriptPath, 0o755)
  return scriptPath
}
