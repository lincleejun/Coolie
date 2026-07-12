import { Context, Data, Effect, Layer } from "effect"
import type { Engine } from "./types.js"
import { claudeEngine } from "./claude/adapter.js"
import { codexEngine } from "./codex/adapter.js"

export class EngineError extends Data.TaggedError("EngineError")<{ readonly message: string }> {}

export class EngineRegistry extends Context.Tag("EngineRegistry")<EngineRegistry, ReadonlyMap<string, Engine>>() {}

export const EngineRegistryLive = Layer.sync(EngineRegistry, () =>
  new Map<string, Engine>([[claudeEngine.id, claudeEngine], [codexEngine.id, codexEngine]]))

export const getEngine = (reg: ReadonlyMap<string, Engine>, id: string): Effect.Effect<Engine, EngineError> => {
  const e = reg.get(id)
  return e ? Effect.succeed(e) : Effect.fail(new EngineError({ message: `engine 未注册：${id}` }))
}

/** per-engine 转录/数据目录解析：claude→claudeHome、codex→codexHome、null/未知→claudeHome 兜底。
 * transcriptPath/deriveTitle/mtime 轮询的调用点用它，替代 M1 硬编码的 cfg.claudeHome。 */
export const engineHome = (engineId: string | null, cfg: { readonly claudeHome: string; readonly codexHome: string }): string =>
  engineId === "codex" ? cfg.codexHome : cfg.claudeHome
