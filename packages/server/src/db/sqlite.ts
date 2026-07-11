import { Context, Effect, Layer } from "effect"
import Database from "better-sqlite3"
import * as fs from "node:fs"
import * as path from "node:path"
import { CoolieConfig } from "../config.js"
import { runMigrations } from "./migrations.js"

// TS4020 workaround: Database.Database resolves to ambient BetterSqlite3 namespace (not exported),
// which tsc cannot name in declaration emit. Interface alias makes it nameable.
interface SqliteDatabase extends Database.Database {}

export class Db extends Context.Tag("Db")<Db, SqliteDatabase>() {}

export const DbLive = Layer.scoped(
  Db,
  Effect.gen(function* () {
    const cfg = yield* CoolieConfig
    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true })
        const db = new Database(cfg.dbPath)
        db.pragma("journal_mode = WAL")
        runMigrations(db)
        return db
      }),
      (db) => Effect.sync(() => db.close()),
    )
  }),
)
