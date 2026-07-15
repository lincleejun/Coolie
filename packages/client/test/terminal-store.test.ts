import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  coerceTerminalId,
  parseExternalByWs,
  setExternalModeDisposer,
  useTerminal,
} from "../src/stores/terminal.js"

beforeEach(() => {
  useTerminal.setState({
    terminalApp: "iterm2",
    externalByWs: {},
  })
  setExternalModeDisposer(() => {})
})

describe("terminal persisted state validation", () => {
  it("coerces dirty terminal ids to the safe default", () => {
    expect(coerceTerminalId("terminal")).toBe("terminal")
    expect(coerceTerminalId("wezterm")).toBe("wezterm")
    expect(coerceTerminalId("custom")).toBe("iterm2")
    expect(coerceTerminalId(null)).toBe("iterm2")
  })

  it("accepts only a plain object of boolean workspace flags", () => {
    expect(parseExternalByWs('{"w1":true,"w2":false}')).toEqual({ w1: true, w2: false })
    expect(parseExternalByWs('{"w1":"true","w2":1}')).toEqual({})
    expect(parseExternalByWs('{"__proto__":true}')).toEqual({})
    expect(parseExternalByWs("[]")).toEqual({})
    expect(parseExternalByWs("null")).toEqual({})
    expect(parseExternalByWs("{bad json")).toEqual({})
  })
})

describe("per-workspace external terminal mode", () => {
  it("persists independently and can switch back", () => {
    useTerminal.getState().setExternal("w1", true)
    expect(useTerminal.getState().isExternal("w1")).toBe(true)
    expect(useTerminal.getState().isExternal("w2")).toBe(false)
    useTerminal.getState().setExternal("w1", false)
    expect(useTerminal.getState().isExternal("w1")).toBe(false)
  })

  it("actively disposes existing GUI sessions only when entering external mode", () => {
    const dispose = vi.fn()
    setExternalModeDisposer(dispose)
    useTerminal.getState().setExternal("w1", true)
    expect(dispose).toHaveBeenCalledWith("w1")
    useTerminal.getState().setExternal("w1", false)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
