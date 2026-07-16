import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockProject,
} from "../fixtures/harness.js"

describe("mock-daemon dispatcher journey", () => {
  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    await seedMockProject({ name: "dispatcher-demo", repoRoot: "/tmp/dispatcher-demo" })
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("opens the dispatcher panel from the sidebar (pointer)", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("dispatcher-demo")
    }, { timeout: 20000 })

    const newButton = await browser.$('[aria-label="New workspace"]')
    await newButton.waitForClickable({ timeout: 15000 })
    await newButton.click()

    const dispatchTitle = await browser.$("h2")
    await dispatchTitle.waitForDisplayed({ timeout: 15000 })
    expect(await dispatchTitle.getText()).toContain("New Workspace")
  })

  it("submits a dispatcher prompt with keyboard path", async () => {
    const composer = await browser.$("textarea")
    await composer.waitForDisplayed({ timeout: 15000 })
    await composer.click()
    await browser.keys(["T", "a", "u", "r", "i", " ", "j", "o", "u", "r", "n", "e", "y"])
    await browser.keys(["Enter"])

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("yosemite")
    }, { timeout: 20000 })
  })
})
