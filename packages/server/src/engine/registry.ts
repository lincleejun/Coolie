import { Context, Data, Effect, Layer } from "effect"
import type { Engine } from "./types.js"
import { claudeEngine } from "./claude/adapter.js"

export class EngineError extends Data.TaggedError("EngineError")<{ readonly message: string }> {}

export class EngineRegistry extends Context.Tag("EngineRegistry")<EngineRegistry, ReadonlyMap<string, Engine>>() {}

export const EngineRegistryLive = Layer.sync(EngineRegistry, () => new Map<string, Engine>([[claudeEngine.id, claudeEngine]]))

export const getEngine = (reg: ReadonlyMap<string, Engine>, id: string): Effect.Effect<Engine, EngineError> => {
  const e = reg.get(id)
  return e ? Effect.succeed(e) : Effect.fail(new EngineError({ message: `engine 未注册：${id}` }))
}
