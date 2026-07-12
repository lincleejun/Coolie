import { useEffect, useRef, useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { planComposerKey } from "./send"
import { makeDrafts } from "./drafts"

const drafts = makeDrafts(localStorage)

/** /model 投递：会话中切模型 = 翻译成 slash 命令（capabilities.midSessionModelSwitch 控制可用性） */
export const deliverModelSwitch = (wsId: string, model: string, engineWorking: boolean): Promise<void> =>
  useData.getState().sendInput(wsId, { text: `/model ${model}`, mode: "send", skipStable: engineWorking })

const QueueIndicator = ({ wsId }: { wsId: string }) => {
  const pending = useData((s) => s.pendingSends.filter((p) => p.wsId === wsId))
  if (pending.length === 0) return null
  return (
    <div className="queue-ind">
      ⏳ {pending.length} 条投递中
      {pending.map((p) => (
        <button key={p.id} className="queue-cancel" title={`撤回：${p.text.slice(0, 40)}`}
          onClick={() => useData.getState().cancelSend(p.id)}>×</button>
      ))}
    </div>
  )
}

export interface ComposerProps {
  wsId: string
  /** dispatch 模式（Task 15）：接管 Enter 提交（创建 workspace），三档语义停用 */
  onSubmitOverride?: (text: string) => void
  placeholder?: string
}

export const Composer = ({ wsId, onSubmitOverride, placeholder }: ComposerProps) => {
  const ta = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(() => drafts.load(wsId))
  const focusNonce = useUi((s) => s.composerFocusNonce)
  const tabs = useData((s) => s.tabsByWs[wsId])
  const config = useData((s) => s.config)
  const engineTab = tabs?.find((t) => t.kind === "engine")
  const engineWorking = engineTab?.status === "working"
  const engine = config?.engines.find((e) => e.id === (engineTab?.engineId ?? "claude"))
  const [model, setModel] = useState("default")

  useEffect(() => { setText(drafts.load(wsId)) }, [wsId])
  useEffect(() => { ta.current?.focus() }, [focusNonce])

  const update = (v: string): void => { setText(v); drafts.save(wsId, v) }

  const deliver = async (mode: "send" | "interrupt-send" | "insert", skipStable: boolean): Promise<void> => {
    const body = text.trim()
    if (body === "") return
    update("") // 先清（乐观）：投递数秒内用户可继续打下一条；失败恢复草稿
    try {
      await useData.getState().sendInput(wsId, { text: body, mode, skipStable })
    } catch (e: any) {
      update(body)
      alert(`投递失败：${e?.message ?? e}`)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (onSubmitOverride) {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        const body = text.trim()
        if (body !== "") { onSubmitOverride(body); update("") }
      }
      if (e.key === "Escape") { e.preventDefault(); useUi.getState().setDispatchMode(false) }
      return
    }
    const action = planComposerKey(e, { engineWorking: engineWorking === true })
    switch (action.kind) {
      case "newline": return // textarea 默认行为
      case "none": return
      case "blur": e.preventDefault(); ta.current?.blur(); return // Esc 失焦回终端（双击 Esc 自然形成失焦→打断）
      case "send": e.preventDefault(); void deliver("send", action.skipStable); return
      case "insert": e.preventDefault(); void deliver("insert", action.skipStable); return
      case "interrupt-send": e.preventDefault(); void deliver("interrupt-send", false); return
    }
  }

  const interrupt = (): void => {
    void useData.getState().sendInput(wsId, { text: "", mode: "interrupt", skipStable: true }).catch(() => {})
  }

  const switchModel = (m: string): void => {
    setModel(m)
    if (m === "default") return
    if (engine?.capabilities.midSessionModelSwitch)
      void deliverModelSwitch(wsId, m, engineWorking === true).catch((e) => alert(`切换失败：${e.message}`))
  }

  return (
    <div className="composer">
      <QueueIndicator wsId={wsId} />
      <div className="composer-box">
        <textarea
          ref={ta}
          value={text}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          placeholder={placeholder ?? "给 engine 的话… Enter 发送 · ⌘Enter 打断并发送 · ⌥Enter 仅插入 · ⇧Enter 换行"}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-side">
          {engineWorking && (
            <button className="stop-btn" title="打断（⌘.）" onClick={interrupt}>■</button>
          )}
          {engine && engine.capabilities.midSessionModelSwitch && !onSubmitOverride && (
            <select className="model-sel" value={model} onChange={(e) => switchModel(e.target.value)} title="模型（投 /model）">
              {engine.models.map((m) => <option key={m} value={m}>{engine.displayName}·{m}</option>)}
            </select>
          )}
          {/* effort 选择器：engine.capabilities.effort=false（claude）→ 不渲染（Noop 降级，M2 codex 启用） */}
        </div>
      </div>
    </div>
  )
}
