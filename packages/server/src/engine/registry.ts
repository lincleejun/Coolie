import { Context, Data, Effect, Layer } from "effect"
import type { Engine } from "./types.js"
import { claudeEngine } from "./claude/adapter.js"
import { codexEngine } from "./codex/adapter.js"
import { copilotEngine } from "./copilot/adapter.js"
import { resolveCodexHooks } from "./codex/version.js"
import { CustomEngineStore } from "./custom-store.js"
import { makeCustomEngine } from "./custom-adapter.js"
import { isBuiltinEngineId } from "./copilot-migration.js"
import type { CustomEngineDefinition } from "@coolie/protocol"

export class EngineError extends Data.TaggedError("EngineError")<{ readonly message: string }> {}

export class EngineRegistry extends Context.Tag("EngineRegistry")<EngineRegistry, ReadonlyMap<string, Engine>>() {}

export const makeEngineRegistry = (custom: readonly CustomEngineDefinition[] = []): Map<string, Engine> => {
  // 启动一次定档：Codex >=0.144（或显式覆写）走 hooks；旧版/探测失败走 notify。
  const codex: Engine = resolveCodexHooks()
    ? { ...codexEngine, capabilities: { ...codexEngine.capabilities, hooks: true } }
    : codexEngine
  const registry = new Map<string, Engine>([
    [claudeEngine.id, claudeEngine],
    [codex.id, codex],
    [copilotEngine.id, copilotEngine],
  ])
  for (const definition of custom) {
    // Stale custom rows must not override built-ins after Task 3.2 migration.
    if (definition.enabled && !isBuiltinEngineId(definition.id))
      registry.set(definition.id, makeCustomEngine(definition))
  }
  return registry
}

export const EngineRegistryLive = Layer.effect(EngineRegistry, Effect.gen(function* () {
  const store = yield* Effect.serviceOption(CustomEngineStore)
  return makeEngineRegistry(store._tag === "Some" ? yield* store.value.list() : [])
}))

export const getEngine = (reg: ReadonlyMap<string, Engine>, id: string): Effect.Effect<Engine, EngineError> => {
  const e = reg.get(id)
  return e ? Effect.succeed(e) : Effect.fail(new EngineError({ message: `engine 未注册：${id}` }))
}

/** per-engine 转录/数据目录解析：claude→claudeHome、codex→codexHome、null/未知→claudeHome 兜底。
 * transcriptPath/deriveTitle/mtime 轮询的调用点用它，替代 M1 硬编码的 cfg.claudeHome。 */
export const engineHome = (engineId: string | null, cfg: {
  readonly claudeHome: string; readonly codexHome: string; readonly home?: string
}): string =>
  engineId === "codex" ? cfg.codexHome : engineId === "claude" || engineId === null ? cfg.claudeHome : cfg.home ?? cfg.claudeHome
