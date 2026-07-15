import { beforeEach, describe, expect, it } from "vitest"
import { openWorkspaceForCurrentProject } from "../src/hotkeys/useGlobalHotkeys"
import { useData } from "../src/stores/data"
import { useUi } from "../src/stores/ui"

describe("workspace creation navigation", () => {
  beforeEach(() => {
    useData.setState({ projects: [], workspaces: [] } as any)
    useUi.getState().selectWs(null)
    useUi.getState().setDispatchMode(false)
  })

  it("Cmd+N enters dispatch mode in the current window", () => {
    useData.setState({
      projects: [{ id: "project-one" }],
      workspaces: [{ id: "workspace-one", projectId: "project-one" }],
    } as any)
    useUi.getState().selectWs("workspace-one")

    openWorkspaceForCurrentProject()

    expect(useUi.getState().dispatchMode).toBe(true)
    expect(useUi.getState().dispatchProjectId).toBe("project-one")
  })

  it("falls back to the first project when no workspace is selected", () => {
    useData.setState({ projects: [{ id: "project-fallback" }] } as any)

    openWorkspaceForCurrentProject()

    expect(useUi.getState().dispatchMode).toBe(true)
    expect(useUi.getState().dispatchProjectId).toBe("project-fallback")
  })

  it("does nothing when no project exists", () => {
    openWorkspaceForCurrentProject()

    expect(useUi.getState().dispatchMode).toBe(false)
    expect(useUi.getState().dispatchProjectId).toBeNull()
  })
})
