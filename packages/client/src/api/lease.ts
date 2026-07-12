/**
 * [Plan 4 contract — verify at execution]
 * gui role lease：GUI 持有 server 生命周期（spec §2.1 role 化 refcount）。Plan 4 落地端点后按其真实
 * API（预期 POST /clients {role:"gui"} + 心跳）替换路径与字段。Plan 4 未合并时（404/501）静默降级为
 * no-op——daemon 靠 M1 的常驻行为兜底，不影响其余功能。
 */
import type { Api } from "./client"
import { ApiError } from "./client"

export const startGuiLease = (api: Api): (() => void) => {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const loop = async (): Promise<void> => {
    if (stopped) return
    try {
      await api.req("POST", "/clients", { role: "gui" })
      timer = setTimeout(() => void loop(), 10_000)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return // Plan 4 未合并：降级
      timer = setTimeout(() => void loop(), 10_000) // 瞬时失败重试
    }
  }
  void loop()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
