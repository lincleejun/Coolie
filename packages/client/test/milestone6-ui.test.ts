import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"
import * as ts from "typescript"
import { KeybindingSettings } from "../src/settings/KeybindingSettings.js"
import { t } from "../src/i18n/index.js"
import { useSettings } from "../src/settings/settings.js"
import { useUi } from "../src/stores/ui.js"
import { OpenInEditorError, openInEditor, platformCapabilities } from "../src/platform.js"
import { canFinishWorkspace, reorderWorkspaceIds } from "../src/sidebar/Sidebar.js"
import { buildTaskCommands, runTaskCommand } from "../src/sidebar/taskCommands.js"
import type { Workspace } from "@coolie/protocol"
import {
  confirmDialog,
  pendingDialogCount,
  resolveActiveDialog,
  trapTabKey,
} from "../src/chrome/dialogs.js"
import { useData } from "../src/stores/data.js"
import { RightPanel } from "../src/rightpanel/RightPanel.js"

afterEach(() => {
  while (pendingDialogCount() > 0) resolveActiveDialog(false)
  useUi.getState().setSettings(false)
  useSettings.getState().setLang("zh")
  vi.restoreAllMocks()
})

describe("milestone 6 UI contracts", () => {
  it("renders all six accessible settings sections in both languages", () => {
    useUi.getState().setSettings(true)
    const html = renderToStaticMarkup(createElement(KeybindingSettings, { forceOpen: true }))
    for (const section of ["general", "engines", "accounts", "keybindings", "feedback", "dev"] as const) {
      expect(html).toContain(t(`settings.section.${section}`, "zh"))
      expect(t(`settings.section.${section}`, "en")).not.toMatch(/\p{Script=Han}/u)
    }
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="' + t("settings.dialog", "zh") + '"')
  })

  it("has complete non-leaking zh/en chrome translations", () => {
    const keys = [
      "sidebar.openProject", "sidebar.search", "task.archive", "task.delete",
      "settings.section.general", "settings.section.dev", "cheatsheet.title",
      "cheatsheet.terminal", "dialog.confirm", "editor.open",
    ] as const
    for (const key of keys) {
      expect(t(key, "zh")).not.toBe(key)
      expect(t(key, "en")).not.toBe(key)
      expect(t(key, "en")).not.toMatch(/\p{Script=Han}/u)
    }
  })

  it("keeps visible App, Sidebar, and settings source text localized", () => {
    for (const relative of [
      "../src/App.tsx",
      "../src/sidebar/Sidebar.tsx",
      "../src/settings/KeybindingSettings.tsx",
    ]) {
      const path = new URL(relative, import.meta.url)
      const source = ts.createSourceFile(relative, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const hardcoded: string[] = []
      const visit = (node: ts.Node): void => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) &&
            /\p{Script=Han}/u.test(node.text))
          hardcoded.push(node.text.trim())
        ts.forEachChild(node, visit)
      }
      visit(source)
      expect(hardcoded, relative).toEqual([])
    }
  })

  it("guards web editor opening and passes desktop paths as structured args", async () => {
    expect(platformCapabilities({}).openEditor).toBe(false)
    await expect(openInEditor("/repo", "src/app.ts", {}, vi.fn())).rejects.toMatchObject({
      name: "OpenInEditorError", code: "desktop_only",
    })
    const invoke = vi.fn(async () => undefined)
    await openInEditor("/repo with spaces", "src/a file;echo.ts", { __TAURI_INTERNALS__: {} }, invoke)
    expect(invoke).toHaveBeenCalledWith("open_in_editor", {
      workspacePath: "/repo with spaces", relativePath: "src/a file;echo.ts",
    })
    for (const path of ["../secret", "src/../../secret", String.raw`src\..\secret`, "/etc/passwd", String.raw`C:\secret`])
      await expect(openInEditor("/repo", path, { __TAURI_INTERNALS__: {} }, invoke))
        .rejects.toMatchObject({ code: "invalid_relative_path" })
    await expect(openInEditor("repo", "src/app.ts", { __TAURI_INTERNALS__: {} }, invoke))
      .rejects.toMatchObject({ code: "invalid_workspace_path" })
    await expect(openInEditor("/repo", "src/app.ts", { __TAURI_INTERNALS__: {} }, async () => {
      throw { code: "path_outside_workspace", message: "editor path escapes workspace" }
    })).rejects.toEqual(new OpenInEditorError("path_outside_workspace", "editor path escapes workspace"))
  })

  it("renders deterministic accessible Files and Changes panel actions", () => {
    const files = renderToStaticMarkup(createElement(RightPanel, { wsId: "w1", forcePanel: "files" }))
    expect(files).toContain('role="tablist"')
    expect(files).toContain('role="tabpanel"')
    expect(files).toContain('aria-selected="true"')
    expect(files).toContain(t("right.files", "zh"))

    const collapsed = renderToStaticMarkup(createElement(RightPanel, { wsId: "w1", forcePanel: "collapsed" }))
    expect(collapsed).toContain('aria-label="' + t("right.changes", "zh") + '"')
    expect(collapsed).toContain('aria-label="' + t("right.files", "zh") + '"')
    expect(collapsed).toContain('aria-expanded="false"')
  })

  it("exposes the complete focused sidebar key layer and stable reorder", () => {
    const workspace = { id: "w1", name: "One", branch: "coolie/one", pinned: false } as Workspace
    expect(buildTaskCommands(workspace).map(({ id, key }) => `${key}:${id}`)).toEqual([
      "Enter:open", "A:archive", "D:delete", "R:rename", "B:renameBranch", "V:switchEngine", "P:pin",
    ])
    expect(reorderWorkspaceIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"])
    expect(reorderWorkspaceIds(["a", "b"], "missing", "a")).toEqual(["a", "b"])
    expect(canFinishWorkspace({ kind: "main", status: "active" })).toBe(false)
    expect(canFinishWorkspace({ kind: "task", status: "active" })).toBe(true)
    expect(canFinishWorkspace({ kind: "task", status: "archived" })).toBe(false)
  })

  it("cycles modal focus instead of escaping the dialog", () => {
    const first = { hidden: false, focus: vi.fn() }
    const last = { hidden: false, focus: vi.fn() }
    vi.stubGlobal("document", { activeElement: last })
    const root = { querySelectorAll: () => [first, last] } as unknown as HTMLElement
    const preventDefault = vi.fn()
    expect(trapTabKey({ key: "Tab", shiftKey: false, preventDefault }, root)).toBe(true)
    expect(preventDefault).toHaveBeenCalled()
    expect(first.focus).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("queues dialog decisions instead of replacing an open modal", async () => {
    const first = confirmDialog("First", "First decision")
    const second = confirmDialog("Second", "Second decision")
    expect(pendingDialogCount()).toBe(2)

    resolveActiveDialog(true)
    await expect(first).resolves.toBe(true)
    expect(pendingDialogCount()).toBe(1)

    resolveActiveDialog(false)
    await expect(second).resolves.toBe(false)
    expect(pendingDialogCount()).toBe(0)
  })

  it("does not archive an adopted worktree until its safety decision is accepted", async () => {
    const archiveWs = vi.fn(async () => undefined)
    useData.setState({ archiveWs })
    const adopted = {
      id: "adopted", name: "External", branch: "feature/external",
      ownership: "adopted", pinned: false,
    } as Workspace

    const cancelled = runTaskCommand("archive", adopted)
    expect(pendingDialogCount()).toBe(1)
    resolveActiveDialog(false)
    await cancelled
    expect(archiveWs).not.toHaveBeenCalled()

    const accepted = runTaskCommand("archive", adopted)
    resolveActiveDialog(true)
    await accepted
    expect(archiveWs).toHaveBeenCalledWith("adopted", false)
  })
})
