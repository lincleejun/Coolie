import { create } from "zustand"
import {
  HOTKEYS_REGISTRY,
  setEffectiveRegistryProvider,
  type HotkeyDef,
} from "../hotkeys/registry"
import {
  KEYBINDINGS_STORAGE_KEY,
  loadKeybindingOverrides,
  mergeKeybindings,
  parseKeybindingJson,
  validateKeybindingOverrides,
  type KeybindingValidation,
} from "./keybindings"
import { applyTheme, type ThemePref } from "./theme"

export type Lang = "zh" | "en"

const THEME_STORAGE_KEY = "coolie.theme"
const LANG_STORAGE_KEY = "coolie.lang"
const NAME_POOL_STORAGE_KEY = "coolie.namePool"
const CUSTOM_NAMES_STORAGE_KEY = "coolie.customNames"
const PREFS_STORAGE_KEY = "coolie.preferences"

export interface AppPreferences {
  defaultEngine: string
  defaultModel: string
  notifications: boolean
  turnSound: boolean
}

const DEFAULT_PREFS: AppPreferences = {
  defaultEngine: "claude", defaultModel: "",
  notifications: true, turnSound: false,
}
const loadPrefs = (): AppPreferences => {
  try {
    const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(PREFS_STORAGE_KEY)
    if (!saved) return DEFAULT_PREFS
    const parsed = JSON.parse(saved) as Partial<AppPreferences>
    return {
      defaultEngine: typeof parsed.defaultEngine === "string" ? parsed.defaultEngine : DEFAULT_PREFS.defaultEngine,
      defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : DEFAULT_PREFS.defaultModel,
      notifications: typeof parsed.notifications === "boolean" ? parsed.notifications : DEFAULT_PREFS.notifications,
      turnSound: typeof parsed.turnSound === "boolean" ? parsed.turnSound : DEFAULT_PREFS.turnSound,
    }
  } catch { return DEFAULT_PREFS }
}

const loadChoice = <T extends string>(key: string, choices: readonly T[], fallback: T): T => {
  if (typeof localStorage === "undefined") return fallback
  try {
    const saved = localStorage.getItem(key)
    return choices.includes(saved as T) ? saved as T : fallback
  } catch {
    return fallback
  }
}

const saveChoice = (key: string, value: string): void => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value)
  } catch { /* storage may be unavailable; in-memory preference still applies */ }
}

interface SettingsState {
  readonly theme: ThemePref
  readonly lang: Lang
  readonly keybindings: Record<string, string | null>
  readonly effectiveHotkeys: HotkeyDef[]
  readonly keybindingError: string | null
  readonly namePool: string
  readonly customNames: string[]
  readonly preferences: AppPreferences
  setTheme(theme: ThemePref): void
  setLang(lang: Lang): void
  setNamePool(namePool: string): void
  setCustomNames(customNames: string[]): void
  setKeybindingOverrides(overrides: Record<string, string | null>): KeybindingValidation
  setPreference<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]): void
  applyKeybindingJson(json: string): KeybindingValidation
  resetKeybindings(): void
}

const loaded = loadKeybindingOverrides(HOTKEYS_REGISTRY)
const loadedTheme = loadChoice(THEME_STORAGE_KEY, ["system", "light", "dark"], "system")
const loadedLang = loadChoice(LANG_STORAGE_KEY, ["zh", "en"], "zh")
const loadNamePool = (): string => {
  if (typeof localStorage === "undefined") return "national-parks"
  try { return localStorage.getItem(NAME_POOL_STORAGE_KEY) || "national-parks" } catch { return "national-parks" }
}
const loadCustomNames = (): string[] => {
  if (typeof localStorage === "undefined") return []
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CUSTOM_NAMES_STORAGE_KEY) ?? "[]")
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []
  } catch { return [] }
}

const persist = (overrides: Record<string, string | null>): string | null => {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(overrides))
    return null
  } catch (error) {
    return `保存快捷键设置失败：${error instanceof Error ? error.message : String(error)}`
  }
}

export const useSettings = create<SettingsState>((set) => {
  const applyValidated = (result: KeybindingValidation): KeybindingValidation => {
    if (!result.ok) {
      set({ keybindingError: result.error })
      return result
    }
    const persistenceError = persist(result.overrides)
    set({
      keybindings: result.overrides,
      effectiveHotkeys: mergeKeybindings(HOTKEYS_REGISTRY, result.overrides),
      keybindingError: persistenceError,
    })
    return result
  }

  return {
    theme: loadedTheme,
    lang: loadedLang,
    namePool: loadNamePool(),
    customNames: loadCustomNames(),
    preferences: loadPrefs(),
    keybindings: loaded.overrides,
    effectiveHotkeys: mergeKeybindings(HOTKEYS_REGISTRY, loaded.overrides),
    keybindingError: loaded.error,
    setTheme: (theme) => {
      saveChoice(THEME_STORAGE_KEY, theme)
      set({ theme })
      applyTheme(theme)
    },
    setLang: (lang) => {
      saveChoice(LANG_STORAGE_KEY, lang)
      set({ lang })
    },
    setNamePool: (namePool) => {
      saveChoice(NAME_POOL_STORAGE_KEY, namePool)
      set({ namePool })
    },
    setCustomNames: (customNames) => {
      try {
        if (typeof localStorage !== "undefined")
          localStorage.setItem(CUSTOM_NAMES_STORAGE_KEY, JSON.stringify(customNames))
      } catch { /* retain in-memory preference */ }
      set({ customNames })
    },
    setPreference: (key, value) => set((state) => {
      const preferences = { ...state.preferences, [key]: value }
      try { if (typeof localStorage !== "undefined") localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(preferences)) } catch {}
      return { preferences }
    }),
    setKeybindingOverrides: (overrides) =>
      applyValidated(validateKeybindingOverrides(HOTKEYS_REGISTRY, overrides)),
    applyKeybindingJson: (json) =>
      applyValidated(parseKeybindingJson(HOTKEYS_REGISTRY, json)),
    resetKeybindings: () => {
      const persistenceError = persist({})
      set({
        keybindings: {},
        effectiveHotkeys: [...HOTKEYS_REGISTRY],
        keybindingError: persistenceError,
      })
    },
  }
})

setEffectiveRegistryProvider(() => useSettings.getState().effectiveHotkeys)
