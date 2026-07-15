import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { Effect } from "effect"
import {
  createWorkspaceSerial,
  drainWorkspace,
  resumeQueuedWorkspaces,
  startQueueDrainer,
  type DrainDeps,
} from "../src/engine/queue-drain.js"
import { runMigrations } from "../src/db/migrations.js"
import { EVENT_CHANNEL } from "../src/events/bus.js"
import { makeQueueRepo } from "../src/repo/queue.js"

const deps = (overrides: Partial<DrainDeps> = {}): DrainDeps => ({
  resolveEngineTab: async () => ({
    tab: { id: "t1", status: "awaiting-input", tmuxWindow: 0 } as any,
    wsActive: true,
    nativeQueue: false,
  }),
  claimNext: async () => ({
    id: 7,
    queueId: 7,
    messageId: "queue:7",
    workspaceId: "w1",
    tabId: "t1",
    text: "下一条",
    mode: "send",
    state: "inflight",
    createdAt: 1,
  }),
  release: async () => {},
  deliver: async () => {},
  markWorking: async () => {},
  onDelivered: async () => {},
  onFailed: async () => {},
  ...overrides,
})

describe("queue drainer", () => {
  it("delivers exactly one oldest prompt on turn completion", async () => {
    const deliver = vi.fn(async () => {})
    const markWorking = vi.fn(async () => {})
    const onDelivered = vi.fn(async () => {})
    expect(await drainWorkspace(deps({ deliver, markWorking, onDelivered }), "w1")).toBe(true)
    expect(deliver).toHaveBeenCalledWith("coolie-w1:0", "下一条")
    expect(markWorking).toHaveBeenCalledWith("t1")
    expect(onDelivered).toHaveBeenCalledWith(7)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("retains failed prompt and records a failure event", async () => {
    const onDelivered = vi.fn(async () => {})
    const onFailed = vi.fn(async () => {})
    const error = new Error("tmux failed")
    expect(await drainWorkspace(deps({ deliver: async () => { throw error }, onDelivered, onFailed }), "w1")).toBe(false)
    expect(onDelivered).not.toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalledWith("w1", 7, error)
  })

  it("does not drain working, archived, or nativeQueue workspaces", async () => {
    const deliver = vi.fn(async () => {})
    for (const resolved of [
      { tab: { status: "working" }, wsActive: true, nativeQueue: false },
      { tab: { status: "awaiting-input" }, wsActive: false, nativeQueue: false },
      { tab: { status: "awaiting-input" }, wsActive: true, nativeQueue: true },
    ]) {
      expect(await drainWorkspace(deps({ resolveEngineTab: async () => resolved as any, deliver }), "w1")).toBe(false)
    }
    expect(deliver).not.toHaveBeenCalled()
  })

  it("only drains a real awaiting-input edge, never idle", async () => {
    const bus = new EventEmitter()
    const deliver = vi.fn(async () => {})
    const stop = startQueueDrainer(bus, deps({ deliver }))
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "idle" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deliver).not.toHaveBeenCalled()
    stop()
  })

  it("rechecks awaiting-input after claiming and releases when the edge went stale", async () => {
    const deliver = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    let reads = 0
    const resolveEngineTab = async () => ({
      tab: { id: "t1", status: ++reads === 1 ? "awaiting-input" : "idle", tmuxWindow: 0 } as any,
      wsActive: true,
      nativeQueue: false,
    })
    expect(await drainWorkspace(deps({ resolveEngineTab, deliver, release }), "w1")).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith(7)
  })

  it("subscribes to awaiting-input and can be stopped", async () => {
    const bus = new EventEmitter()
    const deliver = vi.fn(async () => {})
    const stop = startQueueDrainer(bus, deps({ deliver }))
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "working" } })
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "awaiting-input" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deliver).toHaveBeenCalledTimes(1)
    stop()
    bus.emit(EVENT_CHANNEL, { type: "tab.status.changed", workspaceId: "w1", payload: { status: "awaiting-input" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("interrupt 的乐观 awaiting-input 不触发队列投递", async () => {
    const bus = new EventEmitter()
    const deliver = vi.fn(async () => {})
    const stop = startQueueDrainer(bus, deps({ deliver }))
    bus.emit(EVENT_CHANNEL, {
      type: "tab.status.changed",
      workspaceId: "w1",
      payload: { status: "awaiting-input", source: "interrupt" },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deliver).not.toHaveBeenCalled()
    stop()
  })

  it("recovers restart inflight rows and scans existing queued workspaces once", async () => {
    const recoverInflight = vi.fn(async () => 1)
    const deliver = vi.fn(async () => {})
    await resumeQueuedWorkspaces(
      createWorkspaceSerial(),
      deps({ deliver }),
      { recoverInflight, listWorkspaceIds: async () => ["w1"] },
    )
    expect(recoverInflight).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledOnce()
  })

  it("redelivers the same message after PTY acceptance when the durable receipt did not commit", async () => {
    let state: "queued" | "inflight" | "deleted" = "queued"
    let receiptAttempts = 0
    const claimedMessageIds: string[] = []
    const deliver = vi.fn(async () => {})
    const crashWindowDeps = deps({
      claimNext: async () => {
        if (state !== "queued") return null
        state = "inflight"
        const prompt = {
          id: 7,
          queueId: 7,
          messageId: "queue:7",
          workspaceId: "w1",
          tabId: "t1",
          text: "可能重投",
          mode: "send" as const,
          state: "inflight" as const,
          createdAt: 1,
        }
        claimedMessageIds.push(prompt.messageId)
        return prompt
      },
      deliver,
      onDelivered: async (queueId) => {
        expect(queueId).toBe(7)
        receiptAttempts += 1
        if (receiptAttempts === 1) throw new Error("crash before queue receipt commit")
        state = "deleted"
      },
    })

    await expect(drainWorkspace(crashWindowDeps, "w1", "t1"))
      .rejects.toThrow("crash before queue receipt commit")
    expect(state).toBe("inflight")
    expect(deliver).toHaveBeenCalledOnce()

    await resumeQueuedWorkspaces(createWorkspaceSerial(), crashWindowDeps, {
      recoverInflight: async () => {
        if (state !== "inflight") return 0
        state = "queued"
        return 1
      },
      listWorkspaceIds: async () => ["w1"],
      listTargets: async () => [{ workspaceId: "w1", tabId: "t1" }],
    })

    expect(deliver).toHaveBeenCalledTimes(2)
    expect(claimedMessageIds).toEqual(["queue:7", "queue:7"])
    expect(receiptAttempts).toBe(2)
    expect(state).toBe("deleted")
  })

  it("reopens a file SQLite queue and redelivers the same durable identity after the PTY/receipt crash window", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-queue-restart-"))
    const dbPath = path.join(home, "coolie.db")
    let db: Database.Database | undefined
    try {
      db = new Database(dbPath)
      runMigrations(db)
      db.prepare("INSERT INTO projects (id,name,repo_root,default_base_branch,created_at) VALUES (?,?,?,?,?)")
        .run("p1", "p", "/tmp/p", "main", 1)
      db.prepare(`INSERT INTO workspaces
        (id,project_id,name,path,branch,base_branch,base_ref,status,pinned,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run("w1", "p1", "w", "/tmp/w", "b", "main", "r", "active", 0, 1)

      const beforeRestart = makeQueueRepo(db, () => {})
      const first = await Effect.runPromise(beforeRestart.enqueue({
        workspaceId: "w1", tabId: "t1", text: "PTY 已接收但 receipt 未提交",
      }))
      const second = await Effect.runPromise(beforeRestart.enqueue({
        workspaceId: "w1", tabId: "t1", text: "下一条仍应保持 FIFO",
      }))
      const acceptedByPty = await Effect.runPromise(beforeRestart.claimNext("w1", "t1"))
      expect(acceptedByPty).toMatchObject({
        id: first.id,
        queueId: first.queueId,
        messageId: first.messageId,
        text: "PTY 已接收但 receipt 未提交",
        mode: "send",
        state: "inflight",
      })
      // Crash boundary: the PTY accepted this payload, but delivered() was never called.
      const ptyWrite = { messageId: acceptedByPty!.messageId, text: acceptedByPty!.text }
      expect(ptyWrite).toEqual({ messageId: first.messageId, text: "PTY 已接收但 receipt 未提交" })
      db.close()
      db = undefined

      db = new Database(dbPath)
      runMigrations(db)
      const afterRestart = makeQueueRepo(db, () => {})
      const recoveredClaims: Array<{
        id: number
        messageId: string
        text: string
        mode: "send"
      }> = []
      const deliver = vi.fn(async () => {})
      const restartDeps = deps({
        claimNext: async (workspaceId, tabId) => {
          const prompt = await Effect.runPromise(afterRestart.claimNext(workspaceId, tabId))
          if (prompt) recoveredClaims.push({
            id: prompt.id,
            messageId: prompt.messageId,
            text: prompt.text,
            mode: prompt.mode,
          })
          return prompt
        },
        release: async (queueId) => { await Effect.runPromise(afterRestart.release(queueId)) },
        deliver,
        onDelivered: async (queueId) => { await Effect.runPromise(afterRestart.delivered(queueId)) },
        onFailed: async (_workspaceId, queueId, error) => {
          await Effect.runPromise(afterRestart.release(queueId, String(error)))
        },
      })

      await resumeQueuedWorkspaces(createWorkspaceSerial(), restartDeps, {
        recoverInflight: async () => Effect.runPromise(afterRestart.recoverInflight()),
        listWorkspaceIds: async () => Effect.runPromise(afterRestart.listWorkspaceIds()),
        listTargets: async () => Effect.runPromise(afterRestart.listTargets()),
      })

      expect(recoveredClaims).toEqual([{
        id: first.id,
        messageId: first.messageId,
        text: "PTY 已接收但 receipt 未提交",
        mode: "send",
      }])
      expect(deliver).toHaveBeenCalledWith("coolie-w1:0", "PTY 已接收但 receipt 未提交")
      expect(await Effect.runPromise(afterRestart.peekNext("w1", "t1"))).toMatchObject({
        id: second.id,
        messageId: second.messageId,
        text: "下一条仍应保持 FIFO",
        mode: "send",
        state: "queued",
      })

      const lifecycle = (db.prepare(
        "SELECT type, payload FROM events WHERE type IN ('prompt.queued','prompt.delivery.recovered','prompt.delivered') ORDER BY seq",
      ).all() as Array<{ type: string; payload: string }>)
        .map((row) => ({ type: row.type, payload: JSON.parse(row.payload) }))
        .filter((event) => event.payload.queueId === first.queueId)
      expect(lifecycle).toEqual([
        {
          type: "prompt.queued",
          payload: expect.objectContaining({ queueId: first.queueId, messageId: first.messageId }),
        },
        {
          type: "prompt.delivery.recovered",
          payload: expect.objectContaining({ queueId: first.queueId, messageId: first.messageId }),
        },
        {
          type: "prompt.delivered",
          payload: expect.objectContaining({ queueId: first.queueId, messageId: first.messageId }),
        },
      ])
    } finally {
      db?.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("recovers every exact engine-tab queue target after restart", async () => {
    const resolveEngineTab = vi.fn(async (_workspaceId: string, tabId?: string) => ({
      tab: { id: tabId, status: "awaiting-input", tmuxWindow: tabId === "t1" ? 1 : 2 } as any,
      wsActive: true,
      nativeQueue: false,
    }))
    const claimNext = vi.fn(async (workspaceId: string, tabId?: string) => ({
      id: tabId === "t1" ? 1 : 2,
      queueId: tabId === "t1" ? 1 : 2,
      messageId: `queue:${tabId === "t1" ? 1 : 2}`,
      workspaceId,
      tabId: tabId!,
      text: tabId!,
      mode: "send" as const,
      state: "inflight" as const,
      createdAt: 1,
    }))
    const deliver = vi.fn(async () => {})
    await resumeQueuedWorkspaces(
      createWorkspaceSerial(),
      deps({ resolveEngineTab, claimNext, deliver }),
      {
        recoverInflight: async () => 0,
        listWorkspaceIds: async () => ["w1"],
        listTargets: async () => [
          { workspaceId: "w1", tabId: "t1" },
          { workspaceId: "w1", tabId: "t2" },
        ],
      },
    )
    expect(deliver.mock.calls).toEqual([
      ["coolie-w1:1", "t1"],
      ["coolie-w1:2", "t2"],
    ])
  })

  it("serializes one workspace without blocking another", async () => {
    const serial = createWorkspaceSerial()
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const first = serial.run("w1", async () => { await gate; return "first" })
    const second = serial.run("w1", async () => "second")
    await expect(serial.run("w2", async () => "other")).resolves.toBe("other")
    open()
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
  })
})
