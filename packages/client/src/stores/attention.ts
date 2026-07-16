import { create } from "zustand"
import type { AttentionItem } from "@coolie/protocol"
import type { Api } from "../api/client"
import { useUi } from "./ui"
import { notifyTurnComplete, setBadge } from "../chrome/notify"

const openItems = (items: Record<string, AttentionItem>): AttentionItem[] =>
  Object.values(items).filter((item) => item.state === "open")

const documentUnattended = (): boolean =>
  typeof document === "undefined"
  || document.hidden
  || (typeof document.hasFocus === "function" && !document.hasFocus())

const shouldNotify = (workspaceId: string): boolean => {
  const selectedWs = useUi.getState().selectedWs
  return workspaceId !== selectedWs || documentUnattended()
}

const isActionable = (item: AttentionItem): boolean => {
  const selectedWs = useUi.getState().selectedWs
  const selectedTab = selectedWs ? useUi.getState().selectedTabByWs[selectedWs] : undefined
  if (item.workspaceId === selectedWs && item.tabId === selectedTab && !documentUnattended()) return false
  return true
}

const actionableCount = (items: Record<string, AttentionItem>): number => {
  const ids = new Set<string>()
  for (const item of openItems(items)) {
    if (isActionable(item)) ids.add(item.workspaceId)
  }
  return ids.size
}

interface AttentionState {
  items: Record<string, AttentionItem>
  loadSnapshot(items: readonly AttentionItem[]): void
  mergeItems(items: readonly AttentionItem[], opts?: { notify?: boolean }): void
  remove(id: string): void
  purgeWorkspace(workspaceId: string): void
  count(): number
  isRaised(workspaceId: string): boolean
  openWorkspaceIds(): string[]
  syncWorkspace(api: Api, workspaceId: string, opts?: { notify?: boolean }): Promise<void>
  tryAckVisible(api: Api, workspaceId: string, tabId: string | undefined): Promise<void>
}

export const useAttention = create<AttentionState>((set, get) => ({
  items: {},

  loadSnapshot: (items) => {
    const next: Record<string, AttentionItem> = {}
    for (const item of items) {
      if (item.state === "open") next[item.id] = item
    }
    set({ items: next })
    setBadge(actionableCount(next))
  },

  mergeItems: (items, opts = {}) => {
    const previous = get().items
    const next = { ...previous }
    const added: AttentionItem[] = []
    for (const item of items) {
      if (item.state !== "open") {
        delete next[item.id]
        continue
      }
      if (!previous[item.id]) added.push(item)
      next[item.id] = item
    }
    set({ items: next })
    setBadge(actionableCount(next))
    if (opts.notify !== false) {
      for (const item of added) {
        if (shouldNotify(item.workspaceId)) notifyTurnComplete(item.summary, item.workspaceId)
      }
    }
  },

  remove: (id) => {
    const next = { ...get().items }
    if (!(id in next)) return
    delete next[id]
    set({ items: next })
    setBadge(actionableCount(next))
  },

  purgeWorkspace: (workspaceId) => {
    const next = { ...get().items }
    let changed = false
    for (const [id, item] of Object.entries(next)) {
      if (item.workspaceId === workspaceId) {
        delete next[id]
        changed = true
      }
    }
    if (!changed) return
    set({ items: next })
    setBadge(actionableCount(next))
  },

  count: () => actionableCount(get().items),

  isRaised: (workspaceId) =>
    openItems(get().items).some((item) => item.workspaceId === workspaceId && isActionable(item)),

  openWorkspaceIds: () => {
    const ids = new Set<string>()
    for (const item of openItems(get().items)) {
      if (isActionable(item)) ids.add(item.workspaceId)
    }
    return [...ids]
  },

  syncWorkspace: async (api, workspaceId, opts = {}) => {
    try {
      const items = await api.req(
        "GET",
        `/attention?workspace=${encodeURIComponent(workspaceId)}&state=open`,
      ) as AttentionItem[]
      get().mergeItems(items, opts)
    } catch {
      // Network failure: retain existing durable items until the next sync.
    }
  },

  tryAckVisible: async (api, workspaceId, tabId) => {
    if (documentUnattended() || tabId === undefined) return
    const candidates = openItems(get().items).filter(
      (item) => item.workspaceId === workspaceId && item.tabId === tabId,
    )
    if (candidates.length === 0) return
    for (const item of candidates) {
      try {
        await api.req("POST", `/attention/${encodeURIComponent(item.id)}/ack`, {})
        get().remove(item.id)
      } catch {
        // Failed ack keeps the durable item for a later retry.
      }
    }
  },
}))
