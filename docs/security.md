# Security notes — Coolie 0.1.0

## Unsigned artifact

0.1.0 release builds are **not** Apple-signed or notarized. macOS Gatekeeper will warn on first open. Only install artifacts whose checksum you verified from a trusted CI run. Signing/notarization/auto-update remain explicitly excluded from 0.1.0.

## No App Sandbox

The desktop app runs **without** the macOS App Sandbox and without Hardened Runtime entitlements required for Mac App Store distribution. The daemon must:

- spawn `tmux` and engine CLIs
- create git worktrees under your chosen workspaces root
- open an external terminal/editor via a narrow allowlist

Treat Coolie like other local developer tools (IDEs, agent CLIs): it has broad filesystem access to the projects you add.

## Daemon trust boundary

- The GUI discovers the local daemon via `~/.coolie/server.json` (or `COOLIE_HOME`).
- HTTP/WS traffic is loopback-only with a bearer token written to `server.json`.
- The GUI process and daemon process use separate process groups: quitting the app does **not** kill running engine sessions in tmux.

## Sidecar runtime

Release builds launch a **pinned Node.js 22.22.3** binary bundled inside the app (`Contents/Resources/sidecar/`), plus `server.cjs` and audited native addons (`better-sqlite3`, `node-pty`). The app does not search your `PATH` for Node or `tsx`.

Every sidecar file is listed in `sidecar/manifest.json` with SHA-256 digests. Treat Node, JS, and native addons as one atomic release unit.

## Native command allowlists

Renderer code cannot spawn arbitrary executables. Tauri commands only allow:

- fixed external terminal adapters (`terminal`, `iterm2`, `wezterm`) with a strict `tmux -L … attach -t coolie-…` argv shape
- editor launch via structured argv (`COOLIE_EDITOR_JSON`) against a path confined to the workspace realpath
- `binary_on_path` probes for known dependency names

## Data locations & backups

| Path | Contents |
|---|---|
| `$COOLIE_HOME` (default `~/.coolie`) | SQLite DB, `server.json`, runtime logs |
| `$COOLIE_WORKSPACES_ROOT` | Managed worktrees |
| Engine homes under Coolie isolation | Hook scripts / session metadata |

Back up `coolie.db` before destructive experiments. Archive removes managed worktrees but keeps branches; delete never removes remote branches by itself.

## 0.1.0 exclusions (not implemented)

Do not expect or rely on:

- code signing / notarization / auto-update
- GitHub review-comment sync
- GitHub Issue/PR import into Coolie
- Notes / `.context` product surface
- checkpoint restore / turn rewind
- cloud/remote/team multiplayer
- Hosted PTY migration
- self-rendered agent chat (Coolie embeds engine TUIs)

## Reporting issues

Prefer `coolie doctor` output and daemon logs from `~/.coolie` (see [troubleshooting.md](./troubleshooting.md)). Never attach real `server.json` tokens to public issues — redact bearer tokens first.
