import type { Workspace } from "@coolie/protocol"
import { ApiError } from "../api/client"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { confirmDialog, promptDialog } from "../chrome/dialogs"
import { showToast } from "../chrome/Toasts"
import { t } from "../i18n"

export type TaskCommandId =
  | "open" | "archive" | "delete" | "rename" | "renameBranch" | "switchEngine" | "pin"

export interface TaskCommand {
  id: TaskCommandId
  label: string
  key: string
  run(): Promise<void>
}

const report = (error: unknown): void => showToast("task.command", error)

export const archiveForceConfirmation = (ws: Workspace): string =>
  ws.ownership === "adopted"
    ? t("task.archiveAdopted").replace("{name}", ws.name)
    : t("task.archiveDirty").replace("{name}", ws.name)

export const deleteConfirmation = (ws: Workspace): string =>
  ws.ownership === "adopted"
    ? t("task.deleteAdopted").replace("{name}", ws.name)
    : t("task.deleteMessage").replace("{name}", ws.name).replace("{branch}", ws.branch)

const ask = async (label: string, initial: string): Promise<string | null> => {
  const value = await promptDialog(label, label, initial)
  return value === null || value.trim() === "" ? null : value.trim()
}

export const runTaskCommand = async (id: TaskCommandId, ws: Workspace): Promise<void> => {
  const data = useData.getState()
  try {
    if (id === "open") return useUi.getState().selectWs(ws.id)
    if (id === "pin") return await data.setPinnedWs(ws.id, !ws.pinned)
    if (id === "rename") {
      const name = await ask(t("task.namePrompt"), ws.name)
      if (name) await data.renameWs(ws.id, name)
      return
    }
    if (id === "renameBranch") {
      const branch = await ask(t("task.branchPrompt"), ws.branch)
      if (branch) await data.renameBranchWs(ws.id, branch)
      return
    }
    if (id === "switchEngine") {
      const enabled = data.config?.engines.filter((engine) => engine.enabled) ?? []
      const label = `${t("task.enginePrompt")} (${enabled.map((engine) => engine.id).join(", ")})`
      const engineId = await ask(label, enabled[0]?.id ?? "")
      if (engineId) await data.switchEngine(ws.id, engineId)
      return
    }
    if (id === "delete") {
      if (await confirmDialog(t("task.deleteTitle"), deleteConfirmation(ws), true))
        await data.deleteWs(ws.id, true)
      return
    }
    if (id === "archive") {
      if (ws.ownership === "adopted" &&
        !await confirmDialog(t("task.archiveTitle"), archiveForceConfirmation(ws), true)) return
      try {
        await data.archiveWs(ws.id, false)
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) throw error
        if (await confirmDialog(t("task.archiveTitle"), archiveForceConfirmation(ws), true))
          await data.archiveWs(ws.id, true)
      }
    }
  } catch (error) {
    report(error)
  }
}

export const buildTaskCommands = (ws: Workspace): TaskCommand[] => [
  { id: "open", label: t("task.open"), key: "Enter", run: () => runTaskCommand("open", ws) },
  { id: "archive", label: t("task.archive"), key: "A", run: () => runTaskCommand("archive", ws) },
  { id: "delete", label: t("task.delete"), key: "D", run: () => runTaskCommand("delete", ws) },
  { id: "rename", label: t("task.rename"), key: "R", run: () => runTaskCommand("rename", ws) },
  { id: "renameBranch", label: t("task.renameBranch"), key: "B", run: () => runTaskCommand("renameBranch", ws) },
  { id: "switchEngine", label: t("task.switchEngine"), key: "V", run: () => runTaskCommand("switchEngine", ws) },
  { id: "pin", label: ws.pinned ? t("task.unpin") : t("task.pin"), key: "P", run: () => runTaskCommand("pin", ws) },
]
