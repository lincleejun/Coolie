import { useEffect, useMemo, useRef, useState } from "react"
import { fuzzyFilter } from "../composer/fuzzy"
import { dispatchHotkeyId, getRunnableHotkeyIds } from "../hotkeys/dispatch"
import { hotkeyCategoryKey, hotkeyLabel, prettyChord, type HotkeyDef, type HotkeyId } from "../hotkeys/registry"
import { orderedActiveWs } from "../hotkeys/useGlobalHotkeys"
import { useSettings } from "../settings/settings"
import { useData } from "../stores/data"
import { consumeModalKey, useUi } from "../stores/ui"
import { useT } from "../i18n"
import type { MsgKey } from "../i18n"
import { buildTaskCommands } from "../sidebar/taskCommands"
import { promptDialog } from "./dialogs"

export interface Command {
  readonly id: string
  readonly title: string
  readonly chord?: string
  run(): void
}

export interface BuildCommandDeps {
  readonly hotkeys: readonly HotkeyDef[]
  readonly runnableActionIds: ReadonlySet<HotkeyId>
  readonly workspaces: readonly { id: string; name: string }[]
  readonly checkpointWorkspace?: { id: string; name: string } | undefined
  readonly checkpointCreateTitle?: string | undefined
  readonly checkpointListTitle?: string | undefined
  readonly workspaceSelectTitle?: string | undefined
  readonly translate?: ((key: MsgKey) => string) | undefined
  runHotkey(id: HotkeyId): void
  selectWs(id: string): void
  createCheckpoint?: (() => void) | undefined
  listCheckpoints?: (() => void) | undefined
}

export const buildCommands = (deps: BuildCommandDeps): Command[] => [
  ...deps.hotkeys
    .filter((hotkey) =>
      hotkey.id !== "app.commandPalette" && deps.runnableActionIds.has(hotkey.id))
    .map((hotkey) => ({
      id: `hk:${hotkey.id}`,
      title: `${deps.translate?.(hotkeyCategoryKey(hotkey.category)) ?? hotkey.category} · ${
        deps.translate ? hotkeyLabel(hotkey, deps.translate) : hotkey.labelKey
      }`,
      chord: hotkey.chord,
      run: () => deps.runHotkey(hotkey.id),
    })),
  ...deps.workspaces.map((workspace) => ({
    id: `ws:${workspace.id}`,
    title: `${deps.workspaceSelectTitle ?? "Switch workspace"} · ${workspace.name}`,
    run: () => deps.selectWs(workspace.id),
  })),
  ...(deps.checkpointWorkspace && deps.createCheckpoint ? [{
    id: "checkpoint:create",
    title: `${deps.checkpointCreateTitle ?? "创建 checkpoint"} · ${deps.checkpointWorkspace.name}`,
    run: deps.createCheckpoint,
  }] : []),
  ...(deps.checkpointWorkspace && deps.listCheckpoints ? [{
    id: "checkpoint:list",
    title: `${deps.checkpointListTitle ?? "列出 checkpoints"} · ${deps.checkpointWorkspace.name}`,
    run: deps.listCheckpoints,
  }] : []),
]

export const filterCommands = (commands: readonly Command[], query: string): Command[] => {
  const normalized = query.trim()
  if (normalized === "") return [...commands]
  const titles = fuzzyFilter(commands.map((command) => command.title), normalized)
  const byTitle = new Map<string, Command[]>()
  for (const command of commands) {
    const matches = byTitle.get(command.title) ?? []
    matches.push(command)
    byTitle.set(command.title, matches)
  }
  return titles.flatMap((title) => byTitle.get(title)?.shift() ?? [])
}

export const movePaletteSelection = (current: number, delta: number, length: number): number =>
  length === 0 ? 0 : (current + delta + length) % length

