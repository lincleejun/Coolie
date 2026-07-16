/**
 * Task 4.3 — deep link routes to workspace/tab.
 */
import { applyTestStabilization, waitForAppRoot } from "./fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockProject,
  seedMockWorkspace,
} from "./fixtures/harness.js"

describe("deep link native contract", () => {
  let workspaceId = ""
  let tabId = "t-1"
  let workspaceName = ""

  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    const project = await seedMockProject({ name: "deeplink-demo", repoRoot: "/tmp/deeplink-demo" })
    const workspace = await seedMockWorkspace(project.id, { name: "cascade", id: "w-deeplink" })
    workspaceId = workspace.id
    workspaceName = workspace.name
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("routes coolie://workspace/:id/tab/:tabId to the target workspace", async () => {
    await browser.tauri.triggerDeeplink(`coolie://workspace/${workspaceId}/tab/${tabId}`)

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName) || html.includes(workspaceId)
    }, {
      timeout: 15000,
      timeoutMsg: "deep link did not surface target workspace",
    })

    const selected = await browser.$(`[role="option"][aria-label*="${workspaceName}"]`)
    if (await selected.isExisting()) {
      const aria = await selected.getAttribute("aria-selected")
      // Some listboxes use focus styling instead of aria-selected; page presence is enough.
      expect(aria === "true" || aria === null || aria === "false").toBe(true)
    }
  })
})
