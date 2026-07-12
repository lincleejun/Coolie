/**
 * durable SSE 消费（spec §2.3/§十）：fetch 流式读取（EventSource 带不了 Bearer 头）。
 * 断线：退避 → getInfo()（内部会重新拉起 daemon）→ 用 lastSeq 游标重连 → server 端 replay 补齐，不丢不重。
 */
export interface CoolieEventLike {
  seq: number; workspaceId: string | null; type: string; payload: unknown; ts: number
}

export class SseParser {
  private buf = ""
  feed(chunk: string): CoolieEventLike[] {
    this.buf += chunk
    const out: CoolieEventLike[] = []
    for (;;) {
      const cut = this.buf.indexOf("\n\n")
      if (cut === -1) break
      const block = this.buf.slice(0, cut)
      this.buf = this.buf.slice(cut + 2)
      const dataLines = block.split("\n").filter((l) => l.startsWith("data:"))
      if (dataLines.length === 0) continue // 注释/心跳块
      try {
        const e = JSON.parse(dataLines.map((l) => l.slice(5).trimStart()).join("\n"))
        if (typeof e?.seq === "number" && typeof e?.type === "string") out.push(e)
      } catch { /* 坏块跳过：durable 流靠游标补，不因单块中毒断流 */ }
    }
    return out
  }
}

export const backoffDelay = (attempt: number): number => Math.min(500 * 2 ** attempt, 8000)

export interface EventStreamOpts {
  getInfo: () => Promise<{ port: number; token: string }>
  after: number
  onEvent: (e: CoolieEventLike) => void
  onStatus: (s: "online" | "offline") => void
}

export const startEventStream = (opts: EventStreamOpts): (() => void) => {
  let stopped = false
  let lastSeq = opts.after
  let attempt = 0
  let abort: AbortController | null = null

  const connectLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const info = await opts.getInfo() // server 崩溃场景：这里会 spawn 新 daemon（spec §十）
        abort = new AbortController()
        const r = await fetch(`http://127.0.0.1:${info.port}/events/stream?after=${lastSeq}`, {
          headers: { Authorization: `Bearer ${info.token}` },
          signal: abort.signal,
        })
        if (!r.ok || !r.body) throw new Error(`sse http ${r.status}`)
        opts.onStatus("online")
        attempt = 0
        const parser = new SseParser()
        const reader = r.body.getReader()
        const dec = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          for (const e of parser.feed(dec.decode(value, { stream: true }))) {
            lastSeq = Math.max(lastSeq, e.seq)
            opts.onEvent(e)
          }
        }
        throw new Error("sse stream ended") // server 正常不主动断
      } catch {
        if (stopped) return
        opts.onStatus("offline")
        await new Promise((r) => setTimeout(r, backoffDelay(attempt++)))
      }
    }
  }
  void connectLoop()
  return () => { stopped = true; abort?.abort() }
}
