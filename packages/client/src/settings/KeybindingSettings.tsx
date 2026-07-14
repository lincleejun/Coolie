import { useEffect, useState } from "react"
import { useSettings, type Lang } from "./settings"
import { useUi } from "../stores/ui"
import { useT } from "../i18n"
import type { ThemePref } from "./theme"
import { useData } from "../stores/data"

export const KeybindingSettings = () => {
  const tr = useT()
  const open = useUi((state) => state.settingsOpen)
  const theme = useSettings((state) => state.theme)
  const lang = useSettings((state) => state.lang)
  const keybindings = useSettings((state) => state.keybindings)
  const error = useSettings((state) => state.keybindingError)
  const namePool = useSettings((state) => state.namePool)
  const customNames = useSettings((state) => state.customNames)
  const namePools = useData((state) => state.config?.namePools ?? [])
  const [draft, setDraft] = useState("{}")

  useEffect(() => {
    if (open) setDraft(JSON.stringify(keybindings, null, 2))
  }, [keybindings, open])

  if (!open) return null
  const close = (): void => useUi.getState().setSettings(false)
  const apply = (): void => {
    const result = useSettings.getState().applyKeybindingJson(draft)
    if (result.ok) setDraft(JSON.stringify(result.overrides, null, 2))
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal keybinding-settings"
        role="dialog"
        aria-label={tr("settings.dialog")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <h2>快捷键 JSON 覆盖</h2>
          <button className="dim" onClick={close}>关闭</button>
        </div>
        <fieldset className="settings-preferences">
          <legend>{tr("settings.preferences")}</legend>
          <label>
            <span>{tr("settings.theme")}</span>
            <select
              value={theme}
              onChange={(event) => useSettings.getState().setTheme(event.target.value as ThemePref)}
            >
              <option value="system">{tr("theme.system")}</option>
              <option value="light">{tr("theme.light")}</option>
              <option value="dark">{tr("theme.dark")}</option>
            </select>
          </label>
          <label>
            <span>{tr("settings.language")}</span>
            <select
              value={lang}
              onChange={(event) => useSettings.getState().setLang(event.target.value as Lang)}
            >
              <option value="zh">{tr("language.zh")}</option>
              <option value="en">{tr("language.en")}</option>
            </select>
          </label>
          <label>
            <span>{tr("settings.namePool")}</span>
            <select
              value={namePool}
              onChange={(event) => useSettings.getState().setNamePool(event.target.value)}
            >
              {namePools.map((pool) =>
                <option key={pool.id} value={pool.id}>{pool.displayName}</option>)}
            </select>
          </label>
          {namePool === "custom" && (
            <label>
              <span>{tr("settings.customNames")}</span>
              <textarea
                aria-label={tr("settings.customNames")}
                value={customNames.join("\n")}
                placeholder={tr("settings.customNamesHint")}
                onChange={(event) => useSettings.getState().setCustomNames(event.target.value.split("\n"))}
              />
            </label>
          )}
        </fieldset>
        <p className="dim">只填写需要覆盖的 action。格式示例：{`{ "composer.focus": "meta+shift+l" }`}</p>
        <textarea
          aria-label="快捷键 JSON"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); close() }
            if (event.key === "Enter" && event.metaKey) { event.preventDefault(); apply() }
          }}
        />
        {error && <div className="settings-error" role="alert">{error}</div>}
        <div className="settings-actions">
          <button className="btn-secondary" onClick={() => {
            useSettings.getState().resetKeybindings()
            setDraft("{}")
          }}>恢复默认</button>
          <button className="btn" onClick={apply}>立即应用 ⌘↵</button>
        </div>
      </div>
    </div>
  )
}
