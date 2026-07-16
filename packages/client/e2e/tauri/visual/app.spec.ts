import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockAttention,
  seedMockProject,
  seedMockWorkspace,
} from "../fixtures/harness.js"
import { assertFocusable, assertWithinViewport, stabilizeForStructure } from "./stabilize.js"

describe("desktop structure diagnostics", () => {
  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    await seedMockProject({ name: "structure-demo", repoRoot: "/tmp/structure-demo" })
    await seedMockWorkspace("p-1", { name: "yosemite", id: "w-structure" })
    await waitForAppRoot()
    await stabilizeForStructure()
  })

  it("asserts sidebar and dispatcher layout bounds", async () => {
    await assertWithinViewport(".sidebar", "sidebar")
    await assertFocusable('[aria-label="Open Project"]', "open project")

    const newButton = await browser.$('[aria-label="New workspace"]')
    await newButton.waitForClickable({ timeout: 15000 })
    await newButton.click()

    const dispatchTitle = await browser.$("h2")
    await dispatchTitle.waitForDisplayed({ timeout: 15000 })
    await assertWithinViewport("h2", "dispatcher title")
  })

  it("asserts settings and diff panel structure on keyboard path", async () => {
    await browser.keys(["Escape"])
    const workspaceRow = await browser.$('[data-workspace-id="w-structure"]')
    await workspaceRow.waitForClickable({ timeout: 15000 })
    await workspaceRow.click()

    const changesButton = await browser.$('[aria-label="Changes"]')
    await changesButton.waitForClickable({ timeout: 15000 })
    await changesButton.click()
    await assertWithinViewport(".col-right", "diff panel")

    const settingsButton = await browser.$('[aria-label="Settings"]')
    await settingsButton.waitForClickable({ timeout: 15000 })
    await settingsButton.click()
    await assertWithinViewport(".modal", "settings dialog")
    await browser.keys(["Escape"])
  })

  it("captures a failure-diagnostic screenshot artifact without blocking on pixel diff", async () => {
    await applyTestStabilization()
    await browser.saveScreenshot("./e2e/tauri/artifacts/screenshots/structure-dark-baseline.png")
    const html = await browser.getPageSource()
    expect(html).toMatch(/structure-demo|yosemite/)
  })
})
