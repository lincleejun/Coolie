const CACHE_TTL_MS = 60_000
const CACHE_MAX = 64

interface CacheEntry {
  readonly path: string
  readonly expiresAt: number
}

const pathCache = new Map<string, CacheEntry>()

export const rememberRolloutPath = (sessionId: string, filePath: string, now = Date.now()): void => {
  if (pathCache.size >= CACHE_MAX) {
    const oldest = [...pathCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
    if (oldest) pathCache.delete(oldest[0])
  }
  pathCache.set(sessionId, { path: filePath, expiresAt: now + CACHE_TTL_MS })
}

export const cachedRolloutPath = (sessionId: string, now = Date.now()): string | null => {
  const entry = pathCache.get(sessionId)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    pathCache.delete(sessionId)
    return null
  }
  return entry.path
}

export const clearRolloutCache = (): void => {
  pathCache.clear()
}
