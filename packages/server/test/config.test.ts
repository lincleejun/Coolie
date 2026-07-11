import { describe, it, expect, afterEach } from "vitest"
import { Effect } from "effect"
import { CoolieConfig, CoolieConfigLive } from "../src/config.js"

const load = () => Effect.runSync(CoolieConfig.pipe(Effect.provide(CoolieConfigLive)))

describe("CoolieConfig", () => {
  afterEach(() => { delete process.env.COOLIE_HOME; delete process.env.COOLIE_WORKSPACES_ROOT })
  it("respects COOLIE_HOME", () => {
    process.env.COOLIE_HOME = "/tmp/coolie-test-home"
    const c = load()
    expect(c.home).toBe("/tmp/coolie-test-home")
    expect(c.dbPath).toBe("/tmp/coolie-test-home/coolie.db")
    expect(c.serverInfoPath).toBe("/tmp/coolie-test-home/server.json")
  })
  it("defaults under homedir", () => {
    const c = load()
    expect(c.home.endsWith("/.coolie")).toBe(true)
    expect(c.workspacesRoot.endsWith("/coolie/workspaces")).toBe(true)
  })
})
