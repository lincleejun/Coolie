import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as path from "node:path"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")

const EXPECTED_ENDPOINTS = [
  "DELETE /engines/custom/:id",
  "DELETE /projects/:id",
  "DELETE /workspaces/:id",
  "DELETE /workspaces/:id/checkpoints/:checkpointId",
  "DELETE /workspaces/:id/queue/:queueId",
  "DELETE /workspaces/:id/tabs/:tabId",
  "GET /clients",
  "GET /collect",
  "GET /config",
  "GET /engines/custom",
  "GET /events",
  "GET /events/stream",
  "GET /health",
  "GET /projects",
  "GET /projects/:id/worktrees/adoptable",
  "GET /workspaces",
  "GET /workspaces/:id",
  "GET /workspaces/:id/checkpoints",
  "GET /workspaces/:id/commands",
  "GET /workspaces/:id/files",
  "GET /workspaces/:id/git/changes",
  "GET /workspaces/:id/git/diff",
  "GET /workspaces/:id/git/diffstat",
  "GET /workspaces/:id/pr-instructions",
  "GET /workspaces/:id/queue",
  "GET /workspaces/:id/tabs",
  "GET /ws/terminal",
  "POST /attachments",
  "POST /collect",
  "POST /engines/custom",
  "POST /engines/custom/:id/detect",
  "POST /engines/custom/presets/copilot",
  "POST /hooks/:engine",
  "POST /hooks/engine-exit",
  "POST /notify/:engine",
  "POST /projects",
  "POST /projects/:id/worktrees/adopt",
  "POST /projects/clone",
  "POST /shutdown",
  "POST /workspaces",
  "POST /workspaces/:id/archive",
  "POST /workspaces/:id/attachments",
  "POST /workspaces/:id/branch",
  "POST /workspaces/:id/checkpoints",
  "POST /workspaces/:id/engine",
  "POST /workspaces/:id/ensure",
  "POST /workspaces/:id/finish",
  "POST /workspaces/:id/input",
  "POST /workspaces/:id/pin",
  "POST /workspaces/:id/rename",
  "POST /workspaces/:id/retry",
  "POST /workspaces/:id/tabs",
  "POST /workspaces/:id/tabs/:tabId/rename",
  "POST /workspaces/:id/tabs/:tabId/resume",
  "POST /workspaces/:id/task-status",
  "POST /workspaces/:id/unarchive",
  "POST /workspaces/:id/zen",
  "POST /workspaces/reorder",
] as const

describe("coolie api schema contract", () => {
  it("prints the complete compact public endpoint index", () => {
    const output = execFileSync(TSX, [CLI, "api", "schema"], { encoding: "utf8" })
    const endpoints = output.trim().split("\n").map((line) => {
      const match = /^(GET|POST|DELETE) (\S+)/.exec(line)
      expect(match, `bad schema row: ${line}`).not.toBeNull()
      return `${match![1]} ${match![2]}`
    })

    expect([...endpoints].sort()).toEqual(EXPECTED_ENDPOINTS)
    expect(output).toContain("POST /projects/clone")
    expect(output).toContain("GET /workspaces/:id/git/diff")
    expect(output).toContain("创建 engine/shell")
    expect(output).toContain("POST /workspaces/:id/pin")
  })

  it("documents the queue at-least-once DTO contract and CLI delivery help", () => {
    const schema = execFileSync(
      TSX,
      [CLI, "api", "schema", "--group", "workspaces", "--all"],
      { encoding: "utf8" },
    )
    expect(schema).toContain("SQLite queue 为 at-least-once")
    expect(schema).toContain("receipt 前 crash 可重投同一 messageId")
    expect(schema).toContain("response: {ok:true} | QueueAcceptedResponse")
    expect(schema).toContain("QueueListResponse {deliveryGuarantee:'at-least-once',queue:QueuedPromptDto[]}")
    expect(schema).toContain("id/queueId/messageId 标识同一消息")

    for (const command of ["send", "dispatch"]) {
      const help = execFileSync(TSX, [CLI, command, "--help"], { encoding: "utf8" })
      expect(help).toContain("at-least-once")
      expect(help).toContain("receipt 前 crash 可能重投")
    }
  })
})
