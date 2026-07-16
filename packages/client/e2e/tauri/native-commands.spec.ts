/**
 * Task 4.3 — native command allowlists (terminal/editor).
 */
import { applyTestStabilization, waitForAppRoot } from "./fixtures/app.js"

describe("native command allowlists", () => {
  before(async () => {
    await waitForAppRoot()
    await applyTestStabilization()
  })

  it("rejects non-allowlisted external terminal identifiers", async () => {
    const error = await browser.tauri.execute(async ({ core }) => {
      try {
        await core.invoke("open_external_terminal", {
          terminal: "xterm",
          attachCommand: "tmux -L coolie attach -t coolie-w1",
        })
        return null
      } catch (e) {
        return String(e)
      }
    })
    expect(error).toBeTruthy()
    expect(String(error)).toMatch(/terminal|unknown|invalid|deserialize|allow/i)
  })

  it("rejects unsafe attach commands even for allowlisted terminals", async () => {
    const error = await browser.tauri.execute(async ({ core }) => {
      try {
        await core.invoke("open_external_terminal", {
          terminal: "terminal",
          attachCommand: "bash -c 'touch /tmp/pwned'",
        })
        return null
      } catch (e) {
        return String(e)
      }
    })
    expect(error).toBeTruthy()
    expect(String(error)).toMatch(/tmux|attach|exactly|command/i)
  })

  it("rejects editor paths that escape the workspace root", async () => {
    const error = await browser.tauri.execute(async ({ core }) => {
      try {
        await core.invoke("open_in_editor", {
          workspacePath: "/tmp/coolie-editor-ws",
          relativePath: "../../etc/passwd",
        })
        return null
      } catch (e) {
        return String(e)
      }
    })
    expect(error).toBeTruthy()
  })
})
