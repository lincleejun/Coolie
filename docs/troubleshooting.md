# Troubleshooting Coolie 0.1.0

## Doctor

From a contributor checkout (CLI package):

```bash
bun run --cwd packages/cli start -- doctor
# or, once on PATH after linking:
coolie doctor
```

Doctor reports Git/tmux/engine availability and basic daemon reachability without mutating real engine homes.

## Logs & data paths

| Item | Default location |
|---|---|
| Coolie home | `~/.coolie` (`COOLIE_HOME`) |
| SQLite DB | `~/.coolie/coolie.db` |
| Daemon listen info | `~/.coolie/server.json` |
| Workspaces | `~/coolie/workspaces` (`COOLIE_WORKSPACES_ROOT`) |
| tmux socket | `tmux -L coolie` (`COOLIE_TMUX_SOCKET`) |

GUI failure artifacts from WebdriverIO runs land under `packages/client/e2e/tauri/artifacts/` (screenshots, logs, junit).

## Gatekeeper blocks launch

Expected for unsigned 0.1.0 builds. Right-click → Open, or clear quarantine after checksum verification:

```bash
xattr -dr com.apple.quarantine /Applications/Coolie.app
```

See [installation.md](./installation.md) and [security.md](./security.md).

## Daemon will not start

1. Confirm `git` and `tmux` are on `PATH`.
2. Remove a stale `server.json` only if no daemon process is alive (`coolie server status` / check the pid).
3. For contributor builds, ensure native modules match Node 22.22.3 (`COOLIE_SIDECAR_NODE`).
4. Check that another Coolie daemon is not already bound to the same home.

## Terminal / PTY issues

- Sidecar must load `node-pty` from the app bundle — never Bun as the server runtime.
- External terminal open only supports Terminal.app / iTerm2 / WezTerm with the exact tmux attach command Coolie generates.

## Worktree / archive surprises

- Finish (PR/merge-back) does **not** delete the worktree; use Archive explicitly.
- Archive keeps the branch; Unarchive rebuilds from that branch.
- Adopted external worktrees are never deleted by Coolie archive/delete.

## Backing up before reset

```bash
cp ~/.coolie/coolie.db ~/Desktop/coolie.db.backup
```

`coolie server reset` clears runtime + Coolie tmux socket but keeps the DB/worktrees/branches — still back up if unsure.
