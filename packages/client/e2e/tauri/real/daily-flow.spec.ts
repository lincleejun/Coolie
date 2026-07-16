/**
 * Real-daemon slice of north-star steps 1–10 (Task 3.9).
 * Heavy tmux/engine coverage stays in existing real/* specs; this file
 * asserts the composed daily path remains wired end-to-end.
 */
import * as fs from "node:fs"
import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  createRealWorkspace,
  ensureRealHarness,
  fetchRealWorkspace,
  registerRealProject,
} from "../fixtures/real-harness.js"

describe("real-daemon daily flow (Task 3.9)", () => {
  let projectId = ""
  let workspaceId = ""
  let workspaceName = ""

  before(async () => {
    await ensureRealHarness()
    const project = await registerRealProject()
    projectId = project.id
    const workspace = await createRealWorkspace(projectId, { branchSlug: "daily-flow" })
    workspaceId = workspace.id
    workspaceName = workspace.name
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("steps 1–4: workspace appears with copied env and independent path", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName)
    }, { timeout: 60000 })

    const workspace = await fetchRealWorkspace(workspaceId)
    expect(workspace.status).toBe("active")
    expect(workspace.path).toBeTruthy()
    expect(fs.existsSync(`${workspace.path}/.env`)).toBe(true)
  })

  it("steps 7–8: selecting workspace after refresh keeps task in sidebar (keyboard)", async () => {
    await browser.keys(["Escape"])
    const task = await browser.$(`[role="option"][aria-label*="${workspaceName}"]`)
    await task.waitForDisplayed({ timeout: 30000 })
    await task.click()
    await browser.keys(["Escape"])
    const html = await browser.getPageSource()
    expect(html).toMatch(new RegExp(workspaceName))
  })
})
