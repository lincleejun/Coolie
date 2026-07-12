import { randomUUID } from "node:crypto"
import type { ClientRole } from "@coolie/protocol"

/** 一条已连接客户端的登记（lease）。gui 是持有者；terminal/cli 只登记、不持有。 */
export interface ClientLease {
  readonly id: string
  readonly role: ClientRole
  readonly label: string | null
  readonly connectedAt: number
}

export interface ClientRegistryOpts {
  /** 最后一个 gui 持有者断开后的惰性退出宽限期（ms） */
  readonly graceMs: number
  /** 宽限期届满且期间无 gui 回归 → 触发（整个 registry 生命周期最多一次） */
  readonly onIdleExpired: () => void
  readonly now?: () => number
}

export interface ClientRegistry {
  readonly register: (role: ClientRole, label?: string) => ClientLease
  readonly release: (id: string) => void
  readonly list: () => ClientLease[]
  readonly guiCount: () => number
  readonly idleExitArmed: () => boolean
  readonly graceMs: number
  readonly dispose: () => void
}

/**
 * role 化 refcount（设计文档 §2.1，kobe 路线）：
 * - lease 与连接同生共死（调用方在连接 close 时 release），GUI 崩溃即自动释放——
 *   拒绝「显式 unregister API」协议：崩掉的 GUI 会把 daemon 钉成永生。
 * - 布防只发生在「gui 持有数 >0 → 0」转变沿；从未有过 gui → 永不布防（M1 决定：
 *   CLI 拉起的 server 驻留到显式 stop，`coolie server stop` 是它的退出面）。
 * - timer unref：不阻进程因其他原因退出。
 */
export const makeClientRegistry = (opts: ClientRegistryOpts): ClientRegistry => {
  const clients = new Map<string, ClientLease>()
  const now = opts.now ?? Date.now
  let timer: NodeJS.Timeout | null = null
  let fired = false

  const guiCount = (): number => {
    let n = 0
    for (const c of clients.values()) if (c.role === "gui") n++
    return n
  }
  const disarm = (): void => { if (timer !== null) { clearTimeout(timer); timer = null } }
  const arm = (): void => {
    if (fired) return
    disarm()
    timer = setTimeout(() => { timer = null; if (!fired) { fired = true; opts.onIdleExpired() } }, opts.graceMs)
    timer.unref?.()
  }

  return {
    graceMs: opts.graceMs,
    register: (role, label) => {
      const lease: ClientLease = { id: randomUUID(), role, label: label ?? null, connectedAt: now() }
      clients.set(lease.id, lease)
      if (role === "gui") disarm() // 宽限期内 GUI 回归：取消退出
      return lease
    },
    release: (id) => {
      const lease = clients.get(id)
      if (!lease) return
      clients.delete(id)
      if (lease.role === "gui" && guiCount() === 0) arm()
    },
    list: () => [...clients.values()],
    guiCount,
    idleExitArmed: () => timer !== null,
    dispose: disarm,
  }
}
