import { describe, it, expect } from "vitest"
import { decodeProject, ApiErrorBody, ROUTES } from "@coolie/protocol"
import { Schema } from "effect"

describe("protocol domain", () => {
  it("round-trips a Project", () => {
    const raw = { id: "p1", name: "Coolie", repoRoot: "/tmp/x", defaultBaseBranch: "main", createdAt: 1 }
    const p = decodeProject(raw)
    expect(p.name).toBe("Coolie")
  })
  it("rejects a bad Project", () => {
    expect(() => decodeProject({ id: 1 })).toThrow()
  })
  it("ApiErrorBody accepts known codes only", () => {
    const dec = Schema.decodeUnknownSync(ApiErrorBody)
    expect(dec({ code: "NotFound", message: "x" }).code).toBe("NotFound")
    expect(() => dec({ code: "Nope", message: "x" })).toThrow()
  })
  it("ROUTES contains health and projects", () => {
    const paths = ROUTES.map(r => `${r.method} ${r.path}`)
    expect(paths).toContain("GET /health")
    expect(paths).toContain("POST /projects")
  })
})
