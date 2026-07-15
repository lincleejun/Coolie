import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  canAppBadge,
  canOsNotify,
  notifyTurnComplete,
  requestNotifyPermission,
  setBadge,
} from "../src/chrome/notify.js"
import { useUi } from "../src/stores/ui.js"
import { useSettings } from "../src/settings/settings.js"

describe("notify utility capability degradation", () => {
  beforeEach(() => {
    useSettings.setState({ lang: "en" })
    vi.stubGlobal("document", { title: "Coolie" })
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("window", { focus: vi.fn() })
    vi.stubGlobal("Notification", undefined)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("keeps the title badge working without OS capabilities", () => {
    setBadge(3)
    expect(document.title).toBe("(3) Coolie")

    setBadge(0)
    expect(document.title).toBe("Coolie")
    expect(canOsNotify()).toBe(false)
    expect(canAppBadge()).toBe(false)
  })

  it("adds app badge enhancement when supported", () => {
    const setAppBadge = vi.fn()
    const clearAppBadge = vi.fn()
    vi.stubGlobal("navigator", { setAppBadge, clearAppBadge })

    setBadge(2)
    expect(document.title).toBe("(2) Coolie")
    expect(setAppBadge).toHaveBeenCalledWith(2)

    setBadge(0)
    expect(clearAppBadge).toHaveBeenCalledOnce()
  })

  it("does not touch unavailable DOM globals in node", () => {
    vi.stubGlobal("document", undefined)
    vi.stubGlobal("navigator", undefined)
    vi.stubGlobal("window", undefined)

    expect(() => setBadge(1)).not.toThrow()
    expect(() => notifyTurnComplete("USA", "w1")).not.toThrow()
    expect(() => requestNotifyPermission()).not.toThrow()
  })

  it("requests permission only from a detected default API", () => {
    const requestPermission = vi.fn().mockResolvedValue("denied")
    vi.stubGlobal("Notification", Object.assign(vi.fn(), {
      permission: "default",
      requestPermission,
    }))

    requestNotifyPermission()
    requestNotifyPermission()

    expect(canOsNotify()).toBe(true)
    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it("notifies only when granted and focuses the selected workspace on click", () => {
    const notification = { onclick: null as null | (() => void) }
    const NotificationApi = vi.fn(() => notification)
    vi.stubGlobal("Notification", Object.assign(NotificationApi, {
      permission: "granted",
      requestPermission: vi.fn(),
    }))
    useUi.getState().selectWs(null)

    notifyTurnComplete("USA", "w1")

    expect(NotificationApi).toHaveBeenCalledWith("USA needs you", {
      body: "The engine finished a turn and is waiting for your input",
      tag: "coolie-w1",
    })
    notification.onclick?.()
    expect(window.focus).toHaveBeenCalled()
    expect(useUi.getState().selectedWs).toBe("w1")
  })

  it("silently skips notifications without granted permission", () => {
    const NotificationApi = vi.fn()
    vi.stubGlobal("Notification", Object.assign(NotificationApi, {
      permission: "default",
      requestPermission: vi.fn(),
    }))

    expect(() => notifyTurnComplete("USA", "w1")).not.toThrow()
    expect(NotificationApi).not.toHaveBeenCalled()
  })
})
