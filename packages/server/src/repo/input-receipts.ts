import { createHash } from "node:crypto"
import type Database from "better-sqlite3"
import { Context, Effect, Layer } from "effect"
import { Db } from "../db/sqlite.js"
import { ConflictError, ValidationError } from "./errors.js"

export const MAX_IDEMPOTENCY_KEY_LENGTH = 256
export const MAX_INPUT_BODY_BYTES = 65_536
export const INPUT_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const hashInputBody = (body: string | Uint8Array): string =>
  createHash("sha256").update(body).digest("hex")

export interface InputIdempotencyFields {
  readonly text: string
  readonly mode: string
  readonly tabId?: string
  readonly skipStable?: boolean
}

/** Canonical request body for idempotency hashing — excludes the key itself. */
export const canonicalInputIdempotencyBody = (fields: InputIdempotencyFields): string =>
  JSON.stringify({
    text: fields.text,
    mode: fields.mode,
    ...(typeof fields.tabId === "string" ? { tabId: fields.tabId } : {}),
    ...(fields.skipStable === true ? { skipStable: true } : {}),
  })

export const inputReceiptStatus = (response: Record<string, unknown>): number =>
  response.queued === true ? 202 : 200

export interface StoredInputReceipt {
  readonly workspaceId: string
  readonly key: string
  readonly bodyHash: string
  readonly responseJson: string
  readonly createdAt: number
  readonly expiresAt: number
}

export type InputReceiptCheckResult =
  | { readonly replay: false }
  | { readonly replay: true; readonly responseJson: string }

export interface InputReceiptsRepoShape {
  readonly check: (input: {
    workspaceId: string
    key: string
    bodyHash: string
    bodyByteLength: number
    now?: number
  }) => Effect.Effect<InputReceiptCheckResult, ValidationError | ConflictError>
  readonly put: (input: {
    workspaceId: string
    key: string
    bodyHash: string
    response: unknown
    now?: number
  }) => Effect.Effect<void, ConflictError>
  readonly cleanupExpired: (now?: number) => Effect.Effect<number>
  readonly clearWorkspace: (workspaceId: string) => Effect.Effect<number>
}

export class InputReceiptsRepo extends Context.Tag("InputReceiptsRepo")<
  InputReceiptsRepo,
  InputReceiptsRepoShape
>() {}

const validateKeyAndBody = (key: string, bodyByteLength: number): void => {
  if (key.length === 0)
    throw new ValidationError({ message: "idempotency key required" })
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH)
    throw new ValidationError({ message: `idempotency key exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} chars` })
  if (bodyByteLength > MAX_INPUT_BODY_BYTES)
    throw new ValidationError({ message: `request body exceeds ${MAX_INPUT_BODY_BYTES} bytes` })
}

const rowToReceipt = (row: {
  workspace_id: string
  idempotency_key: string
  body_hash: string
  response_json: string
  created_at: number
  expires_at: number
}): StoredInputReceipt => ({
  workspaceId: row.workspace_id,
  key: row.idempotency_key,
  bodyHash: row.body_hash,
  responseJson: row.response_json,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
})

export const makeInputReceiptsRepo = (db: Database.Database): InputReceiptsRepoShape => ({
  check: ({ workspaceId, key, bodyHash, bodyByteLength, now = Date.now() }) => Effect.try({
    try: () => {
      validateKeyAndBody(key, bodyByteLength)
      const row = db.prepare(`
        SELECT workspace_id, idempotency_key, body_hash, response_json, created_at, expires_at
        FROM input_receipts
        WHERE workspace_id = ? AND idempotency_key = ?
      `).get(workspaceId, key) as {
        workspace_id: string
        idempotency_key: string
        body_hash: string
        response_json: string
        created_at: number
        expires_at: number
      } | undefined
      if (!row) return { replay: false } as const
      if (row.expires_at <= now) {
        db.prepare("DELETE FROM input_receipts WHERE workspace_id = ? AND idempotency_key = ?")
          .run(workspaceId, key)
        return { replay: false } as const
      }
      if (row.body_hash !== bodyHash)
        throw new ConflictError({ message: "idempotency key reused with different request body" })
      return { replay: true, responseJson: row.response_json } as const
    },
    catch: (error) => error instanceof ValidationError || error instanceof ConflictError
      ? error
      : new ValidationError({ message: error instanceof Error ? error.message : String(error) }),
  }),

  put: ({ workspaceId, key, bodyHash, response, now = Date.now() }) => Effect.try({
    try: () => {
      const responseJson = JSON.stringify(response)
      db.transaction(() => {
        const row = db.prepare(`
          SELECT body_hash, response_json, expires_at
          FROM input_receipts
          WHERE workspace_id = ? AND idempotency_key = ?
        `).get(workspaceId, key) as { body_hash: string; response_json: string; expires_at: number } | undefined
        if (row) {
          if (row.expires_at <= now) {
            db.prepare("DELETE FROM input_receipts WHERE workspace_id = ? AND idempotency_key = ?")
              .run(workspaceId, key)
          } else {
            if (row.body_hash !== bodyHash)
              throw new ConflictError({ message: "idempotency key reused with different request body" })
            return
          }
        }
        db.prepare(`
          INSERT INTO input_receipts
            (workspace_id, idempotency_key, body_hash, response_json, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(workspaceId, key, bodyHash, responseJson, now, now + INPUT_RECEIPT_TTL_MS)
      })()
    },
    catch: (error) => error instanceof ConflictError
      ? error
      : new ConflictError({ message: error instanceof Error ? error.message : String(error) }),
  }),

  cleanupExpired: (now = Date.now()) => Effect.sync(() =>
    db.prepare("DELETE FROM input_receipts WHERE expires_at <= ?").run(now).changes),

  clearWorkspace: (workspaceId) => Effect.sync(() =>
    db.prepare("DELETE FROM input_receipts WHERE workspace_id = ?").run(workspaceId).changes),
})

export const InputReceiptsRepoLive = Layer.effect(
  InputReceiptsRepo,
  Effect.gen(function* () {
    const db = yield* Db
    return makeInputReceiptsRepo(db)
  }),
)

export const getStoredInputReceipt = (
  db: Database.Database,
  workspaceId: string,
  key: string,
): StoredInputReceipt | null => {
  const row = db.prepare(`
    SELECT workspace_id, idempotency_key, body_hash, response_json, created_at, expires_at
    FROM input_receipts
    WHERE workspace_id = ? AND idempotency_key = ?
  `).get(workspaceId, key) as {
    workspace_id: string
    idempotency_key: string
    body_hash: string
    response_json: string
    created_at: number
    expires_at: number
  } | undefined
  return row ? rowToReceipt(row) : null
}
