import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { seedFolderTrust } from "../src/engine/claude/trust.js"

// claude 按 cwd 的 realpath 索引 projects[]（macOS /tmp→/private/tmp）——期望键取 realpath。
let home: string, folder: string, cfgPath: string
const key = () => fs.realpathSync(folder)
const read = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"))

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-trust-cfg-"))
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-trust-ws-"))
  cfgPath = path.join(home, "nested", ".claude.json") // 不存在的嵌套路径：验证自动建父目录+文件
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(folder, { recursive: true, force: true }) })

describe("seedFolderTrust", () => {
  it("缺文件时新建配置，写入 projects[<realpath>].hasTrustDialogAccepted=true", () => {
    expect(fs.existsSync(cfgPath)).toBe(false)
    seedFolderTrust(cfgPath, folder)
    expect(fs.existsSync(cfgPath)).toBe(true)
    const c = read()
    // 发现的确切信任 shape：单一布尔键（最小 seed）
    expect(c.projects[key()]).toEqual({ hasTrustDialogAccepted: true })
  })

  it("保留已有其它 project 条目与顶层键（byte-faithful，不丢键）", () => {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify({
      numStartups: 42,
      projects: { "/some/other/proj": { hasTrustDialogAccepted: true, allowedTools: ["x"] } },
    }, null, 2))
    seedFolderTrust(cfgPath, folder)
    const c = read()
    expect(c.numStartups).toBe(42) // 顶层键保留
    expect(c.projects["/some/other/proj"]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ["x"] }) // 他人条目原样
    expect(c.projects[key()]).toEqual({ hasTrustDialogAccepted: true }) // 新条目已加
  })

  it("并入而非覆盖：已存在本 folder 条目时只补 hasTrustDialogAccepted，其余字段保留", () => {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: { [key()]: { allowedTools: [], projectOnboardingSeenCount: 3, hasTrustDialogAccepted: false } },
    }, null, 2))
    seedFolderTrust(cfgPath, folder)
    const c = read()
    expect(c.projects[key()]).toEqual({ allowedTools: [], projectOnboardingSeenCount: 3, hasTrustDialogAccepted: true })
  })

  it("幂等：重复 seed 不产生重复条目，结果稳定", () => {
    seedFolderTrust(cfgPath, folder)
    const first = fs.readFileSync(cfgPath, "utf8")
    seedFolderTrust(cfgPath, folder)
    const second = fs.readFileSync(cfgPath, "utf8")
    expect(second).toBe(first) // 完全一致
    expect(Object.keys(read().projects)).toEqual([key()]) // 单一条目
  })

  it("坏 JSON / 非对象 → 重建为最小信任配置（不抛）", () => {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, "{ not valid json ]")
    expect(() => seedFolderTrust(cfgPath, folder)).not.toThrow()
    expect(read().projects[key()]).toEqual({ hasTrustDialogAccepted: true })
  })
})
