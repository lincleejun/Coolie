import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as http from "node:http"
import { Effect, Layer } from "effect"
import { Workspace } from "@coolie/protocol"
import { createApp, newToken } from "../src/http/app.js"
import { WorkspaceAdopter } from "../src/workspace/adopt.js"
import { WorkspaceFinisher } from "../src/workspace/finish.js"
import { WorkspacesRepo } from "../src/repo/workspaces.js"

let server: http.Server
let base: string
let token: string
const calls: any[] = []
const workspace = new Workspace({
  id: "ws1", projectId: "p1", name: "adopted", path: "/repo-wt", branch: "feature/x",
  baseBranch: "main", baseRef: "abc", status: "active", pinned: false,
  createdAt: 1, archivedAt: null, portBase: 40000,
})

beforeEach(async () => {
  calls.length = 0
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceAdopter, {
      list: (projectId: string) => Effect.sync(() => {
        calls.push(["list", projectId])
        return [{ path: "/repo-wt", branch: "feature/x", head: "abc" }]
      }),
      adopt: (request: any) => Effect.sync(() => { calls.push(["adopt", request]); return workspace }),
    }),
    Layer.succeed(WorkspaceFinisher, {
      finish: (id: string, request: any) => Effect.sync(() => {
        calls.push(["finish", id, request])
        return { mergedBack: false, prUrl: "https://example.test/pr/1", warnings: [] }
      }),
    }),
    Layer.succeed(WorkspacesRepo, {
      get: (id: string) => Effect.sync(() => {
        if (id !== workspace.id) throw new Error(`unexpected workspace ${id}`)
        return workspace
      }),
    } as any),
  )
  token = newToken()
  server = http.createServer(createApp({
    runtime: (effect) => Effect.runPromiseExit(Effect.provide(effect, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => server.close())

const request = (url: string, method: "GET" | "POST", body?: unknown) =>
  fetch(base + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

describe("adopt/finish HTTP routes", () => {
  it("wires discovery and exact-path adoption", async () => {
    const listed = await request("/projects/p1/worktrees/adoptable", "GET")
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([{ path: "/repo-wt", branch: "feature/x", head: "abc" }])
    const adopted = await request("/projects/p1/worktrees/adopt", "POST", { path: "/repo-wt", name: "adopted" })
    expect(adopted.status).toBe(201)
    expect(calls).toContainEqual(["adopt", { projectId: "p1", path: "/repo-wt", name: "adopted" }])
  })

  it("validates finish body and returns the typed outcome", async () => {
    expect((await request("/workspaces/ws1/finish", "POST", { createPr: "yes" })).status).toBe(400)
    const finished = await request("/workspaces/ws1/finish", "POST", { createPr: true, title: "Ship" })
    expect(finished.status).toBe(200)
    expect(await finished.json()).toMatchObject({ prUrl: "https://example.test/pr/1", mergedBack: false })
    expect(calls).toContainEqual(["finish", "ws1", { createPr: true, title: "Ship" }])
  })
})
