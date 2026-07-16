import { beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { AttentionInbox, AttentionInboxLive } from "../src/repo/attention.js"
import { appendEventRow } from "../src/repo/events.js"

let db: Database.Database

const seed = (database: Database.Database) => {
  database.prepare("INSERT INTO projects (id,name,repo_root,default_base_branch,created_at) VALUES (?,?,?,?,?)")
    .run("p1", "p", "/tmp/p", "main", 1)
  database.prepare(`INSERT INTO workspaces
    (id,project_id,name,path,branch,base_branch,base_ref,status,pinned,created_at,task_status,kind,materialized,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("w1", "p1", "w1", "/tmp/w1", "b1", "main", "r", "active", 0, 1, "in_progress", "task", 1, 0)
  database.prepare(`INSERT INTO tabs
    (id,workspace_id,kind,engine_id,engine_session_id,tmux_window,title,status,data)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("t1", "w1", "engine", "claude", "sess-1", 1, "Claude", "awaiting-input", "{}")
}

const insertEvent = (database: Database.Database, workspaceId = "w1") =>
  appendEventRow(database, { workspaceId, type: "engine.turn.finished", payload: { tabId: "t1" } }).seq

const layer = () => AttentionInboxLive.pipe(Layer.provide(Layer.succeed(Db, db)))
const run = <A, E>(eff: Effect.Effect<A, E, AttentionInbox>) =>
  Effect.runPromise(Effect.provide(eff, layer()))
const runExit = <A, E>(eff: Effect.Effect<A, E, AttentionInbox>) =>
  Effect.runPromiseExit(Effect.provide(eff, layer()))
const failTag = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined
  const failure = Cause.failureOption(exit.cause)
  return Option.isSome(failure) ? (failure.value as { _tag: string })._tag : undefined
}

beforeEach(() => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  seed(db)
})