export const CommandPalette = () => {
  const tr = useT()
  const open = useUi((state) => state.paletteOpen)
  const registry = useSettings((state) => state.effectiveHotkeys)
  const workspaces = useData((state) => state.workspaces)
  const selectedWs = useUi((state) => state.selectedWs)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) {
      const target = returnFocus.current
      returnFocus.current = null
      if (target) requestAnimationFrame(() => { if (target.isConnected !== false) target.focus() })
      return
    }
    returnFocus.current ??= document.activeElement as HTMLElement | null
    setQuery("")
    setSelected(0)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const commands = useMemo(() => buildCommands({
    hotkeys: registry,
    runnableActionIds: getRunnableHotkeyIds(),
    workspaces: orderedActiveWs(),
    checkpointWorkspace: workspaces.find((workspace) => workspace.id === selectedWs && workspace.status === "active"),
    checkpointCreateTitle: tr("checkpoint.create"),
    checkpointListTitle: tr("checkpoint.list"),
    workspaceSelectTitle: tr("palette.switchWorkspace"),
    translate: tr,
    runHotkey: (id) => { dispatchHotkeyId(id) },
    selectWs: (id) => useUi.getState().selectWs(id),
    createCheckpoint: selectedWs ? () => {
      void promptDialog(tr("checkpoint.create"), tr("checkpoint.labelPrompt")).then((label) => {
        if (label === null) return
        const api = useData.getState().getApi()
        if (!api) {
          useData.getState().pushWarning("checkpoint.error", tr("checkpoint.noApi"))
          return
        }
        void api.req("POST", `/workspaces/${selectedWs}/checkpoints`, label === "" ? {} : { label })
        .then((item) => useData.getState().pushWarning(
          "checkpoint.created",
          `${tr("checkpoint.created")} ${item.ref} (${item.oid})`,
        ))
        .catch((error) => useData.getState().pushWarning(
          "checkpoint.error",
          error instanceof Error ? error.message : String(error),
        ))
      })
    } : undefined,
    listCheckpoints: selectedWs ? () => {
      const api = useData.getState().getApi()
      if (!api) {
        useData.getState().pushWarning("checkpoint.error", tr("checkpoint.noApi"))
        return
      }
      void api.req("GET", `/workspaces/${selectedWs}/checkpoints`)
        .then((items: Array<{ ref: string; oid: string }>) => useData.getState().pushWarning(
          "checkpoint.list",
          items.length === 0
            ? tr("checkpoint.empty")
            : items.slice(0, 3).map((item) => `${item.ref} (${item.oid.slice(0, 8)})`).join(" · "),
        ))
        .catch((error) => useData.getState().pushWarning(
          "checkpoint.error",
          error instanceof Error ? error.message : String(error),
        ))
    } : undefined,
  }).concat(
    workspaces.find((workspace) => workspace.id === selectedWs)
      ? buildTaskCommands(workspaces.find((workspace) => workspace.id === selectedWs)!).map((command) => ({
        id: `task:${command.id}`,
        title: `${tr("palette.task")} · ${command.label}`,
        chord: command.key,
        run: () => { void command.run() },
      }))
      : [],
  ), [registry, workspaces, selectedWs, open, tr])
  const filtered = filterCommands(commands, query)
  const close = (): void => useUi.getState().setPalette(false)
  const run = (command: Command): void => {
    close()
    command.run()
  }

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label={tr("palette.dialog")}
        onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          aria-label={tr("palette.search")}
          placeholder={tr("palette.placeholder")}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setSelected(0) }}
          onKeyDown={(event) => {
            if (consumeModalKey(event, "Escape", close)) return
            else if (event.key === "ArrowDown") {
              event.preventDefault()
              setSelected((value) => movePaletteSelection(value, 1, filtered.length))
            } else if (event.key === "ArrowUp") {
              event.preventDefault()
              setSelected((value) => movePaletteSelection(value, -1, filtered.length))
            } else if (event.key === "Enter") {
              const command = filtered[selected]
              consumeModalKey(event, "Enter", () => { if (command) run(command) })
            }
          }}
        />
        <div className="palette-list" role="listbox">
          {filtered.map((command, index) => (
            <button
              key={command.id}
              className={`palette-item${index === selected ? " sel" : ""}`}
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(command)}
            >
              <span>{command.title}</span>
              {command.chord && <kbd>{prettyChord(command.chord)}</kbd>}
            </button>
          ))}
          {filtered.length === 0 && <div className="dim palette-empty">{tr("palette.empty")}</div>}
        </div>
      </div>
    </div>
  )
}
