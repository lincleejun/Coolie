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
})
