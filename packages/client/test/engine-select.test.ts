import { describe, expect, it } from "vitest"
import { buildCreateBody } from "../src/composer/Dispatch.js"

describe("buildCreateBody", () => {
  it("always selects the requested engine", () => {
    expect(buildCreateBody({
      projectId: "p1",
      engineId: "claude",
      prompt: "hi",
      model: "default",
      effort: "default",
    })).toEqual({
      projectId: "p1",
      engineId: "claude",
      initialPrompt: "hi",
    })
  })

  it("threads non-default model and effort into creation", () => {
    expect(buildCreateBody({
      projectId: "p1",
      engineId: "codex",
      prompt: "go",
      model: "gpt-5",
      effort: "high",
    })).toEqual({
      projectId: "p1",
      engineId: "codex",
      initialPrompt: "go",
      model: "gpt-5",
      effort: "high",
    })
  })
})
