import { parseCoolieUrl } from "@coolie/protocol"

export interface DeepLinkRouter {
  readonly selectWs: (workspaceId: string) => void
  readonly selectTab: (workspaceId: string, tabId: string) => void
  readonly openProjectDispatch: (projectId: string) => void
}

export interface DeepLinkLookup {
  readonly hasWorkspace: (workspaceId: string) => boolean
  readonly hasTab: (workspaceId: string, tabId: string) => boolean
  readonly hasProject: (projectId: string) => boolean
}

/** Guard UI actions against stale or external ids. Missing targets become harmless no-ops. */
export const createSafeDeepLinkRouter = (
  lookup: DeepLinkLookup,
  actions: DeepLinkRouter,
): DeepLinkRouter => ({
  selectWs: (workspaceId) => {
    if (lookup.hasWorkspace(workspaceId)) actions.selectWs(workspaceId)
  },
  selectTab: (workspaceId, tabId) => {
    if (lookup.hasWorkspace(workspaceId) && lookup.hasTab(workspaceId, tabId))
      actions.selectTab(workspaceId, tabId)
  },
  openProjectDispatch: (projectId) => {
    if (lookup.hasProject(projectId)) actions.openProjectDispatch(projectId)
  },
})

/** Parse and route one URL. Unknown or malformed URLs have no side effects. */
export const routeCoolieUrl = (raw: string, router: DeepLinkRouter): boolean => {
  const target = parseCoolieUrl(raw)
  if (target === null) return false
  if (target.kind === "project") {
    router.openProjectDispatch(target.projectId)
    return true
  }
  router.selectWs(target.workspaceId)
  if (target.tabId !== undefined) router.selectTab(target.workspaceId, target.tabId)
  return true
}

/**
 * Attach both cold-start and running-app handlers. Import and plugin failures are
 * intentionally silent so the same client bundle works under plain Vite.
 */
export const installDeepLinkHandlers = async (
  router: DeepLinkRouter,
): Promise<() => void> => {
  try {
    const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link")
    const handle = (urls: string[] | null): void => {
      for (const url of urls ?? []) routeCoolieUrl(url, router)
    }
    try { handle(await getCurrent()) } catch { /* plain Vite or unavailable plugin */ }
    try { return await onOpenUrl(handle) } catch { return () => {} }
  } catch {
    return () => {}
  }
}
