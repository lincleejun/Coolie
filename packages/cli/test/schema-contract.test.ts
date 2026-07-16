import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as path from "node:path"
import { routeKeys } from "@coolie/protocol"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
const EXPECTED_ENDPOINTS = routeKeys()

const runCli = (args: string[]): { stdout: string; status: number; stderr: string } => {
  try {
    const stdout = execFileSync(TSX, [CLI, ...args], { encoding: "utf8" })
    return { stdout, status: 0, stderr: "" }
  } catch (error: any) {
    return {
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? error),
      status: Number(error.status ?? 1),
    }
  }
}

describe("coolie api schema contract", () => {
  it("prints the complete compact public endpoint index", () => {
    const output = runCli(["api", "schema"]).stdout
    const endpoints = output.trim().split("\n").map((line) => {
      const match = /^(GET|POST|DELETE) (\S+)/.exec(line)
      expect(match, `bad schema row: ${line}`).not.toBeNull()
      return `${match![1]} ${match![2]}`
    })

    expect([...endpoints].sort()).toEqual([...EXPECTED_ENDPOINTS].sort())
    expect(output).toContain("POST /projects/clone")
    expect(output).toContain("GET /projects/:id/branches")
    expect(output).toContain("GET /workspaces/:id/git/diff")
    expect(output).toContain("创建 engine/shell")
    expect(output).toContain("POST /workspaces/:id/pin")
  })

  it("emits parseable agent JSON with stable route documents", () => {
    const output = runCli(["api", "schema", "--json"]).stdout
    const schema = JSON.parse(output)
    expect(schema.version).toBe(1)
    expect(schema.groups).toEqual([
      "system",
      "projects",
      "events",
      "workspaces",
      "engines",
      "hooks",
      "terminal",
    ])
    expect(schema.verbs).toEqual(["GET", "POST", "DELETE"])
    const keys = schema.routes.map((route: { method: string; path: string }) => `${route.method} ${route.path}`)
    expect([...keys].sort()).toEqual([...EXPECTED_ENDPOINTS].sort())
    const input = schema.routes.find((route: { path: string }) => route.path === "/workspaces/:id/input")
    expect(input.idempotency).toContain("Idempotency-Key")
    expect(input.request).toContain("idempotencyKey")
    expect(input.errors).toContain("409 Conflict")
  })

  it("rejects unknown schema group and verb filters", () => {
    expect(runCli(["api", "schema", "--group", "ghost"]).status).not.toBe(0)
    expect(runCli(["api", "schema", "--group", "ghost"]).stderr).toContain("unknown schema group")
    expect(runCli(["api", "schema", "--verb", "PATCH"]).status).not.toBe(0)
    expect(runCli(["api", "schema", "--verb", "PATCH"]).stderr).toContain("unknown schema verb")
  })

  it("documents the queue at-least-once DTO contract and CLI delivery help", () => {
    const schema = runCli(["api", "schema", "--group", "workspaces", "--all"]).stdout
    expect(schema).toContain("SQLite queue 为 at-least-once")
    expect(schema).toContain("receipt 前 crash 可重投同一 messageId")
    expect(schema).toContain("response: {ok:true} | QueueAcceptedResponse")
    expect(schema).toContain("QueueListResponse {deliveryGuarantee:'at-least-once',queue:QueuedPromptDto[]}")
    expect(schema).toContain("id/queueId/messageId 标识同一消息")
    expect(schema).toContain("idempotency:")

    for (const command of ["send", "dispatch"]) {
      const help = runCli([command, "--help"]).stdout
      expect(help).toContain("at-least-once")
      expect(help).toContain("receipt 前 crash 可能重投")
    }
  })
})
