import { makeDrafts } from "../composer/drafts"
import { useUi } from "../stores/ui"
import type { LineSelection } from "./DiffView"

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
export const formatLineComment = (selection: LineSelection, comment: string): string => {
  const lineNumber = (index: number): number | null => {
    const line = selection.lines[index]
    return line ? line.newNo ?? line.oldNo : null
  }
  const first = lineNumber(0)
  const last = lineNumber(selection.lines.length - 1)
  const range = first === null
    ? ""
    : last === null || first === last
      ? ` 第 ${first} 行`
      : ` 第 ${first}–${last} 行`
  const block = selection.lines.map((line) => `${diffSign(line.kind)}${line.text}`).join("\n")
  const fence = fenceFor(block)
  return `关于 \`${selection.path}\`（${selection.section}）${range}：\n${fence}diff\n${block}\n${fence}\n${comment}`
}

export const injectComment = (wsId: string, selection: LineSelection): void => {
  const comment = typeof prompt === "function"
    ? prompt("对选中行的评论（追加到 composer，可再编辑后发送）：") ?? ""
    : ""
  const snippet = formatLineComment(selection, comment)
  const current = drafts.load(wsId)
  drafts.save(wsId, current === "" ? snippet : `${current}\n\n${snippet}`)
  useUi.getState().focusComposer()
}
