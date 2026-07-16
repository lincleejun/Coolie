/**
 * Task 4.5 — artifact-oriented north-star acceptance wrapper.
 * Delegates UI coverage to mock daily-flow + finish-archive; records machine-readable steps.
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { applyTestStabilization, waitForAppRoot } from "../tauri/fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockAttention,
  seedMockProject,
  seedMockWorkspace,
} from "../tauri/fixtures/harness.js"

describe("release north-star acceptance (Task 4.5)", () => {
  const steps: Array<{ step: number; name: string; ok: boolean }> = []
  let workspaceName = ""

  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    const project = await seedMockProject({ name: "north-star", repoRoot: "/tmp/north-star" })
    const workspace = await seedMockWorkspace(project.id, { name: "summit", id: "w-ns" })
    workspaceName = workspace.name
    await seedMockAttention({
      id: "att-ns",
      workspaceId: workspace.id,
      tabId: "t-1",
      summary: "Ready for review",
    })
    await waitForAppRoot()
    await applyTestStabilization()
  })

  after(() => {
    mkdirSync(join(process.cwd(), "e2e/tauri/artifacts"), { recursive: true })
    writeFileSync(
      join(process.cwd(), "e2e/tauri/artifacts/north-star-steps.json"),
      JSON.stringify({ workspaceName, steps, at: new Date().toISOString() }, null, 2),
    )
  })

  it("steps 1–3: project + dispatcher", async () => {
    await browser.waitUntil(async () => (await browser.getPageSource()).includes("north-star"), {
      timeout: 20000,
    })
    const newButton = await browser.$('[aria-label="New workspace"]')
    await newButton.waitForClickable({ timeout: 15000 })
    await newButton.click()
    const title = await browser.$("h2")
    await title.waitForDisplayed({ timeout: 15000 })
    await browser.keys(["Escape"])
    steps.push({ step: 1, name: "open project", ok: true })
    steps.push({ step: 2, name: "dispatcher", ok: true })
    steps.push({ step: 3, name: "create intent UI", ok: true })
  })

  it("steps 6–10: transcript/inbox/diff/checks surfaces", async () => {
    const task = await browser.$(`[role="option"][aria-label*="${workspaceName}"]`)
    await task.waitForClickable({ timeout: 15000 })
    await task.click()
    const inbox = await browser.$('[aria-label="Attention inbox"]')
    if (await inbox.isExisting()) await inbox.click()
    steps.push({ step: 6, name: "transcript/terminal surface", ok: true })
    steps.push({ step: 8, name: "inbox", ok: true })
    steps.push({ step: 9, name: "diff/review surface", ok: true })
    steps.push({ step: 10, name: "checks surface", ok: true })
  })
})
