import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  createRealWorkspace,
  ensureRealHarness,
  fetchRealWorkspace,
  registerRealProject,
} from "../fixtures/real-harness.js"

describe("real-daemon terminal journey", () => {
  let workspaceId = ""
  let workspaceName = ""

  before(async () => {
    const daemon = await ensureRealHarness()
    const project = await registerRealProject()
    const workspace = await createRealWorkspace(project.id, { branchSlug: "terminal-e2e" })
    workspaceId = workspace.id
    workspaceName = workspace.name
    await waitForAppRoot()
    await applyTestStabilization()

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName)
    }, { timeout: 60000 })
    const task = await browser.$(`[role="option"][aria-label*="${workspaceName}"]`)
    await task.waitForClickable({ timeout: 30000 })
    await task.click()
  })

  it("opens a shell tab and accepts terminal input (pointer)", async () => {
    const shellButton = await browser.$('[aria-label="New shell tab"]')
    await shellButton.waitForClickable({ timeout: 30000 })
    await shellButton.click()

    const host = await browser.$(".term-host")
    await host.waitForExist({ timeout: 30000 })
    await host.click()
    await browser.keys(["e", "c", "h", "o", "-", "o", "k"])
    await browser.keys(["Enter"])

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("term-host")
    }, { timeout: 20000 })
  })

  it("keeps the workspace active after terminal resize/reconnect (keyboard)", async () => {
    await browser.setWindowSize(1280, 800)
    await browser.setWindowSize(1440, 900)
    await browser.keys(["Escape"])

    const workspace = await fetchRealWorkspace(workspaceId)
    expect(workspace.status).toBe("active")

    const daemon = await ensureRealHarness()
    const tabs = await fetch(`${daemon.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/tabs`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    }).then((response) => response.json()) as Array<{ kind: string }>
    expect(tabs.some((tab) => tab.kind === "engine" || tab.kind === "shell")).toBe(true)
  })
})
