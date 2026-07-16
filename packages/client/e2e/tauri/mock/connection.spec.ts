import { reloadAppAfterSeed } from "../fixtures/app.js"
import {
  emitMockEvent,
  ensureMockHarness,
  mockRequestLog,
  resetMockHarness,
} from "../fixtures/harness.js"

describe("mock-daemon connection journey", () => {
  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    await reloadAppAfterSeed()
  })

  it("connects to the mock daemon and renders onboarding (pointer)", async () => {
    const heading = await browser.$("h1")
    await heading.waitForDisplayed({ timeout: 20000 })
    expect(await heading.getText()).toMatch(/Open Project|打开项目/)

    const log = await mockRequestLog()
    const paths = log.map((entry) => entry.path)
    expect(paths).toContain("/health")
    expect(paths).toContain("/config")
    expect(paths).toContain("/projects")
    expect(paths).toContain("/workspaces")
    expect(paths).toContain("/events/stream")
  })

  it("shows offline/replay status after SSE disconnect (keyboard)", async () => {
    const daemon = await ensureMockHarness()
    await fetch(`${daemon.baseUrl}/__test__/disconnect-sse`, { method: "POST" })
    await emitMockEvent({ type: "workspace.created", workspaceId: "w-replay", payload: { id: "w-replay" } })

    await browser.keys(["Escape"])
    const body = await browser.getPageSource()
    expect(body).toMatch(/Reconnecting|重连/)

    await fetch(`${daemon.baseUrl}/events/stream?after=0`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    }).then((response) => response.body?.cancel())

    await fetch(`${daemon.baseUrl}/__test__/restore-sse`, { method: "POST" })
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("Connected") || html.includes("已连接")
    }, { timeout: 20000 })
  })
})
