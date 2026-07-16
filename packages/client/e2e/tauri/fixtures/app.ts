/** Shared helpers for Tauri WebdriverIO suites (Task 2C.1). */
export const TEST_VIEWPORT = { width: 1440, height: 900 } as const

/** Disable CSS motion; pin English UI copy; reveal hover-only controls for WDIO. */
export const stabilizeUiScript = `
  (() => {
    try { localStorage.setItem("coolie.lang", "en") } catch {}
    const style = document.createElement("style")
    style.id = "coolie-wdio-stabilize"
    style.textContent = [
      "* { animation: none !important; transition: none !important; caret-color: transparent !important; }",
      /* Hover-only affordances are opacity:0 until :hover — WebDriver treats them as not clickable. */
      ".ws-more, .proj-add, .proj-adopt { opacity: 1 !important; }",
    ].join("\\n")
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

/**
 * App may have bootstrapped before mock seed. Pin English, reload so stores refetch seed,
 * then re-apply stabilization (lang already en — no second refresh loop).
 */
export const reloadAppAfterSeed = async (): Promise<void> => {
  await waitForAppRoot()
  await browser.execute(() => {
    try {
      localStorage.setItem("coolie.lang", "en")
      // Avoid sticky collapsed project rows hiding workspace actions across specs.
      for (const key of Object.keys(localStorage)) {
        if (key.includes("collapse") || key.includes("Collapsed")) localStorage.removeItem(key)
      }
    } catch { /* ignore */ }
  })
  await browser.refresh()
  await waitForAppRoot()
  await applyTestStabilization()
}

export const clickByAriaLabel = async (labels: string[], timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const label of labels) {
      const candidates = [
        await browser.$(`[aria-label="${label}"]`),
        await browser.$(`button*=${label}`),
      ]
      for (const el of candidates) {
        if (!(await el.isExisting())) continue
        try {
          await el.scrollIntoView()
          await el.click()
          return el
        } catch {
          await browser.execute((aria: string) => {
            const node = document.querySelector<HTMLElement>(`[aria-label="${aria}"]`)
              ?? [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(aria))
              ?? null
            node?.click()
          }, label)
          return el
        }
      }
    }
    await browser.pause(200)
  }
  throw new Error(`none of aria-labels clickable: ${labels.join(" | ")}`)
}

/** Click a control by visible text (use instead of invalid `[css]*=text` combinators). */
export const clickByText = async (texts: string[], timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const text of texts) {
      const el = await browser.$(`button*=${text}`)
      if (!(await el.isExisting())) continue
      try {
        await el.scrollIntoView()
        await el.click()
        return el
      } catch {
        await browser.execute((needle: string) => {
          const node = [...document.querySelectorAll("button")].find((b) =>
            (b.textContent || "").includes(needle),
          ) ?? null
          node?.click()
        }, text)
        return el
      }
    }
    await browser.pause(200)
  }
  throw new Error(`none of texts clickable: ${texts.join(" | ")}`)
}
