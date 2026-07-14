import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-link-"))

const coolie = (...args: string[]): string =>
  execFileSync(TSX, [CLI, ...args], {
    env: { ...process.env, COOLIE_HOME: home },
    encoding: "utf8",
  })

describe("coolie link (daemon-free)", () => {
  it("prints a workspace link without starting a server", () => {
    expect(coolie("link", "w1").trim()).toBe("coolie://workspace/w1")
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false)
    expect(fs.existsSync(path.join(home, "coolie.db"))).toBe(false)
  })

  it("prints a workspace tab link", () => {
    expect(coolie("link", "w1", "--tab", "t2").trim()).toBe("coolie://workspace/w1/tab/t2")
  })

  it("rejects unsafe ids instead of printing a malformed link", () => {
    expect(() => coolie("link", "w1/bad")).toThrow()
    expect(() => coolie("link", "w1", "--tab", "t2?token=secret")).toThrow()
  })
})
