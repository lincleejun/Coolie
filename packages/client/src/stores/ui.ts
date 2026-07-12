import { create } from "zustand"

interface UiState {
  selectedWs: string | null
  selectedTabByWs: Record<string, string>
  rightPanel: "collapsed" | "changes" | "files"
  dispatchMode: boolean            // Cmd+N：composer 变新 workspace 首条 prompt 输入
  dispatchProjectId: string | null
  cheatsheetOpen: boolean
  searchQuery: string
  composerFocusNonce: number       // 递增触发 composer focus（Cmd+L / 创建流）
  selectWs(id: string | null): void
  /** 该 ws 被删除时的收尾：仅当它正是当前选中项才清空（否则无操作），避免悬空选中态 */
  clearWsIfSelected(id: string): void
  selectTab(wsId: string, tabId: string): void
  setRightPanel(p: UiState["rightPanel"]): void
  setDispatchMode(on: boolean, projectId?: string | null): void
  setCheatsheet(open: boolean): void
  setSearch(q: string): void
  focusComposer(): void
}

const LS_KEY = "coolie.selectedWs"
const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> =
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} } // node 测试环境兜底

export const useUi = create<UiState>((set) => ({
  selectedWs: storage.getItem(LS_KEY),
  selectedTabByWs: {},
  rightPanel: "collapsed",
  dispatchMode: false,
  dispatchProjectId: null,
  cheatsheetOpen: false,
  searchQuery: "",
  composerFocusNonce: 0,
  selectWs: (id) => {
    if (id) storage.setItem(LS_KEY, id); else storage.removeItem(LS_KEY)
    set({ selectedWs: id, dispatchMode: false })
  },
  clearWsIfSelected: (id) => set((s) => {
    if (s.selectedWs !== id) return s
    storage.removeItem(LS_KEY)
    return { selectedWs: null }
  }),
  selectTab: (wsId, tabId) => set((s) => ({ selectedTabByWs: { ...s.selectedTabByWs, [wsId]: tabId } })),
  setRightPanel: (rightPanel) => set({ rightPanel }),
  setDispatchMode: (on, projectId = null) =>
    set((s) => ({ dispatchMode: on, dispatchProjectId: projectId, composerFocusNonce: s.composerFocusNonce + 1 })),
  setCheatsheet: (cheatsheetOpen) => set({ cheatsheetOpen }),
  setSearch: (searchQuery) => set({ searchQuery }),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),
}))
