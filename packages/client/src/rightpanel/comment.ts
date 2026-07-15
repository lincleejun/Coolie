import { makeDrafts } from "../composer/drafts"
import { useUi } from "../stores/ui"
import type { LineSelection } from "./DiffView"
import { promptDialog } from "../chrome/dialogs"
import { t, type MsgKey } from "../i18n"

const drafts = makeDrafts(
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
)

const diffSign = (kind: string): string => kind === "add" ? "+" : kind === "del" ? "-" : " "

const fenceFor = (content: string): string => {
  const longest = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  return "`".repeat(Math.max(3, longest + 1))
}

/** Format only; final delivery still flows through composer and the server's PTY sanitizer. */
export const formatLineComment = (
  selection: LineSelection,
  comment: string,
  translate: (key: MsgKey) => string = t,
): string => {
  const lineNumber = (index: number): number | null => {
    const line = selection.lines[index]
    return line ? line.newNo ?? line.oldNo : null
  }
  const first = lineNumber(0)
  const last = lineNumber(selection.lines.length - 1)
  const range = first === null
    ? ""
    : last === null || first === last
      ? translate("diff.line").replace("{line}", String(first))
      : translate("diff.lineRange").replace("{first}", String(first)).replace("{last}", String(last))
  const block = selection.lines.map((line) => `${diffSign(line.kind)}${line.text}`).join("\n")
  const fence = fenceFor(block)
  const section = translate(`diff.section.${selection.section}` as MsgKey)
  const intro = translate("diff.commentIntro")
    .replace("{path}", selection.path)
    .replace("{section}", section)
    .replace("{range}", range)
  return `${intro}\n${fence}diff\n${block}\n${fence}\n${comment}`
}

export const injectComment = async (wsId: string, selection: LineSelection): Promise<void> => {
  const comment = await promptDialog(t("dialog.diffComment"), t("dialog.diffCommentMessage"))
  if (comment === null) return
  const snippet = formatLineComment(selection, comment)
  const current = drafts.load(wsId)
  drafts.save(wsId, current === "" ? snippet : `${current}\n\n${snippet}`)
  useUi.getState().focusComposer()
}
