import { useEffect, useState } from "react"
import { tmuxOnPath } from "../api/discovery"
import { pushHotkeyLayer } from "../hotkeys/dispatch"

export const TmuxGuide = () => {
  const [missing, setMissing] = useState(false)
  const [checking, setChecking] = useState(false)
  useEffect(() => { void tmuxOnPath().then((ok) => setMissing(!ok)) }, [])
  useEffect(() => {
    if (!missing) return
    return pushHotkeyLayer({ "workspace.new": () => {}, "tab.newShell": () => {}, "tab.close": () => {} })
  }, [missing])
  if (!missing) return null
  const recheck = async () => {
    setChecking(true)
    setMissing(!(await tmuxOnPath()))
    setChecking(false)
  }
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>需要安装 tmux</h2>
        <p>Coolie 用 tmux 承载 engine 会话（GUI 崩了 engine 也不死）。tmux 不是 macOS 自带工具：</p>
        <pre>brew install tmux</pre>
        <p className="dim">安装后点击重新检测。（也可用 <code>coolie doctor</code> 复核环境。）</p>
        <button className="btn" onClick={() => void recheck()} disabled={checking}>
          {checking ? "检测中…" : "重新检测"}
        </button>
      </div>
    </div>
  )
}
