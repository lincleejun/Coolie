import { create } from "zustand"
import type { TranscriptEntry, TranscriptPage } from "@coolie/protocol"
import type { Api } from "../api/client"

export type EngineViewMode = "terminal" | "transcript"

interface TranscriptCache {
  entries: TranscriptEntry[]
  cursor: string | null
  capability: TranscriptPage["capability"]
  reset: boolean
}

interface TranscriptState {
  modeByTab: Record<string, EngineViewMode>
  cacheByTab: Record<string, TranscriptCache>
  setMode(tabId: string, mode: EngineViewMode): void
  getMode(tabId: string): EngineViewMode
  resetTab(tabId: string): void
  refreshVisible(api: Api, workspaceId: string, tabId: string): Promise<TranscriptPage | null>
  applyPage(tabId: string, page: TranscriptPage): void
}

const defaultCache = (): TranscriptCache => ({
  entries: [],
  cursor: null,
  capability: "unavailable",
  reset: false,
})

export const shouldOfferTranscript = (tabKind: string): boolean => tabKind === "engine"

export const mergeTranscriptPage = (
  previous: TranscriptCache,
  page: TranscriptPage,
): TranscriptCache => ({
  capability: page.capability,
  reset: page.reset,
  cursor: page.cursor,
  entries: page.reset ? [...page.entries] : [...previous.entries, ...page.entries],
})

export const useTranscript = create<TranscriptState>((set, get) => ({
  modeByTab: {},
  cacheByTab: {},

  setMode: (tabId, mode) => set((state) => ({
    modeByTab: { ...state.modeByTab, [tabId]: mode },
  })),

  getMode: (tabId) => get().modeByTab[tabId] ?? "terminal",

  resetTab: (tabId) => set((state) => {
    const nextCache = { ...state.cacheByTab }
    delete nextCache[tabId]
    const nextMode = { ...state.modeByTab }
    delete nextMode[tabId]
    return { cacheByTab: nextCache, modeByTab: nextMode }
  }),

  refreshVisible: async (api, workspaceId, tabId) => {
    const cache = get().cacheByTab[tabId] ?? defaultCache()
    const page = await api.req(
      "GET",
      `/workspaces/${encodeURIComponent(workspaceId)}/tabs/${encodeURIComponent(tabId)}/transcript` +
      (cache.cursor ? `?cursor=${encodeURIComponent(cache.cursor)}` : ""),
    ) as TranscriptPage
    get().applyPage(tabId, page)
    if (page.capability === "unavailable" && get().getMode(tabId) === "transcript")
      get().setMode(tabId, "terminal")
    return page
  },

  applyPage: (tabId, page) => set((state) => {
    const previous = state.cacheByTab[tabId] ?? defaultCache()
    return {
      cacheByTab: {
        ...state.cacheByTab,
        [tabId]: mergeTranscriptPage(previous, page),
      },
    }
  }),
}))
