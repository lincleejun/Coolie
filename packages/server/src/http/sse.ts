import type { IncomingMessage, ServerResponse } from "node:http"
import type { EventEmitter } from "node:events"
import { Effect, Exit } from "effect"
import type { CoolieEvent } from "@coolie/protocol"
import { EventsRepo } from "../repo/events.js"
import { EVENT_CHANNEL } from "../events/bus.js"
import type { Runtime } from "./app.js"

export interface SseDeps {
  readonly runtime: Runtime
  readonly bus: EventEmitter
  readonly heartbeatMs?: number
}

/**
 * durable SSE（设计文档 §2.3）：先订阅 bus（live 进队列），再从 events 表回放到追平，
 * 然后排空队列进入直推。seq 守卫（只发 > lastSent）保证回放与 live 交界处不丢不重。
 */
export const handleEventsStream = async (
  req: IncomingMessage,
  res: ServerResponse,
  deps: SseDeps,
  opts: { readonly after: number; readonly workspaceId?: string },
): Promise<void> => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.write(":ok\n\n")

  let lastSent = opts.after
  const writeEvent = (e: CoolieEvent): void => {
    // destroyed 也要挡：客户端 abort 时 destroyed=true 而 writableEnded 仍是 false，
    // 只查 writableEnded 会往已销毁的流上写，抛 ERR_STREAM_DESTROYED
    if (res.destroyed || res.writableEnded) return
    if (e.seq <= lastSent) return
    if (opts.workspaceId && e.workspaceId !== opts.workspaceId) return
    lastSent = e.seq
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
  }

  const queue: CoolieEvent[] = []
  let replaying = true
  const onLive = (e: CoolieEvent): void => {
    if (replaying) queue.push(e)
    else writeEvent(e)
  }
  deps.bus.on(EVENT_CHANNEL, onLive)

  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(":hb\n\n")
  }, deps.heartbeatMs ?? 15_000)
  const cleanup = (): void => {
    clearInterval(heartbeat)
    deps.bus.off(EVENT_CHANNEL, onLive)
  }
  req.on("close", cleanup)
  // 心跳/live emit 与 close 处理器竞态时的残余写入会在 res 上发 'error'——
  // 吞掉，防 unhandled 'error' 事件打死 daemon
  res.on("error", () => {})

  let cursor = opts.after
  for (;;) {
    const exit = await deps.runtime(Effect.gen(function* () {
      return yield* (yield* EventsRepo).listAfter({
        after: cursor, limit: 200,
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      })
    }))
    if (Exit.isFailure(exit)) { cleanup(); res.end(); return }
    const batch = exit.value
    for (const e of batch) writeEvent(e)
    if (batch.length < 200) break
    cursor = batch[batch.length - 1]!.seq
  }
  replaying = false
  for (const e of queue.splice(0)) writeEvent(e)
}
