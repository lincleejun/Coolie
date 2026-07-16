import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { createApp, newToken } from "../src/http/app.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { EngineRegistry, makeEngineRegistry } from "../src/engine/registry.js"

describe("transcript HTTP (Task 2A.8)", () => {
  let server: http.Server
  let base = ""
  let token = ""
  let db: Database.Database
  let claudeHome = ""
  let wsPath = ""

  const layer = () => Layer.mergeAll(
    WorkspacesRepoLive,
    TabsRepoLive,
    Layer.succeed(EngineRegistry, makeEngineRegistry()),
  ).pipe(Layer.provide(Layer.succeed(Db, db)))

  beforeEach(async () => {
    db = new Database(":memory:")
    runMigrations(db)
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-claude-home-"))
    wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ws-"))
    db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)`).run()
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w1','p1','usa-zion','${wsPath}','coolie/a','main','r','active',0,1,NULL,'{}')`).run()
    db.prepare(`INSERT INTO tabs (id, workspace_id, kind, engine_id, engine_session_id, tmux_window, title, status, data)
      VALUES ('t1','w1','engine','claude','sess-1',1,'Claude','awaiting-input','{}')`).run()

    const encoded = wsPath.replace(/[^a-zA-Z0-9]/g, "-")
    const transcriptDir = path.join(claudeHome, "projects", encoded)
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(transcriptDir, "sess-1.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-07-15T12:00:00.000Z",
        message: { role: "user", content: "hello transcript" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-07-15T12:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "world" }],
        },
      }),
    ].join("\n") + "\n")

    token = newToken()
    server = http.createServer(createApp({
      runtime: (eff) => Effect.runPromiseExit(Effect.provide(eff, layer()) as Effect.Effect<any, any, never>),
      token,
      claudeHome,
      codexHome: claudeHome,
      onShutdown: () => {},
    }))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
    db.close()
    fs.rmSync(claudeHome, { recursive: true, force: true })
    fs.rmSync(wsPath, { recursive: true, force: true })
  })

  const req = (path: string) =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })

  it("returns structured transcript entries for engine tabs", async () => {
    const res = await req("/workspaces/w1/tabs/t1/transcript")
    expect(res.status).toBe(200)
    const page = await res.json()
    expect(page.capability).toBe("available")
    expect(page.entries.length).toBeGreaterThanOrEqual(1)
    expect(page.entries[0].blocks[0].kind).toBe("text")
  })

  it("returns capability unavailable for shell tabs", async () => {
    await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: "w1", kind: "shell", tmuxWindow: 2 })
    }), layer()))
    const shell = (await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* TabsRepo).listByWorkspace("w1")
    }), layer()))).find((tab) => tab.kind === "shell")!
    const res = await req(`/workspaces/w1/tabs/${shell.id}/transcript`)
    expect(res.status).toBe(200)
    expect((await res.json()).capability).toBe("unavailable")
  })

  it("supports incremental cursor reads", async () => {
    const first = await (await req("/workspaces/w1/tabs/t1/transcript?maxEntries=1")).json()
    expect(first.truncated).toBe(true)
    expect(typeof first.cursor).toBe("string")
    const second = await (await req(`/workspaces/w1/tabs/t1/transcript?cursor=${encodeURIComponent(first.cursor)}`)).json()
    expect(second.reset).toBe(false)
    expect(second.entries.length).toBeGreaterThanOrEqual(1)
  })

  it("resets on tampered cursor", async () => {
    const tampered = Buffer.from(JSON.stringify({
      identity: "sess-1:10:100",
      byteOffset: 0,
      sessionId: "other",
    })).toString("base64url")
    const page = await (await req(`/workspaces/w1/tabs/t1/transcript?cursor=${encodeURIComponent(tampered)}`)).json()
    expect(page.reset).toBe(true)
    expect(page.entries).toEqual([])
  })
})
