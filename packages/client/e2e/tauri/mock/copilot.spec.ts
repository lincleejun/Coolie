import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockProject,
  setMockConfig,
} from "../fixtures/harness.js"

describe("mock-daemon Copilot availability journey (Task 3.3)", () => {
  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    await seedMockProject({ name: "copilot-demo", repoRoot: "/tmp/copilot-demo" })
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("shows built-in Copilot login guidance in Settings → Engines", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("copilot-demo")
    }, { timeout: 20000 })

    const settingsButton = await browser.$('[aria-label="Settings"]')
    await settingsButton.waitForClickable({ timeout: 15000 })
    await settingsButton.click()

    const enginesNav = await browser.$("button*=Engines")
    if (!(await enginesNav.isExisting())) {
      const enginesNavZh = await browser.$("button*=引擎")
      await enginesNavZh.waitForClickable({ timeout: 10000 })
      await enginesNavZh.click()
    } else {
      await enginesNav.click()
    }

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("GitHub Copilot") && (
        html.includes("gh auth login") || html.includes("built-in") || html.includes("内置")
      )
    }, { timeout: 15000 })

    await browser.keys(["Escape"])
  })

  it("shows login prompt in Dispatcher when Copilot is selected without auth", async () => {
    const newButton = await browser.$('[aria-label="New workspace"]')
    await newButton.waitForClickable({ timeout: 15000 })
    await newButton.click()

    const engineSelect = await browser.$('[data-testid="dispatch-engine"]')
    await engineSelect.waitForDisplayed({ timeout: 15000 })
    await engineSelect.selectByAttribute("value", "copilot")

    const hint = await browser.$('[data-testid="dispatch-copilot-auth"]')
    await hint.waitForDisplayed({ timeout: 10000 })
    expect(await hint.getText()).toMatch(/gh auth login|Copilot/i)

    await setMockConfig({
      engines: [
        {
          id: "claude",
          displayName: "Claude",
          models: ["default"],
          enabled: true,
          custom: false,
          availability: { available: true, accountHint: "ok", error: null },
        },
        {
          id: "copilot",
          displayName: "GitHub Copilot",
          models: [],
          enabled: true,
          custom: false,
          availability: { available: true, accountHint: "coolie-dev", error: null },
        },
      ],
    })

    // Re-open settings refresh path: close dispatch, refresh via settings, reopen.
    await browser.keys(["Escape"])
    const settingsButton = await browser.$('[aria-label="Settings"]')
    await settingsButton.click()
    const enginesNav = await browser.$("button*=Engines")
    if (await enginesNav.isExisting()) await enginesNav.click()
    else await (await browser.$("button*=引擎")).click()
    const refresh = await browser.$('[data-testid="settings-refresh-engines"]')
    await refresh.waitForClickable({ timeout: 10000 })
    await refresh.click()
    await browser.keys(["Escape"])

    await newButton.click()
    await engineSelect.waitForDisplayed({ timeout: 15000 })
    await engineSelect.selectByAttribute("value", "copilot")
    await browser.waitUntil(async () => {
      const auth = await browser.$('[data-testid="dispatch-copilot-auth"]')
      return !(await auth.isExisting())
    }, { timeout: 15000 })
  })
})
