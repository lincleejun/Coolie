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
import { TabsRepoLive } from "../src/repo/tabs.js"
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
let liveWindows: number[]
let respawned: number[]
let synchronizeRunLists: boolean
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
  liveWindows = [0]
  respawned = []
  synchronizeRunLists = false
  killError = null
  resumeImpl = async (workspaceId, tabId) => ({
    action: "respawned", resumed: false, sessionName: `coolie-${workspaceId}`, tabId, sessionId: "session",
  })
  const composerOps: ComposerOps = {
    input: async () => {},
    newShellWindow: async () => 3,
    listWindows: async () => {
      if (synchronizeRunLists) await new Promise((resolve) => setTimeout(resolve, 20))
      return liveWindows.map((index) => ({ index, name: index === 0 ? "engine" : "run" }))
    },
    newRunWindow: async () => {
      const index = Math.max(...liveWindows) + 1
      liveWindows.push(index)
      return index
    },
    respawnRunWindow: async (_session, index) => { respawned.push(index) },
    killWindow: async (targetSession, index) => {
      killed.push({ session: targetSession, index })
      liveWindows = liveWindows.filter((w) => w !== index)
      if (killError) throw killError
    },
  }
  const layer = Layer.mergeAll(
    WorkspacesRepoLive,
    TabsRepoLive,
    Layer.succeed(SessionEnsurer, {
      ensure: () => Effect.succeed({ action: "none", resumed: false, sessionName: session, tabId: null, sessionId: null }),
      resumeTab: (workspaceId, tabId) => Effect.promise(() => resumeImpl(workspaceId, tabId)),
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
const createRunTab = () => fetch(`${base}/workspaces/${wsId}/tabs`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ kind: "run" }),
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

describe("POST /workspaces/:id/tabs run singleton", () => {
  it("returns 409 when .coolie/run.sh is missing", async () => {
    const response = await createRunTab()
    expect(response.status).toBe(409)
    expect(liveWindows).toEqual([0])
  })

  it("creates one run tab then respawns that window in place", async () => {
    fs.mkdirSync(path.join(wsPath, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(wsPath, ".coolie", "run.sh"), "echo run\n")
    const first = await createRunTab()
    const firstTab = await first.json() as { id: string }
    const second = await createRunTab()
    const secondTab = await second.json() as { id: string }
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(secondTab.id).toBe(firstTab.id)
    expect(respawned).toEqual([1])
    expect((db.prepare("SELECT COUNT(*) c FROM tabs WHERE kind='run'").get() as any).c).toBe(1)
  })

  it("serializes concurrent requests into one run tab and window", async () => {
    fs.mkdirSync(path.join(wsPath, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(wsPath, ".coolie", "run.sh"), "echo run\n")
    synchronizeRunLists = true

    const first = createRunTab()
    const second = createRunTab()
    const [firstResponse, secondResponse] = await Promise.all([first, second])
    const [firstTab, secondTab] = await Promise.all([
      firstResponse.json() as Promise<{ id: string }>,
      secondResponse.json() as Promise<{ id: string }>,
    ])

    expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 201])
    expect(secondTab.id).toBe(firstTab.id)
    expect(liveWindows).toEqual([0, 1])
    expect((db.prepare("SELECT COUNT(*) c FROM tabs WHERE kind='run'").get() as any).c).toBe(1)
  })

  it("kills the new run window when DB insert fails", async () => {
    fs.mkdirSync(path.join(wsPath, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(wsPath, ".coolie", "run.sh"), "echo run\n")
    db.exec(`CREATE TRIGGER fail_run_tab BEFORE INSERT ON tabs
      WHEN NEW.kind = 'run' BEGIN SELECT RAISE(ABORT, 'run insert failure'); END`)
    const response = await createRunTab()
    expect(response.status).toBe(500)
    expect(killed).toContainEqual({ session, index: 1 })
    expect(liveWindows).toEqual([0])
  })
})
