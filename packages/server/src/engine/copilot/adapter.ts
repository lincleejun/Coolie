import * as path from "node:path"
import { randomUUID } from "node:crypto"
import type { Engine } from "../types.js"
import { discoverCopilotBinary } from "./binary.js"

/**
 * Built-in GitHub Copilot engine — conservative capability claims.
 * Unverified capabilities are all false/none; Task 3.3 productizes auth gating.
 *
 * Real CLI opt-in smoke (not CI default):
 *   COOLIE_COPILOT_SMOKE=1 bunx vitest run packages/server/test/engine.copilot.adapter.test.ts
 * Requires `copilot` and `gh` on PATH; never reads ~/.coolie for this probe.
 */
export const copilotEngine: Engine = {
  id: "copilot",
  displayName: "GitHub Copilot",
  capabilities: {
    nativeQueue: false,
    midSessionModelSwitch: false,
    resume: false,
    hooks: false,
    effort: false,
  },
  terminalTitle: "none",
  serverGeneratedId: false,
  models: [],
  newSessionId: () => randomUUID(),
  launchCommand: () => {
    const override = (process.env.COOLIE_COPILOT_CMD ?? "").trim()
    if (override !== "") return override.split(/\s+/)
    const bin = discoverCopilotBinary() ?? "copilot"
    return [bin, "--allow-all-tools"]
  },
  statusFromHookEvent: () => null,
  transcriptPath: ({ home }) => path.join(home, ".coolie-no-transcript"),
  deriveTitle: () => null,
  resumeArgs: () => [],
}
