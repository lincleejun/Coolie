import { isDesktop } from "../platform"

const PROJECT_PARAM = "newWorkspace"

export const workspaceWindowUrl = (projectId: string): string =>
  `/?${PROJECT_PARAM}=${encodeURIComponent(projectId)}`

export const projectIdFromWindowSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get(PROJECT_PARAM)?.trim()
  return value ? value : null
}

/** Open a dedicated workspace creation window for a project. */
export const openWorkspaceWindow = async (
  projectId: string,
  scope: object = globalThis,
): Promise<void> => {
  const url = workspaceWindowUrl(projectId)
  if (!isDesktop(scope)) {
    const opened = window.open(url, "_blank")
    if (opened === null) throw new Error("浏览器阻止了新窗口")
    return
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
  const label = `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const webview = new WebviewWindow(label, {
    url,
    title: "Coolie",
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    decorations: false,
    transparent: true,
    focus: true,
  })
  await new Promise<void>((resolve, reject) => {
    void webview.once("tauri://created", () => resolve())
    void webview.once("tauri://error", (event) => {
      reject(new Error(`新窗口创建失败：${String(event.payload)}`))
    })
  })
}
