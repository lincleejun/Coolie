import { tmuxSessionName } from "@coolie/protocol"

export type TerminalId = "iterm2" | "terminal" | "wezterm"

const SHELL_SAFE = /^[A-Za-z0-9._-]+$/

export const buildAttachCommand = (tmuxSocket: string, wsId: string): string => {
  if (!SHELL_SAFE.test(tmuxSocket) || !SHELL_SAFE.test(wsId))
    throw new Error("非法 socket/wsId：仅允许字母、数字、点、下划线和连字符")
  return `tmux -L ${tmuxSocket} attach -t ${tmuxSessionName(wsId)}`
}
