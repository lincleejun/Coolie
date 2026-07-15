import type { EventEmitter } from "node:events"
import type { CoolieEvent, Tab } from "@coolie/protocol"
import { tmuxSessionName } from "@coolie/protocol"
import { EVENT_CHANNEL } from "../events/bus.js"
import type { QueuedPrompt } from "../repo/queue.js"

export interface DrainDeps {
  readonly resolveEngineTab: (workspaceId: string, tabId?: string) => Promise<{
    tab: Tab
    wsActive: boolean
    nativeQueue: boolean
  } | null>
  readonly claimNext: (workspaceId: string, tabId?: string) => Promise<QueuedPrompt | null>
  readonly release: (queueId: number) => Promise<void>
  readonly deliver: (target: string, text: string) => Promise<void>
  readonly markWorking: (tabId: string) => Promise<void>
  readonly onDelivered: (queueId: number) => Promise<void>
  readonly onFailed: (workspaceId: string, queueId: number, error: unknown) => Promise<void>
}

/**
 * A turn-complete edge may start at most one queued turn.
 *
 * Delivery is at-least-once: PTY acceptance happens before the durable delivered receipt.
 * If the process crashes in that window, startup recovery requeues the inflight row and the
 * same queue/message identity can be delivered again.
 */
export const drainWorkspace = async (deps: DrainDeps, workspaceId: string, tabId?: string): Promise<boolean> => {
  const resolved = await deps.resolveEngineTab(workspaceId, tabId)
  if (!resolved || !resolved.wsActive || resolved.nativeQueue || resolved.tab.status !== "awaiting-input") return false
  const next = await deps.claimNext(workspaceId, tabId)
  if (!next) return false
  const current = await deps.resolveEngineTab(workspaceId, next.tabId)
  if (!current || !current.wsActive || current.nativeQueue || current.tab.status !== "awaiting-input") {
    await deps.release(next.id)
    return false
  }
  const target = `${tmuxSessionName(workspaceId)}:${current.tab.tmuxWindow ?? 0}`
  try {
    await deps.deliver(target, next.text)
  } catch (error) {
    await deps.onFailed(workspaceId, next.id, error).catch(() => {})
    return false
  }
  // Close the stale awaiting-input window before releasing the workspace serial lock.
  // The prompt is already in the PTY, so a status-write failure must never requeue and duplicate it.
  await deps.markWorking(current.tab.id).catch(() => {})
  await deps.onDelivered(next.id)
  return true
}

export interface WorkspaceSerial {
  readonly run: <T>(workspaceId: string, task: () => Promise<T>) => Promise<T>
}

export const createWorkspaceSerial = (): WorkspaceSerial => {
  const chains = new Map<string, Promise<void>>()
  return {
    run: async <T>(workspaceId: string, task: () => Promise<T>): Promise<T> => {
      const previous = chains.get(workspaceId) ?? Promise.resolve()
      let resolve!: () => void
      const marker = new Promise<void>((done) => { resolve = done })
      const chain = previous.catch(() => {}).then(() => marker)
      chains.set(workspaceId, chain)
      await previous.catch(() => {})
      try { return await task() }
      finally {
        resolve()
        if (chains.get(workspaceId) === chain) chains.delete(workspaceId)
      }
    },
  }
}

export const resumeQueuedWorkspaces = async (
  serial: WorkspaceSerial,
  deps: DrainDeps,
  queue: {
    readonly recoverInflight: () => Promise<number>
    readonly listWorkspaceIds: () => Promise<string[]>
    readonly listTargets?: () => Promise<Array<{ workspaceId: string; tabId: string }>>
  },
): Promise<void> => {
  await queue.recoverInflight()
  if (queue.listTargets) {
    const targets = await queue.listTargets()
    await Promise.all(targets.map(({ workspaceId, tabId }) =>
      serial.run(workspaceId, async () => { await drainWorkspace(deps, workspaceId, tabId) })))
    return
  }
  const workspaceIds = await queue.listWorkspaceIds()
  await Promise.all(workspaceIds.map((workspaceId) =>
    serial.run(workspaceId, async () => { await drainWorkspace(deps, workspaceId) })))
}

export const startQueueDrainer = (
  bus: EventEmitter,
  deps: DrainDeps,
  serial: WorkspaceSerial = createWorkspaceSerial(),
): (() => void) => {
  const onEvent = (event: CoolieEvent): void => {
    if (event.type !== "tab.status.changed" || !event.workspaceId) return
    const payload = event.payload as { status?: string; source?: string; tabId?: string } | null
    if (payload?.status !== "awaiting-input") return
    if (payload.source === "interrupt") return
    const workspaceId = event.workspaceId
    void serial.run(workspaceId, async () => { await drainWorkspace(deps, workspaceId, payload.tabId) })
  }
  bus.on(EVENT_CHANNEL, onEvent)
  return () => bus.off(EVENT_CHANNEL, onEvent)
}
