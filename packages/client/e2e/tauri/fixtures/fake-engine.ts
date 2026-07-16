import * as fs from "node:fs"
import * as path from "node:path"

export interface FakeEngineEnv {
  readonly claudeHome: string
  readonly codexHome: string
  readonly claudeConfig: string
  readonly codexConfig: string
}

export const prepareFakeEngineHomes = (home: string): FakeEngineEnv => {
  const claudeHome = path.join(home, ".claude")
  const codexHome = path.join(home, ".codex")
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  const claudeConfig = path.join(home, ".claude.json")
  const codexConfig = path.join(codexHome, "config.toml")
  fs.writeFileSync(claudeConfig, "{}")
  fs.writeFileSync(codexConfig, "")
  return { claudeHome, codexHome, claudeConfig, codexConfig }
}

export const fakeEngineProcessEnv = (home: string): Record<string, string> => {
  const engine = prepareFakeEngineHomes(home)
  return {
    COOLIE_CLAUDE_CMD: "cat",
    COOLIE_CODEX_CMD: "cat",
    COOLIE_DISABLE_HOOKS: "1",
    COOLIE_CLAUDE_HOME: engine.claudeHome,
    COOLIE_CLAUDE_CONFIG: engine.claudeConfig,
    COOLIE_CODEX_HOME: engine.codexHome,
    COOLIE_CODEX_CONFIG: engine.codexConfig,
  }
}
