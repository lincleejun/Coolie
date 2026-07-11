/** Terminal Identity Boundary（kobe）：进 tmux/PTY 的环境统一 TERM，剥外层终端身份泄漏。 */
export const sanitizedTmuxEnv = (base: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (k === "TERM_PROGRAM" || k === "TERM_PROGRAM_VERSION" || k === "TERM_SESSION_ID") continue
    env[k] = v
  }
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  return env
}

/** POSIX 单引号 quoting：argv → 一条可交给 `sh -c` 的命令串（new-session/new-window 的 command 参数）。 */
export const shellQuote = (argv: readonly string[]): string =>
  argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")
