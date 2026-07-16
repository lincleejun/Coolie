import { useEffect, useRef, useState } from "react"
import { useSettings, type Lang } from "./settings"
import { consumeModalKey, useUi } from "../stores/ui"
import { useT } from "../i18n"
import type { ThemePref } from "./theme"
import { useData } from "../stores/data"
import { exportKeybindingsYaml, parseKeybindingsYaml } from "./keybindings"
import { HOTKEYS_REGISTRY } from "../hotkeys/registry"
import { playTurnCompleteSound } from "../chrome/notify"
import { promptDialog, trapTabKey, useAppDialogOpen } from "../chrome/dialogs"
import { showToast } from "../chrome/Toasts"
import { ProjectSettings } from "./ProjectSettings"

type Section = "general" | "project" | "engines" | "accounts" | "keybindings" | "feedback" | "dev"

export const KeybindingSettings = ({ forceOpen = false }: { forceOpen?: boolean }) => {
  const tr = useT()
  const open = useUi((state) => state.settingsOpen) || forceOpen
  const theme = useSettings((state) => state.theme)
  const lang = useSettings((state) => state.lang)
  const keybindings = useSettings((state) => state.keybindings)
  const error = useSettings((state) => state.keybindingError)
  const namePool = useSettings((state) => state.namePool)
  const customNames = useSettings((state) => state.customNames)
  // Default outside the selector: returning a fresh [] inside a zustand selector makes
  // useSyncExternalStore see a new snapshot every render → infinite re-render (blank screen).
  const projects = useData((state) => state.projects)
  const namePools = useData((state) => state.config?.namePools) ?? []
  const engines = useData((state) => state.config?.engines) ?? []
  const selectedWs = useUi((state) => state.selectedWs)
  const selectedProjectId = selectedWs
    ? useData.getState().workspaces.find((workspace) => workspace.id === selectedWs)?.projectId
    : projects[0]?.id
  const [draft, setDraft] = useState("{}")
  const [engineDraft, setEngineDraft] = useState("")
  const [engineMessage, setEngineMessage] = useState<string | null>(null)
  const [section, setSection] = useState<Section>("general")
  const preferences = useSettings((state) => state.preferences)
  const firstNav = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const appDialogOpen = useAppDialogOpen()

  useEffect(() => {
    if (forceOpen) useUi.getState().openModal("settings")
    return () => { if (forceOpen) useUi.getState().closeModal("settings") }
  }, [forceOpen])

  useEffect(() => {
    if (!open) {
      const target = returnFocus.current
      returnFocus.current = null
      if (target) requestAnimationFrame(() => { if (target.isConnected !== false) target.focus() })
      return
    }
    if (!appDialogOpen) {
      returnFocus.current ??= document.activeElement as HTMLElement | null
      setDraft(JSON.stringify(keybindings, null, 2))
      requestAnimationFrame(() => firstNav.current?.focus())
    }
  }, [appDialogOpen, keybindings, open])

  if (!open || appDialogOpen) return null
  const close = (): void => useUi.getState().setSettings(false)
  const runSettingAction = (code: string, action: () => Promise<unknown>): void => {
    void action().catch((error: unknown) => showToast(code, error))
  }
  const apply = (): void => {
    const result = useSettings.getState().applyKeybindingJson(draft)
    if (result.ok) setDraft(JSON.stringify(result.overrides, null, 2))
  }

  return (
    // Prefer mousedown-on-backdrop (same as Inbox/project picker): a click that opens
    // Settings must not hit a freshly mounted backdrop onClick and immediately close it.
    <div
      className="modal-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div
        ref={dialog}
        className="modal keybinding-settings settings-shell"
        role="dialog"
        aria-label={tr("settings.dialog")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (trapTabKey(event.nativeEvent, dialog.current)) return
          consumeModalKey(event, "Escape", close)
        }}
      >
        <div className="settings-head">
          <h2>{tr("settings.dialog")}</h2>
          <button className="dim" onClick={close}>{tr("dialog.close")}</button>
        </div>
        <div className="settings-layout">
        <nav className="settings-nav" aria-label={tr("settings.dialog")}>
          {(["general", "project", "engines", "accounts", "keybindings", "feedback", "dev"] as const).map((id) =>
            <button key={id} ref={id === "general" ? firstNav : undefined}
              className={section === id ? "active" : ""} onClick={() => setSection(id)}>
              {tr(`settings.section.${id}`)}
            </button>)}
        </nav>
        <div className="settings-content">
        {section === "general" && <fieldset className="settings-preferences">
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
          <label><span>{tr("settings.defaultEngine")}</span><input value={preferences.defaultEngine}
            onChange={(event) => useSettings.getState().setPreference("defaultEngine", event.target.value)} /></label>
          <label><span>{tr("settings.defaultModel")}</span><input value={preferences.defaultModel}
            onChange={(event) => useSettings.getState().setPreference("defaultModel", event.target.value)} /></label>
          <label><input type="checkbox" checked={preferences.notifications}
            onChange={(event) => useSettings.getState().setPreference("notifications", event.target.checked)} />{tr("settings.notifications")}</label>
          <label><input type="checkbox" checked={preferences.turnSound}
            onChange={(event) => useSettings.getState().setPreference("turnSound", event.target.checked)} />{tr("settings.turnSound")}</label>
          <button className="btn-secondary" onClick={playTurnCompleteSound}>{tr("settings.testSound")}</button>
        </fieldset>
        }
        {section === "project" && selectedProjectId && <ProjectSettings projectId={selectedProjectId} />}
        {section === "project" && !selectedProjectId && <p className="hint">{tr("projectSettings.noProject")}</p>}
        {section === "accounts" && <fieldset className="settings-preferences"><legend>{tr("settings.section.accounts")}</legend>
          {engines.map((engine) => <div key={engine.id} className="settings-engine-row"><strong>{engine.displayName}</strong>
            <span className="dim">{engine.availability?.accountHint ?? engine.availability?.error ?? tr("settings.notDetected")}</span></div>)}
        </fieldset>}
        {section === "engines" && <fieldset className="settings-preferences">
          <legend>{tr("settings.section.engines")}</legend>
          {engines.map((engine) => (
            <div key={engine.id} className="settings-engine-row">
              <strong>{engine.displayName}</strong>
              <span className="dim">{engine.id} · {engine.enabled ? tr("settings.enabled") : tr("settings.disabled")} · {
                engine.availability?.accountHint ?? engine.availability?.error ?? tr("settings.notDetected")
              }</span>
              {engine.custom && <>
                <button className="btn-secondary" onClick={() => setEngineDraft(JSON.stringify(engine.definition, null, 2))}>{tr("settings.edit")}</button>
                <button className="btn-secondary" onClick={() => {
                  if (!engine.definition) return
                  runSettingAction("settings.engine.toggle",
                    () => useData.getState().saveCustomEngine({ ...engine.definition!, enabled: !engine.enabled }))
                }}>{engine.enabled ? tr("settings.disable") : tr("settings.enable")}</button>
                <button className="btn-secondary" onClick={() => runSettingAction("settings.engine.detect",
                  () => useData.getState().detectCustomEngine(engine.id)
                    .then((result) => { setEngineMessage(result.accountHint ?? result.error ?? tr("settings.notDetected")) }))}>
                  {tr("settings.detect")}</button>
                <button className="btn-secondary" onClick={() => runSettingAction("settings.engine.delete",
                  () => useData.getState().deleteCustomEngine(engine.id))}>{tr("settings.delete")}</button>
              </>}
              {selectedWs && engine.enabled &&
                <button className="btn-secondary" onClick={() => runSettingAction("settings.engine.switch",
                  () => useData.getState().switchEngine(selectedWs, engine.id))}>
                  {tr("settings.switchCurrent")}
                </button>}
            </div>
          ))}
          <p className="hint" data-testid="settings-copilot-builtin">{tr("settings.copilotBuiltin")}</p>
          <div className="settings-actions">
            <button
              className="btn-secondary"
              data-testid="settings-refresh-engines"
              onClick={() => runSettingAction("settings.engine.refresh",
                () => useData.getState().refreshConfig().then(() => {
                  const copilot = useData.getState().config?.engines.find((e) => e.id === "copilot")
                  setEngineMessage(
                    copilot?.availability?.accountHint
                      ?? copilot?.availability?.error
                      ?? tr("settings.notDetected"),
                  )
                }))}
            >{tr("settings.refreshEngines")}</button>
            <button className="btn-secondary" onClick={() => setEngineDraft(JSON.stringify({
              id: "my-engine", displayName: "My Engine", enabled: true,
              command: ["my-engine", "--session", "{sessionId}"],
              capabilities: { nativeQueue: false, midSessionModelSwitch: false, resume: false, hooks: false, effort: false },
              transcriptStrategy: "none", historyStrategy: "none", turnDetection: "none",
            }, null, 2))}>{tr("settings.newEngine")}</button>
          </div>
          {engineDraft && <>
            <textarea aria-label="Custom engine JSON" spellCheck={false} value={engineDraft}
              onChange={(event) => setEngineDraft(event.target.value)} />
            <button className="btn" onClick={() => {
              try {
                void useData.getState().saveCustomEngine(JSON.parse(engineDraft))
                  .then(() => { setEngineDraft(""); setEngineMessage("saved") })
                  .catch((error: unknown) => showToast("settings.engine.save", error))
              } catch (error) { showToast("settings.engine.save", error) }
            }}>{tr("settings.saveEngine")}</button>
          </>}
          {engineMessage && <div className="dim">{engineMessage}</div>}
        </fieldset>
        }
        {section === "keybindings" && <>
        <p className="dim">{tr("settings.keybindingsHint")}</p>
        <textarea
          aria-label={tr("settings.keybindingsJson")}
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (consumeModalKey(event, "Escape", close)) return
            if (event.key === "Enter" && event.metaKey) {
              consumeModalKey(event, "Enter", apply)
            }
          }}
        />
        {error && <div className="settings-error" role="alert">{error}</div>}
        <div className="settings-actions">
          <button className="btn-secondary" onClick={() => {
            useSettings.getState().resetKeybindings()
            setDraft("{}")
          }}>{tr("settings.reset")}</button>
          <button className="btn-secondary" onClick={() => {
            void promptDialog(tr("settings.yamlTitle"), tr("settings.yamlMessage"),
              exportKeybindingsYaml(keybindings), true).then((yaml) => {
              if (!yaml) return
              const result = parseKeybindingsYaml(HOTKEYS_REGISTRY, yaml)
              if (result.ok) useSettings.getState().setKeybindingOverrides(result.overrides)
              else showToast("settings.keybindings.yaml", result.error)
            })
          }}>{tr("settings.yaml")}</button>
          <button className="btn" onClick={apply}>{tr("settings.apply")}</button>
        </div>
        </>}
        {section === "feedback" && <fieldset className="settings-preferences"><legend>{tr("settings.section.feedback")}</legend>
          <p className="dim">{tr("settings.feedbackHint")}</p>
          <button className="btn-secondary" onClick={() => window.open("https://github.com", "_blank", "noopener")}>{tr("settings.issueTracker")}</button>
        </fieldset>}
        {section === "dev" && <fieldset className="settings-preferences"><legend>{tr("settings.devDiagnostics")}</legend>
          <pre className="settings-diagnostics">{JSON.stringify({ status: useData.getState().status, engines: engines.length }, null, 2)}</pre>
        </fieldset>}
        </div></div>
      </div>
    </div>
  )
}
