/** Shared stabilization helpers for desktop structure diagnostics (Task 2C.6). */
import { applyTestStabilization, TEST_VIEWPORT } from "../fixtures/app.js"

export const STABLE_THEME = "dark" as const

export const stabilizeForStructure = async (): Promise<void> => {
  await applyTestStabilization()
  await browser.execute((theme) => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.coolieStructure = "1"
  }, STABLE_THEME)
}

export const assertWithinViewport = async (
  selector: string,
  label: string,
): Promise<void> => {
  const element = await browser.$(selector)
  await element.waitForExist({ timeout: 15000 })
  const rect = await element.getLocation()
  const size = await element.getSize()
  expect(rect.x, `${label} x`).toBeGreaterThanOrEqual(0)
  expect(rect.y, `${label} y`).toBeGreaterThanOrEqual(0)
  expect(rect.x + size.width, `${label} width`).toBeLessThanOrEqual(TEST_VIEWPORT.width)
  expect(rect.y + size.height, `${label} height`).toBeLessThanOrEqual(TEST_VIEWPORT.height)
}

export const assertFocusable = async (selector: string, label: string): Promise<void> => {
  const element = await browser.$(selector)
  await element.waitForExist({ timeout: 15000 })
  const tabIndex = await element.getAttribute("tabindex")
  const role = await element.getAttribute("role")
  const tag = await element.getTagName()
  const focusable = tabIndex !== "-1" || role !== null || tag === "button" || tag === "input" || tag === "textarea"
  expect(focusable, `${label} focus contract`).toBe(true)
}

export const captureFailureScreenshot = async (name: string): Promise<void> => {
  try {
    await browser.saveScreenshot(`./e2e/tauri/artifacts/screenshots/${name}-${Date.now()}.png`)
  } catch {
    // diagnostic only
  }
}
