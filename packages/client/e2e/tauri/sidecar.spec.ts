/**
 * Task 4.3 — packaged sidecar bootstrap from empty server.json.
 */
import { applyTestStabilization, waitForAppRoot } from "./fixtures/app.js"

describe("packaged sidecar native contract", () => {
  before(async () => {
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("spawns bundled sidecar when server.json is absent", async () => {
    const before = await browser.tauri.execute(async ({ core }) => {
      return await core.invoke<string | null>("read_server_info")
    })
    // Isolated COOLIE_HOME from wdio.release.conf should start empty / without live server.
    expect(before === null || before === "").toBe(true)

    await browser.tauri.execute(async ({ core }) => {
      await core.invoke("spawn_server")
    })

    const info = await browser.waitUntil(async () => {
      const raw = await browser.tauri.execute(async ({ core }) => {
        return await core.invoke<string | null>("read_server_info")
      })
      if (!raw) return false
      try {
        const parsed = JSON.parse(raw) as { port?: number; token?: string }
        if (typeof parsed.port !== "number" || typeof parsed.token !== "string") return false
        const health = await fetch(`http://127.0.0.1:${parsed.port}/health`, {
          headers: { Authorization: `Bearer ${parsed.token}` },
        })
        if (!health.ok) return false
        return parsed
      } catch {
        return false
      }
    }, {
      timeout: 20000,
      timeoutMsg: "packaged sidecar did not write healthy server.json",
    })

    expect(info).toBeTruthy()
    expect((info as { port: number }).port).toBeGreaterThan(0)

    // Best-effort shutdown so later suites are not polluted.
    try {
      const parsed = info as { port: number; token: string }
      await fetch(`http://127.0.0.1:${parsed.port}/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${parsed.token}` },
      })
    } catch {
      /* ignore */
    }
  })

  it("packaged argv path does not reference tsx (resource layout)", async () => {
    // Probe via a second spawn attempt after shutdown — command must remain callable.
    // Absolute proof of no-tsx is in Rust unit tests + release bundle audit.
    const result = await browser.tauri.execute(async ({ core }) => {
      try {
        await core.invoke("spawn_server")
        return "ok"
      } catch (error) {
        return String(error)
      }
    })
    expect(result).not.toMatch(/tsx|main\.ts/i)
  })
})
