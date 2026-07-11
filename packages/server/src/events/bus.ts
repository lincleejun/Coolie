import { EventEmitter } from "node:events"
import { Context, Layer } from "effect"

/** 进程内事件总线：EventsRepo.append 落库后在此广播，SSE 在线连接订阅（设计文档 §2.3 live 侧）。 */
export class EventsBus extends Context.Tag("EventsBus")<EventsBus, EventEmitter>() {}
export const EventsBusLive = Layer.sync(EventsBus, () => {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0) // Plan 5 GUI will hold >10 concurrent SSE connections
  return emitter
})
export const EVENT_CHANNEL = "event"
