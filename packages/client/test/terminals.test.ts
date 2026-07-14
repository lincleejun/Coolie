import { describe, expect, it } from "vitest"
import { buildAttachCommand, buildTerminalLaunch, parseCustomArgvTemplate } from "../src/terminal/terminals.js"

describe("buildAttachCommand", () => {
  it("builds the canonical tmux attach command", () => {
    expect(buildAttachCommand("coolie", "w1")).toBe("tmux -L coolie attach -t coolie-w1")
  })

  it("rejects request-controlled shell metacharacters", () => {
    expect(() => buildAttachCommand("coolie;touch /tmp/pwn", "w1")).toThrow(/非法/)
    expect(() => buildAttachCommand("coolie", "w1\nwhoami")).toThrow(/非法/)
  })
})

describe("parseCustomArgvTemplate", () => {
  it("parses an explicit JSON argv array without shell tokenization", () => {
    expect(parseCustomArgvTemplate('["/usr/bin/open","-na","WezTerm","--args","sh","-lc","{cmd}"]'))
      .toEqual(["/usr/bin/open", "-na", "WezTerm", "--args", "sh", "-lc", "{cmd}"])
  })

  it("rejects malformed, non-string, empty, and placeholder-free arrays", () => {
    expect(() => parseCustomArgvTemplate("open -na WezTerm {cmd}")).toThrow(/JSON argv/)
    expect(() => parseCustomArgvTemplate('["open",3,"{cmd}"]')).toThrow(/字符串/)
    expect(() => parseCustomArgvTemplate('["","{cmd}"]')).toThrow(/program/)
    expect(() => parseCustomArgvTemplate('["open","-na","WezTerm"]')).toThrow(/\{cmd\}/)
  })
})

describe("buildTerminalLaunch", () => {
  it("builds iTerm2 and Terminal.app launches as separated program/argv", () => {
    const iterm = buildTerminalLaunch("iterm2", "coolie", "w1")
    expect(iterm.program).toBe("/usr/bin/osascript")
    expect(iterm.args).toEqual(["-e", expect.stringContaining("iTerm2")])

    const terminal = buildTerminalLaunch("terminal", "coolie", "w1")
    expect(terminal.program).toBe("/usr/bin/osascript")
    expect(terminal.args).toEqual(["-e", expect.stringContaining('application "Terminal"')])
  })

  it("substitutes the validated attach command into one argv element", () => {
    const launch = buildTerminalLaunch(
      "custom",
      "coolie",
      "w1",
      '["/usr/bin/open","-na","WezTerm","--args","sh","-lc","{cmd}"]',
    )
    expect(launch).toEqual({
      program: "/usr/bin/open",
      args: ["-na", "WezTerm", "--args", "sh", "-lc", "tmux -L coolie attach -t coolie-w1"],
    })
  })

  it("rejects unknown persisted terminal ids", () => {
    expect(() => buildTerminalLaunch("bogus" as never, "coolie", "w1")).toThrow(/未知终端/)
  })
})
