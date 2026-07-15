import { useEffect, useId, useRef, type RefObject } from "react"
import { create } from "zustand"
import { t } from "../i18n"
import { consumeModalKey, useUi } from "../stores/ui"

type DialogRequest =
  | { kind: "confirm"; title: string; message: string; destructive: boolean; resolve(value: boolean): void }
  | { kind: "prompt"; title: string; message: string; initial: string; multiline: boolean; resolve(value: string | null): void }
  | { kind: "message"; title: string; message: string; resolve(): void }

interface DialogState {
  request: DialogRequest | null
  queued: DialogRequest[]
  returnFocus: HTMLElement | null
  show(request: DialogRequest): void
  complete(accepted: boolean, promptValue?: string): void
}

const useDialog = create<DialogState>((set, get) => ({
  request: null,
  queued: [],
  returnFocus: null,
  show: (next) => {
    if (!get().request) useUi.getState().openModal("dialog")
    set((state) => state.request
      ? { queued: [...state.queued, next] }
      : {
      request: next,
      returnFocus: typeof document === "undefined" ? null : document.activeElement as HTMLElement | null,
    })
  },
  complete: (accepted, promptValue) => {
    const state = get()
    const current = state.request
    if (!current) return
    if (current.kind === "confirm") current.resolve(accepted)
    else if (current.kind === "prompt") current.resolve(accepted ? promptValue ?? "" : null)
    else current.resolve()
    const [request = null, ...queued] = state.queued
    if (request) {
      set({ request, queued })
      return
    }
    const target = state.returnFocus
    if (target && typeof requestAnimationFrame !== "undefined")
      requestAnimationFrame(() => { if (target.isConnected !== false) target.focus() })
    set({ request: null, queued: [], returnFocus: null })
    useUi.getState().closeModal("dialog")
  },
}))

export const useAppDialogOpen = (): boolean => useDialog((state) => state.request !== null)

export const pendingDialogCount = (): number => {
  const state = useDialog.getState()
  return (state.request ? 1 : 0) + state.queued.length
}

/** Completes the active request. Exported so lifecycle decisions can be tested without a DOM. */
export const resolveActiveDialog = (accepted: boolean, promptValue?: string): void =>
  useDialog.getState().complete(accepted, promptValue)

export const trapTabKey = (
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  root: HTMLElement | null,
): boolean => {
  if (event.key !== "Tab" || !root) return false
  const focusable = [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden)
  if (focusable.length === 0) return false
  const current = document.activeElement
  const index = focusable.indexOf(current as HTMLElement)
  const next = event.shiftKey
    ? focusable[(index <= 0 ? focusable.length : index) - 1]
    : focusable[(index + 1) % focusable.length]
  event.preventDefault()
  next?.focus()
  return true
}

export const confirmDialog = (
  title: string,
  message: string,
  destructive = false,
): Promise<boolean> => new Promise((resolve) => useDialog.getState().show({
  kind: "confirm", title, message, destructive, resolve,
}))

export const promptDialog = (
  title: string,
  message: string,
  initial = "",
  multiline = false,
): Promise<string | null> => new Promise((resolve) => useDialog.getState().show({
  kind: "prompt", title, message, initial, multiline, resolve,
}))

export const messageDialog = (
  title: string,
  message: string,
): Promise<void> => new Promise((resolve) => useDialog.getState().show({
  kind: "message", title, message, resolve,
}))

export const DialogHost = () => {
  const request = useDialog((state) => state.request)
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const initialButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const messageId = useId()
  const cancel = (): void => {
    if (!request) return
    useDialog.getState().complete(false)
  }
  const accept = (): void => {
    if (!request) return
    useDialog.getState().complete(true, input.current?.value)
  }
  useEffect(() => {
    if (!request) return
    const frame = requestAnimationFrame(() => (request.kind === "prompt" ? input : initialButton).current?.focus())
    const onKey = (event: KeyboardEvent): void => {
      if (consumeModalKey(event, "Escape", cancel)) return
      if (trapTabKey(event, dialog.current)) return
      if (request.kind !== "prompt" || !request.multiline) consumeModalKey(event, "Enter", accept)
    }
    document.addEventListener("keydown", onKey, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [request])
  if (!request) return null
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel() }}>
      <div ref={dialog} className="modal app-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={messageId}>
        <h2 id={titleId}>{request.title}</h2>
        <p id={messageId}>{request.message}</p>
        {request.kind === "prompt" && (request.multiline
          ? <textarea ref={input as RefObject<HTMLTextAreaElement>} defaultValue={request.initial} aria-labelledby={messageId} />
          : <input ref={input as RefObject<HTMLInputElement>} defaultValue={request.initial} aria-labelledby={messageId} />)}
        <div className="settings-actions">
          {request.kind !== "message" &&
            <button ref={request.kind === "confirm" ? initialButton : undefined}
              className="btn-secondary" onClick={cancel}>{t("dialog.cancel")}</button>}
          <button ref={request.kind === "message" ? initialButton : undefined}
            className={request.kind === "confirm" && request.destructive ? "btn-danger" : "btn"} onClick={accept}>
            {t(request.kind === "confirm" ? "dialog.confirm" : request.kind === "prompt" ? "dialog.apply" : "dialog.close")}
          </button>
        </div>
      </div>
    </div>
  )
}
