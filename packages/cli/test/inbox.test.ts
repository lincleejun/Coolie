import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { decodeAttentionItem } from "@coolie/protocol"
import { runtimeTmuxKillSessions } from "./helpers/runtime-env.js"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
const TMUX_SOCK = process.env.COOLIE_TMUX_SOCKET!

let home: string
let repo: string
let workspaceId = ""

const coolie = (...args: string[]) =>
  execFileSync(TSX, [CLI, ...args], {
    env: {
      ...process.env,
      COOLIE_HOME: home,
      COOLIE_TMUX_SOCKET: TMUX_SOCK,
      COOLIE_CLAUDE_CMD: "cat",
      COOLIE_DISABLE_HOOKS: "1",
      COOLIE_CLAUDE_HOME: path.join(home, "claude-home"),
      COOLIE_CLAUDE_CONFIG: path.join(home, "claude.json"),
      COOLIE_CODEX_CMD: "cat",
      COOLIE_CODEX_HOME: path.join(home, "codex-home"),
      COOLIE_CODEX_CONFIG: path.join(home, "codex-config.toml"),
    },
    encoding: "utf8",
  })

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-inbox-cli-"))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-inbox-cli-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repo })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo })
  coolie("project", "add", repo)
  coolie("create", repo, "--name", "inbox-cli", "--engine", "claude", "--prompt", "noop")
  const db = new Database(path.join(home, "coolie.db"), { readonly: true })
  workspaceId = (db.prepare("SELECT id FROM workspaces WHERE kind = 'task' LIMIT 1").get() as { id: string }).id
  db.close()
}, 60_000)

afterAll(() => {
  try { coolie("server", "stop") } catch {}
  runtimeTmuxKillSessions()
})

describe("coolie inbox CLI (Task 2A.4)", () => {
  it("lists and acks attention items across daemon restart", () => {
    const db = new Database(path.join(home, "coolie.db"))
    const tabId = (db.prepare("SELECT id FROM tabs WHERE workspace_id = ? LIMIT 1").get(workspaceId) as { id: string }).id
    const eventSeq = Number(db.prepare(`INSERT INTO events (workspace_id, type, payload, ts) VALUES (?, 'attention.test', '{}', 99)`).run(workspaceId).lastInsertRowid)
    db.prepare(`INSERT INTO attention_items
      (id, workspace_id, tab_id, kind, source, source_event_seq, session_turn_id, summary, state, created_at, acknowledged_at)
      VALUES ('attn1', ?, ?, 'turn-finished', 'hook', ?, 'sess-1', 'Needs you', 'open', 1, NULL)`).run(workspaceId, tabId, eventSeq)
    db.close()

    const listed = JSON.parse(coolie("inbox", "list", "--workspace", workspaceId))
    expect(listed).toHaveLength(1)
    expect(decodeAttentionItem(listed[0]).id).toBe("attn1")

    coolie("server", "restart")
    const acked = decodeAttentionItem(JSON.parse(coolie("inbox", "ack", "attn1")))
    expect(acked.state).toBe("acknowledged")

    const after = JSON.parse(coolie("inbox", "list", "--workspace", workspaceId, "--state", "open"))
    expect(after).toEqual([])
  })
})
