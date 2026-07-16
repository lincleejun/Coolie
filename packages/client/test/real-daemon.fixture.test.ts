import { describe, it, expect, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { startRealDaemon } from "../e2e/tauri/fixtures/real-daemon.js"

describe("real daemon fixture lifecycle (Task 2C.4)", () => {
  let fixture: Awaited<ReturnType<typeof startRealDaemon>> | null = null

  afterEach(async () => {
    await fixture?.close()
    fixture = null
  })

  it("starts an isolated daemon and tears down without residue", async () => {
    fixture = await startRealDaemon()

    const health = await fetch(`${fixture.baseUrl}/health`)
    expect(health.status).toBe(200)

    const state = await fetch(`${fixture.baseUrl}/state`, {
      headers: { Authorization: `Bearer ${fixture.token}` },
    })
    expect(state.status).toBe(200)

    const tmuxAlive = spawnSync("tmux", ["-L", fixture.tmuxSocket, "has-session"], { stdio: "ignore" }).status === 0
    expect(tmuxAlive).toBe(false)

    await fixture.close()
    fixture = null
  })

  it("survives ten consecutive start/stop cycles", async () => {
    for (let i = 0; i < 10; i += 1) {
      const cycle = await startRealDaemon()
      const health = await fetch(`${cycle.baseUrl}/health`)
      expect(health.status).toBe(200)
      await cycle.close()
    }
  }, 120_000)
})
