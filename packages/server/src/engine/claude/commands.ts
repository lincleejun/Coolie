import * as fs from "node:fs"
import * as path from "node:path"

export interface SlashCommand { name: string; source: "repo" | "user" }

/** 扫描 .md 命令文件（含子目录，名字用 `dir:file` 形态与 claude 一致的扁平化：M1 用相对路径去掉 .md、/ 换 :） */
const scanDir = (dir: string, source: SlashCommand["source"]): SlashCommand[] => {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
  } catch { return [] } // 目录不存在 = 无命令
  return entries
    .filter((e) => e.endsWith(".md"))
    .map((e) => ({ name: e.slice(0, -3).split(path.sep).join(":"), source }))
}

/** repo（worktree/.claude/commands）优先，user（~/.claude/commands）随后；同名去重取 repo */
export const scanSlashCommands = (worktree: string, claudeHome: string): SlashCommand[] => {
  const repo = scanDir(path.join(worktree, ".claude", "commands"), "repo")
  const seen = new Set(repo.map((c) => c.name))
  const user = scanDir(path.join(claudeHome, "commands"), "user").filter((c) => !seen.has(c.name))
  return [...repo, ...user].sort((a, b) => a.name.localeCompare(b.name))
}
