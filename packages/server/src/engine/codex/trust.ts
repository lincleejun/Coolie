import * as fs from "node:fs"
import * as path from "node:path"

export const defaultCodexConfigPath = (codexHome: string): string => path.join(codexHome, "config.toml")

const realpathBestEffort = (p: string): string => {
  try { return fs.realpathSync(p) } catch { return p }
}

const atomicWrite = (configPath: string, next: string): void => {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.coolie-tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, configPath) // 原子替换
}

/** 幂等、原子（tmp+rename）、merge-only 的 codex project trust UPSERT（codex.md §7；F5）。
 * - 段不存在 → 末尾追加 `[projects."<real>"]\ntrust_level = "trusted"`。
 * - 段存在但无 trust_level → 段内首行后插入 trust_level="trusted"。
 * - 段存在且 trust_level 非 "trusted" → 改写该行为 "trusted"。
 * - 段存在且已 "trusted" → no-op（幂等）。
 * 用户其它键/其它 project 段一字不动。 */
export const seedCodexTrust = (configPath: string, cwd: string): void => {
  const real = realpathBestEffort(cwd)
  const header = `[projects."${real}"]`
  let existing = ""
  try { existing = fs.readFileSync(configPath, "utf8") } catch { /* 无文件 → 新建 */ }

  const lines = existing === "" ? [] : existing.split("\n")
  const headerIdx = lines.findIndex((l) => l.trim() === header)

  if (headerIdx === -1) {
    // 段不存在 → 追加整段（保尾换行规整）。
    const prefix = existing === "" || existing.endsWith("\n") ? existing : existing + "\n"
    atomicWrite(configPath, `${prefix}${existing === "" ? "" : "\n"}${header}\ntrust_level = "trusted"\n`)
    return
  }

  // 段存在 → 定位其范围（到下一个 table header 或文件尾），在段内查 trust_level。
  let end = lines.length
  for (let j = headerIdx + 1; j < lines.length; j++) {
    if (/^\s*\[/.test(lines[j]!)) { end = j; break }
  }
  let trustAbs = -1
  for (let j = headerIdx + 1; j < end; j++) {
    if (/^\s*trust_level\s*=/.test(lines[j]!)) { trustAbs = j; break }
  }

  if (trustAbs === -1) {
    // 段有、trust_level 无 → 在 header 后插入。
    lines.splice(headerIdx + 1, 0, 'trust_level = "trusted"')
    atomicWrite(configPath, lines.join("\n"))
    return
  }
  if (/^\s*trust_level\s*=\s*"trusted"\s*$/.test(lines[trustAbs]!)) return // 已 trusted → 幂等 no-op
  // trust_level 存在但非 trusted → UPSERT 改写为 trusted（保留原缩进）。
  const indent = (lines[trustAbs]!.match(/^\s*/) ?? [""])[0]
  lines[trustAbs] = `${indent}trust_level = "trusted"`
  atomicWrite(configPath, lines.join("\n"))
}
