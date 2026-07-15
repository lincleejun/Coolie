import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { Effect, Layer } from "effect"
import { Db } from "../src/db/sqlite.js"
import { runMigrations } from "../src/db/migrations.js"
import { CoolieConfig } from "../src/config.js"
import { ProjectsRepoLive } from "../src/repo/projects.js"
import { EventsRepoLive } from "../src/repo/events.js"
import { WorkspacesRepoLive } from "../src/repo/workspaces.js"
import { GitService } from "../src/git/service.js"
import { SetupRunner, type SetupRunnerShape } from "../src/workspace/setup.js"
import { PostCreateHooksEmpty, WorkspaceLifecycleLive } from "../src/workspace/lifecycle.js"
import { createApp, MAX_ATTACHMENT_BYTES, newToken } from "../src/http/app.js"
import { makeFakeGit } from "./helpers/fake-git.js"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const GIF = Buffer.from("GIF89a", "ascii")
const WEBP = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")])

let server: http.Server
let base: string
let token: string
let home: string
let repoRoot: string
let wsId: string

const request = (pathname: string, body: unknown, auth = token) =>
  fetch(base + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  })

beforeEach(async () => {
  const db = new Database(":memory:")
  runMigrations(db)
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-attachments-home-"))
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-attachments-ws-"))
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-attachments-repo-"))
  fs.mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true })
  const fake = makeFakeGit()
  const setup: SetupRunnerShape = { run: () => Effect.succeed([]) }
  const config = {
    home,
    dbPath: ":memory:",
    serverInfoPath: path.join(home, "server.json"),
    workspacesRoot,
  }
  const layer = WorkspaceLifecycleLive.pipe(
    Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(GitService, fake.git),
      Layer.succeed(SetupRunner, setup),
      PostCreateHooksEmpty,
    )),
    Layer.provideMerge(Layer.mergeAll(ProjectsRepoLive, EventsRepoLive, WorkspacesRepoLive)),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(Layer.succeed(CoolieConfig, config)),
  )
  token = newToken()
  server = http.createServer(createApp({
    runtime: (effect) => Effect.runPromiseExit(Effect.provide(effect, layer) as Effect.Effect<any, any, never>),
    token,
    attachmentsDir: path.join(home, "attachments"),
    onShutdown: () => {},
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const project = await fetch(base + "/projects", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ repoRoot }),
  })
  const projectId = (await project.json()).id
  const workspace = await fetch(base + "/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId }),
  })
  wsId = (await workspace.json()).id
  const ensured = await fetch(`${base}/workspaces/${wsId}/ensure`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: "{}",
  })
  if (!ensured.ok) throw new Error(`workspace ensure failed: ${ensured.status}`)
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(home, { recursive: true, force: true })
})

describe("POST /workspaces/:id/attachments", () => {
  it("stores dispatch images in staging without requiring a workspace", async () => {
    const response = await request("/attachments", {
      name: "clipboard.png", mime: "image/png", dataBase64: PNG.toString("base64"),
    })
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(path.dirname(body.path)).toBe(path.join(home, "attachments", "staging"))
    expect(fs.readFileSync(body.path)).toEqual(PNG)
  })

  it("requires bearer auth and an active workspace", async () => {
    expect((await request(`/workspaces/${wsId}/attachments`, {
      name: "shot.png", mime: "image/png", dataBase64: PNG.toString("base64"),
    }, "wrong")).status).toBe(401)
    const archived = await request(`/workspaces/${wsId}/archive`, {})
    expect(archived.status).toBe(200)
    const response = await request(`/workspaces/${wsId}/attachments`, {
      name: "shot.png", mime: "image/png", dataBase64: PNG.toString("base64"),
    })
    expect(response.status).toBe(409)
  })

  it("validates base64 and image magic bytes instead of trusting mime or name", async () => {
    const malformed = await request(`/workspaces/${wsId}/attachments`, {
      name: "shot.png", mime: "image/png", dataBase64: "not+base64===",
    })
    expect(malformed.status).toBe(400)

    const mismatch = await request(`/workspaces/${wsId}/attachments`, {
      name: "looks-safe.png", mime: "image/png", dataBase64: JPEG.toString("base64"),
    })
    expect(mismatch.status).toBe(400)

    const unsupported = await request(`/workspaces/${wsId}/attachments`, {
      name: "vector.svg", mime: "image/svg+xml", dataBase64: Buffer.from("<svg/>").toString("base64"),
    })
    expect(unsupported.status).toBe(400)
  })

  it.each([
    ["image/png", "png", PNG],
    ["image/jpeg", "jpg", JPEG],
    ["image/gif", "gif", GIF],
    ["image/webp", "webp", WEBP],
  ])("accepts supported %s only when its magic matches", async (mime, extension, bytes) => {
    const response = await request(`/workspaces/${wsId}/attachments`, {
      name: `anything.${extension}`,
      mime,
      dataBase64: bytes.toString("base64"),
    })
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.mime).toBe(mime)
    expect(body.size).toBe(bytes.length)
    expect(body.path).toMatch(new RegExp(`\\.${extension}$`))
  })

  it("enforces the decoded 10MB limit", async () => {
    const tooLarge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)
    PNG.copy(tooLarge)
    const response = await request(`/workspaces/${wsId}/attachments`, {
      name: "huge.png", mime: "image/png", dataBase64: tooLarge.toString("base64"),
    })
    expect(response.status, await response.text()).toBe(413)
  })

  it("generates a safe server filename and atomically stores a 0600 file", async () => {
    const response = await request(`/workspaces/${wsId}/attachments`, {
      name: "../../user-controlled.png",
      mime: "image/png",
      dataBase64: PNG.toString("base64"),
    })
    expect(response.status).toBe(201)
    const body = await response.json()
    const expectedDir = path.join(home, "attachments", wsId)
    expect(path.dirname(body.path)).toBe(expectedDir)
    expect(path.basename(body.path)).toMatch(/^[0-9a-f-]+\.png$/)
    expect(path.isAbsolute(body.path)).toBe(true)
    expect(body).toMatchObject({ mime: "image/png", size: PNG.length })
    expect(fs.readFileSync(body.path)).toEqual(PNG)
    expect(fs.statSync(body.path).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(expectedDir).some((name) => name.endsWith(".tmp"))).toBe(false)
  })

  it("keeps attachments on archive and removes them best-effort on delete", async () => {
    const uploaded = await request(`/workspaces/${wsId}/attachments`, {
      name: "shot.png", mime: "image/png", dataBase64: PNG.toString("base64"),
    })
    const attachmentPath = (await uploaded.json()).path as string
    expect((await request(`/workspaces/${wsId}/archive`, {})).status).toBe(200)
    expect(fs.existsSync(attachmentPath)).toBe(true)

    const deleted = await fetch(base + `/workspaces/${wsId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(deleted.status).toBe(204)
    expect(fs.existsSync(path.join(home, "attachments", wsId))).toBe(false)
  })
})
