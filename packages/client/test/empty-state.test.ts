import { describe, it, expect } from "vitest"
import { onboardingPlan, registerPickedDirectory } from "../src/chrome/EmptyState"

describe("onboardingPlan（B2 空态 onboarding 提交计划）", () => {
  it("open 模式 → POST /projects（repoRoot，两端去空白）", () => {
    expect(onboardingPlan("open", "  /path/to/repo  ")).toEqual({
      path: "/projects", body: { repoRoot: "/path/to/repo" },
    })
  })
  it("clone 模式 → POST /projects/clone（url）", () => {
    expect(onboardingPlan("clone", "https://github.com/a/b.git")).toEqual({
      path: "/projects/clone", body: { url: "https://github.com/a/b.git" },
    })
  })
  it("空输入 / 纯空白 / 未选模式 → null（不发请求）", () => {
    expect(onboardingPlan("open", "")).toBeNull()
    expect(onboardingPlan("clone", "   ")).toBeNull()
    expect(onboardingPlan("none", "/some/path")).toBeNull()
  })
})

describe("native directory onboarding", () => {
  it("registers the selected directory and treats cancellation as a no-op", async () => {
    const calls: string[] = []
    expect(await registerPickedDirectory(async () => "/repo", async (path) => { calls.push(path) })).toBe(true)
    expect(await registerPickedDirectory(async () => null, async (path) => { calls.push(path) })).toBe(false)
    expect(calls).toEqual(["/repo"])
  })
})
