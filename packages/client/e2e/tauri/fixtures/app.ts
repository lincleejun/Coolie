/** Shared helpers for Tauri WebdriverIO suites (Task 2C.1). */
export const TEST_VIEWPORT = { width: 1440, height: 900 } as const

/** Disable CSS motion for deterministic desktop UI assertions. */
export const stabilizeUiScript = `
  (() => {
    const style = document.createElement("style")
    style.id = "coolie-wdio-stabilize"
    style.textContent = "* { animation: none !important; transition: none !important; caret-color: transparent !important; }"
    document.head.appendChild(style)
    document.documentElement.dataset.coolieWdio = "1"
    document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? "dark"
  })()
`

export const applyTestStabilization = async (): Promise<void> => {
  await browser.execute(stabilizeUiScript)
}

export const waitForAppRoot = async (): Promise<void> => {
  await browser.waitUntil(async () => {
    const root = await browser.$("#root")
    return root.isExisting()
  }, { timeout: 30000, timeoutMsg: "Coolie root mount did not appear" })
}
