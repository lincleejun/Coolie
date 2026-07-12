/** 每 workspace 草稿持久化（spec §7.2）；storage 注入使 node 可测 */
export interface DraftStorage {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

export const makeDrafts = (storage: DraftStorage) => ({
  load: (wsId: string): string => storage.getItem(`coolie.draft.${wsId}`) ?? "",
  save: (wsId: string, text: string): void => {
    if (text === "") storage.removeItem(`coolie.draft.${wsId}`)
    else storage.setItem(`coolie.draft.${wsId}`, text)
  },
  clear: (wsId: string): void => storage.removeItem(`coolie.draft.${wsId}`),
  /** 把 from 的草稿搬到 to（dispatch 切项目时保住已打的字，避免 wsId 变更后草稿被丢）。空草稿不搬。 */
  carry: (from: string, to: string): void => {
    if (from === to) return
    const t = storage.getItem(`coolie.draft.${from}`) ?? ""
    if (t === "") return
    storage.setItem(`coolie.draft.${to}`, t)
    storage.removeItem(`coolie.draft.${from}`)
  },
})
