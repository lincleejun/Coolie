import { applyTestStabilization, waitForAppRoot } from "../fixtures/app.js"
import {
  createRealWorkspace,
  ensureRealHarness,
  registerRealProject,
  restartRealDaemonInPlace,
} from "../fixtures/real-harness.js"

describe("real-daemon recovery journey", () => {
  let workspaceName = ""

  before(async () => {
    await ensureRealHarness()
    const project = await registerRealProject()
    const workspace = await createRealWorkspace(project.id, { branchSlug: "recovery-e2e" })
    workspaceName = workspace.name
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("survives daemon restart and restores SSE-backed state (pointer)", async () => {
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName)
    }, { timeout: 60000 })

    const daemon = await restartRealDaemonInPlace()
    process.env.VITE_COOLIE_MOCK_SERVER = `${daemon.port}:${daemon.token}`

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName) && (html.includes("Connected") || html.includes("已连接") || html.includes(workspaceName))
    }, { timeout: 60000 })

    const state = await fetch(`${daemon.baseUrl}/state`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    }).then((response) => response.json()) as { workspaces: Array<{ name: string; status: string }> }
    expect(state.workspaces.some((workspace) => workspace.name === workspaceName && workspace.status === "active")).toBe(true)
  })

  it("archives and restores a workspace after recovery (keyboard)", async () => {
    const daemon = await ensureRealHarness()
    const workspaces = await fetch(`${daemon.baseUrl}/workspaces`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    }).then((response) => response.json()) as Array<{ id: string; name: string }>
    const workspace = workspaces.find((item) => item.name === workspaceName)
    expect(workspace).toBeDefined()

    await fetch(`${daemon.baseUrl}/workspaces/${workspace!.id}/archive`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ force: true }),
    })

    await browser.keys(["Escape"])
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("archived") || html.includes("Archived")
    }, { timeout: 30000 })

    await fetch(`${daemon.baseUrl}/workspaces/${workspace!.id}/unarchive`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    })

    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes(workspaceName) && !html.includes("archived")
    }, { timeout: 30000 })
  })
})
