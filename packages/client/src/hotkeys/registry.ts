import type { MsgKey } from "../i18n/dict"

/**
 * 单一真源（spec §7.3）：绑定与 ⌘/ cheatsheet 同源渲染。
 * 全局键约束在 Cmd 空间——Ctrl 系天然透传给 shell/engine。
 * 打印字符按 event.code（物理键）匹配，防 Dvorak/QWERTZ 漂移（Superset CONTRACT 同款）。
 * 用户 JSON 只能覆盖这里已有 action，不能扩张 registry。
 */
export type HotkeyId =
  | "workspace.new" | "tab.newShell" | "tab.newEngine" | "tab.close" | "tab.rename" | "tab.prev" | "tab.next"
  | "workspace.jump.1" | "workspace.jump.2" | "workspace.jump.3" | "workspace.jump.4" | "workspace.jump.5"
  | "workspace.jump.6" | "workspace.jump.7" | "workspace.jump.8" | "workspace.jump.9"
  | "workspace.prev" | "workspace.next"
  | "composer.focus" | "engine.interrupt" | "app.cheatsheet"
  | "app.commandPalette" | "app.settings" | "workspace.zen"

export type HotkeyCategory = "workspace" | "tab" | "composer" | "app"
export interface HotkeyDef {
  id: HotkeyId
  chord: string
  labelKey: MsgKey
  category: HotkeyCategory
}

const jump = (n: number): HotkeyDef =>
  ({ id: `workspace.jump.${n}` as HotkeyId, chord: `meta+${n}`, labelKey: "hotkey.workspace.jump", category: "workspace" })

export const HOTKEYS_REGISTRY: readonly HotkeyDef[] = [
  { id: "workspace.new", chord: "meta+n", labelKey: "hotkey.workspace.new", category: "workspace" },
  { id: "workspace.prev", chord: "meta+[", labelKey: "hotkey.workspace.prev", category: "workspace" },
  { id: "workspace.next", chord: "meta+]", labelKey: "hotkey.workspace.next", category: "workspace" },
  { id: "workspace.zen", chord: "meta+shift+z", labelKey: "hotkey.workspace.zen", category: "workspace" },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(jump),
  { id: "tab.newShell", chord: "meta+t", labelKey: "hotkey.tab.newShell", category: "tab" },
  { id: "tab.newEngine", chord: "meta+shift+t", labelKey: "hotkey.tab.newEngine", category: "tab" },
  { id: "tab.prev", chord: "meta+alt+[", labelKey: "hotkey.tab.prev", category: "tab" },
  { id: "tab.next", chord: "meta+alt+]", labelKey: "hotkey.tab.next", category: "tab" },
  { id: "tab.rename", chord: "meta+shift+r", labelKey: "hotkey.tab.rename", category: "tab" },
  { id: "tab.close", chord: "meta+w", labelKey: "hotkey.tab.close", category: "tab" },
  { id: "composer.focus", chord: "meta+l", labelKey: "hotkey.composer.focus", category: "composer" },
  { id: "engine.interrupt", chord: "meta+.", labelKey: "hotkey.engine.interrupt", category: "composer" },
  { id: "app.cheatsheet", chord: "meta+/", labelKey: "hotkey.app.cheatsheet", category: "app" },
  { id: "app.commandPalette", chord: "meta+k", labelKey: "hotkey.app.commandPalette", category: "app" },
  { id: "app.settings", chord: "meta+,", labelKey: "hotkey.app.settings", category: "app" },
]

export const hotkeyCategoryKey = (category: HotkeyCategory): MsgKey => `hotkey.category.${category}`

export const hotkeyLabel = (hotkey: HotkeyDef, translate: (key: MsgKey) => string): string =>
  translate(hotkey.labelKey).replace(
    "{n}",
    hotkey.id.startsWith("workspace.jump.") ? hotkey.id.slice(-1) : "",
  )

export interface KeyEventLike {
  metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; code: string; key: string
}

const CODE_MAP: Record<string, string> = {
  BracketLeft: "[", BracketRight: "]", Period: ".", Slash: "/", Comma: ",",
}

/** 只归一 meta 系 chord；alt/shift 参与拼串（精确匹配，不误伤 Cmd+Shift+X 之类未注册组合） */
export const normalizeChord = (e: KeyEventLike): string | null => {
  if (!e.metaKey || e.ctrlKey) return null
  let base: string | null = null
  if (/^Key[A-Z]$/.test(e.code)) base = e.code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(e.code)) base = e.code.slice(5)
  else if (CODE_MAP[e.code]) base = CODE_MAP[e.code]!
  if (base === null) return null
  return `meta+${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}${base}`
}

let effectiveRegistryProvider: () => readonly HotkeyDef[] = () => HOTKEYS_REGISTRY

/**
 * settings 在初始化时安装动态 provider，避免 registry↔settings 的 ESM 循环依赖。
 * 返回清理函数便于隔离测试或未来多实例宿主。
 */
export const setEffectiveRegistryProvider = (
  provider: () => readonly HotkeyDef[],
): (() => void) => {
  effectiveRegistryProvider = provider
  return () => {
    if (effectiveRegistryProvider === provider) effectiveRegistryProvider = () => HOTKEYS_REGISTRY
  }
}

export const getEffectiveRegistry = (): readonly HotkeyDef[] => effectiveRegistryProvider()

export const prettyChord = (chord: string): string =>
  chord.replace("meta+", "⌘").replace("alt+", "⌥").replace("shift+", "⇧").toUpperCase()

export const resolveHotkey = (e: KeyEventLike): HotkeyDef | null => {
  const chord = normalizeChord(e)
  return chord ? getEffectiveRegistry().find((hotkey) => hotkey.chord === chord) ?? null : null
}
