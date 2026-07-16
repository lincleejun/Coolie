import { describe, expect, it } from "vitest"
import {
  buildCreateBody,
  copilotLoginHint,
  engineSelectLabel,
  isEngineUsable,
  resolveDispatchDefaults,
} from "../src/composer/Dispatch.js"
import type { EngineInfo } from "../src/stores/types.js"

const engine = (partial: Partial<EngineInfo> & Pick<EngineInfo, "id" | "displayName">): EngineInfo => ({
  models: [],
  enabled: true,
  capabilities: {
    nativeQueue: false,
    midSessionModelSwitch: false,
    resume: false,
    hooks: false,
    effort: false,
  },
  ...partial,
})

describe("buildCreateBody", () => {
  it("always selects the requested engine", () => {
    expect(buildCreateBody({
      projectId: "p1",
      baseBranch: "main",
      engineId: "claude",
      prompt: "hi",
      model: "default",
      effort: "default",
    })).toEqual({
      projectId: "p1",
      baseBranch: "main",
      engineId: "claude",
      initialPrompt: "hi",
    })
  })

  it("threads non-default model and effort into creation", () => {
    expect(buildCreateBody({
      projectId: "p1",
      baseBranch: "release",
      engineId: "codex",
      prompt: "go",
      model: "gpt-5",
      effort: "high",
    })).toEqual({
      projectId: "p1",
      baseBranch: "release",
      engineId: "codex",
      initialPrompt: "go",
      model: "gpt-5",
      effort: "high",
    })
  })
})

describe("resolveDispatchDefaults / Copilot availability (Task 3.3)", () => {
  const claude = engine({
    id: "claude",
    displayName: "Claude",
    models: ["default", "opus"],
    availability: { available: true, accountHint: "ok", error: null },
  })
  const copilotUnavailable = engine({
    id: "copilot",
    displayName: "GitHub Copilot",
    availability: {
      available: false,
      accountHint: null,
      error: "not logged in. Run `gh auth login` to authenticate GitHub Copilot",
    },
  })
  const copilotOk = engine({
    id: "copilot",
    displayName: "GitHub Copilot",
    availability: { available: true, accountHint: "coolie-dev", error: null },
  })

  it("skips unavailable Copilot when choosing defaults", () => {
    expect(resolveDispatchDefaults(
      [copilotUnavailable, claude],
      { defaultEngine: "copilot", defaultModel: "default" },
    )).toEqual({ engineId: "claude", model: "default" })
  })

  it("uses preferred Copilot when available", () => {
    expect(resolveDispatchDefaults(
      [claude, copilotOk],
      { defaultEngine: "copilot", defaultModel: "default" },
    )).toEqual({ engineId: "copilot", model: "default" })
  })

  it("labels unavailable engines and surfaces login hint", () => {
    expect(isEngineUsable(copilotUnavailable)).toBe(false)
    expect(engineSelectLabel(copilotUnavailable)).toContain("GitHub Copilot")
    expect(engineSelectLabel(copilotUnavailable)).toMatch(/not logged in|unavailable/i)
    expect(copilotLoginHint(copilotUnavailable)).toMatch(/gh auth login/i)
    expect(copilotLoginHint(copilotOk)).toBeNull()
    expect(copilotLoginHint(claude)).toBeNull()
  })
})
