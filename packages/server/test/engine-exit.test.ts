import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { EngineRegistryLive } from "../src/engine/registry.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { createApp, newToken } from "../src/http/app.js"

describe("POST /hooks/engine-exit（keep-alive 回报）", () => {
  let server: http.Server, base: string, token: string, db: Database.Database, tabId: string

  beforeEach(async () => {
    db = new Database(":memory:"); runMigrations(db)
    const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-ee-ws-"))
    db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at) VALUES ('p1','x','/tmp/x','main',1)`).run()
    db.prepare(`INSERT INTO workspaces (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
      VALUES ('w1','p1','usa-zion',?,'coolie/a','main','r','active',0,1,NULL,'{}')`).run(wsPath)
    const layer = Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive, TabsRepoLive, EngineRegistryLive)
      .pipe(Layer.provide(Layer.succeed(Db, db)))
    const runtime = (eff: any) => Effect.runPromiseExit(Effect.provide(eff, layer) as Effect.Effect<any, never, never>)
    tabId = (await Effect.runPromise(Effect.provide(Effect.gen(function* () {
      return yield* (yield* TabsRepo).insert({ workspaceId: "w1", kind: "engine", engineId: "claude", engineSessionId: "sess-1", tmuxWindow: 0 })
    }), layer) as Effect.Effect<any, never, never>)).id
    token = newToken()
    server = http.createServer(createApp({ runtime, token, onShutdown: () => {} }))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => server.close())

  const post = (qs: string, body: unknown) => fetch(`${base}/hooks/engine-exit${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const tabRow = () => db.prepare("SELECT * FROM tabs WHERE id = ?").get(tabId) as any
  const events = () => db.prepare("SELECT type, payload FROM events ORDER BY seq").all() as any[]

  it("exitCode≠0 → status=error + engine.exited（error 徽标产生点）", async () => {
    const r = await post("?workspace=w1", { exitCode: 137 })
    expect(r.status).toBe(200)
    expect(tabRow().status).toBe("error")
    const ev = events().find((e) => e.type === "engine.exited")
    expect(ev).toBeDefined()
    expect(JSON.parse(ev!.payload)).toEqual({ tabId, sessionId: "sess-1", exitCode: 137 })
    const st = events().find((e) => e.type === "tab.status.changed")
    expect(JSON.parse(st!.payload).source).toBe("wrapper")
  })

  it("exitCode=0 → status=idle + engine.exited", async () => {
    await post("?workspace=w1", { exitCode: 0 })
    expect(tabRow().status).toBe("idle")
    expect(events().some((e) => e.type === "engine.exited")).toBe(true)
  })

  it("setStatus+engine.exited 单事务（C3）：engine.exited 写失败则 status 回滚不半写", async () => {
    // 触发器让 engine.exited 事件写入 ABORT，模拟事务内第二写失败
    db.exec(`CREATE TRIGGER break_engine_exited BEFORE INSERT ON events
      WHEN NEW.type = 'engine.exited'
      BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    const before = tabRow().status // "idle"
    const r = await post("?workspace=w1", { exitCode: 1 })
    expect(r.status).not.toBe(200) // 第二写失败 → 整体失败
    expect(tabRow().status).toBe(before) // 单事务回滚：status 未被半写成 error
    // 同事务内的 tab.status.changed 也随之回滚，不留半成品事件
    expect(events().some((e) => e.type === "tab.status.changed")).toBe(false)
    db.exec("DROP TRIGGER break_engine_exited")
  })

  it("无 workspace → 400；无 engine tab 的 workspace → 200 静默；非整数 exitCode → 400；无 token → 401", async () => {
    expect((await post("", { exitCode: 1 })).status).toBe(400)
    expect((await post("?workspace=ghost", { exitCode: 1 })).status).toBe(200)
    expect((await post("?workspace=w1", { exitCode: "boom" })).status).toBe(400)
    expect((await fetch(`${base}/hooks/engine-exit?workspace=w1`, { method: "POST", body: "{}" })).status).toBe(401)
  })
})
