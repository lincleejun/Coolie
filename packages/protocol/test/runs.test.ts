import { describe, expect, it } from "vitest"
import {
  decodeProjectScriptDefinition,
  decodeRunInstanceRecord,
  decodeRunLogMetadata,
  validateProjectScriptInput,
  validateRunId,
} from "../src/runs.js"

describe("runs protocol", () => {
  it("validates named run ids", () => {
    expect(() => validateRunId("dev-server")).not.toThrow()
    expect(() => validateRunId("1bad")).toThrow()
    expect(() => validateRunId("bad id")).toThrow()
  })

  it("decodes project script definitions with explicit scope", () => {
    const script = decodeProjectScriptDefinition({
      id: "s1",
      projectId: "p1",
      runId: "dev-server",
      scriptType: "run",
      scope: "workspace",
      command: "npm",
      args: ["run", "dev"],
      createdAt: 1,
      updatedAt: 2,
    })
    expect(script.scope).toBe("workspace")
  })

  it("rejects setup scripts outside project scope", () => {
    expect(() => decodeProjectScriptDefinition({
      id: "s1",
      projectId: "p1",
      runId: "setup",
      scriptType: "setup",
      scope: "workspace",
      command: "./setup.sh",
      args: [],
      createdAt: 1,
      updatedAt: 2,
    })).toThrow(/project scope/)
  })

  it("rejects invalid command/args input", () => {
    expect(() => validateProjectScriptInput({
      runId: "dev-server",
      scriptType: "run",
      scope: "workspace",
      command: "   ",
      args: [],
    })).toThrow(/command/)
  })

  it("decodes run instances and log metadata for snapshot projection", () => {
    expect(decodeRunInstanceRecord({
      id: "r1",
      workspaceId: "w1",
      runId: "dev-server",
      scriptType: "run",
      status: "running",
      startedAt: 10,
      exitedAt: null,
      exitCode: null,
    }).status).toBe("running")

    expect(decodeRunLogMetadata({
      id: "log-1",
      runInstanceId: "r1",
      workspaceId: "w1",
      scriptType: "run",
      bytes: 128,
      truncated: false,
      updatedAt: 20,
    }).bytes).toBe(128)
  })
})
