import type { AttentionItem, AttentionKind, Workspace } from "@coolie/protocol"

export interface InboxFilter {
  readonly projectId: string
  readonly workspaceId: string
  readonly kind: "" | AttentionKind
}

export const defaultInboxFilter = (): InboxFilter => ({
  projectId: "",
  workspaceId: "",
  kind: "",
})

export const filterAttentionItems = (
  items: readonly AttentionItem[],
  filter: InboxFilter,
  workspaceById: ReadonlyMap<string, Pick<Workspace, "projectId" | "status">>,
): AttentionItem[] =>
  items.filter((item) => {
    const workspace = workspaceById.get(item.workspaceId)
    if (!workspace) return false
    if (filter.projectId !== "" && workspace.projectId !== filter.projectId) return false
    if (filter.workspaceId !== "" && item.workspaceId !== filter.workspaceId) return false
    if (filter.kind !== "" && item.kind !== filter.kind) return false
    return true
  })

export const sortAttentionItems = (items: readonly AttentionItem[]): AttentionItem[] =>
  [...items].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))

export const pickNextAttentionItem = (
  items: readonly AttentionItem[],
  filter: InboxFilter,
  workspaceById: ReadonlyMap<string, Pick<Workspace, "projectId" | "status">>,
): AttentionItem | undefined =>
  sortAttentionItems(filterAttentionItems(items, filter, workspaceById))[0]

export const inboxItemStatusLabel = (
  workspace: Pick<Workspace, "status"> | undefined,
  kind: AttentionKind,
): "open" | "archived" | "error" => {
  if (workspace?.status === "archived") return "archived"
  if (workspace?.status === "error" || kind === "error") return "error"
  return "open"
}

export const moveInboxSelection = (current: number, delta: number, length: number): number =>
  length === 0 ? 0 : (current + delta + length) % length

export const jumpToAttentionItem = (
  item: AttentionItem,
  selectWs: (id: string) => void,
  selectTab: (wsId: string, tabId: string) => void,
): void => {
  selectWs(item.workspaceId)
  selectTab(item.workspaceId, item.tabId)
}
