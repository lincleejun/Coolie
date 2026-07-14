export const COOLIE_SCHEME = "coolie"

const PREFIX = `${COOLIE_SCHEME}://`
const SAFE_ID = /^[A-Za-z0-9._-]+$/

export type CoolieLinkTarget =
  | { readonly kind: "workspace"; readonly workspaceId: string; readonly tabId?: string }
  | { readonly kind: "project"; readonly projectId: string }

const requireSafeId = (name: string, value: string): string => {
  if (!SAFE_ID.test(value))
    throw new Error(`${name} contains unsafe characters (allowed: A-Z a-z 0-9 . _ -)`)
  return value
}

/** Build a credential-free Coolie deep link. Every id is validated before interpolation. */
export const buildCoolieUrl = (target: CoolieLinkTarget): string => {
  if (target.kind === "project")
    return `${PREFIX}project/${requireSafeId("projectId", target.projectId)}`

  const workspaceId = requireSafeId("workspaceId", target.workspaceId)
  if (target.tabId === undefined) return `${PREFIX}workspace/${workspaceId}`
  return `${PREFIX}workspace/${workspaceId}/tab/${requireSafeId("tabId", target.tabId)}`
}

/**
 * Parse only canonical Coolie links. The scheme is case-insensitive; route words are
 * canonical lowercase; ids preserve case. Query and fragment are ignored after a
 * valid path, and one trailing slash is accepted.
 */
export const parseCoolieUrl = (raw: string): CoolieLinkTarget | null => {
  if (!raw.toLowerCase().startsWith(PREFIX)) return null

  const suffix = raw.slice(PREFIX.length)
  const pathEnd = suffix.search(/[?#]/)
  const path = pathEnd === -1 ? suffix : suffix.slice(0, pathEnd)
  const canonicalPath = path.replace(/\/+$/, "")

  let match = /^workspace\/([A-Za-z0-9._-]+)$/.exec(canonicalPath)
  if (match) return { kind: "workspace", workspaceId: match[1]! }

  match = /^workspace\/([A-Za-z0-9._-]+)\/tab\/([A-Za-z0-9._-]+)$/.exec(canonicalPath)
  if (match) return { kind: "workspace", workspaceId: match[1]!, tabId: match[2]! }

  match = /^project\/([A-Za-z0-9._-]+)$/.exec(canonicalPath)
  if (match) return { kind: "project", projectId: match[1]! }

  return null
}
