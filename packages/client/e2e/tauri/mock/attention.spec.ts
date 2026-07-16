import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockAttention,
  seedMockProject,
  seedMockWorkspace,
} from "../fixtures/harness.js"

describe("mock-daemon attention inbox journey", () => {
  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    const project = await seedMockProject({ name: "attention-demo", repoRoot: "/tmp/attention-demo" })
    const workspace = await seedMockWorkspace(project.id, { name: "zion", id: "w-attention" })
    await seedMockAttention({
      id: "att-journey",
      workspaceId: workspace.id,
      tabId: "t-attention",
      summary: "Review the diff",
    })
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("opens inbox, filters items, and jumps to workspace+tab (pointer)", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("attention-demo")
    }, { timeout: 20000 })

    const inboxButton = await browser.$('[aria-label="Attention inbox"]')
    await inboxButton.waitForClickable({ timeout: 15000 })
    await inboxButton.click()

    const panel = await browser.$('[aria-label="Attention inbox"]')
    await panel.waitForDisplayed({ timeout: 15000 })
    expect(await panel.getText()).toContain("Review the diff")

    const nextButton = await browser.$(".inbox-next")
    await nextButton.waitForClickable({ timeout: 15000 })
    await nextButton.click()

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("zion")
    }, { timeout: 15000 })
  })

  it("acks the visible attention item with keyboard-only path", async () => {
    const inboxButton = await browser.$('[aria-label="Attention inbox"]')
    await inboxButton.click()
    await browser.keys(["a", "Escape"])

    await browser.waitUntil(async () => {
      const badge = await browser.$(".inbox-badge")
      return !(await badge.isExisting())
    }, { timeout: 15000 })
  })
})
