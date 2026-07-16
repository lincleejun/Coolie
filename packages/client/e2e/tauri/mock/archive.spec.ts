import { reloadAppAfterSeed } from "../fixtures/app.js"
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
    await reloadAppAfterSeed()
  })

  it("archives an active workspace from the task menu (pointer)", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName)
    }, { timeout: 20000 })

    const task = await browser.$(`[role="option"][aria-label*="${workspaceName}"]`)
    await task.waitForClickable({ timeout: 15000 })
    await task.click()

    const { clickByAriaLabel, clickByText } = await import("../fixtures/app.js")
    await clickByAriaLabel(["More actions", "更多动作"])
    // First menuitem is Pin — select Archive by label text (not CSS+*= which WDIO rejects).
    await clickByText(["Archive task", "归档任务"])

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return /Archived|已归档/.test(html)
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
    await reloadAppAfterSeed()
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName) && !/archived|Archived|已归档/i.test(html)
    }, { timeout: 20000 })
  })
})
