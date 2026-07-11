import { describe, it, expect } from "vitest"
import { decodeProject, decodeCoolieEvent, ApiErrorBody, ROUTES, decodeWorkspace } from "@coolie/protocol"
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
  it("round-trips a CoolieEvent", () => {
    const raw = { seq: 1, workspaceId: null, type: "project.added", payload: { id: "p1" }, ts: 123 }
    const e = decodeCoolieEvent(raw)
    expect(e.type).toBe("project.added")
    expect(e.workspaceId).toBeNull()
  })
  it("rejects a bad CoolieEvent", () => {
    expect(() => decodeCoolieEvent({ seq: "x" })).toThrow()
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
  it("round-trips a Workspace", () => {
    const raw = {
      id: "w1", projectId: "p1", name: "usa-yellowstone", path: "/tmp/ws",
      branch: "coolie/fix-x", baseBranch: "main", baseRef: "abc123", status: "creating",
      pinned: false, createdAt: 1, archivedAt: null, portBase: 40000,
    }
    const w = decodeWorkspace(raw)
    expect(w.branch).toBe("coolie/fix-x")
    expect(w.portBase).toBe(40000)
    expect(w.archivedAt).toBeNull()
  })
  it("rejects a bad workspace status", () => {
    expect(() => decodeWorkspace({
      id: "w1", projectId: "p1", name: "n", path: "/p", branch: "b",
      baseBranch: "main", baseRef: "r", status: "nope",
      pinned: false, createdAt: 1, archivedAt: null, portBase: 0,
    })).toThrow()
  })
  it("ROUTES contains workspace lifecycle + SSE routes", () => {
    const paths = ROUTES.map(r => `${r.method} ${r.path}`)
    for (const p of [
      "GET /workspaces", "POST /workspaces",
      "POST /workspaces/:id/archive", "POST /workspaces/:id/unarchive",
      "POST /workspaces/:id/retry", "DELETE /workspaces/:id",
      "GET /events/stream",
    ]) expect(paths).toContain(p)
  })
})
