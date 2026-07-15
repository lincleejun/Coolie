export type CompletionShell = "bash" | "zsh" | "fish"

export const TOP_LEVEL_COMMANDS = [
  "get", "collect", "send", "dispatch", "create", "list", "rename", "set-status", "set-branch",
  "ensure-worktree", "adopt", "finish", "archive", "unarchive", "delete", "enter", "open", "resume",
  "project", "engine", "tab", "checkpoint", "server", "api", "events", "export", "doctor",
  "completion", "update", "skill",
] as const

export const generateCompletion = (shell: CompletionShell): string => {
  const commands = TOP_LEVEL_COMMANDS.join(" ")
  if (shell === "bash") return `# coolie bash completion
_coolie_complete() {
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W '${commands}' -- "\${COMP_WORDS[COMP_CWORD]}") )
  fi
}
complete -F _coolie_complete coolie
`
  if (shell === "zsh") return `#compdef coolie
_coolie() {
  local -a commands
  commands=(${TOP_LEVEL_COMMANDS.map((command) => `'${command}:${command}'`).join(" ")})
  _describe 'command' commands
}
compdef _coolie coolie
`
  return TOP_LEVEL_COMMANDS.map((command) =>
    `complete -c coolie -n '__fish_use_subcommand' -a '${command}'`).join("\n") + "\n"
}
