import { useEffect, useRef, useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { planComposerKey } from "./send"
import { makeDrafts, type DraftStorage } from "./drafts"
import { fuzzyFilter, detectToken, type TokenHit } from "./fuzzy"
import { Picker } from "./Picker"
import type { SlashCommand } from "../stores/types"

const draftStorage: DraftStorage =
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const drafts = makeDrafts(draftStorage)

/** /model 投递：会话中切模型 = 翻译成 slash 命令（capabilities.midSessionModelSwitch 控制可用性） */
export const deliverModelSwitch = (wsId: string, model: string, engineWorking: boolean): Promise<void> =>
  useData.getState().sendInput(wsId, { text: `/model ${model}`, mode: "send", skipStable: engineWorking })

const QueueIndicator = ({ wsId }: { wsId: string }) => {
  const queued = useData((s) => s.queuedByWs[wsId])
  if (!queued || queued.length === 0) return null
  return (
    <div className="queue-ind">
      ⏳ {queued.length} 条排队中
      {queued.map((prompt) => (
        <button key={prompt.id} className="queue-cancel" title={`撤回：${prompt.text.slice(0, 40)}`}
          onClick={() => void useData.getState().withdrawQueued(wsId, prompt.id)}>×</button>
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

  const [token, setToken] = useState<TokenHit | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [commands, setCommands] = useState<SlashCommand[]>([])

  // @ 首次触发时懒加载文件/命令列表（workspace 切换时失效）
  useEffect(() => { setFiles([]); setCommands([]); setToken(null) }, [wsId])
  useEffect(() => { void useData.getState().refreshQueue(wsId) }, [wsId])
  const ensureLists = (kind: "file" | "command"): void => {
    const api = useData.getState().getApi()
    if (!api) return
    if (kind === "file" && files.length === 0)
      void api.req("GET", `/workspaces/${wsId}/files`).then((r) => setFiles(r.files)).catch(() => {})
    if (kind === "command" && commands.length === 0)
      void api.req("GET", `/workspaces/${wsId}/commands`).then((r) => setCommands(r.commands)).catch(() => setCommands([]))
  }

  const BUILTIN_COMMANDS = ["model", "clear", "compact", "resume", "help"] // claude 内置常用子集
  const pickerItems = token === null ? [] :
    token.kind === "file"
      ? fuzzyFilter(files, token.query)
      : fuzzyFilter([...new Set([...BUILTIN_COMMANDS, ...commands.map((c) => c.name)])], token.query)

  const refreshToken = (v: string, caret: number): void => {
    const t = detectToken(v, caret)
    setToken(t)
    if (t) ensureLists(t.kind)
  }

  const insertAtToken = (replacement: string): void => {
    if (!token || !ta.current) return
    const caret = ta.current.selectionStart
    const next = text.slice(0, token.start) + replacement + " " + text.slice(caret)
    update(next)
    setToken(null)
    requestAnimationFrame(() => {
      const pos = token.start + replacement.length + 1
      ta.current?.setSelectionRange(pos, pos)
      ta.current?.focus()
    })
  }

  useEffect(() => { setText(drafts.load(wsId)) }, [wsId])
  // T14-handoff：右栏 @注入 走 drafts.save + focusNonce bump——聚焦时重载草稿使注入立即上屏
  useEffect(() => { setText(drafts.load(wsId)); ta.current?.focus() }, [focusNonce])

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
    const nativeQueue = engine?.capabilities.nativeQueue === true
    const action = planComposerKey(e, { engineWorking: engineWorking === true, nativeQueue })
    switch (action.kind) {
      case "newline": return // textarea 默认行为
      case "none": return
      case "blur": e.preventDefault(); ta.current?.blur(); return // Esc 失焦回终端
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
      {token && pickerItems.length > 0 && (
        <Picker
          items={pickerItems}
          onClose={() => setToken(null)}
          onPick={(item) => insertAtToken(token.kind === "file" ? `@${item}` : `/${item}`)}
        />
      )}
      <div className="composer-box">
        <textarea
          ref={ta}
          value={text}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          placeholder={placeholder ?? "给 engine 的话… Enter 发送 · ⌘Enter 打断并发送 · ⌥Enter 仅插入 · ⇧Enter 换行"}
          onChange={(e) => { update(e.target.value); refreshToken(e.target.value, e.target.selectionStart) }}
          onKeyDown={(e) => {
            if (token && pickerItems.length > 0 && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key))
              return // PickerKeys 在 document capture 层接管
            onKeyDown(e)
          }}
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
