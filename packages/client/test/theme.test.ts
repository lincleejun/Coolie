import { describe, expect, it, vi } from "vitest"
import {
  createSystemThemeListener,
  resolveTheme,
  terminalTheme,
  type ThemePref,
} from "../src/settings/theme.js"

describe("theme", () => {
  it("resolves explicit and system preferences", () => {
    expect(resolveTheme("light", true)).toBe("light")
    expect(resolveTheme("dark", false)).toBe("dark")
    expect(resolveTheme("system", true)).toBe("dark")
    expect(resolveTheme("system", false)).toBe("light")
  })

  it("only follows media changes while preference is system and cleans up", () => {
    let pref: ThemePref = "system"
    let listener: ((event: { matches: boolean }) => void) | undefined
    const media = {
      addEventListener: vi.fn((_type: "change", next: typeof listener) => { listener = next }),
      removeEventListener: vi.fn(),
    }
    const apply = vi.fn()

    const cleanup = createSystemThemeListener(media, () => pref, apply)
    listener?.({ matches: false })
    expect(apply).toHaveBeenLastCalledWith("light")

    pref = "dark"
    listener?.({ matches: true })
    expect(apply).toHaveBeenCalledTimes(1)

    cleanup()
    expect(media.removeEventListener).toHaveBeenCalledWith("change", listener)
  })

  it("provides readable xterm colors for both themes", () => {
    expect(terminalTheme("dark").foreground).not.toBe(terminalTheme("dark").background)
    expect(terminalTheme("light").foreground).not.toBe(terminalTheme("light").background)
    expect(terminalTheme("light").background).toBe("#f8f8fa")
  })
})
