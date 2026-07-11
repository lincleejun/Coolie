import { describe, it, expect } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { shouldRotateLog, rotateLogIfNeeded } from "../src/log/rotate.js"
import { formatLine, createLogger } from "../src/log/logger.js"

describe("log rotation", () => {
  it("pure decision honors the cap", () => {
    expect(shouldRotateLog(11 * 1024 * 1024)).toBe(true)
    expect(shouldRotateLog(1024)).toBe(false)
    expect(shouldRotateLog(2, 1)).toBe(true)
  })
  it("renames the oversized file to .old", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-log-"))
    const p = path.join(dir, "server.log")
    fs.writeFileSync(p, "x".repeat(10))
    rotateLogIfNeeded(p, 5)
    expect(fs.existsSync(p)).toBe(false)
    expect(fs.readFileSync(`${p}.old`, "utf8")).toHaveLength(10)
  })
  it("rotation failure is swallowed", () => {
    expect(() => rotateLogIfNeeded("/nonexistent/dir/x.log", 1)).not.toThrow()
  })
})

describe("logger", () => {
  it("formats level, context, pid and stack", () => {
    const line = formatLine("ERROR", "server", "boom", new Error("bad"))
    expect(line).toContain("\tERROR\t")
    expect(line).toContain(`server[${process.pid}]`)
    expect(line).toContain("bad")
    expect(line).toContain("Error: bad") // stack 首行
  })
  it("appends to file (fire-and-forget + flush)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-log2-"))
    const p = path.join(dir, "nested", "server.log") // 目录不存在也要能写
    const log = createLogger(p, "test")
    log.info("hello"); log.error("oops", new Error("e1"))
    await log.flush()
    const text = fs.readFileSync(p, "utf8")
    expect(text).toContain("hello")
    expect(text).toContain("oops")
    expect(text.trim().split("\n").length).toBeGreaterThanOrEqual(2)
  })
})
