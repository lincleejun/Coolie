import { applyTestStabilization, waitForAppRoot } from "./fixtures/app.js"

describe("Tauri empty-state smoke", () => {
  before(async () => {
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("renders onboarding copy in the empty state", async () => {
    const heading = await browser.$('[role="heading"]')
    await heading.waitForExist({ timeout: 15000 })
    const text = await heading.getText()
    expect(text.length).toBeGreaterThan(0)
  })

  it("exposes the project onboarding region", async () => {
    const root = await browser.$("#root")
    expect(await root.isDisplayed()).toBe(true)
    const bodyText = await browser.getPageSource()
    expect(bodyText).toContain("Coolie")
  })
})
