import { afterEach, beforeEach, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ensureNotifyScript } from "../src/engine/codex/notify.js"

let testHome = ""

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-codex-notify-"))
  process.env.COOLIE_CODEX_HOME = path.join(testHome, "codex-home")
  process.env.COOLIE_CODEX_CONFIG = path.join(testHome, "config.toml")
})

afterEach(() => {
  delete process.env.COOLIE_CODEX_HOME
  delete process.env.COOLIE_CODEX_CONFIG
  fs.rmSync(testHome, { recursive: true, force: true })
})

it("ensureNotifyScript 生成 loopback、Bearer token、仅 turn-complete 的静默转发器", () => {
  const p = ensureNotifyScript(testHome, "codex")
  expect(p).toBe(path.join(testHome, "hooks", "codex-notify.sh"))
  const body = fs.readFileSync(p, "utf8")
  expect(body).toContain("http://127.0.0.1:$PORT/notify/codex?workspace=$WS")
  expect(body).toContain("Authorization: Bearer $TOKEN")
  expect(body).toContain("agent-turn-complete")
  expect(body).toContain("server.json")
  expect(body).not.toContain("coolie-server")
  expect(body.trim().endsWith("exit 0")).toBe(true)
  expect(fs.statSync(p).mode & 0o111).not.toBe(0)
})
