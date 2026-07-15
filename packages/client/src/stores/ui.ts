import { create } from "zustand"
import type { DiffSection } from "./types"

export interface CenterDiff {
  wsId: string
  section: DiffSection
  path: string
}

export type ModalId =
  | "dialog"
  | "settings"
  | "command-palette"
  | "cheatsheet"
  | "project-picker"
  | "tmux-guide"
  | (string & {})

export interface UiState {
  selectedWs: string | null
  selectedTabByWs: Record<string, string>
  rightPanel: "collapsed" | "changes" | "files"
  sidebarCollapsed: boolean        // 标题栏「折叠侧栏」图标切换（隐藏左列）
  collapsedProjects: Record<string, boolean> // 侧栏项目分组的折叠态（chevron）
  dispatchMode: boolean            // Cmd+N：composer 变新 workspace 首条 prompt 输入
  dispatchProjectId: string | null
  cheatsheetOpen: boolean
  paletteOpen: boolean
  settingsOpen: boolean
  modalStack: ModalId[]
  searchQuery: string
  composerFocusNonce: number       // 递增触发 composer focus（Cmd+L / 创建流）
  centerDiff: CenterDiff | null
  selectWs(id: string | null): void
  /** 该 ws 被删除时的收尾：仅当它正是当前选中项才清空（否则无操作），避免悬空选中态 */
  clearWsIfSelected(id: string): void
  selectTab(wsId: string, tabId: string): void
  setRightPanel(p: UiState["rightPanel"]): void
  toggleSidebar(): void
  toggleProjectCollapsed(projectId: string): void
  setDispatchMode(on: boolean, projectId?: string | null): void
  setCheatsheet(open: boolean): void
  setPalette(open: boolean): void
  setSettings(open: boolean): void
  openModal(id: ModalId): void
  closeModal(id: ModalId): void
  setSearch(q: string): void
  focusComposer(): void
  openCenterDiff(diff: CenterDiff): void
  closeCenterDiff(): void
}

const LS_KEY = "coolie.selectedWs"
const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> =
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} } // node 测试环境兜底

const withModal = (stack: readonly ModalId[], id: ModalId, open: boolean): ModalId[] =>
  open
    ? stack.includes(id) ? [...stack] : [...stack, id]
    : stack.filter((entry) => entry !== id)

export const selectModalActive = (state: Pick<UiState, "modalStack">): boolean =>
  state.modalStack.length > 0

export const isModalActive = (): boolean => selectModalActive(useUi.getState())

interface ModalKeyEvent {
  key: string
  preventDefault(): void
  stopPropagation(): void
  stopImmediatePropagation?(): void
  nativeEvent?: { stopImmediatePropagation?(): void }
}

/** Consume a modal-owned key before it can reach application-wide hotkeys. */
export const consumeModalKey = (event: ModalKeyEvent, key: string, action: () => void): boolean => {
  if (event.key !== key) return false
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation?.()
  event.nativeEvent?.stopImmediatePropagation?.()
  action()
  return true
}

export const useUi = create<UiState>((set) => ({
  selectedWs: storage.getItem(LS_KEY),
  selectedTabByWs: {},
  rightPanel: "collapsed",
  sidebarCollapsed: false,
  collapsedProjects: {},
  dispatchMode: false,
  dispatchProjectId: null,
  cheatsheetOpen: false,
  paletteOpen: false,
  settingsOpen: false,
  modalStack: [],
  searchQuery: "",
  composerFocusNonce: 0,
  centerDiff: null,
  selectWs: (id) => {
    if (id) storage.setItem(LS_KEY, id); else storage.removeItem(LS_KEY)
    set({ selectedWs: id, dispatchMode: false, centerDiff: null })
  },
  clearWsIfSelected: (id) => set((s) => {
    if (s.selectedWs !== id) return s
    storage.removeItem(LS_KEY)
    return { selectedWs: null }
  }),
  selectTab: (wsId, tabId) => set((s) => ({
    selectedTabByWs: { ...s.selectedTabByWs, [wsId]: tabId },
    centerDiff: null,
  })),
  setRightPanel: (rightPanel) => set({ rightPanel }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleProjectCollapsed: (projectId) =>
    set((s) => ({ collapsedProjects: { ...s.collapsedProjects, [projectId]: !s.collapsedProjects[projectId] } })),
  setDispatchMode: (on, projectId = null) =>
    set((s) => ({ dispatchMode: on, dispatchProjectId: projectId, composerFocusNonce: s.composerFocusNonce + 1 })),
  setCheatsheet: (cheatsheetOpen) => set((state) => ({
    cheatsheetOpen,
    ...(cheatsheetOpen ? { paletteOpen: false, settingsOpen: false } : {}),
    modalStack: withModal(
      withModal(withModal(state.modalStack, "command-palette", false), "settings", false),
      "cheatsheet",
      cheatsheetOpen,
    ),
  })),
  setPalette: (paletteOpen) => set((state) => ({
    paletteOpen,
    ...(paletteOpen ? { cheatsheetOpen: false, settingsOpen: false } : {}),
    modalStack: withModal(
      withModal(withModal(state.modalStack, "cheatsheet", false), "settings", false),
      "command-palette",
      paletteOpen,
    ),
  })),
  setSettings: (settingsOpen) => set((state) => ({
    settingsOpen,
    ...(settingsOpen ? { cheatsheetOpen: false, paletteOpen: false } : {}),
    modalStack: withModal(
      withModal(withModal(state.modalStack, "cheatsheet", false), "command-palette", false),
      "settings",
      settingsOpen,
    ),
  })),
  openModal: (id) => set((state) => ({ modalStack: withModal(state.modalStack, id, true) })),
  closeModal: (id) => set((state) => ({ modalStack: withModal(state.modalStack, id, false) })),
  setSearch: (searchQuery) => set({ searchQuery }),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),
  openCenterDiff: (centerDiff) => set({ centerDiff, dispatchMode: false }),
  closeCenterDiff: () => set({ centerDiff: null }),
}))
