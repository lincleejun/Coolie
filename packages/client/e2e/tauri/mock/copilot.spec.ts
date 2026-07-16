import { reloadAppAfterSeed } from "../fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockProject,
  setMockConfig,
} from "../fixtures/harness.js"

const capabilities = {
  nativeQueue: false,
  midSessionModelSwitch: false,
  resume: false,
  hooks: false,
  effort: false,
}

const openDispatch = async (): Promise<void> => {
  const { clickByAriaLabel } = await import("../fixtures/app.js")
  const cta = await browser.$(".ob-action.wide")
  if (await cta.isExisting()) {
    await cta.click()
  } else {
    await clickByAriaLabel(["New workspace", "新建 workspace"])
  }
  await browser.$('[data-testid="dispatch-engine"]').waitForDisplayed({ timeout: 15000 })
}

const selectEngine = async (engineId: string): Promise<void> => {
  await browser.execute((id: string) => {
    const select = document.querySelector<HTMLSelectElement>('[data-testid="dispatch-engine"]')
    if (!select) return
    select.value = id
    select.dispatchEvent(new Event("change", { bubbles: true }))
  }, engineId)
}

describe("mock-daemon Copilot availability journey (Task 3.3)", () => {
  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    // Project-only seed so the center "+ New workspace" CTA is available for dispatch.
    await seedMockProject({ name: "copilot-demo", repoRoot: "/tmp/copilot-demo" })
    await reloadAppAfterSeed()
  })

  it("shows built-in Copilot login guidance in Settings → Engines", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("copilot-demo")
    }, { timeout: 20000 })

    const { clickByAriaLabel, clickByText } = await import("../fixtures/app.js")
    await clickByAriaLabel(["Settings", "设置"])
    await browser.$(".settings-shell, .settings-nav").waitForDisplayed({ timeout: 15000 })
    await clickByText(["Engines", "引擎"])

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("GitHub Copilot") && (
        html.includes("gh auth login") || html.includes("built-in") || html.includes("内置")
      )
    }, { timeout: 15000 })

    await browser.keys(["Escape"])
  })

  it("shows login prompt in Dispatcher when Copilot is selected without auth", async () => {
    await openDispatch()
    await selectEngine("copilot")

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
          capabilities,
          availability: { available: true, accountHint: "ok", error: null },
        },
        {
          id: "copilot",
          displayName: "GitHub Copilot",
          models: [],
          enabled: true,
          custom: false,
          capabilities,
          availability: { available: true, accountHint: "coolie-dev", error: null },
        },
      ],
    })

    // Refresh engines from settings, then reopen dispatch with updated availability.
    await browser.keys(["Escape"])
    const { clickByAriaLabel, clickByText } = await import("../fixtures/app.js")
    await clickByAriaLabel(["Settings", "设置"])
    await browser.$(".settings-shell, .settings-nav").waitForDisplayed({ timeout: 15000 })
    await clickByText(["Engines", "引擎"])
    const refresh = await browser.$('[data-testid="settings-refresh-engines"]')
    await refresh.waitForClickable({ timeout: 10000 })
    await refresh.click()
    await browser.keys(["Escape"])
    await browser.pause(300)

    await openDispatch()
    await selectEngine("copilot")
    await browser.waitUntil(async () => {
      const auth = await browser.$('[data-testid="dispatch-copilot-auth"]')
      return !(await auth.isExisting())
    }, { timeout: 15000 })
  })
})
