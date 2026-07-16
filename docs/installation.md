# Installing Coolie 0.1.0

Coolie 0.1.0 ships as an **unsigned** macOS `.app` / `.dmg` for Apple Silicon and Intel Macs (build the slice that matches your machine). Signing, notarization, and auto-update are **out of scope** for 0.1.0.

## System requirements

- macOS 12 or newer
- [Git](https://git-scm.com/)
- [tmux](https://github.com/tmux/tmux/wiki)
- At least one coding-agent CLI you intend to use (`claude`, `codex`, and/or `copilot`)
- Optional: [GitHub CLI](https://cli.github.com/) (`gh`) for PR creation

Coolie does **not** require a Coolie account. It does **not** bundle `tmux`, Git, or engine CLIs — only its own Node-based server sidecar.

## Install from CI artifact

1. Download the `.dmg` or `.app` zip from the release-artifact workflow.
2. Open the DMG (or unzip) and drag **Coolie.app** to `/Applications` or any folder you prefer.
3. First launch will be blocked by Gatekeeper because the build is unsigned. Use one of:

```bash
# Finder: Right-click Coolie.app → Open → Open
# or clear the quarantine flag after you have verified the checksum:
xattr -dr com.apple.quarantine /Applications/Coolie.app
```

4. Verify the published SHA-256 against the workflow checksum file before clearing quarantine.

## What gets installed on disk

| Path | Purpose |
|---|---|
| `Coolie.app` | GUI + bundled `sidecar/` (pinned Node + server) |
| `~/.coolie/` | Daemon state, SQLite DB, `server.json`, logs |
| `~/coolie/workspaces/` | Managed git worktrees (override with `COOLIE_WORKSPACES_ROOT`) |

Real user homes for Claude/Codex remain separate; Coolie isolates engine homes under the Coolie data dir unless you opt into shared homes.

## Development install (contributors)

```bash
bun install
export COOLIE_SIDECAR_NODE=/absolute/path/to/node-v22.22.3/bin/node
PATH="$(dirname "$COOLIE_SIDECAR_NODE"):$PATH" bun install --frozen-lockfile
bun run typecheck
bun run test:fast
```

See [troubleshooting.md](./troubleshooting.md) for doctor/logs and [security.md](./security.md) for sandbox/unsigned notes.

## Upgrading

0.1.0 has no auto-updater. Replace the `.app` atomically (quit Coolie first). Your `~/.coolie` database migrates on next daemon start. Keep a backup of `~/.coolie/coolie.db` before major upgrades.
