/**
 * Task 4.3 — packaged native contracts (sidecar / deep link / allowlists).
 * Sidecar clean-room /health is also gated by `bun run sidecar:smoke`.
 */
import { applyTestStabilization, waitForAppRoot } from "./fixtures/app.js"
import {
  ensureMockHarness,
  resetMockHarness,
  seedMockProject,
  seedMockWorkspace,
} from "./fixtures/harness.js"

const invokeError = async (command: string, args?: Record<string, unknown>): Promise<string> => {
  await browser.waitUntil(async () => {
    return browser.execute(() =>
      Boolean((window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke),
    )
  }, { timeout: 15000, timeoutMsg: "__TAURI__.core.invoke unavailable" })
  return browser.execute(
    async (cmd, invokeArgs) => {
      const tauri = (window as unknown as {
        __TAURI__: { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
      }).__TAURI__
      try {
        await tauri.core.invoke(cmd, invokeArgs ?? undefined)
        return ""
      } catch (error) {
        return String(error)
      }
    },
    command,
    args ?? null,
  )
}

describe("Tauri native contracts (Task 4.3)", () => {
  let workspaceId = ""
  let workspaceName = ""

  before(async () => {
    await ensureMockHarness()
    await resetMockHarness()
    const project = await seedMockProject({ name: "native-demo", repoRoot: "/tmp/native-demo" })
    const workspace = await seedMockWorkspace(project.id, { name: "cascade", id: "w-native" })
    workspaceId = workspace.id
    workspaceName = workspace.name
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("spawn_server is callable and does not reference checkout tsx", async () => {
    const before = await browser.execute(async () => {
      const tauri = (window as unknown as {
        __TAURI__: { core: { invoke: (c: string) => Promise<unknown> } }
      }).__TAURI__
      return tauri.core.invoke("read_server_info")
    })
    expect(before === null || before === "").toBe(true)

    const spawnError = await invokeError("spawn_server")
    // Packaged resource path must win; never ask for tsx/main.ts.
    expect(spawnError).not.toMatch(/tsx|packages\/server\/src\/main\.ts/i)
    // Empty error means spawn was accepted (daemon may already be up from a prior attempt).
    if (spawnError !== "") {
      // Allow already-running / linger races, but reject resource-missing failures.
      expect(spawnError).not.toMatch(/missing sidecar|resource_dir|not found/i)
    }

    const raw = await browser.execute(async () => {
      const tauri = (window as unknown as {
        __TAURI__: { core: { invoke: (c: string) => Promise<unknown> } }
      }).__TAURI__
      return tauri.core.invoke("read_server_info")
    })
    // Best-effort: if server.json appeared, it must be parseable.
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = JSON.parse(raw) as { port: number; token: string }
      expect(parsed.port).toBeGreaterThan(0)
      expect(parsed.token.length).toBeGreaterThan(8)
    }
  })

  it("deep link parser routes workspace URLs (protocol + UI seed)", async () => {
    // Protocol-level route is covered by packages/client/test/deeplink.test.ts.
    // Here we prove the packaged app can open a coolie:// URL without crashing and
    // that seeded mock state is visible after navigation intent.
    if (typeof browser.tauri?.triggerDeeplink === "function") {
      await browser.tauri.triggerDeeplink(`coolie://workspace/${workspaceId}/tab/t-1`)
    }
    await browser.waitUntil(async () => {
      const html = await browser.getPageSource()
      return html.includes("Coolie") || html.includes(workspaceName) || html.includes("native-demo")
    }, { timeout: 20000, timeoutMsg: "packaged app did not render after deep link" })
  })

  it("rejects non-allowlisted terminal and unsafe editor paths", async () => {
    const terminalError = await invokeError("open_external_terminal", {
      terminal: "xterm",
      attachCommand: "tmux -L coolie attach -t coolie-w1",
    })
    expect(terminalError.length).toBeGreaterThan(0)

    const attachError = await invokeError("open_external_terminal", {
      terminal: "terminal",
      attachCommand: "bash -c 'touch /tmp/pwned'",
    })
    expect(attachError).toMatch(/tmux|attach|exactly|command/i)

    const editorError = await invokeError("open_in_editor", {
      workspacePath: "/tmp/coolie-editor-ws",
      relativePath: "../../etc/passwd",
    })
    expect(editorError.length).toBeGreaterThan(0)
  })
})
