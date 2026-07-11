import { existsSync, renameSync, statSync } from "node:fs"

export const DEFAULT_LOG_ROTATE_CAP_BYTES = 10 * 1024 * 1024 // 10MB

export const shouldRotateLog = (sizeBytes: number, capBytes: number = DEFAULT_LOG_ROTATE_CAP_BYTES): boolean =>
  sizeBytes > capBytes

/** 超限则 rename 成 `<path>.old`（覆盖上一代）。best-effort：失败绝不阻断启动。 */
export const rotateLogIfNeeded = (path: string, capBytes: number = DEFAULT_LOG_ROTATE_CAP_BYTES): void => {
  try {
    if (!existsSync(path)) return
    if (!shouldRotateLog(statSync(path).size, capBytes)) return
    renameSync(path, `${path}.old`)
  } catch { /* swallow */ }
}
