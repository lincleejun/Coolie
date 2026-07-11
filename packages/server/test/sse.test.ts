import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import { EventEmitter } from "node:events"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { EventsRepo, EventsRepoLive } from "../src/repo/events.js"
import { EventsBus } from "../src/events/bus.js"
import { createApp, newToken } from "../src/http/app.js"

let server: http.Server, base: string, token: string, bus: EventEmitter
let append: (workspaceId: string | null, type: string) => Promise<unknown>

beforeEach(async () => {
  const db = new Database(":memory:"); runMigrations(db)
  bus = new EventEmitter()
  const layer = EventsRepoLive.pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(EventsBus, bus))),
  )
  const runtime = (eff: Effect.Effect<any, any, any>) =>
    Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, any, never>)
  append = (workspaceId, type) =>
    runtime(Effect.gen(function* () {
      return yield* (yield* EventsRepo).append({ workspaceId, type, payload: { t: type } })
    }))
  token = newToken()
  const app = createApp({
    runtime, token, onShutdown: () => {},
    bus, sseHeartbeatMs: 60,
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => server.close())

const connect = async (qs: string, ac: AbortController) => {
  const res = await fetch(`${base}/events/stream${qs}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: ac.signal,
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  return res.body!.getReader()
}
const readUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>, pred: (buf: string) => boolean, timeoutMs = 5000,
): Promise<string> => {
  let buf = ""
  const t0 = Date.now()
  const dec = new TextDecoder()
  while (!pred(buf)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`SSE read timeout; got: ${JSON.stringify(buf)}`)
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value)
  }
  return buf
}
// 容忍半截 chunk：最后一行可能是被截断的 data 行，parse 失败就先跳过（下一轮读齐再算）
const dataEvents = (buf: string): any[] =>
  buf.split("\n").filter((l) => l.startsWith("data: ")).flatMap((l) => {
    try { return [JSON.parse(l.slice(6))] } catch { return [] }
  })

describe("GET /events/stream", () => {
  it("requires a token", async () => {
    const r = await fetch(`${base}/events/stream?after=0`)
    expect(r.status).toBe(401)
  })
  it("replays history from ?after= then pushes live events", async () => {
    await append("w1", "workspace.creating") // 连接前：走 replay
    const ac = new AbortController()
    const reader = await connect("?after=0", ac)
    let buf = await readUntil(reader, (b) => dataEvents(b).length >= 1)
    expect(dataEvents(buf)[0].type).toBe("workspace.creating")
    await append("w1", "workspace.created") // 连接后：走 live
    buf += await readUntil(reader, (b) => dataEvents(buf + b).length >= 2)
    const all = dataEvents(buf)
    expect(all.map((e) => e.type)).toEqual(["workspace.creating", "workspace.created"])
    expect(all[1].seq).toBeGreaterThan(all[0].seq)
    ac.abort()
  })
  it("filters by ?workspace= (replay path)", async () => {
    await append("w1", "a.w1")
    await append("w2", "b.w2")
    const ac = new AbortController()
    const reader = await connect("?after=0&workspace=w2", ac)
    const buf = await readUntil(reader, (b) => dataEvents(b).length >= 1)
    const all = dataEvents(buf)
    expect(all).toHaveLength(1)
    expect(all[0].type).toBe("b.w2")
    ac.abort()
  })
  it("filters by ?workspace= (live path)", async () => {
    // connect with no pre-existing events so replay is minimal
    const ac = new AbortController()
    const reader = await connect("?after=0&workspace=w1", ac)
    // read until replay is done (heartbeat or minimal initial data)
    let buf = await readUntil(reader, (b) => b.includes(":hb") || b.includes(":ok\n\n"))
    // after connection is live, append events for w2 and w1
    await append("w2", "b.w2")
    await append("w1", "a.w1")
    // read until the w1 event arrives
    buf += await readUntil(reader, (b) => dataEvents(buf + b).some((e) => e.type === "a.w1"))
    const all = dataEvents(buf)
    const types = all.map((e) => e.type)
    expect(types).toContain("a.w1")
    expect(types).not.toContain("b.w2")
    ac.abort()
  })
  it("sends heartbeat comments", async () => {
    const ac = new AbortController()
    const reader = await connect("?after=0", ac)
    const buf = await readUntil(reader, (b) => b.includes(":hb"))
    expect(buf).toContain(":hb")
    ac.abort()
  })
  it("cleans up bus listener on disconnect", async () => {
    const ac = new AbortController()
    const reader = await connect("?after=0", ac)
    await readUntil(reader, (b) => b.includes(":ok"))
    expect(bus.listenerCount("event")).toBe(1)
    ac.abort()
    await new Promise((r) => setTimeout(r, 100))
    expect(bus.listenerCount("event")).toBe(0)
  })
})
