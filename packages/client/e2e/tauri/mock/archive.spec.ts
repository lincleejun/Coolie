import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockProject,
  seedMockWorkspace,
} from "../fixtures/harness.js"

describe("mock-daemon archive journey", () => {
  let workspaceId = ""
  let workspaceName = ""

  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    const project = await seedMockProject({ name: "archive-demo", repoRoot: "/tmp/archive-demo" })
    const workspace = await seedMockWorkspace(project.id, { name: "glacier" })
    workspaceId = workspace.id
    workspaceName = workspace.name
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("archives an active workspace from the task menu (pointer)", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName)
    }, { timeout: 20000 })

    const task = await browser.$(`[role="option"][aria-label*="${workspaceName}"]`)
    await task.waitForClickable({ timeout: 15000 })
    await task.click()

    const more = await browser.$('[aria-label="More actions"]')
    await more.waitForClickable({ timeout: 15000 })
    await more.click()

    const archive = await browser.$('[role="menuitem"]')
    await archive.waitForClickable({ timeout: 15000 })
    await archive.click()

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("archived") || html.includes("Archived")
    }, { timeout: 20000 })
  })

  it("restores an archived workspace (keyboard)", async () => {
    const daemon = await ensureMockHarness()
    await fetch(`${daemon.baseUrl}/workspaces/${workspaceId}/unarchive`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    })

    await browser.keys(["Escape"])
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName) && !html.includes("archived")
    }, { timeout: 20000 })
  })
})
