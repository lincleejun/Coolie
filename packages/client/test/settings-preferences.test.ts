import { beforeEach, describe, expect, it, vi } from "vitest"

const values = new Map<string, string>()
vi.stubGlobal("localStorage", {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
})

describe("settings preferences", () => {
  beforeEach(() => values.clear())

  it("persists validated theme and language choices", async () => {
    vi.resetModules()
    const { useSettings } = await import("../src/settings/settings.js")

    useSettings.getState().setTheme("light")
    useSettings.getState().setLang("en")

    expect(useSettings.getState().theme).toBe("light")
    expect(useSettings.getState().lang).toBe("en")
    expect(values.get("coolie.theme")).toBe("light")
    expect(values.get("coolie.lang")).toBe("en")
  })

  it("persists workspace name pool and custom names", async () => {
    vi.resetModules()
    const { useSettings } = await import("../src/settings/settings.js")

    useSettings.getState().setNamePool("custom")
    useSettings.getState().setCustomNames([" Alpha ", "beta"])

    expect(useSettings.getState().namePool).toBe("custom")
    expect(useSettings.getState().customNames).toEqual([" Alpha ", "beta"])
    expect(values.get("coolie.namePool")).toBe("custom")
    expect(values.get("coolie.customNames")).toBe(JSON.stringify([" Alpha ", "beta"]))
  })

  it("persists dispatch defaults and drops retired inert preferences on reload", async () => {
    values.set("coolie.preferences", JSON.stringify({
      defaultEngine: "codex",
      defaultModel: "gpt-5",
      notifications: false,
      turnSound: true,
      initTimeoutSeconds: 10,
      hooksDiagnostics: true,
    }))
    vi.resetModules()
    const { useSettings } = await import("../src/settings/settings.js")
    expect(useSettings.getState().preferences).toEqual({
      defaultEngine: "codex",
      defaultModel: "gpt-5",
      notifications: false,
      turnSound: true,
    })

    useSettings.getState().setPreference("defaultModel", "gpt-5.1")
    expect(JSON.parse(values.get("coolie.preferences")!)).toEqual({
      defaultEngine: "codex",
      defaultModel: "gpt-5.1",
      notifications: false,
      turnSound: true,
    })
  })
})
