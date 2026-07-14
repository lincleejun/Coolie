/** LIFO binding stack：模态（picker/cheatsheet/引导）push 一层覆盖同 id 绑定，关掉 pop 回落。 */
import { resolveHotkey, type HotkeyId, type KeyEventLike } from "./registry"

type Layer = Partial<Record<HotkeyId, () => void>>
const layers: Layer[] = []

export const pushHotkeyLayer = (handlers: Layer): (() => void) => {
  layers.push(handlers)
  let popped = false
  return () => {
    if (popped) return
    popped = true
    const i = layers.indexOf(handlers)
    if (i >= 0) layers.splice(i, 1)
  }
}

export const dispatchHotkey = (e: KeyEventLike): boolean => {
  const def = resolveHotkey(e)
  return def ? dispatchHotkeyId(def.id) : false
}

/** 命令面板等非键盘入口按 action id 复用同一 LIFO 动作路由。 */
export const dispatchHotkeyId = (id: HotkeyId): boolean => {
  for (let i = layers.length - 1; i >= 0; i--) {
    const h = layers[i]![id]
    if (h) { h(); return true }
  }
  return false
}

export const getRunnableHotkeyIds = (): ReadonlySet<HotkeyId> => {
  const ids = new Set<HotkeyId>()
  for (const layer of layers)
    for (const id of Object.keys(layer) as HotkeyId[])
      if (layer[id]) ids.add(id)
  return ids
}

/** 测试专用 */
export const _resetLayers = (): void => { layers.length = 0 }
