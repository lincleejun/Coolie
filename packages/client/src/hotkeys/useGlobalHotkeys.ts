import { useEffect } from "react"
import { dispatchHotkey, pushHotkeyLayer } from "./dispatch"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import type { HotkeyId } from "./registry"

/** pinned 稳定分组：置顶项优先，两个组内均保留输入顺序。 */
export const pinnedFirst = <T extends { pinned: boolean }>(items: readonly T[]): T[] => [
  ...items.filter((item) => item.pinned),
  ...items.filter((item) => !item.pinned),
]

/** 视觉顺序的 active workspace 列表——Cmd+1..9/[/] 的索引真源 */
export const orderedActiveWs = () => {
  const ws = useData.getState().workspaces.filter((w) => w.status === "active" || w.status === "creating" || w.status === "error")
  return pinnedFirst(ws)
}

const jumpTo = (i: number): void => {
  const list = orderedActiveWs()
  const w = list[i]
  if (w) useUi.getState().selectWs(w.id)
}

const jumpAdjacent = (delta: number): void => {
  const list = orderedActiveWs()
  if (list.length === 0) return
  const cur = list.findIndex((w) => w.id === useUi.getState().selectedWs)
  const next = ((cur < 0 ? 0 : cur) + delta + list.length) % list.length
  useUi.getState().selectWs(list[next]!.id)
}

export const useGlobalHotkeys = (): void => {
  useEffect(() => {
    const handlers: Partial<Record<HotkeyId, () => void>> = {
      "workspace.new": () => useUi.getState().setDispatchMode(true, useData.getState().projects[0]?.id ?? null),
      "workspace.prev": () => jumpAdjacent(-1),
      "workspace.next": () => jumpAdjacent(+1),
      ...(Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
        [`workspace.jump.${n}`, () => jumpTo(n - 1)])) as Partial<Record<HotkeyId, () => void>>),
      "composer.focus": () => useUi.getState().focusComposer(),
      "engine.interrupt": () => {
        const wsId = useUi.getState().selectedWs
        if (wsId) void useData.getState().sendInput(wsId, { text: "", mode: "interrupt", skipStable: true }).catch(() => {})
      },
      "app.cheatsheet": () => useUi.getState().setCheatsheet(!useUi.getState().cheatsheetOpen),
      "app.commandPalette": () => useUi.getState().setPalette(!useUi.getState().paletteOpen),
      "app.settings": () => useUi.getState().setSettings(!useUi.getState().settingsOpen),
    }
    const pop = pushHotkeyLayer(handlers)
    const onKey = (e: KeyboardEvent): void => {
      if (dispatchHotkey(e)) e.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("keydown", onKey); pop() }
  }, [])
}
