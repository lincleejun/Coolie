import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export interface Logger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, err?: unknown) => void
  flush: () => Promise<void>
}

const coerce = (err: unknown): { message: string; stack?: string } => {
  if (err instanceof Error) return { message: err.message, ...(err.stack ? { stack: err.stack } : {}) }
  try { return { message: typeof err === "string" ? err : JSON.stringify(err) } }
  catch { return { message: String(err) } }
}

export const formatLine = (
  level: "INFO" | "WARN" | "ERROR", context: string, msg: string, err?: unknown,
): string => {
  const e = err === undefined ? undefined : coerce(err)
  const tail = e ? `\t${e.message}${e.stack ? `\n${e.stack}` : ""}` : ""
  return `${new Date().toISOString()}\t${level}\t${context}[${process.pid}]\t${msg}${tail}\n`
}

/** 写文件 fire-and-forget（串行化 + 全错误吞掉），镜像 stderr。日志失败绝不影响主流程。 */
export const createLogger = (filePath: string, context: string): Logger => {
  let pending: Promise<void> = Promise.resolve()
  const write = (line: string): void => {
    pending = pending
      .then(() => mkdir(dirname(filePath), { recursive: true }))
      .then(() => appendFile(filePath, line))
      .catch(() => {})
    process.stderr.write(line)
  }
  return {
    info: (m) => write(formatLine("INFO", context, m)),
    warn: (m) => write(formatLine("WARN", context, m)),
    error: (m, err) => write(formatLine("ERROR", context, m, err)),
    flush: () => pending,
  }
}

/** 长命 daemon 不能被一个野 promise 打死：记录后继续服务（kobe crash-log 教训）。 */
export const installCrashNet = (logger: Logger): void => {
  process.on("unhandledRejection", (reason) => logger.error("unhandledRejection", reason))
  process.on("uncaughtException", (err) => logger.error("uncaughtException", err))
}
