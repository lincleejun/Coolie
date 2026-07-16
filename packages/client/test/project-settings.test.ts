import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ProjectSettings } from "../src/settings/ProjectSettings.js"
import { useSettings } from "../src/settings/settings.js"
import { useData } from "../src/stores/data.js"
import { t } from "../src/i18n/index.js"

describe("ProjectSettings (Task 2B.4)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useSettings.setState({ filesToCopyByProject: {} })
    useData.setState({ projects: [], workspaces: [], getApi: () => null } as any)
  })

  it("renders preview summary without file contents", () => {
    useData.setState({
      projects: [{ id: "p1", name: "Demo", repoRoot: "/tmp/demo", defaultBaseBranch: "main", createdAt: 1 }],
      workspaces: [{ id: "w1", projectId: "p1", name: "Task", kind: "task" }],
      getApi: () => ({
        req: vi.fn(async () => ({
          source: "default",
          entries: [{ relativePath: ".env", size: 12 }, { relativePath: "secrets/key", size: 8 }],
          totalBytes: 20,
        })),
      }),
    } as any)

    const html = renderToStaticMarkup(createElement(ProjectSettings, { projectId: "p1" }))
    expect(html).toContain(t("projectSettings.title", "en"))
    expect(html).not.toContain("SECRET")
  })

  it("persists editable project patterns in settings store", () => {
    useSettings.getState().setFilesToCopyPatterns("p1", [".env*", "local/"])
    expect(useSettings.getState().filesToCopyPatterns("p1")).toEqual([".env*", "local/"])
  })
})
