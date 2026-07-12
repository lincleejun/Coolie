import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** claude 文件夹信任配置的真实位置（~/.claude.json）；`COOLIE_CLAUDE_CONFIG` 覆盖（测试注入临时文件）。 */
export const defaultClaudeConfigPath = (): string =>
  process.env.COOLIE_CLAUDE_CONFIG ?? path.join(os.homedir(), ".claude.json")

/** claude 按 cwd 的 **realpath** 索引 projects[]（macOS /tmp→/private/tmp、软链 worktree 同理），
 * seed 必须用同样解析后的键，否则 claude 查不到、对话框照旧弹出。folder 不存在时退回 path.resolve。 */
const trustKey = (folder: string): string => {
  try { return fs.realpathSync(folder) } catch { return path.resolve(folder) }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * 预置 claude 文件夹信任：`~/.claude.json` 的 `projects[<realpath>].hasTrustDialogAccepted = true`。
 * 经验证（p3-task-15 forensics）：新 worktree 首启会卡「Do you trust this folder?」对话框且在
 * 回答前 **不** 触发 SessionStart —— 直接 deadlock bootstrap 的就绪门控。Coolie 自建的 worktree 属
 * 用户已添加项目的隐式信任范围，故起 engine 前预置此标志、把对话框整个跳过。
 *
 * read-or-default {} → 仅并入 `hasTrustDialogAccepted`（本 folder 已有条目则保留其余字段，byte-faithful，
 * 绝不丢键）→ tmp 同目录写入后 rename 原子替换；缺文件/父目录/坏 JSON 均安全重建，永不抛破坏调用方。
 */
export const seedFolderTrust = (configPath: string, folder: string): void => {
  const key = trustKey(folder)

  let config: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"))
    if (isPlainObject(parsed)) config = parsed
  } catch { /* 缺文件 / 坏 JSON → 从空对象重建 */ }

  const projects = isPlainObject(config.projects) ? config.projects : {}
  const existing = isPlainObject(projects[key]) ? projects[key] : {}
  config.projects = { ...projects, [key]: { ...existing, hasTrustDialogAccepted: true } }

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  // 原子写：同目录 tmp + rename（跨设备风险为零）；mode 0o600 对齐 claude 自身的 rw-------。
  const tmp = `${configPath}.coolie-${process.pid}-${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, configPath)
}
