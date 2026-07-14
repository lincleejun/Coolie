import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as http from "node:http"
import { Effect, Layer } from "effect"
import { createApp, newToken } from "../src/http/app.js"
import { WorkspaceCheckpoints, type Checkpoint } from "../src/workspace/checkpoint.js"

let server: http.Server
let base: string
let token: string
const calls: unknown[][] = []
const checkpoint: Checkpoint = {
  workspaceId: "ws1",
  checkpointId: "cp1",
  ref: "refs/coolie-checkpoints/ws1/cp1",
  oid: "abc123",
  label: "safe point",
  createdAt: 123,
}

beforeEach(async () => {
  calls.length = 0
  const layer = Layer.succeed(WorkspaceCheckpoints, {
    create: (workspaceId: string, label?: string) =>
      Effect.sync(() => { calls.push(["create", workspaceId, label]); return checkpoint }),
    list: (workspaceId: string) =>
      Effect.sync(() => { calls.push(["list", workspaceId]); return [checkpoint] }),
    delete: (workspaceId: string, checkpointId: string) =>
      Effect.sync(() => { calls.push(["delete", workspaceId, checkpointId]) }),
  })
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

const request = (url: string, method: "GET" | "POST" | "DELETE", body?: unknown) =>
  fetch(base + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

describe("checkpoint HTTP routes", () => {
  it("creates and lists checkpoints with ref and oid for manual diff", async () => {
    const created = await request("/workspaces/ws1/checkpoints", "POST", { label: "safe point" })
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual(checkpoint)
    const listed = await request("/workspaces/ws1/checkpoints", "GET")
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([checkpoint])
    expect(calls).toEqual([["create", "ws1", "safe point"], ["list", "ws1"]])
  })

  it("validates create bodies before invoking the service", async () => {
    expect((await request("/workspaces/ws1/checkpoints", "POST", { label: 42 })).status).toBe(400)
    expect((await request("/workspaces/ws1/checkpoints", "POST", { label: "bad\nlabel" })).status).toBe(400)
    expect(calls).toEqual([])
  })

  it("deletes a checkpoint scoped to its workspace", async () => {
    const deleted = await request("/workspaces/ws1/checkpoints/cp1", "DELETE")
    expect(deleted.status).toBe(204)
    expect(calls).toEqual([["delete", "ws1", "cp1"]])
  })
})
