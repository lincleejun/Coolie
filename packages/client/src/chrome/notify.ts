import { useUi } from "../stores/ui"
import { useSettings } from "../settings/settings"
import { t } from "../i18n"

/** OS integrations are optional: WKWebView may expose neither API. */
export const canOsNotify = (): boolean => {
  try {
    return typeof Notification !== "undefined"
      && typeof Notification.requestPermission === "function"
  } catch {
    return false
  }
}

export const canAppBadge = (): boolean => {
  try {
    return typeof navigator !== "undefined"
      && typeof navigator.setAppBadge === "function"
  } catch {
    return false
  }
}

let permissionRequested = false

export const requestNotifyPermission = (): void => {
  try {
    if (!canOsNotify() || Notification.permission !== "default" || permissionRequested) return
    permissionRequested = true
    void Notification.requestPermission().catch(() => {})
  } catch {
    // Permission flow failures do not affect in-app attention.
  }
}

export const notifyTurnComplete = (wsName: string, wsId: string): void => {
  try {
    const prefs = useSettings.getState().preferences
    if (prefs.turnSound) playTurnCompleteSound()
    if (!prefs.notifications) return
    if (!canOsNotify() || Notification.permission !== "granted") return
    const notification = new Notification(t("notification.needsYou").replace("{workspace}", wsName), {
      body: t("notification.turnComplete"),
      tag: `coolie-${wsId}`,
    })
    notification.onclick = () => {
      try {
        if (typeof window !== "undefined") window.focus()
      } catch {
        // Focusing is best effort.
      }
      useUi.getState().selectWs(wsId)
    }
  } catch {
    // OS notifications are progressive enhancement only.
  }
}

export const playTurnCompleteSound = (): void => {
  try {
    const AudioContextCtor = window.AudioContext
    if (!AudioContextCtor) return
    const context = new AudioContextCtor()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = 660
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.17)
    oscillator.onended = () => void context.close()
  } catch {
    // Sound is optional and must never interrupt attention handling.
  }
}

export const setBadge = (count: number): void => {
  try {
    if (typeof document !== "undefined")
      document.title = count > 0 ? `(${count}) Coolie` : "Coolie"
  } catch {
    // Node and unusual webviews may not expose a writable document title.
  }

  if (!canAppBadge()) return
  try {
    if (count > 0) void navigator.setAppBadge(count)
    else if (typeof navigator.clearAppBadge === "function") void navigator.clearAppBadge()
  } catch {
    // App badge failures do not affect the title badge.
  }
}
