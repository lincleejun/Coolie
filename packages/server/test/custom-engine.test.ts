import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import {
  copilotPreset, CustomEngineStore, CustomEngineStoreLive, CustomEngineValidationError,
  detectCustomEngine, validateCustomEngine,
} from "../src/engine/custom-store.js"
import { makeCustomEngine } from "../src/engine/custom-adapter.js"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"

describe("custom engine public definition", () => {
  it("validates argv templates and expands them without shell concatenation", () => {
    const definition = validateCustomEngine({
      id: "acme-agent", displayName: "Acme", enabled: true,
      command: ["acme", "--session={sessionId}", "--model={model}"],
      capabilities: { nativeQueue: false, midSessionModelSwitch: false, resume: true, hooks: false, effort: false },
      transcriptStrategy: "none", historyStrategy: "resume-args", resumeArgs: ["--resume", "{sessionId}"],
      turnDetection: "none",
    })
    const engine = makeCustomEngine(definition)
    expect(engine.launchCommand({ sessionId: "sid", model: "m" })).toEqual(["acme", "--session=sid", "--model=m"])
    expect(engine.launchCommand({ sessionId: "sid" })).toEqual(["acme", "--session=sid"])
    expect(engine.launchCommand({ sessionId: "sid", resume: true })).toEqual(["acme", "--session=sid", "--resume", "sid"])
  })

  it("rejects unknown template variables and built-in ids", () => {
    const base = copilotPreset()
    expect(() => validateCustomEngine({ ...base, id: "claude" })).toThrow(/不能覆盖/)
    expect(() => validateCustomEngine({ ...base, command: ["agent", "{danger}"] })).toThrow(/argv template/)
  })

  it("requires a fixed executable and rejects a missing post-expansion argv[0]", () => {
    const base = copilotPreset()
    expect(() => validateCustomEngine({ ...base, command: ["{model}"] }))
      .toThrow(CustomEngineValidationError)
    expect(() => validateCustomEngine({ ...base, command: ["{model}"] }))
      .toThrow(/固定、非空且非 template/)

    const engine = makeCustomEngine({ ...base, command: ["{model}"] })
    expect(() => engine.launchCommand({ sessionId: "sid" }))
      .toThrow(CustomEngineValidationError)
    expect(() => engine.launchCommand({ sessionId: "sid" }))
      .toThrow(/missing argv\[0\]/)
  })

  it("models Copilot as a regular preset definition", () => {
    const preset = copilotPreset("work-copilot")
    expect(preset).toMatchObject({ id: "work-copilot", presetId: "copilot", command: ["copilot", "--allow-all-tools"] })
    expect(makeCustomEngine(preset).id).toBe("work-copilot")
  })

  it("reports a missing account path as typed availability data", async () => {
    const result = await detectCustomEngine({
      ...copilotPreset(), accountDetectionPath: "/definitely/missing/coolie-account",
    })
    expect(result).toMatchObject({ available: false, accountHint: null })
    expect(result.error).toMatch(/path not found/)
  })

  it("persists CRUD through the migrated store table", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const storeLayer = CustomEngineStoreLive.pipe(Layer.provide(Layer.succeed(Db, db)))
    const result = await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      const store = yield* CustomEngineStore
      yield* store.put(copilotPreset())
      const saved = yield* store.get("copilot")
      const listed = yield* store.list()
      yield* store.remove("copilot")
      return { saved, listed, after: yield* store.list() }
    }), storeLayer))
    expect(result.saved.presetId).toBe("copilot")
    expect(result.listed).toHaveLength(1)
    expect(result.after).toEqual([])
    db.close()
  })
})
