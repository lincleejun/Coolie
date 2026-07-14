import type { ITheme } from "@xterm/xterm"

export type ThemePref = "system" | "light" | "dark"
export type ResolvedTheme = Exclude<ThemePref, "system">

export interface ThemeMedia {
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void
}

export const resolveTheme = (pref: ThemePref, systemDark: boolean): ResolvedTheme =>
  pref === "system" ? (systemDark ? "dark" : "light") : pref

export const terminalTheme = (theme: ResolvedTheme): ITheme =>
  theme === "light"
    ? {
        background: "#f8f8fa",
        foreground: "#1c1c1f",
        cursor: "#315fae",
        cursorAccent: "#f8f8fa",
        selectionBackground: "#3b6fd440",
      }
    : {
        background: "#1e1e22",
        foreground: "#e6e6e9",
        cursor: "#7aa2f7",
        cursorAccent: "#1e1e22",
        selectionBackground: "#7aa2f740",
      }

export const applyResolvedTheme = (theme: ResolvedTheme): void => {
  if (typeof document === "undefined") return
  document.documentElement.dataset.theme = theme
}

export const systemIsDark = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true

export const applyTheme = (pref: ThemePref): ResolvedTheme => {
  const resolved = resolveTheme(pref, systemIsDark())
  applyResolvedTheme(resolved)
  return resolved
}

export const createSystemThemeListener = (
  media: ThemeMedia,
  getPreference: () => ThemePref,
  apply: (theme: ResolvedTheme) => void,
): (() => void) => {
  const onChange = (event: { matches: boolean }): void => {
    if (getPreference() === "system")
      apply(resolveTheme("system", event.matches))
  }
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

export const watchSystemTheme = (
  getPreference: () => ThemePref,
  apply: (theme: ResolvedTheme) => void = applyResolvedTheme,
): (() => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  return createSystemThemeListener(
    window.matchMedia("(prefers-color-scheme: dark)"),
    getPreference,
    apply,
  )
}
