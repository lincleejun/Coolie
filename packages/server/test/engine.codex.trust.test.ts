import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { seedCodexTrust, defaultCodexConfigPath } from "../src/engine/codex/trust.js"

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coolie-cxt-"))

describe("seedCodexTrust", () => {
  it("空配置 → 写入 trusted 条目（realpath 归一）", () => {
    const home = mkTmp(); const cfg = defaultCodexConfigPath(home); const cwd = mkTmp()
    seedCodexTrust(cfg, cwd)
    const real = fs.realpathSync(cwd)
    const txt = fs.readFileSync(cfg, "utf8")
    expect(txt).toContain(`[projects."${real}"]`)
    expect(txt).toContain('trust_level = "trusted"')
  })
  it("merge-only：保留用户既有键，幂等重跑不重复", () => {
    const home = mkTmp(); const cfg = defaultCodexConfigPath(home); const cwd = mkTmp()
    fs.mkdirSync(path.dirname(cfg), { recursive: true })
    fs.writeFileSync(cfg, 'model = "gpt-5"\n\n[projects."/other"]\ntrust_level = "trusted"\n')
    seedCodexTrust(cfg, cwd); seedCodexTrust(cfg, cwd) // 幂等
    const txt = fs.readFileSync(cfg, "utf8")
    expect(txt).toContain('model = "gpt-5"')          // 用户键保留
    expect(txt).toContain('[projects."/other"]')       // 既有条目保留
    const real = fs.realpathSync(cwd)
    const occurrences = txt.split(`[projects."${real}"]`).length - 1
    expect(occurrences).toBe(1)                          // 不重复
  })
  it("UPSERT（F5）：header 已存在但无 trust_level → 补 trusted，段内其它键保留", () => {
    const home = mkTmp(); const cfg = defaultCodexConfigPath(home); const cwd = mkTmp()
    const real = fs.realpathSync(cwd)
    fs.mkdirSync(path.dirname(cfg), { recursive: true })
    // 半写状态：本 cwd 的段在，但只有别的键、没有 trust_level（旧实现会误判已受信而跳过）。
    fs.writeFileSync(cfg, `[projects."${real}"]\nsome_key = "v"\n`)
    seedCodexTrust(cfg, cwd)
    const txt = fs.readFileSync(cfg, "utf8")
    expect(txt).toContain('trust_level = "trusted"') // 补上了
    expect(txt).toContain('some_key = "v"')           // 段内其它键保留
    // 幂等：重跑不再重复插入。
    seedCodexTrust(cfg, cwd)
    const txt2 = fs.readFileSync(cfg, "utf8")
    expect(txt2.split('trust_level =').length - 1).toBe(1)
  })
  it("UPSERT（F5）：header 存在且 trust_level 非 trusted → 改写为 trusted", () => {
    const home = mkTmp(); const cfg = defaultCodexConfigPath(home); const cwd = mkTmp()
    const real = fs.realpathSync(cwd)
    fs.mkdirSync(path.dirname(cfg), { recursive: true })
    fs.writeFileSync(cfg, `[projects."${real}"]\ntrust_level = "untrusted"\n`)
    seedCodexTrust(cfg, cwd)
    const txt = fs.readFileSync(cfg, "utf8")
    expect(txt).toContain('trust_level = "trusted"')
    expect(txt).not.toContain('untrusted')
  })
})
