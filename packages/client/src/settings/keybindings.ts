import type { HotkeyDef, HotkeyId } from "../hotkeys/registry"

export const KEYBINDINGS_STORAGE_KEY = "coolie.keybindings"

export interface ValidationSuccess {
  readonly ok: true
  readonly overrides: Record<string, string | null>
}

export interface ValidationFailure {
  readonly ok: false
  readonly error: string
}

export type KeybindingValidation = ValidationSuccess | ValidationFailure

const CHORD_PATTERN = /^meta\+(?:alt\+)?(?:shift\+)?[a-z0-9[\]./,]$/

export const mergeKeybindings = (
  base: readonly HotkeyDef[],
  overrides: Readonly<Record<string, string | null>>,
): HotkeyDef[] =>
  base.flatMap((hotkey) => overrides[hotkey.id] === null
    ? []
    : [overrides[hotkey.id] === undefined ? hotkey : { ...hotkey, chord: overrides[hotkey.id]! }])

export const validateKeybindingOverrides = (
  base: readonly HotkeyDef[],
  value: unknown,
): KeybindingValidation => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "键位配置必须是 JSON 对象：{ \"action.id\": \"meta+键\" }" }

  const knownIds = new Set(base.map((hotkey) => hotkey.id))
  const overrides: Record<string, string | null> = {}
  for (const [id, chord] of Object.entries(value)) {
    if (!knownIds.has(id as HotkeyId))
      return { ok: false, error: `未知 action「${id}」；请从快捷键列表中选择已有 action` }
    if (chord === null) {
      overrides[id] = null
      continue
    }
    if (typeof chord !== "string")
      return { ok: false, error: `action「${id}」的键位必须是字符串或 null` }
    if (!CHORD_PATTERN.test(chord))
      return { ok: false, error: `action「${id}」的键位格式无效：${chord}（示例：meta+k、meta+shift+l）` }
    overrides[id] = chord
  }

  const ownerByChord = new Map<string, string>()
  for (const hotkey of mergeKeybindings(base, overrides)) {
    const owner = ownerByChord.get(hotkey.chord)
    if (owner)
      return { ok: false, error: `键位冲突：${hotkey.chord} 同时分配给「${owner}」和「${hotkey.id}」` }
    ownerByChord.set(hotkey.chord, hotkey.id)
  }
  return { ok: true, overrides }
}

export const parseKeybindingJson = (
  base: readonly HotkeyDef[],
  json: string,
): KeybindingValidation => {
  try {
    return validateKeybindingOverrides(base, JSON.parse(json) as unknown)
  } catch (error) {
    return {
      ok: false,
      error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export interface LoadedKeybindings {
  readonly overrides: Record<string, string | null>
  readonly error: string | null
}

export const exportKeybindingsYaml = (overrides: Readonly<Record<string, string | null>>): string =>
  ["version: 1", "keybindings:", ...Object.entries(overrides).map(([id, chord]) =>
    `  ${JSON.stringify(id)}: ${chord === null ? "null" : JSON.stringify(chord)}`)].join("\n") + "\n"

export const parseKeybindingsYaml = (base: readonly HotkeyDef[], yaml: string): KeybindingValidation => {
  const lines = yaml.split(/\r?\n/)
  const overrides: Record<string, string | null> = {}
  let inBindings = false
  try {
    for (const raw of lines) {
      const line = raw.trim()
      if (line === "" || line.startsWith("#") || line === "version: 1") continue
      if (line === "keybindings:") { inBindings = true; continue }
      if (!inBindings) throw new Error(`unsupported line: ${line}`)
      const match = raw.match(/^\s{2}("[^"]+"|[A-Za-z0-9_.-]+):\s*(null|"[^"]*")\s*$/)
      if (!match) throw new Error(`invalid binding: ${line}`)
      const id = match[1]!.startsWith("\"") ? JSON.parse(match[1]!) as string : match[1]!
      overrides[id] = match[2] === "null" ? null : JSON.parse(match[2]!) as string
    }
  } catch (error) {
    return { ok: false, error: `YAML import failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return validateKeybindingOverrides(base, overrides)
}

export const loadKeybindingOverrides = (base: readonly HotkeyDef[]): LoadedKeybindings => {
  try {
    if (typeof localStorage === "undefined") return { overrides: {}, error: null }
    const raw = localStorage.getItem(KEYBINDINGS_STORAGE_KEY)
    if (!raw) return { overrides: {}, error: null }
    const result = parseKeybindingJson(base, raw)
    return result.ok
      ? { overrides: result.overrides, error: null }
      : { overrides: {}, error: result.error }
  } catch (error) {
    return {
      overrides: {},
      error: `读取快捷键设置失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
