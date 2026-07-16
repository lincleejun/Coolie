import { describe, expect, it } from "vitest"
import { HANDLER_ROUTES } from "../../server/src/http/handler-routes.js"
import {
  ROUTES,
  routeKeys,
  validateRouteFilter,
  RouteFilterError,
  buildAgentApiSchema,
} from "../src/routes.js"

export const EXPECTED_PUBLIC_ENDPOINTS = [
  "DELETE /engines/custom/:id",
  "DELETE /projects/:id",
  "DELETE /workspaces/:id",
  "DELETE /workspaces/:id/checkpoints/:checkpointId",
  "DELETE /workspaces/:id/queue/:queueId",
  "DELETE /workspaces/:id/tabs/:tabId",
  "GET /attention",
  "GET /attention/:id",
  "GET /clients",
  "GET /collect",
  "GET /config",
  "GET /engines/custom",
  "GET /events",
  "GET /events/stream",
  "GET /health",
  "GET /projects",
  "GET /projects/:id/branches",
  "GET /projects/:id/environment/preview",
  "GET /projects/:id/worktrees/adoptable",
  "GET /state",
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
  "GET /workspaces/:id/runs",
  "GET /workspaces/:id/runs/:runId/log",
  "GET /workspaces/:id/tabs",
  "GET /workspaces/:id/tabs/:tabId/transcript",
  "GET /ws/terminal",
  "POST /attachments",
  "POST /attention/:id/ack",
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
  "POST /workspaces/:id/environment/recopy",
  "POST /workspaces/:id/finish",
  "POST /workspaces/:id/input",
  "POST /workspaces/:id/pin",
  "POST /workspaces/:id/rename",
  "POST /workspaces/:id/retry",
  "POST /workspaces/:id/runs/:runId/start",
  "POST /workspaces/:id/runs/:runId/stop",
  "POST /workspaces/:id/tabs",
  "POST /workspaces/:id/tabs/:tabId/rename",
  "POST /workspaces/:id/tabs/:tabId/resume",
  "POST /workspaces/:id/task-status",
  "POST /workspaces/:id/unarchive",
  "POST /workspaces/:id/zen",
  "POST /workspaces/reorder",
] as const

const handlerKeys = (): string[] =>
  HANDLER_ROUTES.map(({ method, path }) => `${method} ${path}`)

describe("public route contract", () => {
  it("indexes the complete HTTP and WebSocket endpoint set exactly once", () => {
    const actual = routeKeys()
    expect(new Set(actual).size).toBe(actual.length)
    expect([...actual].sort()).toEqual(EXPECTED_PUBLIC_ENDPOINTS)
  })

  it("matches every HTTP handler template without ghost routes", () => {
    const schemaKeys = [...routeKeys()].sort()
    const handlers = [...handlerKeys()].sort()
    expect(schemaKeys).toEqual(handlers)
  })

  it("uses one template row for each dynamic hook family", () => {
    const paths = ROUTES.map(({ method, path }) => `${method} ${path}`)
    expect(paths.filter((route) => route.startsWith("POST /hooks/"))).toEqual([
      "POST /hooks/:engine",
      "POST /hooks/engine-exit",
    ])
    expect(paths.filter((route) => route.startsWith("POST /notify/"))).toEqual([
      "POST /notify/:engine",
    ])
  })

  it("rejects unknown schema filters", () => {
    expect(() => validateRouteFilter({ group: "ghost" })).toThrow(RouteFilterError)
    expect(() => validateRouteFilter({ verb: "PATCH" })).toThrow(RouteFilterError)
  })

  it("builds agent JSON documents with explicit request/response metadata", () => {
    const schema = buildAgentApiSchema()
    expect(schema.version).toBe(1)
    expect(schema.routes).toHaveLength(ROUTES.length)
    const input = schema.routes.find((route) => route.path === "/workspaces/:id/input")
    expect(input?.idempotency).toContain("Idempotency-Key")
    expect(input?.request).toContain("idempotencyKey")
    const state = schema.routes.find((route) => route.path === "/state")
    expect(state?.request).toBe("query: workspace?")
    expect(state?.response).toContain("CoolieStateSnapshot")
    expect(new Set(schema.routes.map((route) => route.name)).size).toBe(schema.routes.length)
  })
})
