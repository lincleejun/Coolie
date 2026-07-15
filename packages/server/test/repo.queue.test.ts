import { beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { EventEmitter } from "node:events"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { EventsBus, EVENT_CHANNEL } from "../src/events/bus.js"
import { QueueRepo, QueueRepoLive } from "../src/repo/queue.js"

let db: Database.Database
let bus: EventEmitter
let live: any[]

const layer = () => QueueRepoLive.pipe(
  Layer.provide(Layer.succeed(Db, db)),
  Layer.provide(Layer.succeed(EventsBus, bus)),
)
const run = <A>(eff: Effect.Effect<A, any, QueueRepo>) =>
  Effect.runPromise(Effect.provide(eff, layer()))

beforeEach(() => {
  db = new Database(":memory:")
  runMigrations(db)
  db.prepare("INSERT INTO projects (id,name,repo_root,default_base_branch,created_at) VALUES (?,?,?,?,?)")
    .run("p1", "p", "/tmp/p", "main", 1)
  db.prepare(`INSERT INTO workspaces
    (id,project_id,name,path,branch,base_branch,base_ref,status,pinned,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("w1", "p1", "w", "/tmp/w", "b", "main", "r", "active", 0, 1)
  bus = new EventEmitter()
  live = []
  bus.on(EVENT_CHANNEL, (event) => live.push(event))
})

describe("QueueRepo", () => {
  it("persists FIFO prompts and commits durable event before broadcast", async () => {
    const [a, b] = await run(Effect.gen(function* () {
      const queue = yield* QueueRepo
      return [
        yield* queue.enqueue({ workspaceId: "w1", tabId: "t1", text: "一" }),
        yield* queue.enqueue({ workspaceId: "w1", tabId: "t1", text: "二" }),
      ] as const
    }))
    expect([a.position, b.position]).toEqual([1, 2])
    expect(a).toMatchObject({
      id: a.queueId,
      messageId: `queue:${a.queueId}`,
      deliveryGuarantee: "at-least-once",
    })
    const listed = await run(Effect.gen(function* () { return yield* (yield* QueueRepo).listQueued("w1") }))
    expect(listed.map((q) => q.text)).toEqual(["一", "二"])
    expect((await run(Effect.gen(function* () { return yield* (yield* QueueRepo).peekNext("w1") })))?.id).toBe(a.id)
    expect((db.prepare("SELECT type FROM events ORDER BY seq").all() as any[]).map((r) => r.type))
      .toEqual(["prompt.queued", "prompt.queued"])
    expect(live.map((e) => e.type)).toEqual(["prompt.queued", "prompt.queued"])
    expect(live[0]?.payload).toMatchObject({ queueId: a.queueId, messageId: a.messageId })
  })

  it("keeps positions and restart targets isolated per engine tab", async () => {
    const positions = await run(Effect.gen(function* () {
      const queue = yield* QueueRepo
      const first = yield* queue.enqueue({ workspaceId: "w1", tabId: "t1", text: "一" })
      const sibling = yield* queue.enqueue({ workspaceId: "w1", tabId: "t2", text: "二" })
      const second = yield* queue.enqueue({ workspaceId: "w1", tabId: "t1", text: "三" })
      return [first.position, sibling.position, second.position]
    }))
    expect(positions).toEqual([1, 1, 2])
    expect(await run(Effect.gen(function* () { return yield* (yield* QueueRepo).listTargets() })))
      .toEqual([{ workspaceId: "w1", tabId: "t1" }, { workspaceId: "w1", tabId: "t2" }])
  })

  it("remove emits once and clearWorkspace removes remaining prompts", async () => {
    const ids = await run(Effect.gen(function* () {
      const queue = yield* QueueRepo
      const a = yield* queue.enqueue({ workspaceId: "w1", tabId: "t1", text: "一" })
      const b = yield* queue.enqueue({ workspaceId: "w1", tabId: "t1", text: "二" })
      return [a.id, b.id]
    }))
    expect((await run(Effect.gen(function* () { return yield* (yield* QueueRepo).withdraw(ids[0]!, "w1") }))).status).toBe("withdrawn")
    expect((await run(Effect.gen(function* () { return yield* (yield* QueueRepo).withdraw(ids[0]!, "w1") }))).status).toBe("missing")
    expect(live.filter((e) => e.type === "prompt.withdrawn")).toHaveLength(1)
    expect(await run(Effect.gen(function* () { return yield* (yield* QueueRepo).clearWorkspace("w1") }))).toBe(1)
  })

  it("claims with CAS, forbids withdrawing inflight, and only delivers inflight", async () => {
    const queued = await run(Effect.gen(function* () {
      return yield* (yield* QueueRepo).enqueue({ workspaceId: "w1", tabId: "t1", text: "一" })
    }))
    const claimed = await run(Effect.gen(function* () { return yield* (yield* QueueRepo).claimNext("w1") }))
    expect(claimed).toMatchObject({ id: queued.id, state: "inflight" })
    expect(await run(Effect.gen(function* () { return yield* (yield* QueueRepo).claimNext("w1") }))).toBeNull()
    expect((await run(Effect.gen(function* () { return yield* (yield* QueueRepo).withdraw(queued.id, "w1") }))).status)
      .toBe("inflight")
    expect(await run(Effect.gen(function* () { return yield* (yield* QueueRepo).delivered(queued.id) }))).toBe(true)
    expect(live.at(-1)).toMatchObject({
      type: "prompt.delivered",
      payload: { queueId: queued.queueId, messageId: queued.messageId },
    })
  })

  it("releases a failed inflight prompt and durably records the failure", async () => {
    const queued = await run(Effect.gen(function* () {
      return yield* (yield* QueueRepo).enqueue({ workspaceId: "w1", tabId: "t1", text: "一" })
    }))
    await run(Effect.gen(function* () { yield* (yield* QueueRepo).claimNext("w1") }))
    expect(await run(Effect.gen(function* () {
      return yield* (yield* QueueRepo).release(queued.id, "tmux failed")
    }))).toBe(true)
    expect((await run(Effect.gen(function* () { return yield* (yield* QueueRepo).peekNext("w1") })))?.id).toBe(queued.id)
    expect((db.prepare("SELECT type FROM events ORDER BY seq DESC LIMIT 1").get() as any).type)
      .toBe("prompt.delivery.failed")
    expect(live.at(-1)?.payload).toMatchObject({ queueId: queued.queueId, messageId: queued.messageId })
  })

  it("recovers daemon-crash inflight prompts back to queued", async () => {
    await run(Effect.gen(function* () {
      const queue = yield* QueueRepo
      yield* queue.enqueue({ workspaceId: "w1", tabId: "t1", text: "一" })
      yield* queue.claimNext("w1")
    }))
    expect(await run(Effect.gen(function* () { return yield* (yield* QueueRepo).recoverInflight() }))).toBe(1)
    expect((await run(Effect.gen(function* () { return yield* (yield* QueueRepo).peekNext("w1") })))?.state).toBe("queued")
    expect(await run(Effect.gen(function* () { return yield* (yield* QueueRepo).listWorkspaceIds() }))).toEqual(["w1"])
  })
})
