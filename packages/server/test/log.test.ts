import { describe, it, expect, vi } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { shouldRotateLog, rotateLogIfNeeded } from "../src/log/rotate.js"
import { formatLine, createLogger, installCrashNet } from "../src/log/logger.js"

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

describe("installCrashNet", () => {
  it("registers one listener per fatal event, logs on direct invocation without exiting, then cleans up", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-log3-"))
    const p = path.join(dir, "server.log")
    const logger = createLogger(p, "test")

    const rejectionsBefore = process.listeners("unhandledRejection").length
    const exceptionsBefore = process.listeners("uncaughtException").length

    installCrashNet(logger)

    expect(process.listeners("unhandledRejection").length).toBe(rejectionsBefore + 1)
    expect(process.listeners("uncaughtException").length).toBe(exceptionsBefore + 1)

    const rejectionHandler = process.listeners("unhandledRejection").at(-1) as (reason: unknown) => void
    const exceptionHandler = process.listeners("uncaughtException").at(-1) as (err: Error) => void

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit should not be called by the crash net")
    }) as never)

    try {
      // Invoke the registered handler directly — never via process.emit(...) — so
      // vitest's own unhandledRejection/uncaughtException listeners are never triggered.
      exceptionHandler(new Error("boom"))
      await logger.flush()
      const text = fs.readFileSync(p, "utf8")
      expect(text).toContain("uncaughtException")
      expect(text).toContain("boom")
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
      // Leave global listener state exactly as we found it.
      process.removeListener("unhandledRejection", rejectionHandler)
      process.removeListener("uncaughtException", exceptionHandler)
    }

    expect(process.listeners("unhandledRejection").length).toBe(rejectionsBefore)
    expect(process.listeners("uncaughtException").length).toBe(exceptionsBefore)
  })
})
