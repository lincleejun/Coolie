import { describe, expect, it } from "vitest"
import { buildAttachCommand } from "../src/terminal/terminals.js"

describe("buildAttachCommand", () => {
  it("builds the canonical tmux attach command", () => {
    expect(buildAttachCommand("coolie", "w1")).toBe("tmux -L coolie attach -t coolie-w1")
  })

  it("rejects request-controlled shell metacharacters", () => {
    expect(() => buildAttachCommand("coolie;touch /tmp/pwn", "w1")).toThrow(/非法/)
    expect(() => buildAttachCommand("coolie", "w1\nwhoami")).toThrow(/非法/)
    expect(() => buildAttachCommand("{cmd}", "w1")).toThrow(/非法/)
  })
})
