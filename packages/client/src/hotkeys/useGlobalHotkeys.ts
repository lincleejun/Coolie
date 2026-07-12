import { useEffect } from "react"
import { dispatchHotkey, pushHotkeyLayer } from "./dispatch"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"

/** 视觉顺序的 active workspace 列表（pinned 优先 → createdAt 倒序）——Cmd+1..9/[/] 的索引真源 */
export const orderedActiveWs = () => {
  const ws = useData.getState().workspaces.filter((w) => w.status === "active" || w.status === "creating" || w.status === "error")
  return [...ws].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || b.createdAt - a.createdAt)
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
    const pop = pushHotkeyLayer({
      "workspace.new": () => useUi.getState().setDispatchMode(true, useData.getState().projects[0]?.id ?? null),
      "workspace.prev": () => jumpAdjacent(-1),
      "workspace.next": () => jumpAdjacent(+1),
      ...(Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`workspace.jump.${n}`, () => jumpTo(n - 1)]))),
      "composer.focus": () => useUi.getState().focusComposer(),
      "engine.interrupt": () => {
        const wsId = useUi.getState().selectedWs
        if (wsId) void useData.getState().sendInput(wsId, { text: "", mode: "interrupt", skipStable: true }).catch(() => {})
      },
      "app.cheatsheet": () => useUi.getState().setCheatsheet(!useUi.getState().cheatsheetOpen),
    })
    const onKey = (e: KeyboardEvent): void => {
      if (dispatchHotkey(e)) e.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("keydown", onKey); pop() }
  }, [])
}
