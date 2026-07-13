import { describe, expect, it } from "vitest"
import {
  SUN_PATH_MAX,
  assertSockPathFits,
  sockPathByteLength,
  sockPathWarning,
} from "../src/daemon/socket.js"

describe("unix socket sun_path 上限守卫（N1）", () => {
  it("正常短路径不抛且无警告", () => {
    const p = "/Users/x/.coolie/coolie.sock"
    expect(() => assertSockPathFits(p)).not.toThrow()
    expect(sockPathWarning(p)).toBeNull()
  })

  it("按 UTF-8 字节而非字符计数", () => {
    expect(sockPathByteLength("/临/coolie.sock")).toBe(Buffer.byteLength("/临/coolie.sock", "utf8"))
  })

  it("达到平台上限时响亮失败并给出修复建议", () => {
    if (!Number.isFinite(SUN_PATH_MAX)) return
    const long = "/" + "a".repeat(SUN_PATH_MAX + 10) + "/coolie.sock"
    expect(() => assertSockPathFits(long)).toThrow(
      new RegExp(`${sockPathByteLength(long)}.*${SUN_PATH_MAX}.*COOLIE_HOME`, "s"),
    )
  })

  it("达到 90% 软阈值时仅警告", () => {
    if (!Number.isFinite(SUN_PATH_MAX)) return
    const near = "/" + "b".repeat(Math.floor(SUN_PATH_MAX * 0.9) - 1)
    expect(sockPathByteLength(near)).toBe(Math.floor(SUN_PATH_MAX * 0.9))
    expect(() => assertSockPathFits(near)).not.toThrow()
    expect(sockPathWarning(near)).toContain(String(sockPathByteLength(near)))
  })
})
