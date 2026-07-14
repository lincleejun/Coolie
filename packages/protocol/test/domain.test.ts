import { describe, it, expect } from "vitest"
import { decodeProject, decodeCoolieEvent, ApiErrorBody, ROUTES, decodeWorkspace, decodeTab, tmuxSessionName } from "@coolie/protocol"
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
      ownership: "adopted", pinned: false, createdAt: 1, archivedAt: null, portBase: 40000,
    }
    const w = decodeWorkspace(raw)
    expect(w.branch).toBe("coolie/fix-x")
    expect(w.ownership).toBe("adopted")
    expect(w.portBase).toBe(40000)
    expect(w.archivedAt).toBeNull()
  })
  it("decodes legacy Workspace payloads as managed", () => {
    const raw = {
      id: "w1", projectId: "p1", name: "legacy", path: "/tmp/ws",
      branch: "coolie/legacy", baseBranch: "main", baseRef: "abc123", status: "active",
      pinned: false, createdAt: 1, archivedAt: null, portBase: 40000,
    }
    expect(decodeWorkspace(raw).ownership).toBe("managed")
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
  it("round-trips a Tab", () => {
    const raw = {
      id: "t1", workspaceId: "w1", kind: "engine", engineId: "claude",
      engineSessionId: "3f0e8f7a-0000-4000-8000-000000000001", tmuxWindow: 0,
      title: null, status: "working", lastHookAt: null,
    }
    const t = decodeTab(raw)
    expect(t.kind).toBe("engine")
    expect(t.status).toBe("working")
    expect(t.tmuxWindow).toBe(0)
  })
  it("rejects a bad tab status", () => {
    expect(() => decodeTab({
      id: "t1", workspaceId: "w1", kind: "engine", engineId: null,
      engineSessionId: null, tmuxWindow: null, title: null, status: "busy", lastHookAt: null,
    })).toThrow()
  })
  it("tmuxSessionName is the single naming source", () => {
    expect(tmuxSessionName("01ABC")).toBe("coolie-01ABC")
  })
  it("ROUTES contains tabs/hooks/ws-terminal routes", () => {
    const paths = ROUTES.map(r => `${r.method} ${r.path}`)
    for (const p of ["GET /workspaces/:id/tabs", "POST /hooks/:engine", "GET /ws/terminal"])
      expect(paths).toContain(p)
  })
})
