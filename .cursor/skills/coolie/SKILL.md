---
name: coolie
description: Discover and safely operate Coolie tasks, worktrees, agents, and local API.
---

# Coolie

Use Coolie when work should run in an isolated task worktree or when coordinating an existing Coolie task. Treat the CLI and its discovered API schema as the source of truth.

## Start with discovery

1. Run `coolie api schema` for the compact endpoint index.
2. Narrow it with `coolie api schema --group workspaces` or `--verb POST`.
3. Before using an unfamiliar mutation, run the narrowed command with `--all` to inspect request/response shapes and examples.
4. Run `coolie list`, `coolie get TASK_ID`, or `coolie collect TASK_ID` before choosing a target.

Do not guess endpoint paths, task IDs, status values, or request fields.

## Common task workflow

- Create: `coolie create PROJECT_PATH --name NAME --prompt PROMPT`
- Materialize or heal: `coolie ensure-worktree TASK_ID`
- Inspect: `coolie get TASK_ID`
- Compare runtime, diff, PR, and transcript state: `coolie collect TASK_ID`
- Send one prompt: `coolie send TASK_ID 'PROMPT'`
- Route dispatcher work: `coolie dispatch TASK_ID 'PROMPT'`
- Rename metadata: `coolie rename TASK_ID NAME`
- Set task status: `coolie set-status TASK_ID in_review`
- Rename its branch safely: `coolie set-branch TASK_ID BRANCH`
- Finish: `coolie finish TASK_ID --create-pr`
- Archive only when work should leave the active list: `coolie archive TASK_ID`

Valid task statuses are `backlog`, `in_progress`, `in_review`, `done`, `canceled`, and `error`.

## Safety rules

- Prefer the CLI over direct database, git-worktree, tmux, or process manipulation.
- Pass arguments as distinct argv values. Never build shell command strings from task data.
- Read state before mutation, and use the exact task ID returned by Coolie.
- Do not remove a worktree or branch manually. Use `archive`, `delete`, or the documented API.
- `coolie server reset` only resets runtime state and Coolie's dedicated tmux socket; it intentionally preserves the database, worktrees, and branches.
- `coolie update` is read-only and never installs software.
- Preserve queued prompts: use normal `send`; use `--interrupt` only when interruption is intended.
- If offline or the daemon is unavailable, report the failure. Do not bypass Coolie's state machine with ad-hoc writes.

## API use

Use direct API routes only when the CLI lacks the required composition. Discover the route first:

```sh
coolie api schema --group workspaces --all
```

Authenticate through Coolie's supported client path; never print or persist the daemon bearer token. Keep polling fallback behavior unless the caller explicitly owns a live event subscription.

## Runtime administration

- `coolie server status`
- `coolie server start`
- `coolie server restart`
- `coolie server stop`
- `coolie server reset`

Reset is not a project cleanup command. Never pair it with deleting `coolie.db`, repositories, branches, or worktrees.
