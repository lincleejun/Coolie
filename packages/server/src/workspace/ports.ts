/** 每 workspace 一段 10 个连续端口（Conductor 同款），base 从 4 万段起步。 */
export const PORT_BLOCK_SIZE = 10
export const PORT_BASE_START = 40_000
const PORT_BASE_MAX = 64_990

/** 找第一个未占用的段基址；持久化在 workspaces.data.portBase，删行后自然回收。 */
export const allocatePortBase = (used: ReadonlyArray<number>): number => {
  const taken = new Set(used)
  for (let base = PORT_BASE_START; base <= PORT_BASE_MAX; base += PORT_BLOCK_SIZE) {
    if (!taken.has(base)) return base
  }
  throw new Error("端口段耗尽（>2400 个并存 workspace？）") // 视为 defect
}

export const portEnv = (portBase: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: PORT_BLOCK_SIZE }, (_, i) => [`COOLIE_PORT_${i}`, String(portBase + i)]),
  )
