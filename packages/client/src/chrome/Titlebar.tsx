import { getCurrentWindow } from "@tauri-apps/api/window"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"

export const Titlebar = () => {
  const status = useData((s) => s.status)
  const selectedWs = useUi((s) => s.selectedWs)
  const ws = useData((s) => s.workspaces.find((w) => w.id === selectedWs))
  // getCurrentWindow() 在非 Tauri 浏览器（DEV 可视化自检）里会抛——降级为 no-op window，生产不变。
  const win = (() => { try { return getCurrentWindow() } catch { return { close() {}, minimize() {}, toggleMaximize() {} } as ReturnType<typeof getCurrentWindow> } })()
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="traffic" data-tauri-drag-region>
        <button className="tl close" title="关闭" onClick={() => void win.close()} />
        <button className="tl min" title="最小化" onClick={() => void win.minimize()} />
        <button className="tl max" title="缩放" onClick={() => void win.toggleMaximize()} />
      </div>
      <div className="titlebar-center" data-tauri-drag-region>
        {ws ? <><strong>{ws.name}</strong><span className="branch">⑂ {ws.branch}</span></> : <strong>Coolie</strong>}
      </div>
      <div className={`conn conn-${status}`} title={`server: ${status}`}>
        {status === "online" ? "●" : status === "offline" ? "○ 重连中…" : "○ 连接中…"}
      </div>
    </div>
  )
}
