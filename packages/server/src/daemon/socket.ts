/** sockaddr_un.sun_path 固定上限（含结尾 NUL）。未知平台不套用 Darwin/Linux 常量，避免误报。 */
export const SUN_PATH_MAX =
  process.platform === "darwin" ? 104 :
  process.platform === "linux" ? 108 :
  Number.POSITIVE_INFINITY

export const sockPathByteLength = (p: string): number => Buffer.byteLength(p, "utf8")

export const assertSockPathFits = (sockPath: string): void => {
  if (!Number.isFinite(SUN_PATH_MAX)) return
  const length = sockPathByteLength(sockPath)
  if (length >= SUN_PATH_MAX) {
    throw new Error(
      `unix socket 路径过长：${length} 字节，平台上限 ${SUN_PATH_MAX}（含结尾 NUL）：${sockPath}。` +
      "请把 COOLIE_HOME 设到更短的目录（例如 ~/.coolie）后重启。",
    )
  }
}

export const sockPathWarning = (sockPath: string): string | null => {
  if (!Number.isFinite(SUN_PATH_MAX)) return null
  const length = sockPathByteLength(sockPath)
  const softLimit = Math.floor(SUN_PATH_MAX * 0.9)
  return length >= softLimit
    ? `socket 路径 ${length} 字节，接近平台上限 ${SUN_PATH_MAX}（${sockPath}）——请缩短 COOLIE_HOME`
    : null
}
