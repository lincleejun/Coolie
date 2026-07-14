import { describe, expect, it } from "vitest"
import {
  bootstrapWebServerInfo,
  clearStoredWebServer,
  parseServerSpecifier,
  resolveWebServerInfo,
  saveStoredWebServer,
  sanitizeServerUrl,
} from "../src/api/discovery.js"
import { isDesktop, pickDirectory, platformCapabilities } from "../src/platform.js"

const memoryStorage = (initial: Record<string, string> = {}): Storage => {
  const values = new Map(Object.entries(initial))
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe("web platform capabilities", () => {
  it("detects desktop only from the Tauri runtime marker", () => {
    expect(isDesktop({})).toBe(false)
    expect(isDesktop({ __TAURI_INTERNALS__: {} })).toBe(true)
    expect(platformCapabilities({}).daemonDiscovery).toBe(false)
    expect(platformCapabilities({}).externalTerminal).toBe(false)
    expect(platformCapabilities({ __TAURI_INTERNALS__: {} }).deepLinks).toBe(true)
    expect(platformCapabilities({ __TAURI_INTERNALS__: {} }).directoryPicker).toBe(true)
  })

  it("opens a desktop directory dialog, treats cancellation as null, and rejects web use", async () => {
    const desktop = { __TAURI_INTERNALS__: {} }
    const open = async () => "/repo"
    expect(await pickDirectory(desktop, async () => ({ open }))).toBe("/repo")
    expect(await pickDirectory(desktop, async () => ({ open: async () => null }))).toBeNull()
    await expect(pickDirectory({}, async () => ({ open }))).rejects.toThrow("desktop")
  })

  it("turns dialog loading/call failures and non-directory-shaped results into clear errors", async () => {
    const desktop = { __TAURI_INTERNALS__: {} }
    await expect(pickDirectory(desktop, async () => { throw new Error("missing plugin") }))
      .rejects.toThrow("directory dialog")
    await expect(pickDirectory(desktop, async () => ({ open: async () => ["/a"] })))
      .rejects.toThrow("single directory")
  })
})

describe("explicit web server discovery", () => {
  it("parses a loopback port and opaque token without persisting query credentials", () => {
    const storage = memoryStorage()
    expect(parseServerSpecifier("3210:tok:en")).toEqual({ port: 3210, token: "tok:en", pid: 0 })
    expect(resolveWebServerInfo("?server=3210%3Atok%3Aen", storage)).toEqual({
      port: 3210,
      token: "tok:en",
      pid: 0,
    })
    expect(storage.length).toBe(0)
  })

  it("sanitizes only the server query while preserving other query values and hash", () => {
    expect(sanitizeServerUrl("http://localhost:4173/app?server=3210%3Asecret&theme=dark#logs"))
      .toBe("/app?theme=dark#logs")
  })

  it("captures URL credentials once, removes them immediately, and reuses memory on reconnect", () => {
    const storage = memoryStorage()
    let search = "?server=3210%3Asecret&theme=dark"
    const replacements: string[] = []
    const resolver = bootstrapWebServerInfo(
      () => ({ href: `http://localhost/app${search}#tail`, search }),
      storage,
      (url) => {
        replacements.push(url)
        search = "?theme=dark"
      },
    )
    expect(resolver()).toEqual({ port: 3210, token: "secret", pid: 0 })
    expect(replacements).toEqual(["/app?theme=dark#tail"])
    expect(resolver()).toEqual({ port: 3210, token: "secret", pid: 0 })
    expect(storage.length).toBe(0)
  })

  it("removes an invalid server parameter before falling back to stored configuration", () => {
    const storage = memoryStorage({ "coolie.web.server": "4321:stored-token" })
    const replacements: string[] = []
    const resolver = bootstrapWebServerInfo(
      () => ({
        href: "http://localhost/app?server=truncated-secret&theme=dark#tail",
        search: "?server=truncated-secret&theme=dark",
      }),
      storage,
      (url) => { replacements.push(url) },
    )
    expect(replacements).toEqual(["/app?theme=dark#tail"])
    expect(resolver()).toEqual({ port: 4321, token: "stored-token", pid: 0 })
  })

  it("rejects non-loopback-style invalid connection specifications", () => {
    expect(parseServerSpecifier("0:token")).toBeNull()
    expect(parseServerSpecifier("65536:token")).toBeNull()
    expect(parseServerSpecifier("3000:")).toBeNull()
    expect(parseServerSpecifier("https://example.test:3000:token")).toBeNull()
  })

  it("uses an explicit localStorage seam and can clear it", () => {
    const storage = memoryStorage()
    expect(saveStoredWebServer("4567:secret", storage)).toBe(true)
    expect(resolveWebServerInfo("", storage)).toEqual({ port: 4567, token: "secret", pid: 0 })
    clearStoredWebServer(storage)
    expect(resolveWebServerInfo("", storage)).toBeNull()
  })

  it("degrades safely when browser storage is unavailable", () => {
    const blocked = {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("blocked") },
      removeItem: () => { throw new Error("blocked") },
    }
    expect(resolveWebServerInfo("", blocked)).toBeNull()
    expect(saveStoredWebServer("4567:secret", blocked)).toBe(false)
    expect(() => clearStoredWebServer(blocked)).not.toThrow()
  })
})