describe("AttentionInbox", () => {
  it("records and lists attention items with cursor pagination", async () => {
    const seq1 = insertEvent(db)
    const seq2 = insertEvent(db)
    const first = await run(Effect.gen(function* () {
      const inbox = yield* AttentionInbox
      const a = yield* inbox.record({
        workspaceId: "w1", tabId: "t1", kind: "turn-finished", source: "hook",
        sourceEventSeq: seq1, sessionTurnId: "sess-1", summary: "Turn 1", createdAt: 1_000,
      })
      const b = yield* inbox.record({
        workspaceId: "w1", tabId: "t1", kind: "permission", source: "notify",
        sourceEventSeq: seq2, sessionTurnId: "sess-2", summary: "Permission", createdAt: 2_000,
      })
      return { a, b }
    }))

    const page1 = await run(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).list({ workspaceId: "w1", limit: 1 })
    }))
    expect(page1).toHaveLength(1)
    expect(page1[0]?.id).toBe(first.a.id)

    const page2 = await run(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).list({
        workspaceId: "w1",
        cursorCreatedAt: page1[0]!.createdAt,
        cursorId: page1[0]!.id,
        limit: 10,
      })
    }))
    expect(page2.map((item) => item.id)).toEqual([first.b.id])
  })

  it("deduplicates completion by sourceEventSeq", async () => {
    const seq = insertEvent(db)
    const items = await run(Effect.gen(function* () {
      const inbox = yield* AttentionInbox
      const signal = {
        workspaceId: "w1", tabId: "t1", kind: "turn-finished" as const, source: "hook" as const,
        sourceEventSeq: seq, sessionTurnId: "sess-1", summary: "Turn 1",
      }
      const first = yield* inbox.record(signal)
      const second = yield* inbox.record({ ...signal, summary: "duplicate" })
      return [first, second]
    }))
    expect(items[0]?.id).toBe(items[1]?.id)
    expect(db.prepare("SELECT COUNT(*) c FROM attention_items").get()).toEqual({ c: 1 })
  })

  it("acknowledges idempotently and rejects stale episode guards", async () => {
    const seq1 = insertEvent(db)
    const seq2 = insertEvent(db)
    const { oldItem, newItem } = await run(Effect.gen(function* () {
      const inbox = yield* AttentionInbox
      const oldItem = yield* inbox.record({
        workspaceId: "w1", tabId: "t1", kind: "turn-finished", source: "hook",
        sourceEventSeq: seq1, sessionTurnId: "sess-old", summary: "Old turn",
      })
      const newItem = yield* inbox.record({
        workspaceId: "w1", tabId: "t1", kind: "turn-finished", source: "hook",
        sourceEventSeq: seq2, sessionTurnId: "sess-new", summary: "New turn",
      })
      return { oldItem, newItem }
    }))

    const stale = await runExit(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).acknowledge(newItem.id, "sess-old", 2_000)
    }))
    expect(failTag(stale)).toBe("ConflictError")

    const acked = await run(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).acknowledge(newItem.id, "sess-new", 2_000)
    }))
    expect(acked.state).toBe("acknowledged")
    expect(acked.acknowledgedAt).toBe(2_000)

    const again = await run(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).acknowledge(newItem.id, "sess-new", 3_000)
    }))
    expect(again.state).toBe("acknowledged")
    expect(again.acknowledgedAt).toBe(2_000)

    const oldAck = await run(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).acknowledge(oldItem.id, "sess-old", 4_000)
    }))
    expect(oldAck.state).toBe("acknowledged")
  })

  it("survives reopen and rolls back failed transactions", async () => {
    const filePath = path.join(os.tmpdir(), `coolie-attn-${Date.now()}-${Math.random()}.db`)
    let fileDb = new Database(filePath)
    fileDb.pragma("foreign_keys = ON")
    runMigrations(fileDb)
    seed(fileDb)
    const fileLayer = AttentionInboxLive.pipe(Layer.provide(Layer.succeed(Db, fileDb)))
    const runFile = <A, E>(eff: Effect.Effect<A, E, AttentionInbox>) =>
      Effect.runPromise(Effect.provide(eff, fileLayer))

    const seq = appendEventRow(fileDb, { workspaceId: "w1", type: "engine.turn.finished", payload: { tabId: "t1" } }).seq
    await runFile(Effect.gen(function* () {
      yield* (yield* AttentionInbox).record({
        workspaceId: "w1", tabId: "t1", kind: "inferred", source: "transcript-poller",
        sourceEventSeq: seq, sessionTurnId: "sess-1", summary: "Inferred",
      })
    }))

    fileDb.close()
    fileDb = new Database(filePath)
    fileDb.pragma("foreign_keys = ON")
    db = fileDb

    const reopened = await run(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).list({ workspaceId: "w1" })
    }))
    expect(reopened).toHaveLength(1)

    expect(() => fileDb.transaction(() => {
      fileDb.prepare("INSERT INTO attention_items (id, workspace_id, tab_id, kind, source, source_event_seq, summary, state, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run("bad", "w1", "missing-tab", "error", "hook", 9999, "x", "open", 1)
    })()).toThrow()
    expect(fileDb.prepare("SELECT COUNT(*) c FROM attention_items").get()).toEqual({ c: 1 })
    fs.unlinkSync(filePath)
  })

  it("rejects corrupt rows on read", async () => {
    const seq = insertEvent(db)
    db.prepare(`
      INSERT INTO attention_items
        (id, workspace_id, tab_id, kind, source, source_event_seq, summary, state, created_at, acknowledged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run("bad", "w1", "t1", "error", "hook", seq, "x", 1, 999)
    await expect(run(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).list({ workspaceId: "w1" })
    }))).rejects.toThrow(/open attention item/)
  })

  it("preserves attention on archive and cascades on workspace delete", async () => {
    const seq = insertEvent(db)
    const item = await run(Effect.gen(function* () {
      return yield* (yield* AttentionInbox).record({
        workspaceId: "w1", tabId: "t1", kind: "turn-finished", source: "hook",
        sourceEventSeq: seq, sessionTurnId: "sess-1", summary: "Turn",
      })
    }))

    db.prepare("UPDATE workspaces SET status = 'archived', archived_at = ? WHERE id = ?").run(Date.now(), "w1")
    expect(db.prepare("SELECT COUNT(*) c FROM attention_items WHERE id = ?").get(item.id)).toEqual({ c: 1 })

    db.prepare("DELETE FROM tabs WHERE workspace_id = ?").run("w1")
    db.prepare("DELETE FROM workspaces WHERE id = ?").run("w1")
    expect(db.prepare("SELECT COUNT(*) c FROM attention_items").get()).toEqual({ c: 0 })
  })
})
