import { tmuxSessionName } from "@coolie/protocol"

export type TerminalId = "iterm2" | "terminal" | "custom"

export interface TerminalLaunch {
  readonly program: string
  readonly args: string[]
}

const SHELL_SAFE = /^[A-Za-z0-9._-]+$/

export const buildAttachCommand = (tmuxSocket: string, wsId: string): string => {
  if (!SHELL_SAFE.test(tmuxSocket) || !SHELL_SAFE.test(wsId))
    throw new Error("非法 socket/wsId：仅允许字母、数字、点、下划线和连字符")
  return `tmux -L ${tmuxSocket} attach -t ${tmuxSessionName(wsId)}`
}

/**
 * Custom templates are JSON argv arrays, not shell strings. Element zero is
 * passed to Command::new as the program; the remainder are passed as argv.
 * No tokenization, interpolation by a shell, or quote interpretation occurs.
 */
export const parseCustomArgvTemplate = (template: string): string[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(template)
  } catch {
    throw new Error('自定义终端模板必须是 JSON argv 数组，例如 ["/usr/bin/open","-na","WezTerm","sh","-lc","{cmd}"]')
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("自定义终端模板必须是非空 JSON argv 数组")
  if (!parsed.every((item) => typeof item === "string"))
    throw new Error("自定义终端模板的每一项必须是字符串")
  const argv = parsed as string[]
  if (argv[0] === "" || argv[0]!.includes("\0") || argv[0]!.includes("{cmd}"))
    throw new Error("自定义终端模板的 program 必须是固定的非空字符串")
  if (argv.some((item) => item.includes("\0")))
    throw new Error("自定义终端模板不能包含 NUL")
  if (!argv.slice(1).some((item) => item.includes("{cmd}")))
    throw new Error("自定义终端模板 argv 必须含 {cmd} 占位")
  return argv
}

const itermScript = (cmd: string): string => [
  'tell application "iTerm2"',
  "  activate",
  "  set w to (create window with default profile)",
  `  tell current session of w to write text "${cmd}"`,
  "end tell",
].join("\n")

const terminalScript = (cmd: string): string => [
  'tell application "Terminal"',
  "  activate",
  `  do script "${cmd}"`,
  "end tell",
].join("\n")

export const buildTerminalLaunch = (
  id: TerminalId,
  tmuxSocket: string,
  wsId: string,
  customTemplate?: string,
): TerminalLaunch => {
  const cmd = buildAttachCommand(tmuxSocket, wsId)
  switch (id) {
    case "iterm2":
      return { program: "/usr/bin/osascript", args: ["-e", itermScript(cmd)] }
    case "terminal":
      return { program: "/usr/bin/osascript", args: ["-e", terminalScript(cmd)] }
    case "custom": {
      const [program, ...args] = parseCustomArgvTemplate(customTemplate ?? "")
      return { program: program!, args: args.map((arg) => arg.replaceAll("{cmd}", cmd)) }
    }
    default:
      throw new Error(`未知终端类型：${String(id)}`)
  }
}
