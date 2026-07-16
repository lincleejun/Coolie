import { beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import {
  INPUT_RECEIPT_TTL_MS,
  InputReceiptsRepo,
  InputReceiptsRepoLive,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_INPUT_BODY_BYTES,
  getStoredInputReceipt,
  hashInputBody,
  makeInputReceiptsRepo,
} from "../src/repo/input-receipts.js"

let db: Database.Database

const seedWorkspaces = (database: Database.Database) => {
  database.prepare("INSERT INTO projects (id,name,repo_root,default_base_branch,created_at) VALUES (?,?,?,?,?)")
    .run("p1", "p", "/tmp/p", "main", 1)
  database.prepare(`INSERT INTO workspaces
    (id,project_id,name,path,branch,base_branch,base_ref,status,pinned,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("w1", "p1", "w1", "/tmp/w1", "b1", "main", "r", "active", 0, 1)
  database.prepare(`INSERT INTO workspaces
    (id,project_id,name,path,branch,base_branch,base_ref,status,pinned,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("w2", "p1", "w2", "/tmp/w2", "b2", "main", "r", "active", 0, 2)
}

const layer = () => InputReceiptsRepoLive.pipe(Layer.provide(Layer.succeed(Db, db)))
const run = <A, E>(eff: Effect.Effect<A, E, InputReceiptsRepo>) =>
  Effect.runPromise(Effect.provide(eff, layer()))
const runExit = <A, E>(eff: Effect.Effect<A, E, InputReceiptsRepo>) =>
  Effect.runPromiseExit(Effect.provide(eff, layer()))
const failTag = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined
  const failure = Cause.failureOption(exit.cause)
  return Option.isSome(failure) ? (failure.value as { _tag: string })._tag : undefined
}

beforeEach(() => {
  db = new Database(":memory:")
  runMigrations(db)
  seedWorkspaces(db)
})

describe("InputReceiptsRepo", () => {
  it("returns replay for same workspace/key/body and rejects oversized key/body", async () => {
    const body = JSON.stringify({ text: "hello", mode: "send" })
    const bodyHash = hashInputBody(body)
    const response = { queued: true, id: 1, position: 1 }

    await run(Effect.gen(function* () {
      const repo = yield* InputReceiptsRepo
      expect(yield* repo.check({ workspaceId: "w1", key: "k1", bodyHash, bodyByteLength: body.length }))
        .toEqual({ replay: false })
      yield* repo.put({ workspaceId: "w1", key: "k1", bodyHash, response, now: 1_000 })
    }))

    const replay = await run(Effect.gen(function* () {
      return yield* (yield* InputReceiptsRepo).check({
        workspaceId: "w1", key: "k1", bodyHash, bodyByteLength: body.length, now: 2_000,
      })
    }))
    expect(replay).toEqual({ replay: true, responseJson: JSON.stringify(response) })

    const badKey = await runExit(Effect.gen(function* () {
      return yield* (yield* InputReceiptsRepo).check({
        workspaceId: "w1",
        key: "x".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
        bodyHash,
        bodyByteLength: body.length,
      })
    }))
    expect(failTag(badKey)).toBe("ValidationError")

    const badBody = await runExit(Effect.gen(function* () {
      return yield* (yield* InputReceiptsRepo).check({
        workspaceId: "w1",
        key: "k1",
        bodyHash,
        bodyByteLength: MAX_INPUT_BODY_BYTES + 1,
      })
    }))
    expect(failTag(badBody)).toBe("ValidationError")
  })

  it("returns ConflictError when the same key is reused with a different body", async () => {
    const firstBody = JSON.stringify({ text: "one" })
    const secondBody = JSON.stringify({ text: "two" })
    await run(Effect.gen(function* () {
      const repo = yield* InputReceiptsRepo
      yield* repo.put({
        workspaceId: "w1",
        key: "dup",
        bodyHash: hashInputBody(firstBody),
        response: { sent: true },
      })
    }))

    const exit = await runExit(Effect.gen(function* () {
      return yield* (yield* InputReceiptsRepo).check({
        workspaceId: "w1",
        key: "dup",
        bodyHash: hashInputBody(secondBody),
        bodyByteLength: secondBody.length,
      })
    }))
    expect(failTag(exit)).toBe("ConflictError")
  })

  it("isolates receipts per workspace even when key and body match", async () => {
    const body = JSON.stringify({ text: "shared" })
    const bodyHash = hashInputBody(body)
    await run(Effect.gen(function* () {
      const repo = yield* InputReceiptsRepo
      yield* repo.put({ workspaceId: "w1", key: "shared-key", bodyHash, response: { workspace: "w1" } })
      yield* repo.put({ workspaceId: "w2", key: "shared-key", bodyHash, response: { workspace: "w2" } })
    }))

    const w1 = await run(Effect.gen(function* () {
      return yield* (yield* InputReceiptsRepo).check({
        workspaceId: "w1", key: "shared-key", bodyHash, bodyByteLength: body.length,
      })
    }))
    const w2 = await run(Effect.gen(function* () {
      return yield* (yield* InputReceiptsRepo).check({
        workspaceId: "w2", key: "shared-key", bodyHash, bodyByteLength: body.length,
      })
    }))
    if (!w1.replay || !w2.replay) throw new Error("expected replay")
    expect(JSON.parse(w1.responseJson)).toEqual({ workspace: "w1" })
    expect(JSON.parse(w2.responseJson)).toEqual({ workspace: "w2" })
  })

  it("commits receipt atomically; rollback leaves no durable row", () => {
    const body = JSON.stringify({ text: "txn" })
    const bodyHash = hashInputBody(body)
    expect(() => db.transaction(() => {
      db.prepare(`
        INSERT INTO input_receipts
          (workspace_id, idempotency_key, body_hash, response_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("w1", "txn-key", bodyHash, JSON.stringify({ ok: true }), 1, 1 + INPUT_RECEIPT_TTL_MS)
      throw new Error("abort before commit")
    })()).toThrow("abort before commit")
    expect(getStoredInputReceipt(db, "w1", "txn-key")).toBeNull()
  })

  it("survives database restart and still replays the first response", async () => {
    const body = JSON.stringify({ text: "restart" })
    const bodyHash = hashInputBody(body)
    const response = { queued: true, id: 9, position: 1 }
    const dbPath = `/tmp/coolie-input-receipts-${Date.now()}.sqlite`
    const first = new Database(dbPath)
    runMigrations(first)
    seedWorkspaces(first)
    await Effect.runPromise(makeInputReceiptsRepo(first).put({
      workspaceId: "w1",
      key: "restart-key",
      bodyHash,
      response,
      now: 10_000,
    }))
    first.close()

    const reopened = new Database(dbPath)
    const replay = await Effect.runPromise(makeInputReceiptsRepo(reopened).check({
      workspaceId: "w1",
      key: "restart-key",
      bodyHash,
      bodyByteLength: body.length,
      now: 20_000,
    }))
    expect(replay).toEqual({ replay: true, responseJson: JSON.stringify(response) })
    reopened.close()
  })

  it("cleans up expired receipts and treats them as absent on check", async () => {
    const body = JSON.stringify({ text: "ttl" })
    const bodyHash = hashInputBody(body)
    const createdAt = 1_000_000
    await run(Effect.gen(function* () {
      const repo = yield* InputReceiptsRepo
      yield* repo.put({
        workspaceId: "w1",
        key: "ttl-key",
        bodyHash,
        response: { ok: true },
        now: createdAt,
      })
      expect(yield* repo.cleanupExpired(createdAt + INPUT_RECEIPT_TTL_MS + 1)).toBe(1)
      expect(yield* repo.check({
        workspaceId: "w1",
        key: "ttl-key",
        bodyHash,
        bodyByteLength: body.length,
        now: createdAt + INPUT_RECEIPT_TTL_MS + 2,
      })).toEqual({ replay: false })
    }))
  })

  it("put is idempotent for the same key/body after the first response is stored", async () => {
    const body = JSON.stringify({ text: "idem" })
    const bodyHash = hashInputBody(body)
    await run(Effect.gen(function* () {
      const repo = yield* InputReceiptsRepo
      yield* repo.put({ workspaceId: "w1", key: "idem", bodyHash, response: { first: true } })
      yield* repo.put({ workspaceId: "w1", key: "idem", bodyHash, response: { first: true } })
      const replay = yield* repo.check({
        workspaceId: "w1", key: "idem", bodyHash, bodyByteLength: body.length,
      })
      expect(replay).toEqual({ replay: true, responseJson: JSON.stringify({ first: true }) })
    }))
  })

  it("clearWorkspace removes only that workspace receipts", async () => {
    const body = JSON.stringify({ text: "clear" })
    const bodyHash = hashInputBody(body)
    await run(Effect.gen(function* () {
      const repo = yield* InputReceiptsRepo
      yield* repo.put({ workspaceId: "w1", key: "k", bodyHash, response: { w: 1 } })
      yield* repo.put({ workspaceId: "w2", key: "k", bodyHash, response: { w: 2 } })
      expect(yield* repo.clearWorkspace("w1")).toBe(1)
      expect(getStoredInputReceipt(db, "w1", "k")).toBeNull()
      expect(getStoredInputReceipt(db, "w2", "k")).not.toBeNull()
    }))
  })
})
