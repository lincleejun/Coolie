import { describe, it, expect, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import Database from "better-sqlite3"
import { runMigrations } from "../../server/src/db/migrations.js"
import { toCsv, toTable } from "../src/export-format.js"

const TSX = path.resolve(__dirname, "../../../node_modules/.bin/tsx")
const CLI = path.resolve(__dirname, "../src/main.ts")
let home: string
const coolie = (...args: string[]) =>
  execFileSync(TSX, [CLI, ...args], { env: { ...process.env, COOLIE_HOME: home }, encoding: "utf8" })

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-export-"))
  const db = new Database(path.join(home, "coolie.db")); runMigrations(db)
  db.prepare("INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES (?,?,?,?,?)")
    .run("p1", "demo", "/tmp/demo", "main", 1)
  db.prepare("INSERT INTO events (workspace_id, type, payload, ts) VALUES (?,?,?,?)")
    .run(null, "project.added", JSON.stringify({ id: "p1" }), 2)
  db.close()
})

describe("export-format pure helpers", () => {
  it("toCsv escapes per RFC-4180", () => {
    expect(toCsv(["a", "b"], [{ a: 'x,"y', b: 1 }])).toBe('a,b\n"x,""y",1\n')
  })
  it("toTable aligns columns", () => {
    const t = toTable(["id", "name"], [{ id: "1", name: "long-name" }, { id: "22", name: "x" }])
    expect(t.split("\n")[0]).toMatch(/^id\s+name$/)
  })
})

describe("coolie export (daemon-free)", () => {
  it("exports projects as csv without starting a server", () => {
    const out = coolie("export", "projects", "--csv")
    expect(out.split("\n")[0]).toBe("id,name,repoRoot,defaultBaseBranch,createdAt")
    expect(out).toContain("p1,demo,/tmp/demo,main,1")
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false) // 证明 daemon-free
  })
  it("exports events as json honoring --after", () => {
    const all = JSON.parse(coolie("export", "events", "--json"))
    expect(all).toHaveLength(1)
    expect(all[0].type).toBe("project.added")
    expect(JSON.parse(coolie("export", "events", "--json", "--after", "999"))).toHaveLength(0)
  })
  it("empty home exports empty set, exit 0", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-empty-"))
    const out = execFileSync(TSX, [CLI, "export", "projects", "--json"],
      { env: { ...process.env, COOLIE_HOME: empty }, encoding: "utf8" })
    expect(JSON.parse(out)).toEqual([])
  })
  it("bad format exits 2", () => {
    expect(() => coolie("export", "projects", "--format", "yaml")).toThrow()
  })
})

describe("coolie doctor", () => {
  it("prints read-only checks and mentions tmux/git", () => {
    const out = coolie("doctor")
    expect(out).toMatch(/\b(ok|warn|fail)\tdb\t/)
    expect(out).toContain("tmux")
    expect(out).toContain("git")
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false) // doctor 不拉起 server
  })
})
