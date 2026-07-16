export interface PlatformCapabilities {
  readonly desktop: boolean
  readonly daemonDiscovery: boolean
  readonly deepLinks: boolean
  readonly windowControls: boolean
  readonly externalTerminal: boolean
  readonly directoryPicker: boolean
  readonly openEditor: boolean
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
    openEditor: desktop,
  }
}

export type OpenInEditorErrorCode =
  | "desktop_only"
  | "invalid_workspace_path"
  | "invalid_relative_path"
  | "workspace_unavailable"
  | "path_unavailable"
  | "path_outside_workspace"
  | "invalid_editor_config"
  | "editor_launch_failed"
  | "invoke_failed"

export class OpenInEditorError extends Error {
  readonly code: OpenInEditorErrorCode

  constructor(code: OpenInEditorErrorCode, message: string) {
    super(message)
    this.name = "OpenInEditorError"
    this.code = code
  }
}

const editorErrorCodes = new Set<OpenInEditorErrorCode>([
  "desktop_only",
  "invalid_workspace_path",
  "invalid_relative_path",
  "workspace_unavailable",
  "path_unavailable",
  "path_outside_workspace",
  "invalid_editor_config",
  "editor_launch_failed",
  "invoke_failed",
])

const isAbsolutePath = (path: string): boolean =>
  path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")

export const validateEditorPath = (workspacePath: string, relativePath: string): void => {
  if (!isAbsolutePath(workspacePath) || workspacePath.includes("\0"))
    throw new OpenInEditorError("invalid_workspace_path", "editor workspace path must be absolute")
  if (
    relativePath === "" ||
    relativePath.includes("\0") ||
    isAbsolutePath(relativePath) ||
    relativePath.startsWith("\\") ||
    relativePath.split(/[\\/]/).includes("..")
  )
    throw new OpenInEditorError("invalid_relative_path", "editor path must be relative to the workspace")
}

const editorInvokeError = (error: unknown): OpenInEditorError => {
  if (error instanceof OpenInEditorError) return error
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; message?: unknown }
    if (
      typeof value.code === "string" &&
      editorErrorCodes.has(value.code as OpenInEditorErrorCode) &&
      typeof value.message === "string"
    )
      return new OpenInEditorError(value.code as OpenInEditorErrorCode, value.message)
  }
  return new OpenInEditorError(
    "invoke_failed",
    `open-in-editor failed: ${error instanceof Error ? error.message : String(error)}`,
  )
}

export const openInEditor = async (
  workspacePath: string,
  relativePath: string,
  scope: object = globalThis,
  invokeCommand: (command: string, args: Record<string, unknown>) => Promise<unknown> =
    async (command, args) => (await import("@tauri-apps/api/core")).invoke(command, args),
): Promise<void> => {
  if (!isDesktop(scope))
    throw new OpenInEditorError("desktop_only", "open-in-editor is only available in the desktop app")
  validateEditorPath(workspacePath, relativePath)
  try {
    await invokeCommand("open_in_editor", { workspacePath, relativePath })
  } catch (error) {
    throw editorInvokeError(error)
  }
}

/** Open a URL in the system browser (desktop) or a new tab (web). */
export const openExternalUrl = async (
  url: string,
  scope: object = globalThis,
): Promise<void> => {
  if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) URLs can be opened")
  if (isDesktop(scope)) {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("plugin:opener|open_url", { url })
      return
    } catch {
      // Fall through to window.open when opener plugin is unavailable.
    }
  }
  const opened = (scope as Window).open?.(url, "_blank", "noopener,noreferrer")
  if (!opened && typeof (scope as Window).location !== "undefined") {
    ;(scope as Window).location.href = url
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
