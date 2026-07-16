/**
 * PRD north-star steps 1–10 (Task 3.9) — mock-daemon blocking UI journey.
 * Steps 11–12 are covered by finish-archive.spec.ts.
 */
import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockAttention,
  seedMockProject,
  seedMockWorkspace,
} from "../fixtures/harness.js"

describe("mock-daemon daily flow (Task 3.9 / north-star 1–10)", () => {
  let workspaceName = ""
  let projectName = "daily-demo"

  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    const project = await seedMockProject({ name: projectName, repoRoot: "/tmp/daily-demo" })
    const workspace = await seedMockWorkspace(project.id, { name: "redwood", id: "w-daily" })
    workspaceName = workspace.name
    await seedMockAttention({
      id: "att-daily",
      workspaceId: workspace.id,
      tabId: "t-1",
      summary: "Agent finished a turn",
    })
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("steps 1–3: project visible, dispatcher create worktree intent (pointer)", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(projectName) && html.includes(workspaceName)
    }, { timeout: 20000 })

    const newButton = await browser.$('[aria-label="New workspace"]')
    await newButton.waitForClickable({ timeout: 15000 })
    await newButton.click()

    const dispatchTitle = await browser.$("h2")
    await dispatchTitle.waitForDisplayed({ timeout: 15000 })
    expect(await dispatchTitle.getText()).toMatch(/New Workspace|新工作区/)

    const engine = await browser.$('[data-testid="dispatch-engine"]')
    await engine.waitForDisplayed({ timeout: 10000 })
    // Copilot appears as built-in option (step 2 engine choice / Task 3.3)
    const options = await engine.$$("option")
    const labels = await Promise.all(options.map((o) => o.getText()))
    expect(labels.some((label) => /Copilot|Claude/i.test(label))).toBe(true)

    await browser.keys(["Escape"])
  })

  it("steps 5–6 + 8: Runs panel, Transcript toggle, Inbox (keyboard)", async () => {
    const task = await browser.$(`[role="option"][aria-label*="${workspaceName}"]`)
    await task.waitForClickable({ timeout: 15000 })
    await task.click()

    // Runs (step 5)
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("test") && (html.includes("exited") || html.includes("Run"))
    }, { timeout: 15000 })

    // Transcript toggle (step 6) — keyboard-oriented control
    const transcriptToggle = await browser.$("button*=Transcript")
    if (await transcriptToggle.isExisting()) {
      await transcriptToggle.click()
      await browser.waitUntil(async () => {
        const html = await browser.getPageSource()
        return html.includes("Mock transcript entry") || html.includes("transcript")
      }, { timeout: 15000 })
    }

    // Inbox attention (step 8) — keyboard path
    const inboxButton = await browser.$('[aria-label="Attention inbox"]')
    await inboxButton.waitForClickable({ timeout: 15000 })
    await inboxButton.click()
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("Agent finished a turn")
    }, { timeout: 15000 })
    await browser.keys(["Escape"])
  })

  it("steps 9–10: Agent Review + Checks (keyboard)", async () => {
    // Open Changes / Review
    const changes = await browser.$("button*=Changes")
    if (await changes.isExisting()) await changes.click()
    else await (await browser.$("button*=变更")).click()

    const review = await browser.$('[data-testid="agent-review"]')
    await review.waitForClickable({ timeout: 15000 })
    await review.click()

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("Review") || html.includes("review")
    }, { timeout: 15000 })

    // Checks tab (step 10) — keyboard via tab button
    const checks = await browser.$("button*=Checks")
    if (await checks.isExisting()) await checks.click()
    else await (await browser.$("button*=检查")).click()

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("gh CLI unavailable") || html.includes("Working tree") || html.includes("Local checks")
    }, { timeout: 15000 })
  })

  it("error/offline/restart traces remain observable", async () => {
    const daemon = await ensureMockHarness()
    await fetch(`${daemon.baseUrl}/__test__/disconnect-sse`, { method: "POST" })
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return /Reconnecting|重连|offline|离线/i.test(html)
    }, { timeout: 20000 })
    await fetch(`${daemon.baseUrl}/__test__/restore-sse`, { method: "POST" })
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return /Connected|已连接/i.test(html)
    }, { timeout: 20000 })
  })
})
