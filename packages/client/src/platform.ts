export interface PlatformCapabilities {
  readonly desktop: boolean
  readonly daemonDiscovery: boolean
  readonly deepLinks: boolean
  readonly windowControls: boolean
  readonly externalTerminal: boolean
  readonly directoryPicker: boolean
}

/** Runtime capability check shared by the desktop and browser builds. */
export const isDesktop = (scope: object = globalThis): boolean =>
  "__TAURI_INTERNALS__" in scope

export const platformCapabilities = (scope: object = globalThis): PlatformCapabilities => {
  const desktop = isDesktop(scope)
  return {
    desktop,
    daemonDiscovery: desktop,
    deepLinks: desktop,
    windowControls: desktop,
    externalTerminal: desktop,
    directoryPicker: desktop,
  }
}

export const capabilities = platformCapabilities()

type DialogModule = {
  open(options: { directory: true; multiple: false }): Promise<string | string[] | null>
}

export const pickDirectory = async (
  scope: object = globalThis,
  loadDialog: () => Promise<DialogModule> = () => import("@tauri-apps/plugin-dialog"),
): Promise<string | null> => {
  if (!isDesktop(scope)) throw new Error("directory picker is only available in the desktop app")
  try {
    const selected = await (await loadDialog()).open({ directory: true, multiple: false })
    if (selected === null) return null
    if (typeof selected !== "string" || selected === "")
      throw new Error("directory dialog did not return a single directory")
    return selected
  } catch (error) {
    if (error instanceof Error && error.message.includes("single directory")) throw error
    throw new Error(`directory dialog failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
