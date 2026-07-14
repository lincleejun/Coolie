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
  // tmux 客户端按 locale 决定是否启用 UTF-8。Cursor/IDE 启动的进程常见
  // LANG="" + LC_CTYPE=C；该环境下 `tmux attach` 会直接省略 CJK/宽字符，
  // GUI 只剩英文与横线碎片，而 iTerm2（UTF-8 locale）显示正常。
  // 在唯一的终端环境边界统一钉住 UTF-8，LC_ALL 必须一起覆盖，否则它会压过
  // LANG/LC_CTYPE。macOS 普遍提供 en_US.UTF-8，Linux 普遍提供 C.UTF-8。
  const utf8Locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"
  env.LANG = utf8Locale
  env.LC_CTYPE = utf8Locale
  env.LC_ALL = utf8Locale
  return env
}

/** POSIX 单引号 quoting：argv → 一条可交给 `sh -c` 的命令串（new-session/new-window 的 command 参数）。 */
export const shellQuote = (argv: readonly string[]): string =>
  argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")
