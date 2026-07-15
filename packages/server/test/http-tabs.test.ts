import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { createApp, newToken } from "../src/http/app.js"
import { TabsRepo, TabsRepoLive } from "../src/repo/tabs.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import type { ComposerOps } from "../src/tmux/ops.js"
import { SessionEnsurer } from "../src/workspace/heal.js"
import { createWorkspaceSerial } from "../src/engine/queue-drain.js"

let server: http.Server
let base: string
let token: string
let db: Database.Database
let killed: Array<{ session: string; index: number }>
let killError: Error | null
let wsPath: string
let resumeImpl: (workspaceId: string, tabId: string) => Promise<any>

const wsId = "ws-c12"
const otherWsId = "ws-c12-other"
const session = `coolie-${wsId}`

beforeEach(async () => {
  db = new Database(":memory:")
  runMigrations(db)
  wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-http-tabs-"))
  db.prepare(`INSERT INTO projects (id, name, repo_root, default_base_branch, created_at)
    VALUES ('p-c12', 'p', '/tmp/c12-repo', 'main', 1)`).run()
  db.prepare(`INSERT INTO workspaces
    (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
    VALUES (?, 'p-c12', 'w', ?, 'coolie/w', 'main', 'BASE', 'active', 0, 1, NULL, '{}')`)
    .run(wsId, wsPath)
  db.prepare(`INSERT INTO workspaces
    (id, project_id, name, path, branch, base_branch, base_ref, status, pinned, created_at, archived_at, data)
    VALUES (?, 'p-c12', 'other', ?, 'coolie/other', 'main', 'BASE', 'active', 0, 2, NULL, '{}')`)
    .run(otherWsId, `${wsPath}-other`)

  killed = []
  killError = null
  resumeImpl = async (workspaceId, tabId) => ({
    action: "respawned", resumed: false, sessionName: `coolie-${workspaceId}`, tabId, sessionId: "session",
  })
  const composerOps: ComposerOps = {
    input: async () => {},
    newShellWindow: async () => 3,
    killWindow: async (targetSession, index) => {
      killed.push({ session: targetSession, index })
      if (killError) throw killError
    },
  }
  const layer = Layer.mergeAll(
    WorkspacesRepoLive,
    TabsRepoLive,
    Layer.succeed(SessionEnsurer, {
      ensure: () => Effect.succeed({ action: "none", resumed: false, sessionName: session, tabId: null, sessionId: null }),
      resumeTab: (workspaceId, tabId) => Effect.promise(() => resumeImpl(workspaceId, tabId)),
      createEngineTab: (workspaceId, engineId) => Effect.gen(function* () {
        const created = yield* (yield* TabsRepo)
          .insert({ workspaceId, kind: "engine", engineId, engineSessionId: "new-session", tmuxWindow: 4 })
        return { action: "respawned", resumed: false, sessionName: session, tabId: created.id, sessionId: "new-session" }
      }) as any,
      switchEngine: null as any,
    }),
  )
    .pipe(Layer.provide(Layer.succeed(Db, db)))
  token = newToken()
  server = http.createServer(createApp({
    runtime: (effect) =>
      Effect.runPromiseExit(Effect.provide(effect, layer) as Effect.Effect<any, any, never>),
    token,
    onShutdown: () => {},
    composerOps,
    workspaceSerial: createWorkspaceSerial(),
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  fs.rmSync(wsPath, { recursive: true, force: true })
})

const createShellTab = () => fetch(`${base}/workspaces/${wsId}/tabs`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ kind: "shell" }),
})
const createEngineTab = () => fetch(`${base}/workspaces/${wsId}/tabs`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ kind: "engine", engineId: "claude" }),
})
const resumeTab = (workspaceId: string, tabId = "engine-tab") => fetch(
  `${base}/workspaces/${workspaceId}/tabs/${tabId}/resume`,
  { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" },
)

describe("POST /workspaces/:id/tabs/:tabId/resume serialization", () => {
  it("serializes concurrent resumes in one workspace", async () => {
    let active = 0
    let maxActive = 0
    resumeImpl = async (workspaceId, tabId) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      return { action: "respawned", resumed: false, sessionName: `coolie-${workspaceId}`, tabId, sessionId: "session" }
    }

    const responses = await Promise.all([resumeTab(wsId), resumeTab(wsId)])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(maxActive).toBe(1)
  })

  it("does not block a different workspace behind an in-flight resume", async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    resumeImpl = async (workspaceId, tabId) => {
      if (workspaceId === wsId) {
        entered()
        await gate
      }
      return { action: "respawned", resumed: false, sessionName: `coolie-${workspaceId}`, tabId, sessionId: "session" }
    }

    const first = resumeTab(wsId)
    await started
    const other = await resumeTab(otherWsId)
    expect(other.status).toBe(200)
    release()
    expect((await first).status).toBe(200)
  })
})

describe("POST /workspaces/:id/tabs C12 compensation", () => {
  it("rejects the removed run tab kind", async () => {
    const response = await fetch(`${base}/workspaces/${wsId}/tabs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "run" }),
    })
    expect(response.status).toBe(400)
  })

  it("kills the exact window and preserves the original DB error when insert fails", async () => {
    db.exec(`CREATE TRIGGER fail_shell_tab BEFORE INSERT ON tabs
      WHEN NEW.kind = 'shell' BEGIN SELECT RAISE(ABORT, 'C12 original insert failure'); END`)
    killError = new Error("compensation also failed")

    const response = await createShellTab()
    const body = await response.json() as { message: string }

    expect(response.status).toBe(500)
    expect(killed).toEqual([{ session, index: 3 }])
    expect(body.message).toContain("C12 original insert failure")
    expect(body.message).not.toContain("compensation also failed")
  })

  it("returns 201 and does not compensate after a successful insert", async () => {
    const response = await createShellTab()
    expect(response.status).toBe(201)
    expect(killed).toEqual([])
  })
})

describe("engine chat tab lifecycle", () => {
  it("creates, renames, and only closes an engine tab when a sibling remains", async () => {
    const firstResponse = await createEngineTab()
    const first = await firstResponse.json() as { id: string }
    expect(firstResponse.status).toBe(201)
    expect((await fetch(`${base}/workspaces/${wsId}/tabs/${first.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(409)

    const second = await (await createEngineTab()).json() as { id: string }
    const renamed = await fetch(`${base}/workspaces/${wsId}/tabs/${second.id}/rename`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Review" }),
    })
    expect(renamed.status).toBe(200)
    expect((await renamed.json() as { title: string }).title).toBe("Review")
    expect((await fetch(`${base}/workspaces/${wsId}/tabs/${second.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(204)
  })
})
