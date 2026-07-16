import { reloadAppAfterSeed } from "../fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockProject,
  seedMockWorkspace,
} from "../fixtures/harness.js"

describe("mock-daemon finish→archive journey (Task 3.8)", () => {
  let workspaceName = ""
  let workspaceId = ""
  let token = ""
  let baseUrl = ""

  before(async () => {
    const daemon = await ensureMockHarness()
    token = daemon.token
    baseUrl = daemon.baseUrl
    await resetMockHarness()
    const project = await seedMockProject({ name: "finish-demo", repoRoot: "/tmp/finish-demo" })
    const workspace = await seedMockWorkspace(project.id, {
      name: "olympic",
      id: "w-finish",
      finishResult: {
        prUrl: "https://example.test/pr/42",
        mergedBack: false,
        warnings: [],
        finishedAt: Date.now(),
        createPr: true,
        mergeBack: false,
      },
    })
    workspaceName = workspace.name
    workspaceId = workspace.id
    await reloadAppAfterSeed()
  })

  it("shows Open PR / Archive / Keep working on finish success surface", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName)
    }, { timeout: 20000 })

    const task = await browser.$(`[role="option"][aria-label*="${workspaceName}"]`)
    await task.waitForClickable({ timeout: 15000 })
    await task.click()

    const panel = await browser.$('[data-testid="finish-success"]')
    await panel.waitForDisplayed({ timeout: 20000 })
    expect(await panel.getText()).toMatch(/Finished|完成|PR|Pull request/i)
    expect(await browser.$('[data-testid="finish-open-pr"]').isExisting()).toBe(true)
    expect(await browser.$('[data-testid="finish-archive"]').isExisting()).toBe(true)
    expect(await browser.$('[data-testid="finish-keep-working"]').isExisting()).toBe(true)
  })

  it("archives from success panel (mock-success path)", async () => {
    const archiveBtn = await browser.$('[data-testid="finish-archive"]')
    await archiveBtn.waitForClickable({ timeout: 10000 })
    await archiveBtn.click()

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return /archived|Archived|已归档/i.test(html)
    }, { timeout: 20000 })
  })

  it("retains finishResult when archive returns 409 (API invariant)", async () => {
    // Restore active + finishResult for failure case
    await fetch(`${baseUrl}/workspaces/${workspaceId}/unarchive`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    })
    await fetch(`${baseUrl}/workspaces/${workspaceId}/finish`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ createPr: true, title: "demo" }),
    })

    const archiveRes = await fetch(`${baseUrl}/workspaces/${workspaceId}/archive`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fail: true }),
    })
    expect(archiveRes.status).toBe(409)

    const list = await fetch(`${baseUrl}/workspaces`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json()) as Array<{ id: string; finishResult?: { prUrl?: string }; status: string }>
    const ws = list.find((item) => item.id === workspaceId)
    expect(ws?.status).toBe("active")
    expect(ws?.finishResult?.prUrl).toContain("/pr/")
  })

  it("PR-disabled finish returns conflict (gh unavailable)", async () => {
    const res = await fetch(`${baseUrl}/workspaces/${workspaceId}/finish`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ createPr: true, failGh: true }),
    })
    expect(res.status).toBe(409)
  })
})
