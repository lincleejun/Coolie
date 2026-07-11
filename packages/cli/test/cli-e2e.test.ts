import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
let home: string, repo: string

const coolie = (...args: string[]) =>
  execFileSync(TSX, [CLI, ...args], { env: { ...process.env, COOLIE_HOME: home }, encoding: "utf8" })

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-"))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cli-repo-"))
  execFileSync("git", ["init", "-b", "main"], { cwd: repo })
})
afterAll(() => { try { coolie("server", "stop") } catch {} })

describe("coolie CLI e2e", () => {
  it("auto-spawns server and manages projects", () => {
    const added = coolie("project", "add", repo)
    expect(added).toContain("added")
    expect(coolie("project", "list")).toContain(repo)
    expect(coolie("server", "status")).toContain("running")
  })
  it("api schema prints the route table", () => {
    const out = coolie("api", "schema")
    expect(out).toContain("GET /health")
    expect(out).toContain("POST /projects")
  })
  it("unknown command exits non-zero", () => {
    expect(() => coolie("frobnicate")).toThrow()
  })
})
