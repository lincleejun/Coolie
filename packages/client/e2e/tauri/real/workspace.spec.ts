import * as fs from "node:fs"
import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  createRealWorkspace,
  ensureRealHarness,
  fetchRealWorkspace,
  registerRealProject,
} from "../fixtures/real-harness.js"

describe("real-daemon workspace journey", () => {
  let projectId = ""
  let workspaceId = ""
  let workspaceName = ""

  before(async () => {
    await ensureRealHarness()
    const project = await registerRealProject()
    projectId = project.id
    const workspace = await createRealWorkspace(projectId, { branchSlug: "copy-setup" })
    workspaceId = workspace.id
    workspaceName = workspace.name
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("creates a workspace and surfaces it in the sidebar (pointer)", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName)
    }, { timeout: 60000 })

    const task = await browser.$(`[role="option"][aria-label*="${workspaceName}"]`)
    await task.waitForClickable({ timeout: 30000 })
    await task.click()
  })

  it("copies .env before setup completes (keyboard)", async () => {
    const workspace = await fetchRealWorkspace(workspaceId)
    expect(workspace.status).toBe("active")
    expect(fs.existsSync(`${workspace.path}/.env`)).toBe(true)
    expect(fs.readFileSync(`${workspace.path}/.env`, "utf8")).toContain("SECRET=42")
    expect(fs.existsSync(`${workspace.path}/.coolie/port.txt`)).toBe(true)

    await browser.keys(["Escape"])
    const body = await browser.getPageSource()
    expect(body).toMatch(new RegExp(workspaceName))
  })
})
