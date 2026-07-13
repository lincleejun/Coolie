import { create } from "zustand"

interface AttentionState {
  needsYou: Set<string>
  raise(wsId: string): void
  clear(wsId: string): void
  count(): number
  isRaised(wsId: string): boolean
}

export const useAttention = create<AttentionState>((set, get) => ({
  needsYou: new Set(),
  raise: (wsId) => set((state) =>
    state.needsYou.has(wsId)
      ? state
      : { needsYou: new Set(state.needsYou).add(wsId) },
  ),
  clear: (wsId) => set((state) => {
    if (!state.needsYou.has(wsId)) return state
    const needsYou = new Set(state.needsYou)
    needsYou.delete(wsId)
    return { needsYou }
  }),
  count: () => get().needsYou.size,
  isRaised: (wsId) => get().needsYou.has(wsId),
}))
