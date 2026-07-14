import { describe, expect, it } from "vitest"
import { projectIdFromWindowSearch, workspaceWindowUrl } from "../src/chrome/workspaceWindow"

describe("workspace creation window routing", () => {
  it("encodes the project id in the child-window URL", () => {
    expect(workspaceWindowUrl("project/a b")).toBe("/?newWorkspace=project%2Fa%20b")
  })

  it("reads only a non-empty project id", () => {
    expect(projectIdFromWindowSearch("?newWorkspace=project%2Fa")).toBe("project/a")
    expect(projectIdFromWindowSearch("?newWorkspace=%20")).toBeNull()
    expect(projectIdFromWindowSearch("?other=value")).toBeNull()
  })
})
