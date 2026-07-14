import { describe, expect, it } from "vitest"
import { buildCoolieUrl, COOLIE_SCHEME, parseCoolieUrl } from "../src/links.js"

describe("buildCoolieUrl", () => {
  it("builds workspace, tab, and project links without credentials", () => {
    expect(buildCoolieUrl({ kind: "workspace", workspaceId: "w1" })).toBe("coolie://workspace/w1")
    expect(buildCoolieUrl({ kind: "workspace", workspaceId: "W_1", tabId: "t.2" }))
      .toBe("coolie://workspace/W_1/tab/t.2")
    expect(buildCoolieUrl({ kind: "project", projectId: "p-3" })).toBe("coolie://project/p-3")
  })

  it("rejects unsafe or empty ids instead of emitting malformed links", () => {
    expect(() => buildCoolieUrl({ kind: "workspace", workspaceId: "" })).toThrow(/workspaceId/)
    expect(() => buildCoolieUrl({ kind: "workspace", workspaceId: "a/b" })).toThrow(/workspaceId/)
    expect(() => buildCoolieUrl({ kind: "workspace", workspaceId: "w1", tabId: "x?token=secret" }))
      .toThrow(/tabId/)
    expect(() => buildCoolieUrl({ kind: "project", projectId: "p#fragment" })).toThrow(/projectId/)
  })
})

describe("parseCoolieUrl", () => {
  it("round-trips every supported target", () => {
    const targets = [
      { kind: "workspace", workspaceId: "w1" },
      { kind: "workspace", workspaceId: "W1", tabId: "T2" },
      { kind: "project", projectId: "p3" },
    ] as const
    for (const target of targets) expect(parseCoolieUrl(buildCoolieUrl(target))).toEqual(target)
  })

  it("treats the scheme case-insensitively while preserving id case", () => {
    expect(parseCoolieUrl("COOLIE://workspace/W1")).toEqual({ kind: "workspace", workspaceId: "W1" })
    expect(parseCoolieUrl("Coolie://project/P3")).toEqual({ kind: "project", projectId: "P3" })
  })

  it("ignores query and fragment after a valid path, and accepts trailing slashes", () => {
    expect(parseCoolieUrl("coolie://workspace/w1///?source=cli#focus"))
      .toEqual({ kind: "workspace", workspaceId: "w1" })
    expect(parseCoolieUrl("coolie://workspace/w1/tab/t2?source=cli#focus"))
      .toEqual({ kind: "workspace", workspaceId: "w1", tabId: "t2" })
  })

  it.each([
    "",
    "https://workspace/w1",
    "coolie:workspace/w1",
    "coolie://bogus/x",
    "coolie://Workspace/w1",
    "coolie://workspace/",
    "coolie://workspace//w1",
    "coolie://workspace/w1/tab/",
    "coolie://workspace/w1/bogus/t2",
    "coolie://workspace/a b",
    "coolie://workspace/a%2Fb",
    "coolie://project/p1/extra",
  ])("rejects malformed or unknown input: %s", (raw) => {
    expect(parseCoolieUrl(raw)).toBeNull()
  })

  it("exports the canonical scheme", () => {
    expect(COOLIE_SCHEME).toBe("coolie")
  })
})
