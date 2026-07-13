import { useUi } from "../stores/ui"

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
    if (!canOsNotify() || Notification.permission !== "granted") return
    const notification = new Notification(`${wsName} 需要你`, {
      body: "engine 完成一轮，等待你的输入",
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
