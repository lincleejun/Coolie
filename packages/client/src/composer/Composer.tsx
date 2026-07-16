import { useEffect, useRef, useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { planComposerKey } from "./send"
import { makeDrafts, type DraftStorage } from "./drafts"
import { fuzzyFilter, detectToken, type TokenHit } from "./fuzzy"
import { Picker } from "./Picker"
import type { SlashCommand } from "../stores/types"
import { useT } from "../i18n"
import {
  collectSupportedImages,
  insertAttachmentReferences,
  makeAttachmentReferences,
  translateAttachmentReferences,
  uploadImageFiles,
  type AttachmentReference,
} from "./attachments"
import { Dropdown } from "../chrome/Dropdown"
import { AttachIcon, SendIcon, SparkleIcon, StopIcon } from "../chrome/icons"

const draftStorage: DraftStorage =
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const drafts = makeDrafts(draftStorage)

/** /model 投递：会话中切模型 = 翻译成 slash 命令（capabilities.midSessionModelSwitch 控制可用性） */
export const deliverModelSwitch = (wsId: string, model: string, engineWorking: boolean): Promise<void> =>
  useData.getState().sendInput(wsId, { text: `/model ${model}`, mode: "send", skipStable: engineWorking })

const QueueIndicator = ({ wsId }: { wsId: string }) => {
  const tr = useT()
  const queued = useData((s) => s.queuedByWs[wsId])
  if (!queued || queued.length === 0) return null
  return (
    <div className="queue-ind">
      ⏳ {tr("composer.queue").replace("{count}", String(queued.length))}
      {queued.map((prompt) => (
        <button key={prompt.id} className="queue-cancel" title={tr("composer.withdraw").replace("{prompt}", prompt.text.slice(0, 40))}
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
  disabled?: boolean
}

export const Composer = ({ wsId, onSubmitOverride, placeholder, disabled = false }: ComposerProps) => {
  const tr = useT()
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(() => drafts.load(wsId))
  const textRef = useRef(text)
  const workspaceRef = useRef(wsId)
  const attachmentRefs = useRef<AttachmentReference[]>([])
  workspaceRef.current = wsId
  const [attachmentStatus, setAttachmentStatus] = useState<{
    done: number
    total: number
    error: string | null
  } | null>(null)
  const focusNonce = useUi((s) => s.composerFocusNonce)
  const tabs = useData((s) => s.tabsByWs[wsId])
  const selectedTabId = useUi((s) => s.selectedTabByWs[wsId])
  const config = useData((s) => s.config)
  const selectedTab = tabs?.find((t) => t.id === selectedTabId)
  const engineTab = selectedTab?.kind === "engine"
    ? selectedTab
    : tabs?.find((t) => t.kind === "engine")
  const engineWorking = engineTab?.status === "working"
  const engine = config?.engines.find((e) => e.id === (engineTab?.engineId ?? "claude"))
  const [model, setModel] = useState("default")

  const [token, setToken] = useState<TokenHit | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [commands, setCommands] = useState<SlashCommand[]>([])

  // @ 首次触发时懒加载文件/命令列表（workspace 切换时失效）
  useEffect(() => { setFiles([]); setCommands([]); setToken(null) }, [wsId])
  useEffect(() => { void useData.getState().refreshQueue(wsId) }, [wsId, engineTab?.id])
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

  useEffect(() => {
    const next = drafts.load(wsId)
    textRef.current = next
    setText(next)
    attachmentRefs.current = []
    setAttachmentStatus(null)
  }, [wsId])
  // T14-handoff：右栏 @注入 走 drafts.save + focusNonce bump——聚焦时重载草稿使注入立即上屏
  useEffect(() => {
    const next = drafts.load(wsId)
    textRef.current = next
    setText(next)
    ta.current?.focus()
  }, [focusNonce])

  const update = (v: string): void => {
    textRef.current = v
    setText(v)
    drafts.save(wsId, v)
  }

  const handleImages = (incoming: Iterable<File>): boolean => {
    const images = collectSupportedImages(incoming)
    if (images.length === 0) return false
    const api = useData.getState().getApi()
    if (!api) {
      setAttachmentStatus({ done: 0, total: images.length, error: tr("composer.attachments.noApi") })
      return true
    }
    setAttachmentStatus({ done: 0, total: images.length, error: null })
    void uploadImageFiles(api, wsId, images, {
      staging: onSubmitOverride !== undefined,
      onProgress: (done, total) => {
        if (workspaceRef.current === wsId) setAttachmentStatus({ done, total, error: null })
      },
    }).then(({ paths, errors }) => {
      // Workspace switches can race a large upload; never inject an old workspace's
      // absolute attachment path into the newly selected workspace draft.
      if (workspaceRef.current !== wsId) return
      if (paths.length > 0) {
        const references = makeAttachmentReferences(
          paths,
          attachmentRefs.current.length,
          (index) => tr("composer.attachments.imageLabel").replace("{index}", String(index)),
        )
        attachmentRefs.current = [...attachmentRefs.current, ...references]
        const current = textRef.current
        const start = ta.current?.selectionStart ?? current.length
        const end = ta.current?.selectionEnd ?? start
        const inserted = insertAttachmentReferences(current, start, end, references)
        update(inserted.text)
        requestAnimationFrame(() => {
          ta.current?.setSelectionRange(inserted.caret, inserted.caret)
          ta.current?.focus()
        })
      }
      const error = errors.length > 0
        ? `${tr("composer.attachments.failed")}: ${errors.map((item) => `${item.name} (${item.message})`).join("; ")}`
        : null
      setAttachmentStatus({ done: images.length, total: images.length, error })
    })
    return true
  }

  const deliver = async (mode: "send" | "interrupt-send" | "insert", skipStable: boolean): Promise<void> => {
    const draftBody = text.trim()
    if (draftBody === "") return
    const refs = attachmentRefs.current
    const body = translateAttachmentReferences(draftBody, refs)
    update("") // 先清（乐观）：投递数秒内用户可继续打下一条；失败恢复草稿
    attachmentRefs.current = []
    try {
      await useData.getState().sendInput(wsId, { text: body, mode, skipStable })
    } catch (e: any) {
      attachmentRefs.current = refs
      update(draftBody)
      useData.getState().pushWarning(
        "composer.send",
        tr("composer.sendFailed").replace("{error}", String(e?.message ?? e)),
      )
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (onSubmitOverride) {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        const body = text.trim()
        if (body !== "") {
          onSubmitOverride(translateAttachmentReferences(body, attachmentRefs.current))
          attachmentRefs.current = []
          update("")
        }
      }
      if (e.key === "Escape") { e.preventDefault(); useUi.getState().setDispatchMode(false) }
      return
    }
    const nativeQueue = engine?.capabilities?.nativeQueue === true
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

  /** Click-to-send (mirrors ⏎): dispatch flow when in dispatch mode, else deliver. */
  const submit = (): void => {
    if (disabled) return
    if (onSubmitOverride) {
      const body = text.trim()
      if (body !== "") {
        onSubmitOverride(translateAttachmentReferences(body, attachmentRefs.current))
        attachmentRefs.current = []
        update("")
      }
      return
    }
    void deliver("send", engineWorking === true)
  }

  const switchModel = (m: string): void => {
    setModel(m)
    if (m === "default") return
    if (engine?.capabilities?.midSessionModelSwitch)
      void deliverModelSwitch(wsId, m, engineWorking === true)
        .catch((e) => useData.getState().pushWarning(
          "engine.switch",
          tr("composer.modelSwitchFailed").replace("{error}", e.message),
        ))
  }

  return (
    <div className="composer">
      <div className="composer-inner">
      <QueueIndicator wsId={wsId} />
      {attachmentStatus && (
        <div className={attachmentStatus.error ? "attachment-status attachment-error" : "attachment-status"} role="status">
          {attachmentStatus.error ??
            `${attachmentStatus.done === attachmentStatus.total
              ? tr("composer.attachments.complete")
              : tr("composer.attachments.uploading")} ${attachmentStatus.done}/${attachmentStatus.total}`}
        </div>
      )}
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
          disabled={disabled}
          value={text}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          placeholder={placeholder ?? tr("composer.placeholder")}
          onChange={(e) => { update(e.target.value); refreshToken(e.target.value, e.target.selectionStart) }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.items)
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null)
            if (collectSupportedImages(files).length > 0) {
              e.preventDefault()
              handleImages(files)
            }
          }}
          onDragOver={(e) => {
            if (collectSupportedImages(e.dataTransfer.files).length > 0) e.preventDefault()
          }}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer.files)
            if (collectSupportedImages(files).length > 0) {
              e.preventDefault()
              handleImages(files)
            }
          }}
          onKeyDown={(e) => {
            if (token && pickerItems.length > 0 && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key))
              return // PickerKeys 在 document capture 层接管
            onKeyDown(e)
          }}
        />
        <div className="cbox-bar">
          {engine && engine.capabilities?.midSessionModelSwitch && !onSubmitOverride && (
            <Dropdown
              className="model-chip"
              title={tr("composer.model")}
              leading={<SparkleIcon size={13} className="mk" />}
              value={model}
              onChange={switchModel}
              options={[
                { value: "default", label: engine.displayName },
                ...engine.models.map((m) => ({ value: m, label: `${engine.displayName}·${m}` })),
              ]}
            />
          )}
          {/* effort 选择器：engine.capabilities.effort=false（claude）→ 不渲染（Noop 降级，M2 codex 启用） */}
          <div className="cbar-sp" />
          {engineWorking && (
            <button className="cchip stop-chip" title={tr("composer.interruptTitle")} aria-label={tr("composer.interrupt")} onClick={interrupt}>
              <StopIcon size={12} />
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length > 0) handleImages(files)
              e.target.value = ""
            }}
          />
          <button className="icobtn" title={tr("composer.attach")} aria-label={tr("composer.attach")} onClick={() => fileInput.current?.click()} disabled={disabled}>
            <AttachIcon />
          </button>
          <button className="csend" title={tr("composer.send")} aria-label={tr("composer.send")} onClick={submit} disabled={disabled}>
            <SendIcon />
          </button>
        </div>
      </div>
      </div>
    </div>
  )
}
